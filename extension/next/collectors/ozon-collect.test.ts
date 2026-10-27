import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOzon, ozonList } from './ozon-collect.ts';
import { sourceHealth, mergeCollection, summarize } from '../domain.mjs';
import { Worker } from 'node:worker_threads';
const page = (ids: string[], nextPage = '') => JSON.stringify({ widgetStates: { checks: JSON.stringify({ cheques: ids.map(id => ({ link: `/_action/downloadCheque?id=${id}` })) }) }, nextPage });
const readPdf = async () => '01.01.2026 10:00\n1. Товар\n≡ 100,00\nИТОГ ≡ 100,00';

test('Ozon marks parsed PDF items without a receipt total as partial', async () => {
  const result = await collectOzon({
    fetch: async input => new Response(String(input).includes('downloadCheque') ? 'pdf' : page(['private-id'])),
    readPdf: async () => '01.01.2026 10:00\n1. Товар\n≡ 100,00\n2. Другой товар\n≡ 50,00'
  });
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every(row => row.parse_quality === 'unverified'));
  assert.equal(result.stats.unverifiedReceipts, 1);
  assert.equal(result.stats.failedReceipts, 0);
  assert.equal(result.stats.incomplete, true);
  assert.ok(result.warnings.some(text => text.startsWith('Ozon:') && text.includes('не распознан итог')));
  assert.doesNotMatch(result.warnings.join(' '), /private-id|downloadCheque/);
  assert.equal(sourceHealth('ozon', { collection: { stats: { ozon: result.stats }, warnings: result.warnings } }).state, 'partial');
});

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

test('unknown terminal list responses identify each section without declaring the history complete', async () => {
  const result = await collectOzon({ fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname.includes('downloadCheque')) return new Response('pdf');
    if (url.pathname.includes('entrypoint')) return new Response(JSON.stringify({ unexpected: 'private-token' }));
    return new Response(page(['a'], `/my/e-check?page=2${url.searchParams.has('archive') ? '&archive=1' : ''}`));
  }, readPdf });
  assert.equal(result.stats.incomplete, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0]!, /текущие чеки, страница 2/);
  assert.match(result.warnings[1]!, /архив, страница 2/);
  assert.doesNotMatch(result.warnings.join(' '), /проверьте вход|private-token/);
});

test('unknown Ozon responses expose only structural counters, never response contents', async () => {
  const secret = 'private-response-token-and-receipt';
  for (const empty of [false, true]) {
    const result = await collectOzon({ fetch: async input => {
      const url = new URL(String(input));
      if (url.pathname.includes('downloadCheque')) return new Response('pdf');
      if (!url.pathname.includes('entrypoint')) return new Response(page(['a'], `/my/e-check?page=2${url.searchParams.has('archive') ? '&archive=1' : ''}`));
      if (empty) return new Response('');
      const archive = new URL(url.searchParams.get('url')!, 'https://www.ozon.ru').searchParams.has('archive');
      return new Response(archive ? `<html><body>${secret}</body></html>` : JSON.stringify({ widgetStates: {}, error: { message: secret } }));
    }, readPdf });
    assert.equal(result.rows.length, 1);
    assert.equal(result.stats.incomplete, true);
    assert.equal(result.stats.unrecognizedListResponses, 2);
    assert.equal(result.stats.unrecognizedListJsonResponses, empty ? 0 : 1);
    assert.equal(result.stats.unrecognizedListHtmlResponses, empty ? 0 : 1);
    assert.equal(result.stats.unrecognizedListEmptyResponses, empty ? 2 : 0);
    assert.equal(result.stats.unrecognizedListErrorResponses, empty ? 0 : 1);
    assert.equal(result.stats.unrecognizedListWidgetResponses, empty ? 0 : 1);
    assert.equal(result.stats.unrecognizedListEmptyWidgets, empty ? 0 : 1);
    assert.equal(result.stats.failedCurrentListPage, 2);
    assert.equal(result.stats.failedArchiveListPage, 2);
    assert.ok(Object.values(result.stats).every(value => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))));
    assert.doesNotMatch(JSON.stringify({ stats: result.stats, warnings: result.warnings }), new RegExp(secret));
  }
});

test('Ozon accepts the observed metadata-only end only after a matching content page', async () => {
  const metadata = {
    browser: {}, client: {}, layoutTrackingInfo: '', location: {}, seo: {}, userInfo: { authenticated: true, label: 'private-user' }, shared: '', segments: [],
    pageInfo: { url: '/my/e-check', layoutId: 1, layoutVersion: 2, pageType: 'checks', ruleId: 3, pageTypeTracking: 'checks' },
    pageToken: 'private-cursor', serverTiming: [], userToken: 'private-token', experimentsConfig: {}, requestID: 'private-request', verticalInfo: {}, resolveParams: {}, isPrefetched: false,
  };
  const invalidEnds = [
    { pageInfo: { ...metadata.pageInfo, pageType: 'login' } },
    { pageInfo: { ...metadata.pageInfo, url: 'https://example.test/my/e-check' } },
    { pageInfo: { ...metadata.pageInfo, layoutVersion: 999 } },
    { isPrefetched: true }, { userInfo: null }, { userInfo: {} }, { userInfo: { authenticated: false } }, { unexpected: true }, { widgetStates: {} }, { error: true },
  ];
  for (const invalid of [null, ...invalidEnds]) {
    const result = await collectOzon({ fetch: async input => {
      const url = new URL(String(input));
      if (url.pathname.includes('downloadCheque')) return new Response('pdf');
      if (url.pathname.includes('entrypoint')) return new Response(JSON.stringify({ ...metadata, ...invalid }));
      return new Response(JSON.stringify({ ...metadata, ...JSON.parse(page(['a'], '/my/e-check?page=2')), layout: [] }));
    }, readPdf });
    assert.equal(result.rows.length, 1);
    assert.equal(result.stats.incomplete, invalid !== null);
    assert.equal(result.stats.metadataListEnds, invalid === null ? 2 : 0);
    assert.equal(result.stats.unrecognizedListResponses, invalid === null ? 0 : 2);
    assert.doesNotMatch(JSON.stringify({ stats: result.stats, warnings: result.warnings }), /private-cursor|private-token|private-request|private-user/);
  }
  await assert.rejects(collectOzon({ fetch: async () => new Response(JSON.stringify(metadata)), readPdf }), /не полностью/);
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

test('Ozon passes raw receipt pairs to persisted reconciliation across batches', async () => {
  const pre = 'ORDER-12345678-1234-1234-1234-123456789abc';
  const final = 'ORDER-22345678-1234-1234-1234-123456789abc';
  const batch = (ids: string[]) => collectOzon({
    fetch: async input => new Response(String(input).includes('downloadCheque') ? String(input) : page(ids)),
    readPdf: async bytes => {
      const kind = new TextDecoder().decode(bytes).includes(pre) ? 'ПРЕДОПЛАТА' : 'ПОЛНЫЙ РАСЧЕТ';
      return `01.01.2026 10:00\n${kind}\n1. Товар\n≡ 100,00\nИТОГ ≡ 100,00`;
    }
  });
  const pair = await batch([pre, final]);
  assert.equal(pair.rows.length, 2);
  assert.equal(pair.stats.removed, 0);
  const first = await batch([pre]), second = await batch([final]);
  const merged = mergeCollection(first.rows, second.rows, { source: 'ozon', processedReceipts: second.processedReceipts });
  assert.equal(merged.length, 1);
  assert.equal(summarize(merged).net, 10000);
  assert.equal(mergeCollection(merged, pair.rows, { source: 'ozon', processedReceipts: pair.processedReceipts }).length, 1);
});
