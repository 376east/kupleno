// @ts-ignore Node test types are intentionally not part of the extension bundle.
import assert from 'node:assert/strict';
// @ts-ignore Node test types are intentionally not part of the extension bundle.
import test from 'node:test';
import { collectWildberries, normalizeReceiptList, parseReceiptHtml } from './wildberries.ts';
import { rowId } from '../preferences.mjs';
import { sourceHealth } from '../domain.mjs';

const receipt = { id: 'r-1', url: 'https://receipt.wb.ru/r-1', date: '2026-09-14T10:00:00Z', operationSum: 100, operationTypeId: 1 };
const item = (title: string, price: string) => `<div class="products-item"><div class="products-cell products-cell_name"><div class="products-prop-value">Наименование ${title}</div></div><div class="products-cell products-cell_price"></div><div class="products-cell products-cell_cost"><div class="products-prop-value">${price}</div></div></div>`;

test('normalizes known receipt envelopes and rejects unknown HTTP 200 payloads', () => {
  assert.deepEqual(normalizeReceiptList({ data: { GetReceiptsV4V1: { data: { receipts: [], nextReceiptUID: 'next' } } } }), { receipts: [], nextReceiptUid: 'next' });
  assert.throws(() => normalizeReceiptList({ error: 'token expired', token: 'secret', email: 'person@example.test' }), (error: unknown) => {
    const message = String((error as Error).message);
    return /WB_LIST_UNKNOWN_PAYLOAD shape=\{error:string,token:string,email:string\}/.test(message) && !message.includes('secret') && !message.includes('person@');
  });
});

test('parses zero-price items and keeps a total mismatch as one fallback', () => {
  const complete = parseReceiptHtml(`<h2>Кассовый чек</h2>Приход${item('Товар', '100,00 ₽')}${item('Подарок', '0,00 ₽')}<div class="total"></div>`, receipt);
  assert.equal(complete.length, 2);
  assert.equal(complete[1]?.amount, '0.00');
  assert.equal(complete[0]?.title, 'Товар');
  assert.equal(complete[0]?.rowId, rowId({ ...complete[0]!, rowId: '' }));
  const mismatch = parseReceiptHtml(`<h2>Кассовый чек</h2>Приход${item('Товар', '90,00 ₽')}<div class="total"></div>`, receipt);
  assert.equal(mismatch.length, 1);
  assert.equal(mismatch[0]?.parse_quality, 'fallback');
  assert.match(String(mismatch[0]?.raw_title), /receipt_total_mismatch/);
  assert.deepEqual(parseReceiptHtml('<h2>Кассовый чек</h2>Приход<div class="total"></div>', { id: 'no-sum', url: receipt.url }), []);
});

test('collects two API pages and retains success when one receipt fails', async () => {
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('https://astro.wildberries.ru/')) {
      return new Response(url.includes('nextReceiptUid=cursor-2')
        ? JSON.stringify({ data: { receipts: [{ receiptUid: 'r-2', link: 'https://receipt.wb.ru/r-2', operationSum: 20 }] } })
        : JSON.stringify({ data: { receipts: [{ receiptUid: 'r-1', link: 'https://receipt.wb.ru/r-1', operationSum: 100, operationDateTime: receipt.date }], nextReceiptUid: 'cursor-2' } }), { status: 200 });
    }
    if (url.endsWith('/r-1')) return new Response(`<h2>Кассовый чек</h2>Приход${item('Товар', '100,00 ₽')}<div class="total"></div>`);
    return new Response('', { status: 503 });
  };
  const result = await collectWildberries({ fetch: fakeFetch, token: 'test-token' });
  assert.equal(result.rows.length, 1);
  assert.equal(result.stats.failedReceipts, 1);
  assert.equal(result.stats.incomplete, false);
  assert.equal(requests.filter((url) => url.startsWith('https://astro.wildberries.ru/')).length, 2);
  assert.equal(sourceHealth('wildberries', { collection: { stats: { wildberries: result.stats }, warnings: result.warnings } }).state, 'partial');
});

test('empty end, repeated cursor, list failure, missing document and cancellation stay distinct', async () => {
  const empty = await collectWildberries({ token: 'synthetic', fetch: async () => new Response(JSON.stringify({ receipts: [] })) });
  assert.equal(empty.stats.incomplete, false); assert.equal(empty.rows.length, 0); assert.deepEqual(empty.warnings, []);
  let pages = 0;
  const repeated = await collectWildberries({ token: 'synthetic', fetch: async () => {
    pages++; return new Response(JSON.stringify({ receipts: [], nextReceiptUid: 'same' }));
  } });
  assert.equal(pages, 2); assert.equal(repeated.stats.incomplete, true); assert.match(repeated.warnings.join(' '), /повторилась страница/);
  await assert.rejects(collectWildberries({ token: 'synthetic', fetch: async () => new Response('', { status: 503 }) }), /WB_LIST_HTTP_503/);
  await assert.rejects(collectWildberries({ token: 'synthetic', fetch: async () => new Response(JSON.stringify({ receipts: [{ receiptUid: 'missing' }] })) }), /не распознаны ссылки/);
  const controller = new AbortController(); controller.abort(new DOMException('synthetic cancel', 'AbortError'));
  let requests = 0;
  await assert.rejects(collectWildberries({ token: 'synthetic', signal: controller.signal, fetch: async () => { requests++; return new Response(); } }), { name: 'AbortError' });
  assert.equal(requests, 0);
});

test('reports measured document stages and keeps first and final progress with skipped and failed receipts', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const ids = ['known', 'a', 'b', 'c', 'd'];
  const progress: Array<[number, number]> = [];
  const result = await collectWildberries({
    token: 'fixture-only', knownReceiptIds: ['known'],
    fetch: async input => {
      const url = new URL(String(input));
      if (url.hostname === 'astro.wildberries.ru') {
        now += 20;
        return Response.json({ receipts: ids.map(id => ({ receiptUid: id, link: `https://receipt.wb.ru/${id}`, operationSum: 100, operationDateTime: receipt.date })) });
      }
      assert.notEqual(url.pathname, '/known');
      now += 400;
      return url.pathname === '/c' ? new Response('', { status: 503 }) : new Response(`<h2>Кассовый чек</h2>Приход${item('Товар', '100,00 ₽')}<div class="total"></div>`);
    },
    onProgress: update => { if (!update.message.includes('найдено')) progress.push([update.done, update.total]); },
  });
  assert.deepEqual(progress, [[1, 4], [4, 4]]);
  assert.equal(result.stats.receiptProgressUpdates, 2);
  assert.equal(result.stats.listingElapsedMs, 20);
  assert.equal(result.stats.receiptFetchElapsedMs, 1600);
  assert.equal(result.stats.elapsedMs, 1620);
  assert.equal(result.stats.failedReceipts, 1);
  assert.equal(result.rows.length, 3);
});

test('stops at the first receipt rate limit and retains any receipts already read', async () => {
  const field = (label: string, value: string) => `<div class="property-name">${label}</div><div class="property-value">${value}</div>`;
  const document = '<h2>Кассовый чек</h2><div class="check-header-column first">Приход<br></div>'
    + item('Товар', '100,00 ₽') + '<div class="total">'
    + field('Итого', '100.00') + field('Электронными', '25.00') + field('Аванс', '75.00')
    + field('№ ФН', '101') + field('№ ФД', '202') + field('ФПД', '303') + '</div>';
  const receipts = Array.from({ length: 46 }, (_, index) => ({
    receiptUid: String(index), link: `https://receipt.wb.ru/${index}`, operationSum: 100, operationDateTime: receipt.date,
  }));
  for (const limitAt of [1, 2]) {
    let requests = 0;
    const fetch: typeof globalThis.fetch = async input => {
      if (new URL(String(input)).hostname === 'astro.wildberries.ru') return Response.json({ receipts });
      if (++requests >= limitAt) return new Response('private response body', { status: 429 });
      return new Response(document);
    };
    const result = collectWildberries({ fetch, token: 'fixture-only' });
    if (limitAt === 1) await assert.rejects(result, { message: 'WB_RECEIPT_HTTP_429' });
    else {
      const partial = await result;
      assert.equal(partial.rows.length, 1);
      assert.deepEqual(partial.fiscalPayments, [{ id: '101:202:303', date: '2026-09-14 10:00', paid: 2500, advance: 7500 }]);
      assert.equal(partial.stats.incomplete, true);
      assert.equal(partial.stats.failedReceipts, 1);
      assert.equal(partial.stats.wbReceiptHttpStatus, 429);
      assert.equal(partial.stats.skippedDueToRateLimit, 44);
      assert.equal(partial.warnings.length, 1);
      assert.match(partial.warnings[0]!, /временно ограничил запросы/);
    }
    assert.equal(requests, limitAt);
  }
});
