import type { Purchase } from '../model';
import { identifyRows } from '../preferences.mjs';
import { moneyDecimal, moneyMinor, reconcileSettlementReceipts } from '../domain.mjs';

type Receipt = { id: string; url: string; date?: string; orderId?: string; type?: string };
const strip = (s: string) => s.normalize('NFC').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
function date(html: string, fallback?: string) { const m = strip(html).match(/(\d{2})\.(\d{2})\.(\d{2,4})\s+(\d{2}:\d{2})/); return m ? `${m[3]!.length === 2 ? `20${m[3]}` : m[3]}-${m[2]}-${m[1]} ${m[4]}` : String(fallback || ''); }

export function parseYandexReceipt(html: string, receipt: Receipt): Purchase[] {
  const rows = html.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  const parsed: Array<{ title: string; cents: number; settlement: string }> = [];
  let total: number | null = null;
  for (const row of rows) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => strip(m[1]!));
    if (cells.some((cell) => /^ИТОГО?\s*:?$/i.test(cell))) { total = moneyMinor(cells.at(-1)); continue; }
    if (!/^\d+\.$/.test(cells[0] || '')) continue;
    const cents = moneyMinor(cells.at(-1)); const title = (cells[1] || '').replace(/\s*(?:Признак способа расч[её]та:|ИНН Поставщика:|АГЕНТ(?:\s|$)|КТ:|\[M[+-]\]).*$/i, '').trim();
    if (title && cents !== null) parsed.push({ title, cents, settlement: /предоплат|аванс/i.test(cells[1] || '') ? 'prepayment' : /полный\s+расч[её]т/i.test(cells[1] || '') ? 'full' : 'unknown' });
  }
  const isRefund = receipt.type === 'RETURN_INCOME' || /возврат прихода/i.test(strip(html)); const stamp = date(html, receipt.date);
  const fallback = (): Purchase[] => total === null ? [] : identifyRows([{ rowId: '', source: 'yandex', date: stamp, amount: moneyDecimal(isRefund ? -Math.abs(total) : Math.abs(total)), title: `Yandex receipt не разобран (${receipt.id})`, type: isRefund ? 'refund' : 'purchase', currency: 'RUB', marketplace_id: `${receipt.orderId || ''}:${receipt.id}`, receipt_url: receipt.url, yandex_order_id: receipt.orderId || '', parse_quality: 'fallback' }]);
  const sum = parsed.reduce((n, item) => n + Math.abs(item.cents), 0);
  if (!parsed.length || (total !== null && sum !== Math.abs(total))) return fallback();
  return identifyRows(parsed.map((item, index) => ({ rowId: '', source: 'yandex', date: stamp, amount: moneyDecimal(isRefund ? -Math.abs(item.cents) : item.cents), title: item.title, type: isRefund ? 'refund' : 'purchase', currency: 'RUB', marketplace_id: `${receipt.orderId || ''}:${receipt.id}`, receipt_url: receipt.url, yandex_order_id: receipt.orderId || '', yandex_settlement_kind: item.settlement, item_index: String(index + 1), parse_quality: total === null ? 'unverified' : 'complete' })));
}

export function reconcileYandexReceipts(input: Purchase[]): { rows: Purchase[]; removed: number } {
  return reconcileSettlementReceipts(identifyRows(input));
}
