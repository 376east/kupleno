import type { Purchase } from '../model';
import { identifyRows } from '../preferences.mjs';
import { moneyDecimal, moneyMinor, reconcileSettlementReceipts } from '../domain.mjs';

type Receipt = { id: string; url: string; date?: string; orderId?: string };
const dateValue = (value: string | undefined) => String(value || '').replace('T', ' ').replace(/Z$/, '').slice(0, 16);
const orderFrom = (receipt: Receipt) => receipt.orderId || receipt.id.match(/^(.+?)-[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[1] || '';
const totalLabel = /^ИТОГ(?:О)?(?=$|[\s:≡])/i;
const totalAmount = /^[\s:≡]*(-?\d[\d \u00a0\u202f]*(?:[,.]\d{1,2})?)\s*(?:₽|руб\.?)?$/i;
const itemLine = /^\d{1,3}\.(?!\d)\s*(.*)$/;

export function parseOzonReceipt(text: string, receipt: Receipt): Purchase[] {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  const dateMatch = text.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
  const date = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]} ${dateMatch[4]}:${dateMatch[5]}` : dateValue(receipt.date);
  const isRefund = /возврат/i.test(text.slice(0, 1000));
  const settlement = /полный\s+расч[её]т|полная\s+оплата|итоговый\s+расч[её]т/i.test(text) ? 'full' : /предоплат|предварительная\s+оплата|получение\s+аванса|аванс/i.test(text) ? 'prepayment' : 'unknown';
  const items: Array<{ title: string; cents: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(itemLine);
    if (!match) continue;
    const titleParts = match[1] ? [match[1]] : [];
    const inline = match[1]?.match(/^(.*?)(?:\s+)(-?\d[\d\s]*(?:[,.]\d{1,2})?)\s*(?:₽|руб)?$/i);
    let cents: number | null = inline ? moneyMinor(inline[2]) : null;
    let seenAmount = cents !== null;
    if (inline) titleParts.splice(0, titleParts.length, inline[1]!);
    for (let next = index + 1; next < lines.length && !itemLine.test(lines[next]!) && !totalLabel.test(lines[next]!); next += 1) {
      const line = lines[next]!;
      const amountMatch = line.match(/≡\s*(-?\d[\d\s]*(?:[,.]\d{1,2})?)/);
      if (amountMatch && !/НДС/i.test(line)) { cents = moneyMinor(amountMatch[1]); seenAmount = true; }
      else if (!seenAmount) titleParts.push(line);
    }
    const title = titleParts.join(' ').replace(/\s+/g, ' ').trim();
    if (title && cents !== null) items.push({ title, cents });
  }
  const totalIndex = lines.findIndex((line) => totalLabel.test(line));
  const inlineTotal = lines[totalIndex]?.replace(totalLabel, '').trim() ?? '';
  const totalText = totalIndex < 0 ? '' : /^[\s:≡]*$/.test(inlineTotal) ? lines[totalIndex + 1] ?? '' : inlineTotal;
  const total = moneyMinor(totalText.match(totalAmount)?.[1] || '');
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
  return reconcileSettlementReceipts(identifyRows(input));
}
