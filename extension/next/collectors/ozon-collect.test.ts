import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOzon, ozonList } from './ozon-collect.ts';
import { Worker } from 'node:worker_threads';
const page = (ids: string[], nextPage = '') => JSON.stringify({ widgetStates: { checks: JSON.stringify({ cheques: ids.map(id => ({ link: `/_action/downloadCheque?id=${id}` })) }) }, nextPage });
const readPdf = async () => '01.01.2026 10:00\n1. Товар\n≡ 100,00\nИТОГ ≡ 100,00';

test('escaped Ozon receipt URLs retain PDF flags when found repeatedly', () => {
  const encoded = String.raw`<script>{"cheques":[{"link":"\u002f_action\u002fdownloadCheque\u003fid\u003dabc\u0026rawdata\u003d1\u0026download\u003d1"}]}</script><a href="/_action/downloadCheque?id=abc">Receipt</a>`;
  const found=ozonList(encoded);
  assert.equal(found.records.length,1);
  const url=new URL(found.records[0]!.url);
  assert.equal(url.searchParams.get('rawdata'),'1'); assert.equal(url.searchParams.get('download'),'1');
});

test('systemic PDF transport failure stops after three attempts', async () => {
  let pdfRequests=0;
  await assert.rejects(collectOzon({fetch:async input=>{
    if(String(input).includes('downloadCheque')) { pdfRequests++; throw new Error('Ozon: ошибка получения PDF (запрос, TypeError).'); }
    return new Response(page(['a','b','c','d','e']));
  },readPdf}),/три запроса PDF/);
  assert.equal(pdfRequests,3);
});

test('403 stops collection without repeating denied list or PDF requests', async () => {
  let calls=0;
  await assert.rejects(collectOzon({fetch:async()=>{calls++;return new Response('',{status:403});},readPdf}),/списку чеков \(HTTP 403\)/);
  assert.equal(calls,1);
  calls=0;
  await assert.rejects(collectOzon({fetch:async input=>{
    if(String(input).includes('downloadCheque')){calls++;return new Response('',{status:403});}
    return new Response(page(['a','b','c']));
  },readPdf}),/PDF \(HTTP 403\)/);
  assert.equal(calls,1);
});

test('large inline payload cannot block receipt link scanning', async () => {
  const moduleUrl = new URL('./ozon-collect.ts', import.meta.url).href;
  const result = await new Promise<number>((resolve,reject) => {
    const worker = new Worker(`const {parentPort}=require('node:worker_threads'); import(${JSON.stringify(moduleUrl)}).then(({ozonList})=>{const page='<script>'+ '/'.repeat(300000) +'</script><a href="/_action/downloadCheque?id=test">Receipt</a>'; parentPort.postMessage(ozonList(page).records.length);});`, {eval:true,execArgv:[]});
    const timer=setTimeout(()=>{void worker.terminate();reject(new Error('Receipt scanner blocked'));},3000);
    worker.once('message',count=>{clearTimeout(timer);resolve(count);});
    worker.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  assert.equal(result,1);
});

test('non-responsive tab fails once without repeating the same timeout for archive', async () => {
  let calls=0;
  await assert.rejects(collectOzon({fetch:async()=>{calls++;throw new Error('Вкладка Ozon не ответила за 30 секунд.');},readPdf}),/не ответила/);
  assert.equal(calls,1);
});
test('Ozon paginates embedded widgets and deduplicates current/archive receipts', async () => {
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async input => {
    const url = new URL(String(input)); requests.push(url.href);
    if (url.pathname.includes('downloadCheque')) return new Response(new Uint8Array([1]));
    if (url.pathname.includes('entrypoint')) { assert.equal(url.searchParams.get('url'), '/my/e-check?page=2'); return new Response(page(['b'])); }
    return new Response(url.searchParams.has('archive') ? page(['b', 'c']) : page(['a'], '/my/e-check?page=2'));
  };
  const result = await collectOzon({ fetch, readPdf });
  assert.equal(result.rows.length, 3); assert.equal(result.stats.receipts, 3); assert.equal(result.stats.pages, 3);
  assert.equal(requests.filter(url => url.includes('downloadCheque')).length, 3); assert.deepEqual(result.warnings, []);
});
test('Ozon retains parsed receipts and reports partial PDF failure', async () => {
  const fetch: typeof globalThis.fetch = async input => String(input).includes('downloadCheque') ? new Response(new Uint8Array([1]), { status: String(input).endsWith('b') ? 500 : 200 }) : new Response(page(['a', 'b']));
  const result = await collectOzon({ fetch, readPdf });
  assert.equal(result.rows.length, 1); assert.equal(result.stats.failedReceipts, 1); assert.ok(result.warnings.some(text => text.includes('HTTP 500: 1')));
});
test('Ozon distinguishes known empty history from login and all-PDF failure', async () => {
  assert.equal((await collectOzon({ fetch: async () => new Response(page([])), readPdf })).rows.length, 0);
  await assert.rejects(collectOzon({ fetch: async () => new Response('<html>Войти</html>'), readPdf }), /не полностью/);
  await assert.rejects(collectOzon({ fetch: async input => new Response(String(input).includes('downloadCheque') ? '' : page(['a'])), readPdf: async () => '' }), /не удалось прочитать/);
  assert.equal(ozonList(page(['a'])).records.length, 1);
});
test('Ozon stops cycles and does not fetch external next-page URLs', async () => {
  let external = false;
  const result = await collectOzon({ fetch: async input => {
    const url = new URL(String(input)); external ||= url.hostname === 'evil.test';
    if (url.pathname.includes('downloadCheque')) return new Response('pdf');
    return new Response(page(['a'], url.searchParams.has('archive') ? 'https://evil.test/my/e-check' : '/my/e-check?page=2'));
  }, readPdf });
  assert.equal(external, false); assert.equal(result.stats.incomplete, true); assert.equal(result.rows.length, 1);
});

test('Ozon reports the failure stage without leaking receipt URLs or contents', async () => {
  const fetch: typeof globalThis.fetch = async input => new Response(String(input).includes('downloadCheque') ? '' : page(['private-receipt-id']));
  await assert.rejects(collectOzon({ fetch, readPdf: async () => '1. Товар 100,00 ₽\nИТОГ 100,00' }), /Дата в PDF не распознана: 1/);
  await assert.rejects(collectOzon({ fetch, readPdf: async () => { throw new Error('https://private.test/receipt-secret'); } }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Ошибка PDF \(Error\): 1/);
    assert.doesNotMatch(error.message, /private|secret/);
    return true;
  });
});
