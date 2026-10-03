import type { Purchase } from '../model';
import { identifyRows } from '../preferences.mjs';
import { moneyDecimal, moneyMinor } from '../domain.mjs';

type Receipt = { id: string; url: string; date?: string; orderId?: string };
type OzonRow = Purchase & { ozon_settlement_kind?: string; ozon_order_id?: string; item_index?: string; raw_amount?: string };
const settlementOf = (row: OzonRow) => String(row.ozon_settlement_kind || (row as Record<string, unknown>).__ozonSettlementKind || 'unknown');

const titleKey = (title: unknown) => String(title || '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]+/gi, ' ').trim();
const dateValue = (value: string | undefined) => String(value || '').replace('T', ' ').replace(/Z$/, '').slice(0, 16);
const orderFrom = (receipt: Receipt) => receipt.orderId || receipt.id.match(/^(.+?)-[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[1] || '';
function rowOrder(row: OzonRow): string {
  const explicit = String(row.ozon_order_id || '').trim();
  if (explicit) return explicit;
  const title = String(row.raw_title || '').match(/Заказ\s*№\s*(\S+)/iu)?.[1];
  if (title) return title;
  const marketplace = String(row.marketplace_id || '').trim();
  if (marketplace) return marketplace;
  const receipt = String(row.receipt_url || '').match(/[?&](?:chequeId|id)=([^&#]+)/i)?.[1] || '';
  return receipt.match(/^(.+?)-[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[1] || '';
}
const totalFrom = (text: string) => moneyMinor((text.match(/ИТОГ[\s\S]{0,80}?(-?\d[\d\s]*(?:[,.]\d{1,2})?)/i) || [])[1] || '');

export function parseOzonReceipt(text: string, receipt: Receipt): Purchase[] {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  const dateMatch = text.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
  const date = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]} ${dateMatch[4]}:${dateMatch[5]}` : dateValue(receipt.date);
  const isRefund = /возврат/i.test(text.slice(0, 1000));
  const settlement = /полный\s+расч[её]т|полная\s+оплата|итоговый\s+расч[её]т/i.test(text) ? 'full' : /предоплат|получение\s+аванса|аванс/i.test(text) ? 'prepayment' : 'unknown';
  const items: Array<{ title: string; cents: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(/^\d{1,3}\.\s*(.*)$/);
    if (!match) continue;
    const titleParts = match[1] ? [match[1]] : [];
    const inline = match[1]?.match(/^(.*?)(?:\s+)(-?\d[\d\s]*(?:[,.]\d{1,2})?)\s*(?:₽|руб)?$/i);
    let cents: number | null = inline ? moneyMinor(inline[2]) : null;
    let seenAmount = cents !== null;
    if (inline) titleParts.splice(0, titleParts.length, inline[1]!);
    for (let next = index + 1; next < lines.length && !/^\d{1,3}\.\s/.test(lines[next]!) && !/^ИТОГ/i.test(lines[next]!); next += 1) {
      const line = lines[next]!;
      const amountMatch = line.match(/≡\s*(-?\d[\d\s]*(?:[,.]\d{1,2})?)/);
      if (amountMatch) { cents = moneyMinor(amountMatch[1]); seenAmount = true; }
      else if (!seenAmount) titleParts.push(line);
    }
    const title = titleParts.join(' ').replace(/\s+/g, ' ').trim();
    if (title && cents !== null) items.push({ title, cents });
  }
  const totalLine = lines.find((line) => /^ИТОГ/i.test(line)) || '';
  const total = moneyMinor((totalLine.match(/(-?\d[\d\s]*(?:[,.]\d{1,2})?)/) || [])[1] || '') ?? totalFrom(text);
  const fallback = (reason: string): Purchase[] => total === null ? [] : identifyRows([{
    rowId: '', source: 'ozon', date, amount: moneyDecimal(isRefund ? -Math.abs(total) : Math.abs(total)), title: `Ozon PDF не разобран (${receipt.id})`,
    type: isRefund ? 'refund' : 'purchase', currency: 'RUB', marketplace_id: receipt.id, receipt_url: receipt.url,
    ozon_order_id: orderFrom(receipt), ozon_settlement_kind: settlement, parse_quality: 'fallback', raw_title: `fallback=${reason}`, raw_amount: moneyDecimal(total)
  }]);
  if (!items.length) return fallback('no_items');
  const parsed = items.reduce((sum, item) => sum + Math.abs(item.cents), 0);
  if (total !== null && parsed !== Math.abs(total)) return fallback('receipt_total_mismatch');
  return identifyRows(items.map((item, index) => ({
    rowId: '', source: 'ozon', date, amount: moneyDecimal(isRefund ? -Math.abs(item.cents) : item.cents), title: item.title,
    type: isRefund ? 'refund' : 'purchase', currency: 'RUB', marketplace_id: receipt.id, receipt_url: receipt.url,
    ozon_order_id: orderFrom(receipt), ozon_settlement_kind: settlement, item_index: String(index + 1), raw_amount: moneyDecimal(item.cents),
    parse_quality: total === null ? 'unverified' : 'complete'
  })));
}

export function reconcileOzonReceipts(input: Purchase[]): { rows: Purchase[]; removed: number } {
  const rows = input.map((row) => ({ ...row })) as OzonRow[];
  const remove = new Set<OzonRow>();
  const consumedFinals = new Set<OzonRow>();
  const finals = rows.filter((row) => row.type !== 'refund' && settlementOf(row) === 'full');
  for (const early of rows) {
    if (early.type === 'refund' || settlementOf(early) === 'full') continue;
    const order = rowOrder(early);
    if (!order) continue;
    const cents = moneyMinor(early.amount);
    if (cents === null) continue;
    const match = finals.find((final) => !consumedFinals.has(final)
      && rowOrder(final) === order
      && titleKey(final.title) === titleKey(early.title)
      && moneyMinor(final.amount) === cents
      && String(final.item_index || '') === String(early.item_index || '')
      && String(early.date || '') <= String(final.date || ''));
    if (match) { remove.add(early); consumedFinals.add(match); }
  }
  return { rows: identifyRows(rows.filter((row) => !remove.has(row))), removed: remove.size };
}
