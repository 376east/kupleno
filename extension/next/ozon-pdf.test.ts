import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOzonPdf } from './worker/ozon-pdf.ts';
const url = 'https://www.ozon.ru/_action/downloadCheque?id=test';
test('background PDF preserves bytes, cookie mode and HTTP denial', async () => {
  const bytes = new Uint8Array(100000).map((_, i) => i % 256);
  const result = await fetchOzonPdf(url, async (input, init) => {
    assert.equal(input, url); assert.equal(init?.credentials, 'include');
    return new Response(bytes);
  });
  assert.deepEqual(Uint8Array.from(atob(result.text), c => c.charCodeAt(0)), bytes);
  assert.equal((await fetchOzonPdf(url, async () => new Response('', { status: 403 }))).status, 403);
});
test('background PDF bounds size and reports network failure', async () => {
  assert.equal((await fetchOzonPdf(url, async () => new Response('', { headers: { 'content-length': '30000000' } }))).status, 413);
  const result = await fetchOzonPdf(url, async () => { throw new TypeError('private request URL'); });
  assert.equal(result.status, 502); assert.doesNotMatch(result.error, /private/);
});
