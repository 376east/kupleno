import type { Purchase } from '../model';
import type { CollectionResult } from '../collection';
import { identifyRows } from '../preferences.mjs';
import { moneyDecimal, moneyMinor } from '../domain.mjs';
import { readWildberriesPayment } from './fiscal.ts';

const LIST_URL = 'https://astro.wildberries.ru/api/v1/receipt-api/v1/receipts';
const PAGE_SIZE = 50;
const MAX_PAGES = 2000;
const MAX_ROWS = 100000;

type Receipt = {
  id: string;
  url: string;
  date?: string;
  receiptUid?: string;
  operationDateTime?: string;
  operationSum?: unknown;
  operationTypeId?: unknown;
  currencyNameIso?: unknown;
};

type Progress = { done: number; total: number; message: string };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function amount(value: unknown): number | null {
  return (typeof value === 'number' || typeof value === 'string') ? moneyMinor(value) : null;
}

function cleanHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

function receiptType(receipt: Receipt, html: string): 'purchase' | 'refund' {
  const header = cleanHtml(html.slice(0, 14000));
  if (/возврат прихода/i.test(header)) return 'refund';
  if (/(?:^|\s)приход(?:\s|$)/i.test(header)) return 'purchase';
  if (Number(receipt.operationTypeId) === 2) return 'refund';
  return 'purchase';
}

function receiptDate(receipt: Receipt): string {
  const raw = receipt.date || receipt.operationDateTime || '';
  const date = new Date(raw);
  if (!raw || Number.isNaN(date.valueOf())) return '';
  return raw.replace('T', ' ').replace(/Z$/, '').slice(0, 16);
}

function fallback(receipt: Receipt, reason: string, type: 'purchase' | 'refund', total: number | null): Purchase[] {
  if (total === null) return [];
  const signed = type === 'refund' ? -Math.abs(total) : Math.abs(total);
  return identifyRows([{
    rowId: '', source: 'wildberries', date: receiptDate(receipt),
    amount: moneyDecimal(signed), currency: text(receipt.currencyNameIso) || 'RUB', type,
    title: `Wildberries receipt ${receipt.id} (состав не распознан)`, marketplace_id: receipt.id,
    receipt_url: receipt.url, item_index: '1', raw_amount: String(receipt.operationSum ?? ''),
    parse_quality: 'fallback', raw_title: `fallback=${reason}`
  }]);
}

/** Recognizes only documented historical envelopes; unknown HTTP 200 payloads are rejected. */
export function normalizeReceiptList(payload: unknown): { receipts: unknown[]; nextReceiptUid: string | null } {
  const root = object(payload);
  const candidates: unknown[] = [
    root?.data && object(root.data)?.result && object(object(root.data)?.result)?.data,
    root?.data && object(root.data)?.GetReceiptsV4V1 && object(object(root.data)?.GetReceiptsV4V1)?.data,
    root?.result && object(root.result)?.data, root?.data && object(root.data)?.result,
    root?.data && object(root.data)?.GetReceiptsV4V1, root?.data, root?.result, root
  ];
  for (const candidate of candidates) {
    const value = object(candidate);
    if (value && Array.isArray(value.receipts)) {
      const cursor = text(value.nextReceiptUid) || text(value.nextReceiptUID);
      return { receipts: value.receipts, nextReceiptUid: cursor || null };
    }
  }
  throw new Error(`WB_LIST_UNKNOWN_PAYLOAD shape=${payloadShape(payload)}`);
}

function payloadShape(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  const record = object(value);
  if (!record) return typeof value;
  if (depth >= 3) return 'object';
  const keys = Object.keys(record).slice(0, 8).map((key) => (/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(key) ? key : '?'));
  return `{${keys.map((key) => `${key}:${payloadShape(record[key], depth + 1)}`).join(',')}}`;
}

export function parseReceiptHtml(html: string, receipt: { id: string; url: string; date?: string }): Purchase[] {
  const enriched = receipt as Receipt;
  const chunks = html.match(/<div class="products-item[\s\S]*?(?=<div class="products-item|<div class="total|<\/body>)/gi) || [];
  const items: Array<{ title: string; amount: number }> = [];
  for (const chunk of chunks) {
    const name = chunk.match(/products-cell_name[^>]*>([\s\S]*?)(?=<div[^>]*products-cell_price)/i)?.[1] || '';
    const title = cleanHtml(name.replace(/<div[^>]*products-prop-value gray[^>]*>[\s\S]*?<\/div>/gi, ' ')).replace(/^Наименование\s*/i, '');
    const price = cleanHtml(chunk.match(/products-cell_cost[\s\S]*?products-prop-value[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '');
    const itemAmount = amount(price.replace(/[^\d,.-]/g, ''));
    if (title && itemAmount !== null) items.push({ title, amount: itemAmount });
  }
  const type = receiptType(enriched, html);
  const expected = amount(enriched.operationSum);
  const parsedTotal = items.reduce((sum, item) => sum + Math.abs(item.amount), 0);
  if (!items.length) return fallback(enriched, 'no_items', type, expected);
  if (expected !== null && parsedTotal !== Math.abs(expected)) return fallback(enriched, 'receipt_total_mismatch', type, expected);
  return identifyRows(items.map((item, index) => ({
    rowId: '', source: 'wildberries', date: receiptDate(enriched),
    amount: moneyDecimal(type === 'refund' ? -Math.abs(item.amount) : item.amount),
    currency: text(enriched.currencyNameIso) || 'RUB', type, title: item.title, marketplace_id: receipt.id,
    receipt_url: receipt.url, item_index: String(index + 1), raw_amount: moneyDecimal(item.amount),
    parse_quality: expected === null ? 'unverified' : 'complete'
  })));
}

function receiptFromUnknown(value: unknown): Receipt | null {
  const item = object(value);
  if (!item) return null;
  const id = text(item.receiptUid) || text(item.id);
  const url = text(item.link) || text(item.url);
  return id && url ? { ...item, id, url, receiptUid: id, date: text(item.operationDateTime) || undefined } : null;
}

export async function collectWildberries(options: {
  fetch: typeof fetch; token: string; signal?: AbortSignal; onProgress?: (progress: Progress) => void | Promise<void>; knownReceiptIds?: string[];
}): Promise<CollectionResult> {
  if (!options.token.trim()) throw new Error('WB_TOKEN_REQUIRED');
  const started = performance.now();
  const known = new Set((options.knownReceiptIds || []).map((id) => id.trim()).filter(Boolean));
  const receipts = new Map<string, Receipt>();
  const warnings: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = '';
  let pages = 0;
  let incomplete = false;
  let invalidReceipts = 0;
  while (cursor !== null && pages < MAX_PAGES) {
    options.signal?.throwIfAborted();
    if (cursors.has(cursor)) { incomplete = true; warnings.push('Wildberries: повторилась страница чеков; история получена не полностью.'); break; }
    cursors.add(cursor);
    const url = new URL(LIST_URL);
    url.searchParams.set('receiptsPerPage', String(PAGE_SIZE));
    url.searchParams.set('nextReceiptUid', cursor);
    const response = await options.fetch(url, { signal: options.signal, headers: { accept: 'application/json', authorization: `Bearer ${options.token}` } });
    if (!response.ok) throw new Error(`WB_LIST_HTTP_${response.status}`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error('WB_LIST_NON_JSON'); }
    const page = normalizeReceiptList(payload);
    pages += 1;
    for (const raw of page.receipts) {
      const receipt = receiptFromUnknown(raw);
      if (!receipt) invalidReceipts++;
      if (receipt && !receipts.has(receipt.id)) receipts.set(receipt.id, receipt);
    }
    if (receipts.size > MAX_ROWS) { const error = new Error('ROW_LIMIT_EXCEEDED'); (error as Error & { code: string }).code = 'ROW_LIMIT_EXCEEDED'; throw error; }
    await options.onProgress?.({ done: pages, total: MAX_PAGES, message: `Wildberries: найдено чеков ${receipts.size}.` });
    cursor = page.nextReceiptUid;
  }
  if (pages >= MAX_PAGES && cursor) { incomplete = true; warnings.push('Wildberries: достигнут лимит страниц чеков.'); }
  if (invalidReceipts) { incomplete = true; warnings.push(`Wildberries: не распознаны ссылки на ${invalidReceipts} чеков.`); }
  const pending = [...receipts.values()].filter(receipt => !known.has(receipt.id));
  const documentsStarted = performance.now();
  const rows: Purchase[] = [];
  const fiscalPayments: NonNullable<CollectionResult['fiscalPayments']> = [];
  let failedReceipts = 0;
  let processed = 0;
  let lastProgressAt = documentsStarted, receiptProgressUpdates = 0;
  for (const receipt of pending) {
    options.signal?.throwIfAborted();
    try {
      const parsed = new URL(receipt.url);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'receipt.wb.ru' || parsed.username || parsed.password) throw new Error('WB_RECEIPT_URL_FORBIDDEN');
      const response = await options.fetch(receipt.url, { signal: options.signal, headers: { accept: 'text/html' } });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      if (response.url && new URL(response.url).origin !== 'https://receipt.wb.ru') throw new Error('WB_RECEIPT_REDIRECT');
      const html = await response.text();
      if (html.length > 8 * 1024 * 1024) throw new Error('WB_RECEIPT_SIZE');
      const items = parseReceiptHtml(html, receipt);
      if (!items.length || items.some(row => !row.date)) throw new Error('WB_RECEIPT_EMPTY');
      rows.push(...items);
      const payment = readWildberriesPayment(html, items[0]!.date, items[0]!.currency || 'RUB');
      if (payment) fiscalPayments.push(payment);
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError' || options.signal?.aborted) throw error;
      failedReceipts += 1;
    }
    processed++;
    const now = performance.now();
    if (options.onProgress && (processed === 1 || processed === pending.length || now - lastProgressAt >= 1000)) {
      lastProgressAt = now;
      receiptProgressUpdates++;
      await options.onProgress({ done: processed, total: pending.length, message: `Wildberries: обработано ${processed} из ${pending.length} чеков.` });
    }
    if (rows.length > MAX_ROWS) { const error = new Error('ROW_LIMIT_EXCEEDED'); (error as Error & { code: string }).code = 'ROW_LIMIT_EXCEEDED'; throw error; }
  }
  if (failedReceipts) warnings.push(`Wildberries: не удалось прочитать ${failedReceipts} чеков. Ранее сохранённая история остаётся.`);
  if (!rows.length && (failedReceipts || invalidReceipts) && !known.size) throw new Error(warnings.at(-1));
  const qualityCount = (quality: string) => new Set(rows.filter(row => row.parse_quality === quality).map(row => row.marketplace_id)).size;
  const fallbackReceipts = qualityCount('fallback'), unverifiedReceipts = qualityCount('unverified');
  const finished = performance.now();
  return { rows, fiscalPayments, warnings, stats: {
    receipts: receipts.size, pages, failedReceipts, invalidReceipts, skippedKnown: known.size > 0, incomplete,
    itemRows: rows.length, fallbackReceipts, unverifiedReceipts, receiptProgressUpdates,
    listingElapsedMs: Math.round(documentsStarted - started), receiptFetchElapsedMs: Math.round(finished - documentsStarted),
    elapsedMs: Math.round(finished - started),
  } };
}
