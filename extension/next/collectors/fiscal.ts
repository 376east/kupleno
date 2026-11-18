import type { FiscalPayment } from '../model';
import { moneyMinor } from '../domain.mjs';

const paymentLabels = /^(наличными|безналичными|электронными|аванс|зач[её]т предварительной оплаты|кредит|встречное предоставление)\s*:?$/i;
const offsetLabels = /^(аванс|зач[её]т предварительной оплаты)/i;
const unsupportedLabels = /^(кредит|встречное предоставление)/i;
const operation = /^(Приход|Возврат\s+прихода|Расход|Возврат\s+расхода)$/i;
const payout = /^(Возврат\s+прихода|Расход)$/i;

function identity(parts: Array<string | undefined>): string | undefined {
  if (parts.some(part => !part || !/^\d{1,20}$/.test(part))) return undefined;
  return parts.map(part => part!.replace(/^0+(?=\d)/, '')).join(':');
}

function fiscalPayment(id: string | undefined, date: string, kind: string, total: number | null, components: Array<[string, string | undefined]>): FiscalPayment | undefined {
  if (!id || !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?$/.test(date) || !operation.test(kind) || total === null || !components.length) return undefined;
  let paid = 0, advance = 0;
  const seen = new Set<string>();
  for (const [label, value] of components) {
    const amount = moneyMinor(value?.replace(/^≡\s*/, ''));
    const key = label.toLowerCase().replace(/ё/g, 'е').replace(/\s*:\s*$/, '');
    if (amount === null || seen.has(key) || (unsupportedLabels.test(label) && amount !== 0)) return undefined;
    seen.add(key);
    if (offsetLabels.test(label)) advance += Math.abs(amount);
    else paid += Math.abs(amount);
  }
  if (paid + advance !== Math.abs(total)) return undefined;
  const sign = payout.test(kind) ? -1 : 1;
  return { id, date, paid: sign * paid || 0, advance: sign * advance || 0 };
}

export const ozonTotalLabel = /^ИТОГ(?:О)?(?=$|[\s:≡])/i;
export const ozonTotalAmount = /^[\s:≡]*(-?\d[\d \u00a0\u202f]*(?:[,.]\d{1,2})?)\s*(?:₽|руб\.?)?$/i;

export function readOzonTotal(lines: string[], index: number): number | null {
  if (index < 0) return null;
  const inline = lines[index]!.replace(ozonTotalLabel, '').trim();
  const text = /^[\s:≡]*$/.test(inline) ? lines[index + 1] ?? '' : inline;
  return moneyMinor(text.match(ozonTotalAmount)?.[1]);
}

export function readOzonPayment(text: string, date: string): FiscalPayment | undefined {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const totalIndex = lines.findIndex(line => ozonTotalLabel.test(line));
  const fields = [/^\s*ФН[ \t]*:[ \t]*(?:\r?\n[ \t]*)?(\d+)[ \t]*$/mi,
    /^\s*ФД[ \t]*:[ \t]*(?:\r?\n[ \t]*)?(\d+)[ \t]*$/mi,
    /^\s*ФПД[ \t]*:[ \t]*(?:\r?\n[ \t]*)?(\d+)[ \t]*$/mi];
  const id = identity(fields.map(field => text.match(field)?.[1]));
  const kind = lines.slice(0, totalIndex).find(line => operation.test(line)) || '';
  const components: Array<[string, string | undefined]> = [];
  for (let index = totalIndex + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^(?:ФП(?:Д)?|ФН|РН ККТ)\s*(?::|$)/i.test(line)) break;
    const match = line.match(/^(.*?)(?:\s*≡\s*|:\s*)(\d[\d\s,.]*)$/);
    const label = match?.[1]?.trim() || line;
    if (paymentLabels.test(label)) components.push([label, match?.[2] ?? lines[index + 1]]);
  }
  return fiscalPayment(id, date, kind, readOzonTotal(lines, totalIndex), components);
}

export function receiptText(html: string): string {
  return html.normalize('NFC').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;|&#xA0;/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function readYandexPayment(html: string, url: string, date: string): FiscalPayment | undefined {
  const plain = receiptText(html);
  const kind = plain.match(/Кассовый\s+чек[.\s]*(Возврат\s+прихода|Приход)(?:\s|$)/i)?.[1] || '';
  const fields = [/(?:^|\s)ФН\s*:\s*(\d+)/i, /(?:^|\s)ФД\s*:\s*(\d+)/i, /(?:^|\s)ФП(?:Д)?\s*:\s*(\d+)/i];
  const id = identity(fields.map(field => plain.match(field)?.[1]));
  if (!id) return undefined;
  let query: URLSearchParams;
  try { query = new URL(url).searchParams; } catch { return undefined; }
  if (identity(['fn', 'n', 'fpd'].map(key => query.get(key) ?? undefined)) !== id) return undefined;
  const table = [...html.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map(([row]) =>
    [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => receiptText(cell[1]!)));
  const total = moneyMinor(table.find(cells => cells.some(cell => /^ИТОГО?\s*:?$/i.test(cell)))?.at(-1));
  const components: Array<[string, string | undefined]> = table.flatMap(cells =>
    cells.length >= 2 && paymentLabels.test(cells[0]!) ? [[cells[0]!, cells.at(-1)]] : []);
  return fiscalPayment(id, date, kind, total, components);
}

export function readWildberriesPayment(html: string, date: string, currency: string): FiscalPayment | undefined {
  if (currency.toUpperCase() !== 'RUB') return undefined;
  const heading = html.match(/<div\b[^>]*class="check-header-column first"[^>]*>([\s\S]*?)<br\b/i)?.[1];
  const fields = [...html.matchAll(/<div\s+class="property-name[^"]*"[^>]*>([^<]*)<\/div>\s*<div\s+class="property-value[^"]*"[^>]*>([^<]*)<\/div>/gi)]
    .map(([, label, value]) => [receiptText(label!), receiptText(value!)] as [string, string]);
  const field = (label: RegExp) => fields.find(([name]) => label.test(name))?.[1];
  const id = identity([/^№\s*ФН$/i, /^№\s*ФД$/i, /^ФПД$/i].map(field));
  const total = moneyMinor(field(/^ИТОГО?\s*:?$/i));
  return fiscalPayment(id, date, receiptText(heading || ''), total, fields.filter(([name]) => paymentLabels.test(name)));
}
