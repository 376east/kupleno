const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { receiptPdf } = require('./next-browser-smoke.cjs');

async function yandexDocumentReasons() {
  const { readYandexOrderDocuments } = await import('../extension/next/worker/yandex-order-documents.ts');
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? undefined : 'chromium', executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true });
  try {
    const page = await browser.newPage();
    const expectedUrl = 'https://market.yandex.ru/my/order/123456';
    await page.route(expectedUrl, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body></body></html>' }));
    await page.goto(expectedUrl);
    const button = '<button id="docs">Чеки и другие документы</button>';
    const dialog = body => `<div role="dialog"><h2>Документы по заказу</h2>${body}</div>`;
    let mode = '', reads = 0, closed = 0, opened = 0, released = 0;
    const api = {
      tabs: {
        create: async () => ({ id: 1 }),
        get: async () => { if (mode === 'request') throw new Error('https://private.test/secret'); return { id: 1, url: expectedUrl, status: mode === 'navigation' ? 'loading' : 'complete' }; },
        remove: async () => { closed++; },
      },
      scripting: { executeScript: async ({ func, args }) => {
        if (args[1] === 'read' && mode === 'deadline' && ++reads === 2) return new Promise(() => {});
        if (args[1] === 'read' && mode === 'latest' && ++reads === 2) await page.setContent(button + dialog('<p>Ошибка загрузки документов</p>'));
        return [{ result: await page.evaluate(({ source, args }) => new Function(`return (${source})`)()(...args), { source: func.toString(), args }) }];
      } },
    };
    const options = { browser: api, timeoutMs: 650, isCurrent: () => true, onOpened: async () => { opened++; }, onReleased: async () => { released++; } };
    for (const [reason, body] of [
      ['navigation', ''], ['button', ''], ['dialog', button],
      ['loading', button + dialog('<progress></progress>')],
      ['error', button + dialog('<p>Ошибка загрузки документов</p>')],
      ['unrecognized', button + dialog('<p>Неизвестный ответ secret</p>')],
      ['latest', button + dialog('<progress></progress>')], ['deadline', button + dialog('<progress></progress>')], ['request', ''],
    ]) {
      mode = reason; reads = 0;
      await page.setContent(body);
      const result = await readYandexOrderDocuments('123456', options);
      assert.deepEqual(result, { urls: [], complete: false, blocked: false, failureReason: reason === 'latest' ? 'error' : reason === 'deadline' ? 'loading' : reason });
    }
    mode = 'loading';
    await page.setContent(button + dialog('<progress></progress>'));
    const controller = new AbortController();
    const cancelTimer = setTimeout(() => controller.abort(), 150);
    try { assert.deepEqual(await readYandexOrderDocuments('123456', { ...options, signal: controller.signal }), { urls: [], complete: false, blocked: false }); }
    finally { clearTimeout(cancelTimer); }
    mode = 'complete';
    await page.setContent(button + dialog('<a href="https://check.yandex.ru/doc">Чек</a>'));
    assert.deepEqual(await readYandexOrderDocuments('123456', options), { urls: ['https://check.yandex.ru/doc'], complete: true, blocked: false });
    assert.equal(opened, 11); assert.equal(released, 10, 'Unavailable inspection retains durable ownership');
    assert.equal(closed, 9, 'Navigation-incomplete and unavailable-inspection tabs retain original safe cleanup behavior');
    console.log('PASS: Yandex document navigation/button/dialog/loading/error/unrecognized/request reasons; latest state retained; cancellation and success omit reason. Synthetic DOM only.');
  } finally { await browser.close(); }
}

async function main() {
  if (process.argv.includes('--yandex-document-reasons')) return yandexDocumentReasons();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kupleno-collect-test-'));
  const build = path.join(root, 'extension');
  await fs.cp(path.resolve(__dirname, '../extension/next/.output/chrome-mv3'), build, { recursive: true });
  // Pregrant hosts only in the disposable synthetic test extension. Shipping manifest remains optional.
  const manifest = JSON.parse(await fs.readFile(path.join(build, 'manifest.json'), 'utf8'));
  manifest.host_permissions = manifest.optional_host_permissions;
  manifest.permissions.push('cookies');
  await fs.writeFile(path.join(build, 'manifest.json'), JSON.stringify(manifest));
  // Attach Playwright's synthetic routes before a worker-created tab starts its store navigation.
  await fs.writeFile(path.join(build, 'test-tabs.js'), `
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type !== 'KUPLENO_TEST_RECEIPT_CACHE') return;
    if (message.action === 'started') chrome.storage.local.set({ 'synthetic-fiscal-fetch-started': true }).then(() => reply({ ok: true }));
    else chrome.storage.local.get(['synthetic-cache-api-fail', 'synthetic-fiscal-fetch-hold', 'synthetic-fiscal-fetch-forbidden', 'synthetic-fiscal-fetch-malformed']).then(reply);
    return true;
  });
  const createTab = chrome.tabs.create.bind(chrome.tabs);
  globalThis.testTabReady = new Map();
  chrome.tabs.create = async properties => {
    if (!['https://www.ozon.ru/my/e-check?archive=1', 'https://www.wildberries.ru/lk/receipts/get', 'https://market.yandex.ru/my/orders?filter=COMPLETED'].includes(properties.url) && !new RegExp('^https://market[.]yandex[.]ru/my/order/[1-9][0-9]*$').test(properties.url)) return createTab(properties);
    const marker = crypto.randomUUID();
    let timer;
    const ready = new Promise((resolve, reject) => {
      globalThis.testTabReady.set(marker, resolve);
      timer = setTimeout(() => reject(new Error('Synthetic tab was not attached.')), 15000);
    });
    try {
      const tab = await createTab({ ...properties, url: 'about:blank#kupleno-fixture=' + marker });
      await ready;
      return await chrome.tabs.update(tab.id, { url: properties.url });
    } finally { clearTimeout(timer); globalThis.testTabReady.delete(marker); }
  };`);
  const backgroundPath = path.join(build, manifest.background.service_worker);
  await fs.writeFile(backgroundPath, "importScripts('./test-tabs.js');\n" + await fs.readFile(backgroundPath, 'utf8'));
  const pdf = receiptPdf('BT /F1 16 Tf 40 750 Td (01.01.2026 10:00) Tj 0 -24 Td (1. Book 100.00) Tj ET');
  // Chromium offscreen targets are not intercepted by Playwright context.route.
  // Only the disposable copy gets a local network fixture, loaded before the unchanged production module.
  await fs.writeFile(path.join(build, 'test-fixtures.js'), `
  const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
  let ozonFinished = 0;
  let yandexOrderValidated = false;
  let yandexReferencesValidated = false;
  chrome.runtime.sendMessage = (...args) => {
    const message = args[0];
    if (message?.type === 'KUPLENO_OFFSCREEN_EVENT' && message.action === 'finished' && message.result?.unresolvedOrderIds?.length && !yandexReferencesValidated) {
      yandexReferencesValidated = true;
      const probes = (async () => {
        for (const field of ['unresolvedOrderIds', 'failedDocumentOrderIds', 'failedReceiptOrderIds']) {
          for (const ids of [['https://check.yandex.ru/not-an-order'], ['0'], new Array(1001).fill('123456')]) {
            const response = await sendMessage({ ...message, result: { ...message.result, [field]: ids } });
            if (response?.ok !== false) throw new Error('Invalid synthetic order references were accepted.');
          }
        }
      })();
      const callback = args.at(-1);
      if (typeof callback === 'function') { void probes.then(() => sendMessage(...args), () => callback({ ok: false })); return; }
      return probes.then(() => sendMessage(...args));
    }
    if (message?.type === 'KUPLENO_YANDEX_REQUEST' && !yandexOrderValidated && new URL(message.url).searchParams.get('r').includes('resolveOrderReceiptsByOrderId')) {
      yandexOrderValidated = true;
      const request = JSON.parse(message.body), first = request.params[0];
      const invalid = [
        { ...request, params: Array.from({ length: 9 }, (_, index) => ({ ...first, orderId: first.orderId + index })) },
        { ...request, params: [{ ...first, orderId: 'invalid' }] },
        { ...request, path: '/my/orders?filter=COMPLETED' },
        { ...request, path: '/my/order/' + (first.orderId + 1) },
        { ...request, params: [{ ...first, orderId: first.orderId + 1 }] },
        { ...request, params: [first, { ...first, orderId: first.orderId + 1, extra: true }] },
        { ...request, params: [first, first] },
        { ...request, params: [first, { ...first, orderId: first.orderId + 1, archived: !first.archived }] },
      ].map(body => ({ ...message, body: JSON.stringify(body) }));
      const paginationUrl = new URL(message.url);
      paginationUrl.searchParams.set('r', 'src/resolvers/orders/resolveConsolidationOrders:resolveConsolidationOrders');
      invalid.push({ ...message, url: paginationUrl.href, body: JSON.stringify({ ...request, path: '/my/orders?filter=COMPLETED', params: [{ filter: 'COMPLETED', size: 18 }, { filter: 'COMPLETED', size: 18 }] }) });
      for (const headerContext of [{ sk: 'invalid' + String.fromCharCode(13, 10) + 'header' }, { sk: 'x'.repeat(2001) }, { authorization: 'synthetic-secret' }, { sk: 123 }, []]) invalid.push({ ...message, headerContext });
      const probes = (async () => {
        for (const probe of invalid) {
          const response = await sendMessage(probe);
          if (response?.ok !== false) throw new Error('Invalid synthetic Yandex order request was accepted.');
        }
      })();
      const callback = args.at(-1);
      if (typeof callback === 'function') { void probes.then(() => sendMessage(...args), () => callback({ ok: false, error: 'Yandex order validation failed.' })); return; }
      return probes.then(() => sendMessage(...args));
    }
    if (message?.type === 'KUPLENO_OFFSCREEN_EVENT' && message.action === 'finished' && message.result?.rows?.[0]?.source === 'ozon' && ++ozonFinished === 2) {
      // Deliver and persist the result, but lose its acknowledgement in transit.
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        args[args.length - 1] = () => callback(undefined);
        return sendMessage(...args);
      }
      return sendMessage(...args).then(() => undefined);
    }
    if (message?.type === 'KUPLENO_YANDEX_REQUEST' && typeof args.at(-1) !== 'function') return sendMessage(...args).then(response => {
      if (response && Object.hasOwn(response, 'challengeUrl')) throw new Error('Transient challenge URL escaped the provider.');
      return response;
    });
    return sendMessage(...args);
  };
  const cacheOpen = CacheStorage.prototype.open, cacheMatch = Cache.prototype.match, cachePut = Cache.prototype.put;
  const cacheFlags = () => chrome.runtime.sendMessage({ type: 'KUPLENO_TEST_RECEIPT_CACHE', action: 'flags' });
  const failCache = async () => (await cacheFlags())['synthetic-cache-api-fail'];
  CacheStorage.prototype.open = async function(...args) { if (await failCache()) throw new Error('Synthetic cache API unavailable'); return cacheOpen.apply(this,args); };
  Cache.prototype.match = async function(...args) { if (await failCache()) throw new Error('Synthetic cache API unavailable'); return cacheMatch.apply(this,args); };
  Cache.prototype.put = async function(...args) { if (await failCache()) throw new Error('Synthetic cache API unavailable'); return cachePut.apply(this,args); };
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'market.yandex.ru' && url.pathname === '/my/orders') throw new Error('Offscreen must not refetch the owned tab seed.');
    if (url.hostname === 'check.yandex.ru') {
      await chrome.runtime.sendMessage({ type: 'KUPLENO_TEST_RECEIPT_CACHE', action: 'started' });
      while ((await cacheFlags())['synthetic-fiscal-fetch-hold']) await new Promise(resolve => setTimeout(resolve,20));
      if ((await cacheFlags())['synthetic-fiscal-fetch-forbidden']) throw new Error('Warm cache unexpectedly fetched fiscal HTML');
      const refund = url.pathname.includes('refund-'), amount = refund ? '25,00' : '100,00';
      if ((await cacheFlags())['synthetic-fiscal-fetch-malformed']) return new Response('<div>01.01.2026 12:00</div><table><tr><td>ИТОГ</td><td>999,00</td></tr></table>');
      return new Response('<div data-synthetic-fiscal-raw="cache-only">01.01.2026 12:00'+(refund?' Возврат прихода':'')+'</div><table><tr><td>1.</td><td>Книга</td><td>1</td><td>'+amount+'</td></tr><tr><td>ИТОГ</td><td>'+amount+'</td></tr></table>');
    }
    throw new Error('Unexpected fixture request: ' + url.origin + url.pathname);
  };`);
  const html = await fs.readFile(path.join(build, 'offscreen.html'), 'utf8');
  await fs.writeFile(path.join(build, 'offscreen.html'), html.replace('<head>', '<head><script src="/test-fixtures.js"></script>'));
  const context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
    channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? undefined : 'chromium',
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true,
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
  }).catch(async error => {
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('kupleno-collect-test-'));
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  });
  const fixtureNavigationErrors = [];
  let fixtureWorkerUrl;
  context.on('page', target => {
    void (async () => {
      try { await target.waitForURL(url => url.href.startsWith('about:blank#kupleno-fixture='), { timeout: 15000, waitUntil: 'commit' }); }
      catch { return; }
      const worker = context.serviceWorkers().find(worker => worker.url() === fixtureWorkerUrl);
      assert.ok(worker, 'Synthetic navigation has its exact worker');
      assert.equal(await worker.evaluate(marker => {
        const resolve = globalThis.testTabReady.get(marker);
        if (!resolve) return false;
        resolve(); return true;
      }, target.url().slice('about:blank#kupleno-fixture='.length)), true);
    })().catch(error => fixtureNavigationErrors.push(error.message));
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
    fixtureWorkerUrl = worker.url();
    const id = new URL(worker.url()).host;
    await worker.evaluate(base64 => {
      const original = globalThis.fetch; globalThis.testPdfRequests = 0;
      globalThis.fetch = async (input, init) => {
        if (String(input).includes('/downloadCheque')) { globalThis.testPdfRequests++; return new Response(Uint8Array.from(atob(base64), c => c.charCodeAt(0))); }
        return original(input, init);
      };
    }, pdf.toString('base64'));
    const requests = [];
    let stallOzon = false, ozonGate;
    let holdYandex = false, releaseYandex;
    let yandexReceiptRequests = 0;
    let yandexOrderIds = [123456];
    let cacheRefund = false;
    let yandexMode = 'normal', challengeCandidate = '', metadataGate, releaseHumanNavigation, headerPhase = '';
    let domClicks = 0, documentClicks = 0;
    let holdHumanNavigation = false, unsafeNavigations = 0;
    const ozonRequestPages = new Set();
    await context.route('https://www.ozon.ru/**', async route => {
      if (route.request().isNavigationRequest()) return route.fulfill({contentType:'text/html',body:'<html><script>window.fetch = () => new Promise(() => {});</script><body>Receipt page</body></html>'});
      requests.push(route.request().url());
      ozonRequestPages.add(route.request().frame().page());
      if (stallOzon) return new Promise(() => {});
      if (ozonGate) await ozonGate;
      return route.fulfill(route.request().url().includes('downloadCheque') ? { contentType: 'application/pdf', body: pdf } : { contentType: 'application/json', json: { cheques: [{ link: '/_action/downloadCheque?id=synthetic' }] } });
    });
    await context.route('https://market.yandex.ru/**', async route => {
      const url = new URL(route.request().url()); requests.push(url.href);
      if (url.pathname === '/synthetic-document-click') { documentClicks++; return route.fulfill({ json: { ok: true } }); }
      if (url.pathname.startsWith('/my/order/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><button id=docs>Чеки и другие документы</button><script>document.getElementById('docs').onclick=()=>{fetch('/synthetic-document-click');const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.innerHTML='<h2>Документы по заказу</h2><a href="https://check.yandex.ru/doc/purchase">Чек</a><a href="https://check.yandex.ru/doc/delivery">Чек доставки</a><a href="https://market.yandex.ru/document">Подтверждение покупки</a>';document.body.append(dialog);};</script></html>` });
      if (url.pathname === '/synthetic-dom-click') { domClicks++; return route.fulfill({ json: { ok: true } }); }
      if (url.pathname === '/showcaptcha' || url.pathname === '/captcha') {
        if (holdHumanNavigation && route.request().isNavigationRequest()) await new Promise(resolve => { releaseHumanNavigation = resolve; });
        return route.fulfill({ contentType: 'text/html', body: '<html><body><h1>Synthetic human verification page</h1></body></html>' });
      }
      if (url.pathname === '/api/resolve/') {
        const requestBody = route.request().postDataJSON();
        const receiptRequest = url.searchParams.get('r')?.includes('resolveOrderReceiptsByOrderId');
        assert.equal(requestBody.params.length, 1);
        if (!receiptRequest) assert.equal(requestBody.params[0].pageToken, 'owned-tab-cursor', 'List cursor comes from the same owned DOM snapshot as header context');
        const expectedPath = receiptRequest ? '/my/order/' + requestBody.params[0].orderId : '/my/orders?filter=COMPLETED';
        assert.equal(requestBody.path, expectedPath);
        const requestHeaders = route.request().headers();
        assert.equal(requestHeaders['x-retpath-y'], 'https://market.yandex.ru' + expectedPath);
        assert.equal(requestHeaders.referer, 'https://market.yandex.ru' + expectedPath);
        if (receiptRequest) assert.equal(requestHeaders['x-market-page-id'], 'market:order');
        if (headerPhase) {
          const wire = route.request().headers();
          const prefix = headerPhase === 'fresh' ? 'fresh' : 'cached';
          assert.equal(wire.sk, headerPhase === 'absent' ? undefined : prefix + '-sk-secret');
          assert.equal(wire['x-market-app-version'], headerPhase === 'absent' ? undefined : prefix + '-version');
          assert.equal(wire['x-market-front-glue'], headerPhase === 'absent' ? undefined : prefix + '-glue');
          assert.equal(wire['x-market-page-id'], receiptRequest ? 'market:order' : headerPhase === 'absent' ? 'market:orders' : 'market:orders:' + prefix);
        }
        if (yandexMode === 'transport-list') return route.abort('failed');
        if (yandexMode === 'dom-fallback' && !receiptRequest) return route.fulfill({ json: { results: [{ data: { result: 'list', collections: { orderConsolidationResult: { list: { ordersGroupsIds: [], pageToken: 'owned-tab-cursor' } } } } }] } });
        if (yandexMode.startsWith('dom-') && !receiptRequest) return route.fulfill({ json: { results: [{ error: { code: 'NOT_FOUND' } }] } });
        if (yandexMode === 'html-list') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Synthetic unavailable page</body></html>' });
        if (yandexMode === 'login-redirect') return route.fulfill({ status: 302, headers: { location: 'https://market.yandex.ru/login' } });
        if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return route.fulfill({ json: { results: [{ data: { result: 'list', collections: { orderConsolidationResult: { list: { ordersGroupsIds: yandexOrderIds, pageToken: '', hasNext: false } } } } }] } });
        yandexReceiptRequests++;
        if (metadataGate) await metadataGate;
        if (yandexMode === 'html-metadata') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Synthetic unavailable page</body></html>' });
        if (yandexMode === 'challenge') return route.fulfill({ json: { type: 'captcha', captcha: { 'captcha-page': challengeCandidate } } });
        if (yandexMode === 'redirect-challenge') return route.fulfill({ status: 302, headers: { location: challengeCandidate } });
        if (holdYandex) await new Promise(resolve => { releaseYandex = resolve; });
        const body = route.request().postDataJSON(); assert.ok(yandexOrderIds.includes(body.params[0].orderId));
        assert.equal(body.params.length, 1);
        if ((yandexMode === 'dom-fallback' && body.params[0].orderId === 345678) || (yandexMode === 'docs-late' && body.params[0].orderId === 234567) || yandexMode === 'docs-concurrent') return route.fulfill({ json: { results: [{ data: { result: ['r'], collections: { orderReceipt: { r: {} } } } }] } });
        return route.fulfill({ json: { results: body.params.map(({orderId}) => ({ data: { result: cacheRefund ? ['r','refund'] : ['r'], collections: { orderReceipt: { r: { id: String(orderId), fiscalUrl: 'https://check.yandex.ru/test/' + orderId, createdAt: 1767225600, type: 'INCOME' }, ...(cacheRefund ? { refund: { id: 'refund-'+orderId, fiscalUrl: 'https://check.yandex.ru/test/refund-'+orderId, createdAt:1767225600,type:'RETURN_INCOME' } } : {}) } } } })) } });
      }
      const captured = headerPhase && headerPhase !== 'absent' ? '<script id="synthetic-header-context" type="application/json">{"sk":"cached-sk-secret","-version":"cached-version","marketFrontGlue":"cached-glue","page":"market:orders:cached"}</script>' : '';
      if (yandexMode === 'dom-fatal') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><script type="application/json">{"pageToken":"owned-tab-cursor"}</script><h1>Что-то пошло не так</h1><button>Показать ещё</button></html>' });
      if (yandexMode === 'dom-fallback' || yandexMode === 'dom-stuck') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><script type="application/json">{"pageToken":"owned-tab-cursor"}</script><button data-route="/my/order/123456">Order</button><button id="more">Показать ещё</button><script>let loaded=0;document.getElementById('more').onclick=()=>{fetch('/synthetic-dom-click');${yandexMode === 'dom-stuck' ? '' : "setTimeout(()=>{const item=document.createElement('button');item.dataset.route='/my/order/'+(loaded===0?'234567':'345678');item.textContent='Order';document.body.append(item);if(++loaded===2)document.getElementById('more').remove();},1100);"}};</script></html>` });
      return route.fulfill({ contentType: 'text/html', body: '<html>' + (yandexMode === 'transport-list' ? '' : '<a href="/my/order/123456">Order</a>') + '<script type="application/json">{"pageToken":"owned-tab-cursor"}</script>' + captured + '</html>' });
    });
    await context.route('https://evil.test/**', route => { unsafeNavigations++; return route.fulfill({ contentType: 'text/html', body: '<html>Must not be opened</html>' }); });
    await context.route('https://check.yandex.ru/**', route => route.fulfill({ contentType: 'text/html', body: '<div>01.01.2026 12:00</div><table><tr><td>1</td><td>Книга</td><td>1</td><td>100,00</td></tr><tr><td>ИТОГ</td><td>100,00</td></tr></table>' }));
    await context.route('https://www.wildberries.ru/**', route => route.fulfill({contentType:'text/html',body:'<html>WB test</html>'}));
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/app.html`);
    const sendCommand = message => page.evaluate(message => chrome.runtime.sendMessage({ type: 'KUPLENO_JOB', ...message }), message);
    let retainYandexCache = false;
    const command = async message => {
      if (message.action === 'start' && message.source === 'yandex' && !retainYandexCache) {
        const previous = await sendCommand({ action: 'status', source: 'yandex' });
        if (!previous.job || ['failed','cancelled'].includes(previous.job.status)) assert.equal((await sendCommand({ action: 'clearReceiptCache', source: 'yandex' })).ok, true, 'Isolate independent legacy Yandex network scenarios');
      }
      return sendCommand(message);
    };
    async function finish(source, expectedRows = 1) {
      const scope = source ? { source } : {};
      let result;
      const deadline = Date.now() + 30000;
      do {
        result = await command({ action: 'status', ...scope });
        if (['completed','failed','cancelled'].includes(result?.job?.status)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      assert.equal(result.job.status, 'completed', JSON.stringify(result));
      assert.equal(await page.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), result.job.marketTabId), false, 'Owned tab closes before acknowledgement');
      assert.equal(result.job.result.rows.length, expectedRows);
      assert.equal(result.job.result.rows[0].amount, '100.00');
      assert.ok(Object.values(result.job.result.stats).every(value => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))));
      if (source === 'ozon') assert.equal(result.job.result.stats.unrecognizedListResponses, 0);
      if (source === 'yandex') {
        assert.equal(result.job.result.stats.receiptMetadataRequests, expectedRows, 'Each order succeeds once without an archive fallback masking a bridge rejection');
        assert.equal(result.job.result.stats.responseRootErrors, 0);
        assert.equal(result.job.result.stats.lastPageIds, expectedRows);
        assert.equal(result.job.result.stats.lastPageHasNextKnown, true);
        assert.equal(result.job.result.stats.repeatedCursor, false);
      }
      // Result survives the app being closed/reopened, and is removed only after explicit acknowledgement.
      await page.reload();
      assert.equal((await command({ action: 'status', ...scope })).job.id, result.job.id);
      assert.deepEqual((await command({ action: 'status', ...scope })).job.result.stats, result.job.result.stats, 'Safe diagnostics survive worker delivery and app reopen');
      await command({ action: 'ack', id: result.job.id });
      assert.equal((await command({ action: 'status', ...scope })).job, null);
      return result.job.result;
    }
    // Cache cases deliberately share one manager. Legacy scenarios below clear it per run.
    retainYandexCache = true;
    const cacheName = 'kupleno-yandex-receipts-v1';
    const cacheEntries = () => page.evaluate(async name => {
      if (!await caches.has(name)) return [];
      const cache = await caches.open(name);
      return Promise.all((await cache.keys()).map(async key => ({ key: key.url, html: await (await cache.match(key)).text() })));
    }, cacheName);
    const cacheRun = async (refreshReceipts = false, quality = 'complete') => {
      const started = await command({ action: 'start', source: 'yandex', profile: 'personal', ...(refreshReceipts ? { refreshReceipts: true } : {}) });
      assert.equal(started.ok, true, JSON.stringify(started));
      let done;
      for (let attempt = 0; attempt < 300; attempt++) {
        done = await command({ action: 'status', source: 'yandex' });
        if (done.job.status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(done.job.status, 'completed', JSON.stringify(done));
      assert.equal(done.job.refreshReceipts === true, refreshReceipts);
      assert.ok(done.job.result.rows.every(row => row.parse_quality === quality));
      assert.ok(!JSON.stringify(done.job).includes('data-synthetic-fiscal-raw'), 'RAW HTML never enters durable jobs');
      assert.ok(!JSON.stringify(done.job).includes('kupleno-yandex-receipts.invalid'), 'Hashed cache keys never enter durable jobs');
      const result = done.job.result;
      assert.equal((await command({ action: 'ack', id: done.job.id })).ok, true);
      return result;
    };
    const financial = result => result.rows.map(({ receipt_url, item_index, amount, type, title, rowId }) => ({ receipt_url, item_index, amount, type, title, rowId })).sort((a,b) => a.receipt_url.localeCompare(b.receipt_url));
    assert.equal((await command({ action: 'clearReceiptCache', source: 'yandex' })).ok, true);
    const cold = await cacheRun();
    assert.equal(cold.stats.receiptNetworkRequests, 1); assert.equal(cold.stats.cachedReceipts, 0);
    assert.equal((await cacheEntries()).length, 1);
    assert.ok((await cacheEntries())[0].html.includes('data-synthetic-fiscal-raw'));
    await page.evaluate(() => chrome.storage.local.set({ 'synthetic-fiscal-fetch-forbidden': true }));
    const metadataBeforeWarm = yandexReceiptRequests;
    const warm = await cacheRun();
    assert.deepEqual(financial(warm), financial(cold));
    assert.equal(warm.stats.receiptNetworkRequests, 0); assert.equal(warm.stats.cachedReceipts, 1);
    assert.equal(yandexReceiptRequests, metadataBeforeWarm + 1, 'Warm cache still discovers current receipt metadata');
    await page.evaluate(() => chrome.storage.local.set({ 'synthetic-fiscal-fetch-forbidden': false }));
    cacheRefund = true;
    const refund = await cacheRun();
    assert.equal(refund.stats.receiptNetworkRequests, 1); assert.equal(refund.stats.cachedReceipts, 1);
    assert.equal(refund.rows.length, 2); assert.equal(refund.rows.find(row => row.type === 'refund').amount, '-25.00');
    await page.evaluate(async name => {
      const cache = await caches.open(name), key = (await cache.keys())[0], previous = await cache.match(key);
      const bytes = Number(previous.headers.get('x-kupleno-bytes'));
      await cache.put(key, new Response('x'.repeat(bytes), { headers: previous.headers }));
    }, cacheName);
    const repaired = await cacheRun();
    assert.deepEqual(financial(repaired), financial(refund));
    assert.equal(repaired.stats.receiptNetworkRequests, 1); assert.equal(repaired.stats.cachedReceipts, 1, 'Malformed RAW is reparsed and replaced from network, never trusted as parsed rows');
    const forced = await cacheRun(true);
    assert.deepEqual(financial(forced), financial(refund));
    assert.equal(forced.stats.receiptNetworkRequests, 2); assert.equal(forced.stats.cachedReceipts, 0);
    await page.evaluate(() => chrome.storage.local.set({ 'synthetic-fiscal-fetch-malformed': true }));
    const malformedForced = await cacheRun(true, 'fallback');
    assert.equal(malformedForced.stats.cachedReceipts, 0); assert.equal(malformedForced.stats.receiptNetworkRequests, 2);
    assert.ok(malformedForced.rows.every(row => Math.abs(Number(row.amount)) === 999), 'Forced malformed RAW cannot silently reuse the older complete receipt');
    assert.equal((await cacheEntries()).length, 0, 'Forced reread removes old entries and never caches incomplete parsed bodies');
    await page.evaluate(() => chrome.storage.local.set({ 'synthetic-fiscal-fetch-malformed': false }));
    await cacheRun(true);
    await page.evaluate(() => chrome.storage.local.set({ 'synthetic-cache-api-fail': true }));
    const cacheFailed = await cacheRun();
    assert.deepEqual(financial(cacheFailed), financial(refund));
    assert.equal(cacheFailed.stats.receiptNetworkRequests, 2);
    assert.ok(cacheFailed.stats.cacheReadErrors > 0); assert.ok(cacheFailed.stats.cacheWriteErrors > 0);
    await page.evaluate(() => chrome.storage.local.set({ 'synthetic-cache-api-fail': false }));
    await cacheRun(true);
    const beforeUntrustedClear = await cacheEntries();
    for (const message of [
      { type: 'KUPLENO_OFFSCREEN', action: 'clearReceiptCache' },
      { type: 'KUPLENO_JOB', action: 'clearReceiptCache', source: 'wildberries' },
      { type: 'KUPLENO_JOB', action: 'start', source: 'yandex', profile: 'personal', refreshReceipts: 'true' },
      { type: 'KUPLENO_JOB', action: 'start', source: 'wildberries', profile: 'personal', refreshReceipts: true }
    ]) assert.notEqual(await page.evaluate(message => chrome.runtime.sendMessage(message).then(result => result?.ok, () => false), message), true, 'Untrusted or invalid cache/force command rejected');
    assert.deepEqual(await cacheEntries(), beforeUntrustedClear);
    await page.getByRole('link', { name: 'Настройки', exact: true }).click();
    const [cacheBackup] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать копию', exact: true }).click()]);
    const exportedCacheBackup = await fs.readFile(await cacheBackup.path(), 'utf8');
    assert.ok(!exportedCacheBackup.includes('data-synthetic-fiscal-raw'), 'Cache bodies are excluded from backup export');
    assert.ok(!exportedCacheBackup.includes('kupleno-yandex-receipts.invalid'), 'Hashed cache keys are excluded from backup export');
    await page.goto(`chrome-extension://${id}/app.html`);
    assert.equal((await command({ action: 'clearReceiptCache', source: 'yandex' })).ok, true);
    await page.evaluate(() => chrome.storage.local.set({ 'synthetic-fiscal-fetch-hold': true, 'synthetic-fiscal-fetch-started': false }));
    const lateCache = await command({ action: 'start', source: 'yandex', profile: 'personal' });
    await page.waitForFunction(async () => (await chrome.storage.local.get('synthetic-fiscal-fetch-started'))['synthetic-fiscal-fetch-started']);
    assert.equal((await command({ action: 'cancel', id: lateCache.job.id })).job.status, 'cancelled');
    assert.equal((await command({ action: 'clearReceiptCache', source: 'yandex' })).ok, true);
    await page.evaluate(() => chrome.storage.local.set({ 'synthetic-fiscal-fetch-hold': false }));
    await page.waitForTimeout(250);
    assert.equal((await cacheEntries()).length, 0, 'Cancelled late RAW response cannot repopulate cleared cache');
    cacheRefund = false;
    const afterClear = await cacheRun();
    assert.equal(afterClear.stats.receiptNetworkRequests, 1); assert.equal(afterClear.stats.cachedReceipts, 0, 'A new run after source-cache clear fetches fiscal HTML again');
    assert.equal((await command({ action: 'clearReceiptCache', source: 'yandex' })).ok, true);
    retainYandexCache = false;
    console.log('PASS: RAW fiscal cache cold/warm; fresh refund metadata; malformed body repair; forced reread; cache API fallback; trusted clear; cancelled late response; RAW excluded from jobs/backup.');
    if (process.env.KUPLENO_COLLECTION_CACHE_ONLY === '1') return;
    yandexReceiptRequests = 0;
    const ozon = await context.newPage(); await ozon.goto('https://www.ozon.ru/my/e-check');
    // Site code can replace fetch; the extension's isolated-world request must still work.
    await ozon.evaluate(() => { window.fetch = () => new Promise(() => {}); });
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await page.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.ozon.ru/*' })).some(tab => tab.status === 'complete'))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await page.bringToFront();
    const activeBefore = await page.evaluate(async () => (await chrome.tabs.query({active:true,currentWindow:true}))[0].id);
    // Keep the synthetic request pending until the dedicated tab's initial state is observed.
    let releaseOzon;
    ozonGate = new Promise(resolve => { releaseOzon = resolve; });
    const ozonStarted = await command({ action: 'start', source: 'ozon', profile: 'personal' });
    assert.equal(ozonStarted.ok, true, JSON.stringify(ozonStarted));
    assert.equal(ozonStarted.job.status, 'running', JSON.stringify({ source: ozonStarted.job.source, status: ozonStarted.job.status, error: ozonStarted.job.error, fixtureNavigationErrors }));
    const dedicatedId=ozonStarted.job.marketTabId;
    assert.equal(typeof dedicatedId,'number');
    const tabState=await page.evaluate(id=>chrome.tabs.get(id),dedicatedId);
    assert.equal(tabState.active,false);
    assert.equal(await page.evaluate(async () => (await chrome.tabs.query({active:true,currentWindow:true}))[0].id),activeBefore,'Collection must not steal the active tab');
    ozonGate = undefined; releaseOzon();
    await finish();
    assert.equal(ozonRequestPages.size,1);
    assert.equal(ozonRequestPages.has(ozon),false,'Never use the pre-existing store tab');
    assert.equal(ozon.isClosed(),false,'Preserve the user tab');
    assert.equal(await page.evaluate(id=>chrome.tabs.get(id).then(()=>true,()=>false),dedicatedId),false,'Close only the dedicated tab after acknowledgement');
    assert.equal(await worker.evaluate(() => globalThis.testPdfRequests), 1);
    // No Yandex tab exists: start must open it, wait and continue without a second click.
    const yandexUser = await context.newPage(); await yandexUser.goto('https://market.yandex.ru/my/orders');
    yandexOrderIds = Array.from({ length: 8 }, (_, index) => 123456 + index);
    const started = await command({ action: 'start', source: 'yandex', profile: 'personal' });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(typeof started.job.marketTabId,'number');
    await finish('yandex', 8);
    yandexOrderIds = [123456];
    assert.equal(yandexUser.isClosed(),false);
    assert.equal(yandexReceiptRequests, 8);
    const denied = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'KUPLENO_YANDEX_REQUEST', id: 'fake', url: 'https://evil.test/', body: '{}' }));
    assert.equal(denied.ok, false);
    // The second Ozon finish loses its reply after worker persistence. ACK must release its exact task before the next run.
    holdYandex = true; releaseYandex = undefined;
    const terminalNeighbour = await command({ action: 'start', source: 'yandex', profile: 'personal' });
    assert.equal(terminalNeighbour.ok, true);
    const lostReplyStart = await command({ action: 'start', source: 'ozon', profile: 'personal' });
    assert.equal(lostReplyStart.ok, true);
    let lostReplyDone;
    for (let attempt = 0; attempt < 100; attempt++) {
      lostReplyDone = await command({ action: 'status', source: 'ozon' });
      if (lostReplyDone.job.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(lostReplyDone.job.status, 'completed', JSON.stringify(lostReplyDone));
    const retainedDelivery = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'KUPLENO_OFFSCREEN', action: 'status' }));
    assert.ok(retainedDelivery.ids.includes(lostReplyStart.job.id), 'Lost finished reply leaves the old offscreen delivery alive');
    await command({ action: 'ack', id: lostReplyStart.job.id });
    const immediatelyRecollected = await command({ action: 'start', source: 'ozon', profile: 'personal' });
    assert.equal(immediatelyRecollected.ok, true);
    assert.notEqual(immediatelyRecollected.job.status, 'failed', JSON.stringify(immediatelyRecollected));
    assert.notEqual(immediatelyRecollected.job.id, lostReplyStart.job.id);
    const releasedDelivery = await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'KUPLENO_OFFSCREEN', action: 'status' }));
    assert.equal(releasedDelivery.ids.includes(lostReplyStart.job.id), false, 'ACK releases only the old job id');
    assert.ok(releasedDelivery.ids.includes(terminalNeighbour.job.id), 'ACK leaves the other source task alive');
    assert.equal((await command({ action: 'status', source: 'yandex' })).job.status, 'running');
    assert.equal((await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }))).length, 1, 'ACK preserves the singleton document');
    await finish('ozon');
    for (let attempt = 0; attempt < 100 && !releaseYandex; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(typeof releaseYandex, 'function'); holdYandex = false; releaseYandex();
    await finish('yandex');
    console.log('PASS: lost finished reply; exact ACK releases retained delivery; immediate same-source collection succeeds.');
    // Migrate a durable old single-job result without discarding it on worker restart.
    const devtools = await context.newCDPSession(page);
    await devtools.send('ServiceWorker.enable');
    async function restartWorker() {
      const { targetInfos } = await devtools.send('Target.getTargets');
      const target = targetInfos.find(target => target.type === 'service_worker' && target.url === `chrome-extension://${id}/background.js`);
      assert.ok(target, 'Locate the exact disposable extension worker');
      await devtools.send('Target.closeTarget', { targetId: target.targetId });
      const status = await command({ action: 'status' });
      const fresh = context.serviceWorkers().find(worker => worker.url() === `chrome-extension://${id}/background.js`);
      return { status, fresh };
    }
    const legacy = { id: 'legacy-completed', source: 'ozon', profile: 'personal', status: 'completed', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), message: 'legacy', progress: { done: 1, total: 1 }, result: { rows: [], stats: { receipts: 0 }, warnings: [] } };
    await page.evaluate(async legacy => {
      await chrome.storage.local.remove('kupleno-next-jobs');
      await chrome.storage.local.set({ 'kupleno-next-job': legacy });
    }, legacy);
    assert.equal((await restartWorker()).status.job.id, legacy.id);
    assert.equal((await page.evaluate(() => chrome.storage.local.get('kupleno-next-job')))['kupleno-next-job'], undefined);
    await command({ action: 'ack', id: legacy.id });

    // All three sources remain active together; a slow Ozon request does not own the other buttons.
    stallOzon = true; holdYandex = true;
    const parallelWorker = context.serviceWorkers()[0];
    await parallelWorker.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.parallelWb = true;
      globalThis.fetch = async (input, init) => {
        if (globalThis.parallelWb && String(input).startsWith('https://astro.wildberries.ru/')) {
          await new Promise((resolve, reject) => {
            globalThis.releaseParallelWb = resolve;
            init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          });
          return new Response(JSON.stringify({ receipts: [{ receiptUid: 'parallel-wb', link: 'https://receipt.wb.ru/parallel-wb', operationSum: 100, operationDateTime: '2026-01-01T10:00:00Z' }] }));
        }
        if (String(input) === 'https://receipt.wb.ru/parallel-wb') return new Response('<h2>Кассовый чек</h2>Приход<div class="products-item"><div class="products-cell products-cell_name"><div class="products-prop-value">Наименование Книга</div></div><div class="products-cell products-cell_price"></div><div class="products-cell products-cell_cost"><div class="products-prop-value">100,00 ₽</div></div></div><div class="total"></div>');
        return original(input, init);
      };
    });
    await context.addCookies([{ url: 'https://www.wildberries.ru/', name: 'wbid-sdk-id-token', value: 'synthetic.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url') + '.signature' }]);
    await page.goto(`chrome-extension://${id}/app.html#stores`);
    const stores = page.locator('.store-panel');
    await stores.filter({ has: page.getByRole('heading', { name: 'Ozon', exact: true }) }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const otherStoreButtons = ['Wildberries', 'Яндекс Маркет'].map(name => stores.filter({ has: page.getByRole('heading', { name, exact: true }) }).getByRole('button', { name: 'Обновить покупки', exact: true }));
    const idlePositions = await Promise.all(otherStoreButtons.map(button => button.boundingBox()));
    const [parallelOzon, duplicateOzon] = await Promise.all([
      command({ action: 'start', source: 'ozon', profile: 'personal' }),
      command({ action: 'start', source: 'ozon', profile: 'work' })
    ]);
    assert.equal(parallelOzon.ok, true); assert.equal(duplicateOzon.ok, false, 'One source cannot start twice');
    await stores.filter({ has: page.getByRole('heading', { name: 'Ozon', exact: true }) }).getByRole('button', { name: 'Остановить сбор', exact: true }).waitFor();
    assert.deepEqual(await Promise.all(otherStoreButtons.map(button => button.boundingBox())), idlePositions, 'Starting Ozon must not move the other store buttons');
    for (const name of ['Wildberries', 'Яндекс Маркет']) assert.equal(await stores.filter({ has: page.getByRole('heading', { name, exact: true }) }).getByRole('button', { name: 'Обновить покупки', exact: true }).isEnabled(), true, name + ' remains enabled');
    const updateAll = page.getByRole('button', { name: 'Обновить все магазины', exact: true });
    await updateAll.click();
    await page.getByRole('button', { name: 'Остановить сбор', exact: true }).nth(2).waitFor();
    assert.equal(await updateAll.isEnabled(), false, 'All stores already have active jobs');
    const allRunning = await command({ action: 'status' });
    assert.equal(allRunning.jobs.filter(job => job.status === 'running').length, 3, JSON.stringify(allRunning.jobs.map(({ source, status, error, diagnostic, startedAt, updatedAt }) => ({ source, status, error, diagnostic, startedAt, updatedAt }))));
    assert.equal(allRunning.jobs.find(job => job.source === 'ozon').id, parallelOzon.job.id, 'Batch preserves the active Ozon job');
    const parallelWb = { job: allRunning.jobs.find(job => job.source === 'wildberries') };
    const parallelYandex = { job: allRunning.jobs.find(job => job.source === 'yandex') };
    await page.goto(`chrome-extension://${id}/app.html#stores`);
    await page.getByRole('button', { name: 'Остановить сбор', exact: true }).nth(2).waitFor();
    const captureOutput = process.env.KUPLENO_PARALLEL_OUTPUT;
    if (captureOutput) { await fs.mkdir(captureOutput, { recursive: true }); await page.screenshot({ path: path.join(captureOutput, 'parallel-desktop.png'), fullPage: true }); }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Concurrent store controls fit mobile');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.getByRole('button', { name: 'Обновить покупки', exact: true }).first().evaluate(el => getComputedStyle(el).transitionDuration), '0s', 'Reduced motion disables store control transitions');
    if (captureOutput) await page.screenshot({ path: path.join(captureOutput, 'parallel-mobile-reduced.png'), fullPage: false });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`chrome-extension://${id}/app.html`);

    assert.equal(allRunning.job, null, 'Legacy unqualified status never picks an arbitrary active job');
    assert.equal((await command({ action: 'cancel' })).ok, false, 'Ambiguous legacy cancellation is rejected');
    assert.equal((await command({ action: 'cancel', id: parallelOzon.job.id })).job.status, 'cancelled');
    assert.equal((await command({ action: 'status', source: 'yandex' })).job.status, 'running');
    assert.equal((await command({ action: 'status', source: 'wildberries' })).job.status, 'running');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await parallelWorker.evaluate(() => typeof globalThis.releaseParallelWb === 'function')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await parallelWorker.evaluate(() => globalThis.releaseParallelWb());
    let wbDone;
    for (let attempt = 0; attempt < 100; attempt++) {
      wbDone = await command({ action: 'status', source: 'wildberries' });
      if (wbDone.job.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(wbDone.job.status, 'completed', JSON.stringify(wbDone));
    const restarted = await restartWorker();
    assert.equal(restarted.status.jobs.find(job => job.source === 'wildberries').status, 'completed', 'Completed results survive restart');
    assert.equal(restarted.status.jobs.find(job => job.source === 'yandex').status, 'running', 'Offscreen source survives worker restart');
    for (let attempt = 0; attempt < 100 && !releaseYandex; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(typeof releaseYandex, 'function');
    holdYandex = false; releaseYandex();
    let yandexDone;
    for (let attempt = 0; attempt < 100; attempt++) {
      yandexDone = await command({ action: 'status', source: 'yandex' });
      if (yandexDone.job.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(yandexDone.job.status, 'completed', JSON.stringify(yandexDone));
    await command({ action: 'ack', id: 'wrong-job' });
    assert.equal((await command({ action: 'status' })).jobs.filter(job => job.status === 'completed').length, 2);
    // ACK of one exact result leaves its neighbour durable.
    await command({ action: 'ack', id: parallelWb.job.id });
    assert.equal((await command({ action: 'status', source: 'yandex' })).job.id, parallelYandex.job.id);
    // Seed three pending durable results simultaneously to exercise Stores+App fresh-state writes.
    const completed = ['ozon', 'wildberries', 'yandex'].map(source => ({ ...legacy, id: 'apply-' + source, source, result: { rows: [{ rowId: 'apply-' + source, source, date: '2026-01-01', title: 'Synthetic ' + source, amount: '100.00', marketplace_id: 'apply-' + source }], stats: { receipts: 1 }, warnings: [] } }));
    await page.evaluate(jobs => chrome.storage.local.set({ 'kupleno-next-jobs': Object.fromEntries(jobs.map(job => [job.source, job])) }), completed);
    await restartWorker();
    await page.goto(`chrome-extension://${id}/app.html#stores`);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await command({ action: 'status' })).jobs.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await command({ action: 'status' })).jobs.length, 0, 'Only saved results are acknowledged');
    const persisted = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => { const request = indexedDB.open('kupleno-storage-v2'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { return await new Promise((resolve, reject) => { const request = database.transaction('current').objectStore('current').get('state'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
      finally { database.close(); }
    });
    assert.deepEqual(persisted.state.rows.map(row => row.source).sort(), ['ozon', 'wildberries', 'yandex']);
    assert.equal(Object.keys(persisted.state.metadata.appliedCollections).length, 3);
    for (const source of ['ozon', 'wildberries', 'yandex']) {
      const stats = persisted.state.metadata.collection.stats[source];
      assert.equal(stats.appliedRowsBefore, 0);
      assert.equal(stats.appliedRowsReceived, 1);
      assert.equal(stats.appliedRowsAfter, 1);
      assert.equal(stats.appliedArchivedRowsBefore, 0);
    }
    await page.reload();
    assert.equal((await command({ action: 'status' })).jobs.length, 0);
    await context.clearCookies();
    await page.goto(`chrome-extension://${id}/app.html`);
    console.log('PASS: three concurrent sources; duplicate-source guard; independent cancellation; singleton offscreen; legacy migration; worker restart; exact ACK; concurrent fresh-CAS Stores application.');
    const before = requests.length;
    const startedAt = Date.now();
    assert.equal((await command({ action: 'start', source: 'ozon', profile: 'personal' })).ok, true);
    await page.goto(`chrome-extension://${id}/app.html#stores`);
    await page.getByRole('button', {name:'Скопировать сведения',exact:true}).waitFor();
    let stalled;
    do {
      stalled=await command({action:'status'});
      if(stalled.job.status==='failed') break;
      await new Promise(resolve=>setTimeout(resolve,200));
    } while(Date.now()-startedAt<40000);
    assert.equal(stalled.job.status,'failed',JSON.stringify(stalled));
    assert.equal(await page.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), stalled.job.marketTabId), false, 'Failure closes tab');
    assert.match(stalled.job.error,/не ответил[аи]? за/);
    assert.equal(requests.length-before,1,'Timeout must not retry the archive');
    assert.equal((await command({action:'start',source:'ozon',profile:'personal'})).ok,true);
    const cancelledAt=Date.now();
    const cancelled=await command({action:'cancel'});
    assert.equal(cancelled.job.status,'cancelled');
    assert.equal(await page.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), cancelled.job.marketTabId), false, 'Cancellation closes tab');
    assert.ok(Date.now()-cancelledAt<7000,'Cancellation must not wait for network');
    const wbUser = await context.newPage(); await wbUser.goto('https://www.wildberries.ru/lk/receipts/get');
    const wbStart = await command({action:'start',source:'wildberries',profile:'personal'});
    assert.equal(wbStart.ok,true);
    let wbResult;
    for(let i=0;i<100;i++) { wbResult=await command({action:'status'}); if(wbResult.job.status==='failed') break; await new Promise(r=>setTimeout(r,100)); }
    assert.equal(wbResult.job.status,'failed');
    // execute() closes in finally, immediately after publishing its terminal state.
    for(let i=0;i<30;i++) { if(!await page.evaluate(id=>chrome.tabs.get(id).then(()=>true,()=>false),wbStart.job.marketTabId)) break; await new Promise(r=>setTimeout(r,100)); }
    assert.equal(await page.evaluate(id=>chrome.tabs.get(id).then(()=>true,()=>false),wbStart.job.marketTabId),false);
    assert.equal(wbUser.isClosed(),false);
    // A failed run is exported separately; historical warnings must not mask the current failure.
    const oldWarning = 'Яндекс Маркет: предупреждение прежнего сбора.';
    const prior = structuredClone(persisted.state);
    prior.metadata.collection.warnings = [oldWarning];
    prior.metadata.collection.stats.yandex.incomplete = true;
    await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-prior.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'kupleno-backup', version: 2, state: prior })) });
    await page.getByRole('dialog').getByRole('button', { name: 'Загрузить историю', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.goto(`chrome-extension://${id}/app.html#stores`);
    await page.getByText(oldWarning, { exact: true }).waitFor();
    const saved = () => page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => { const request = indexedDB.open('kupleno-storage-v2'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { return await new Promise((resolve, reject) => { const request = database.transaction('current').objectStore('current').get('state'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
      finally { database.close(); }
    });
    const failureBaseline = await saved();
    async function failedYandex(started) {
      const deadline = Date.now() + 15000;
      let result;
      do {
        result = await command({ action: 'status', source: 'yandex' });
        if (result.job.status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      assert.equal(result.job.id, started.job.id);
      assert.equal(result.job.status, 'failed', JSON.stringify(result));
      assert.ok(result.job.failureStats, 'Even a zero-row failure keeps its fixed diagnostics');
      return result.job;
    }
    yandexMode = 'html-list';
    const htmlFailure = await failedYandex(await command({ action: 'start', source: 'yandex', profile: 'personal' }));
    assert.equal(htmlFailure.failureStats.apiHtmlResponses, 1);
    assert.equal(htmlFailure.failureStats.apiResponseStatus, 200);
    assert.equal(htmlFailure.failureStats.providerHtmlResponses, 1);
    assert.equal(htmlFailure.failureStats.receiptMetadataRequests, 0);
    assert.doesNotMatch(htmlFailure.error, /Проверьте вход|Войдите/);
    await page.getByRole('alert').filter({ hasText: 'страницу вместо истории' }).waitFor();
    assert.equal(await page.getByText(oldWarning, { exact: true }).count(), 0, 'Do not mix a prior warning with the current failure');
    assert.deepEqual((await saved()).state, failureBaseline.state, 'Failed collection leaves saved rows/settings/metadata untouched');
    const restartedFailure = await restartWorker();
    assert.deepEqual(restartedFailure.status.jobs.find(job => job.source === 'yandex').failureStats, htmlFailure.failureStats);
    await page.goto(`chrome-extension://${id}/app.html#settings`);
    const [failureDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать копию', exact: true }).click()]);
    const exportedFailure = JSON.parse(await fs.readFile(await failureDownload.path(), 'utf8'));
    assert.ok(!JSON.stringify(exportedFailure).includes('owned-tab-cursor'), 'Owned-tab seed stays out of backups');
    const attempts = exportedFailure.state.metadata.collectionDiagnostics;
    assert.equal(attempts.available, true);
    assert.deepEqual(attempts.attempts.find(job => job.source === 'yandex').failureStats, htmlFailure.failureStats);
    assert.deepEqual(exportedFailure.state.rows, failureBaseline.state.rows);
    assert.deepEqual(exportedFailure.state.settings, failureBaseline.state.settings);
    assert.deepEqual((await saved()).state, failureBaseline.state, 'Export diagnostics are a snapshot, not a database write');
    yandexMode = 'html-metadata'; yandexOrderIds = Array.from({ length: 17 }, (_, index) => 123456 + index);
    const metadataBefore = yandexReceiptRequests;
    const metadataFailure = await failedYandex(await command({ action: 'start', source: 'yandex', profile: 'personal' }));
    assert.ok(yandexReceiptRequests - metadataBefore <= 2, 'Global HTML rejection must not hammer queued orders or archive');
    assert.ok(metadataFailure.failureStats.apiHtmlResponses > 0);
    yandexMode = 'login-redirect';
    const loginFailure = await failedYandex(await command({ action: 'start', source: 'yandex', profile: 'personal' }));
    assert.equal(loginFailure.failureStats.providerLoginResponses, 1);
    assert.equal(loginFailure.failureStats.providerRedirectResponses, 1);
    assert.match(loginFailure.error, /Войдите/);
    yandexMode = 'challenge'; yandexOrderIds = [123456];
    const privateMarker = 'synthetic-challenge-secret';
    const safeCandidate = 'https://market.yandex.ru/showcaptcha?retpath=https%3A%2F%2Fmarket.yandex.ru%2Fmy%2Forders&key=' + privateMarker;
    const unsafeCandidates = ['https://evil.test/showcaptcha', 'https://user:pass@market.yandex.ru/showcaptcha', '/checkcaptcha', 'captcha',
      '/showcaptcha?retpath=https%3A%2F%2Fevil.test%2F', '/showcaptcha?retpath=https%253A%252F%252Fevil.test%252F',
      '/showcaptcha?retpath=' + Buffer.from('https://evil.test/').toString('base64url'), '/showcaptcha?retpath=/my/orders&retpath=/'];
    for (const candidate of unsafeCandidates) {
      challengeCandidate = candidate;
      const failure = await failedYandex(await command({ action: 'start', source: 'yandex', profile: 'personal' }));
      assert.equal(failure.failureStats.providerChallengeResponses, 1);
      assert.equal(failure.failureStats.providerChallengeOpenedResponses, 0);
      await page.waitForFunction(id => chrome.tabs.get(id).then(() => false, () => true), failure.marketTabId, { timeout: 5000, polling: 100 });
    }
    assert.equal(unsafeNavigations, 0);
    // Revalidate ownership after the reply: a tab the user moved elsewhere cannot be redirected.
    challengeCandidate = safeCandidate;
    let releaseMetadata;
    metadataGate = new Promise(resolve => { releaseMetadata = resolve; });
    const beforeOwnershipRequest = yandexReceiptRequests;
    const ownershipStarted = await command({ action: 'start', source: 'yandex', profile: 'personal' });
    for (let attempt = 0; attempt < 100 && yandexReceiptRequests === beforeOwnershipRequest; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(yandexReceiptRequests > beforeOwnershipRequest);
    const ownershipWorker = context.serviceWorkers().find(worker => worker.url() === `chrome-extension://${id}/background.js`);
    await ownershipWorker.evaluate(id => {
      const get = chrome.tabs.get.bind(chrome.tabs);
      chrome.tabs.get = async requested => {
        const tab = await get(requested);
        if (requested !== id) return tab;
        chrome.tabs.get = get;
        return { ...tab, pendingUrl: 'https://market.yandex.ru/my/order/999999' };
      };
    }, ownershipStarted.job.marketTabId);
    metadataGate = undefined; releaseMetadata();
    const ownershipFailure = await failedYandex(ownershipStarted);
    assert.equal(ownershipFailure.failureStats.providerChallengeOpenedResponses, 0);
    await page.waitForFunction(id => chrome.tabs.get(id).then(() => false, () => true), ownershipFailure.marketTabId, { timeout: 5000, polling: 100 });
    // Keep the actual navigation pending: cleanup must respect pendingUrl and leave the check for the human.
    yandexMode = 'redirect-challenge'; challengeCandidate = safeCandidate; holdHumanNavigation = true;
    await page.bringToFront();
    const activeBeforeCheck = await page.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    const openedFailure = await failedYandex(await command({ action: 'start', source: 'yandex', profile: 'personal' }));
    assert.equal(openedFailure.failureStats.providerChallengeOpenedResponses, 1);
    assert.equal(openedFailure.failureStats.providerRedirectResponses, 1);
    assert.equal(openedFailure.failureStats.apiHtmlResponses, 1);
    assert.match(openedFailure.error, /открыл проверку/);
    const humanTab = await page.evaluate(id => chrome.tabs.get(id), openedFailure.marketTabId);
    assert.ok((humanTab.pendingUrl || humanTab.url).startsWith('https://market.yandex.ru/showcaptcha'));
    assert.equal(humanTab.active, false);
    assert.equal(await page.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id), activeBeforeCheck);
    assert.ok(!JSON.stringify(await page.evaluate(() => chrome.storage.local.get('kupleno-next-jobs'))).includes(privateMarker), 'Challenge URL/tokens never enter durable jobs');
    assert.ok(!JSON.stringify(await page.evaluate(() => chrome.storage.local.get('kupleno-next-jobs'))).includes('owned-tab-cursor'), 'Owned-tab seed never enters durable jobs');
    for (let attempt = 0; attempt < 100 && typeof releaseHumanNavigation !== 'function'; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(typeof releaseHumanNavigation, 'function'); holdHumanNavigation = false; releaseHumanNavigation();
    await page.evaluate(id => chrome.tabs.remove(id), openedFailure.marketTabId);
    assert.equal(yandexUser.isClosed(), false, 'Human verification never touches the pre-existing store tab');
    assert.deepEqual((await saved()).state, failureBaseline.state);
    // SK presence must never disguise a rejected fetch as a real HTTP 502 response.
    yandexMode = 'transport-list'; headerPhase = 'cached';
    const apiRequestsBeforeTransport = requests.filter(value => value.includes('/api/resolve/')).length;
    const transportFailure = await failedYandex(await command({ action: 'start', source: 'yandex', profile: 'personal' }));
    const transportRequests = requests.filter(value => value.includes('/api/resolve/')).slice(apiRequestsBeforeTransport);
    assert.equal(transportRequests.length, 2, 'Transport failure is attempted once per existing list resolver, without a transient retry');
    assert.equal(new Set(transportRequests).size, 2);
    assert.equal(transportFailure.failureStats.transientRetries, 0);
    assert.equal(transportFailure.failureStats.transientExhausted, 0);
    assert.equal(transportFailure.failureStats.apiResponseStatus, 0, 'A rejected fetch has no HTTP response status');
    assert.equal(transportFailure.failureStats.apiNonJsonResponses, 0);
    assert.equal(transportFailure.failureStats.receiptMetadataRequests, 0);
    assert.equal(transportFailure.error, 'Яндекс Маркет: список заказов не прочитан.');
    assert.doesNotMatch(transportFailure.error, /HTTP 502/);
    headerPhase = '';
    await page.goto(`chrome-extension://${id}/app.html`);
    const deniedDom = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'KUPLENO_YANDEX_ORDERS_DOM', id: 'fake' }));
    assert.equal(deniedDom.ok, false, 'The UI cannot run owned-tab DOM operations');
    yandexMode = 'dom-fallback'; yandexOrderIds = [123456, 234567, 345678]; domClicks = 0;
    const domStarted = await command({ action: 'start', source: 'yandex', profile: 'personal' });
    let domDone;
    for (let attempt = 0; attempt < 150; attempt++) {
      domDone = await command({ action: 'status', source: 'yandex' });
      if (domDone.job.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(domDone.job.status, 'completed', JSON.stringify(domDone));
    assert.equal(domDone.job.id, domStarted.job.id);
    assert.equal(domDone.job.result.rows.length, 4, JSON.stringify({ stats: domDone.job.result.stats, refs: domDone.job.result.unresolvedOrderIds, domClicks }));
    assert.equal(domDone.job.result.stats.orders, 3);
    assert.equal(domDone.job.result.stats.lastPageItems, 0);
    assert.equal(domDone.job.result.stats.lastPageHasNextKnown, false);
    assert.equal(domDone.job.result.stats.lastPageCursorMatchesRequest, true);
    assert.equal(domDone.job.result.stats.responseEntryErrors, 0);
    for (const field of ['listingElapsedMs', 'metadataElapsedMs', 'documentFallbackElapsedMs', 'receiptFetchElapsedMs', 'elapsedMs']) assert.ok(Number.isSafeInteger(domDone.job.result.stats[field]) && domDone.job.result.stats[field] >= 0);
    assert.equal(domDone.job.result.stats.domReceiptUrlsAdded, 2);
    assert.equal(domDone.job.result.stats.domReceiptCompleteDialogs, 1);
    assert.equal(documentClicks, 1);
    assert.deepEqual((await page.evaluate(() => chrome.storage.local.get('kupleno-next-yandex-document-tabs')))['kupleno-next-yandex-document-tabs'], []);
    assert.equal(domDone.job.result.stats.incomplete, true);
    assert.equal(domDone.job.result.stats.domFallbackClicks, 2);
    assert.equal(domClicks, 2, 'Never-disabled load-more is clicked once per actual new ID set');
    assert.deepEqual(domDone.job.result.unresolvedOrderIds, ['345678']);
    assert.equal(domDone.job.result.stats.missingFiscalUrlFields, 1);
    assert.ok(!JSON.stringify(domDone.job.result.stats).includes('345678'));
    await command({ action: 'ack', id: domDone.job.id });
    yandexMode = 'dom-fatal'; domClicks = 0;
    const domFatal = await failedYandex(await command({ action: 'start', source: 'yandex', profile: 'personal' }));
    assert.equal(domFatal.failureStats.domFallbackSteps, 1);
    assert.equal(domFatal.failureStats.domFallbackBlocked, 1);
    assert.equal(domClicks, 0);
    yandexMode = 'dom-stuck'; domClicks = 0;
    const stuck = await command({ action: 'start', source: 'yandex', profile: 'personal' });
    for (let attempt = 0; attempt < 80 && !domClicks; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(domClicks, 1);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(domClicks, 1, 'No growth does not trigger another click');
    assert.equal((await command({ action: 'cancel', id: stuck.job.id })).job.status, 'cancelled');
    yandexMode = 'docs-concurrent'; yandexOrderIds = [123456, 234567];
    const concurrentDocsWorker = context.serviceWorkers().find(worker => worker.url() === `chrome-extension://${id}/background.js`);
    await concurrentDocsWorker.evaluate(() => {
      const create = chrome.tabs.create.bind(chrome.tabs);
      let first = true;
      globalThis.restoreConcurrentDocuments = () => { chrome.tabs.create = create; };
      chrome.tabs.create = async details => {
        const tab = await create(details);
        if (String(details.url).startsWith('https://market.yandex.ru/my/order/') && first) { first = false; await new Promise(resolve => setTimeout(resolve, 500)); }
        return tab;
      };
    });
    await command({ action: 'start', source: 'yandex', profile: 'personal' });
    let concurrentDocs;
    for (let attempt = 0; attempt < 120; attempt++) {
      concurrentDocs = await command({ action: 'status', source: 'yandex' });
      if (concurrentDocs.job.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(concurrentDocs.job.status, 'completed', JSON.stringify(concurrentDocs));
    assert.equal(concurrentDocs.job.result.stats.domReceiptOrdersAttempted, 2);
    assert.equal(concurrentDocs.job.result.stats.domReceiptCompleteDialogs, 2, 'The same operation is not counted twice while create is pending');
    assert.equal(concurrentDocs.job.result.stats.domReceiptBlocked, 0);
    assert.equal(concurrentDocs.job.result.stats.domReceiptUrlsAdded, 2, 'Identical actual dialog hrefs are deduplicated');
    assert.equal(concurrentDocs.job.result.rows.length, 2);
    await command({ action: 'ack', id: concurrentDocs.job.id });
    await concurrentDocsWorker.evaluate(() => globalThis.restoreConcurrentDocuments());
    // A delayed create may resolve after the completed job was acknowledged.
    // Its ownership must survive separately from jobs, without permitting UI actions.
    yandexMode = 'docs-late'; yandexOrderIds = [123456, 234567];
    const beforeLateClicks = documentClicks;
    const lateWorker = context.serviceWorkers().find(worker => worker.url() === `chrome-extension://${id}/background.js`);
    await lateWorker.evaluate(() => {
      const create = chrome.tabs.create.bind(chrome.tabs), get = chrome.tabs.get.bind(chrome.tabs);
      globalThis.lateDocumentTab = undefined;
      chrome.tabs.create = async details => {
        const tab = await create(details);
        if (details.url === 'https://market.yandex.ru/my/order/234567') {
          globalThis.lateDocumentTab = tab.id;
          await new Promise(resolve => { globalThis.releaseLateDocument = resolve; });
        }
        return tab;
      };
      chrome.tabs.get = async id => {
        if (id === globalThis.lateDocumentTab) throw new Error('Synthetic inspection unavailable');
        return get(id);
      };
    });
    const lateStarted = await command({ action: 'start', source: 'yandex', profile: 'personal' });
    let lateDone;
    for (let attempt = 0; attempt < 280; attempt++) {
      lateDone = await command({ action: 'status', source: 'yandex' });
      if (lateDone.job.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(lateDone.job.status, 'completed', JSON.stringify(lateDone));
    assert.equal(lateDone.job.result.rows.length, 1);
    assert.equal(lateDone.job.result.stats.domReceiptOrdersAttempted, 1);
    await command({ action: 'ack', id: lateStarted.job.id });
    await lateWorker.evaluate(() => globalThis.releaseLateDocument());
    let registry;
    for (let attempt = 0; attempt < 60; attempt++) {
      registry = (await page.evaluate(() => chrome.storage.local.get('kupleno-next-yandex-document-tabs')))['kupleno-next-yandex-document-tabs'];
      if (registry?.length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(registry.length, 1, 'Late ownership persists after ACK despite unavailable inspection');
    assert.equal(registry[0].ownerJobId, lateStarted.job.id);
    assert.equal(registry[0].orderId, '234567');
    assert.equal(documentClicks, beforeLateClicks, 'Late creation cannot click documents after ACK');
    const untracked = await page.evaluate(() => chrome.tabs.create({ url: 'https://market.yandex.ru/my/order/234567', active: false }));
    await restartWorker();
    assert.equal(await page.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), registry[0].tabId), false, 'Restart cleans the tracked ordinary order tab');
    assert.equal(await page.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), untracked.id), true, 'Identical untracked user tab is preserved');
    assert.deepEqual((await page.evaluate(() => chrome.storage.local.get('kupleno-next-yandex-document-tabs')))['kupleno-next-yandex-document-tabs'], []);
    await page.evaluate(id => chrome.tabs.remove(id), untracked.id);
    yandexMode = 'normal'; yandexOrderIds = [123456];
    console.log('PASS: document fallback reads actual hrefs; late ACK ownership survives inspection failure and restart cleans only tracked tabs.');
    console.log('PASS: owned DOM fallback unions routing IDs; delayed never-disabled load-more does not hammer; fatal/cancel stop; partial receipt references stay separate.');
    // Body consumption obeys the provider abort signal; header HTML/auth must survive a timeout.
    for (const bodyMode of ['html', 'auth']) {
      yandexMode = 'normal'; yandexOrderIds = [123456];
      const bodyWorker = context.serviceWorkers().find(worker => worker.url() === `chrome-extension://${id}/background.js`);
      await bodyWorker.evaluate(bodyMode => {
        const execute = chrome.scripting.executeScript.bind(chrome.scripting);
        globalThis.bodyTimeoutCalls = 0;
        globalThis.restoreBodyTimeoutFixture = () => { chrome.scripting.executeScript = execute; };
        chrome.scripting.executeScript = async details => {
          if (details.world !== 'MAIN' || !String(details.args?.[0]).includes('resolveConsolidationOrders')) return execute(details);
          globalThis.bodyTimeoutCalls++;
          await execute({ target: details.target, world: 'MAIN', args: [bodyMode], func: mode => {
            const fetch = window.fetch, timer = window.setTimeout;
            window.restoreBodyTimeoutPage = () => { window.fetch = fetch; window.setTimeout = timer; };
            window.setTimeout = (fn, delay, ...args) => timer(fn, delay > 20000 && delay <= 25000 ? 50 : delay, ...args);
            window.fetch = async (_input, options) => new Response(new ReadableStream({ start(controller) { options.signal.addEventListener('abort', () => controller.error(new DOMException('Synthetic body aborted', 'AbortError')), { once: true }); } }), { status: mode === 'auth' ? 403 : 200, headers: { 'content-type': mode === 'html' ? 'text/html' : 'application/json' } });
          } });
          try { return await execute(details); }
          finally { await execute({ target: details.target, world: 'MAIN', func: () => window.restoreBodyTimeoutPage() }); }
        };
      }, bodyMode);
      try {
        const bodyFailure = await failedYandex(await command({ action: 'start', source: 'yandex', profile: 'personal' }));
        assert.equal(await bodyWorker.evaluate(() => globalThis.bodyTimeoutCalls), 1);
        assert.equal(bodyFailure.failureStats.transientRetries, 0);
        if (bodyMode === 'html') assert.equal(bodyFailure.failureStats.providerHtmlResponses, 1);
      } finally { await bodyWorker.evaluate(() => globalThis.restoreBodyTimeoutFixture()); }
    }
    // A lost MAIN reply must settle before one retry; no abort ACK means no retry/archive.
    for (const timeoutMode of ['safe', 'absent', 'html', 'auth']) {
      const acknowledge = timeoutMode === 'safe';
      yandexMode = 'normal'; yandexOrderIds = acknowledge ? [123456] : [123456, 234567];
      const timeoutWorker = context.serviceWorkers().find(worker => worker.url() === `chrome-extension://${id}/background.js`);
      await timeoutWorker.evaluate(timeoutMode => {
        const acknowledge = timeoutMode === 'safe';
        const execute = chrome.scripting.executeScript.bind(chrome.scripting);
        globalThis.timeoutFixtureCalls = 0; let lost = false;
        globalThis.restoreTimeoutFixture = () => { chrome.scripting.executeScript = execute; };
        chrome.scripting.executeScript = async details => {
          if (details.world === 'MAIN' && typeof details.args?.[0] === 'string' && details.args[0].includes('resolveOrderReceiptsByOrderId')) {
            globalThis.timeoutFixtureCalls++;
            const order = JSON.parse(details.args[1]).params[0].orderId;
            if (!lost && order === (acknowledge ? 123456 : 234567)) {
              lost = true;
              await execute(details);
              if (timeoutMode !== 'absent') await execute({ target: details.target, world: 'MAIN', args: [details.args[3], timeoutMode], func: (id, mode) => {
                // Synthetic outstanding read: abort must settle before the ACK returns its observed metadata.
                let settle; const settled = new Promise(resolve => { settle = resolve; });
                window.__kuplenoYandexReads ||= new Map();
                window.__kuplenoYandexReads.set(id, { abort: () => { window.__kuplenoYandexReads.delete(id); settle(); }, settled, meta: { responseStatus: mode === 'auth' ? 403 : 200, html: mode === 'html', challenge: false, login: false, redirected: false, challengeOpened: false } });
              } });
              return new Promise(() => {});
            }
          }
          return execute(details);
        };
      }, timeoutMode);
      try {
        await command({ action: 'start', source: 'yandex', profile: 'personal' });
        let timeoutDone;
        for (let attempt = 0; attempt < 380; attempt++) {
          timeoutDone = await command({ action: 'status', source: 'yandex' });
          if (timeoutDone.job.status !== 'running') break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(timeoutDone.job.status, 'completed', JSON.stringify(timeoutDone));
        assert.equal(timeoutDone.job.result.rows.length, 1);
        assert.equal(await timeoutWorker.evaluate(() => globalThis.timeoutFixtureCalls), 2);
        assert.equal(timeoutDone.job.result.stats.transientRetries, acknowledge ? 1 : 0);
        assert.equal(timeoutDone.job.result.stats.incomplete, !acknowledge);
        if (timeoutMode === 'html') assert.equal(timeoutDone.job.result.stats.providerHtmlResponses, 1);
        await command({ action: 'ack', id: timeoutDone.job.id });
      } finally { await timeoutWorker.evaluate(() => globalThis.restoreTimeoutFixture()); }
    }
    console.log('PASS: outer MAIN timeout retries once only after settled ACK; missing ACK stops queued work without archive or retry.');
    // The captured client context is a fallback; fresh DOM values still take precedence.
    yandexMode = 'normal'; yandexOrderIds = [123456];
    for (const phase of ['empty', 'fresh', 'absent']) {
      headerPhase = phase;
      const headerWorker = context.serviceWorkers().find(worker => worker.url() === `chrome-extension://${id}/background.js`);
      await headerWorker.evaluate(phase => {
        const execute = chrome.scripting.executeScript.bind(chrome.scripting);
        globalThis.restoreHeaderFixture = () => { chrome.scripting.executeScript = execute; };
        chrome.scripting.executeScript = async details => {
          if (details.world === 'MAIN') await execute({ target: details.target, world: 'MAIN', args: [phase], func: phase => {
            const node = document.getElementById('synthetic-header-context');
            if (phase === 'empty') node?.remove();
            if (phase === 'fresh' && node) node.textContent = JSON.stringify({ sk: 'fresh-sk-secret', '-version': 'fresh-version', marketFrontGlue: 'fresh-glue', page: 'market:orders:fresh' });
          } });
          return execute(details);
        };
      }, phase);
      try {
        const started = await command({ action: 'start', source: 'yandex', profile: 'personal' });
        assert.equal(started.job.status, 'running', JSON.stringify(started));
        const result = await finish('yandex');
        assert.equal(result.stats.providerLiveSkResponses > 0, phase === 'fresh');
        assert.equal(result.stats.providerContextSkResponses > 0, phase !== 'absent');
        assert.equal(result.stats.providerContextSkUsedResponses > 0, phase === 'empty');
      } finally { await headerWorker.evaluate(() => { globalThis.restoreHeaderFixture(); delete globalThis.restoreHeaderFixture; }); }
    }
    headerPhase = '';
    const durableAfterHeaders = JSON.stringify(await page.evaluate(() => chrome.storage.local.get('kupleno-next-jobs')));
    assert.ok(!/cached-sk-secret|fresh-sk-secret|cached-glue|fresh-glue|owned-tab-cursor/.test(durableAfterHeaders));
    assert.deepEqual((await saved()).state, failureBaseline.state);
    assert.deepEqual(fixtureNavigationErrors, []);
    console.log('PASS: captured header context survives DOM removal; fresh DOM wins; missing context stays absent; invalid headers rejected; tokens never persisted.');
    console.log('PASS: failed-run diagnostics survive restart/export without history writes; old warnings hidden; HTML stops the queue; login distinguished; human check URL guarded and kept without focus or token persistence.');
    console.log('PASS: hanging Ozon request becomes failed; live diagnostics visible; one attempt; cancellation remains responsive; site fetch override cannot intercept extension requests.');
    console.log('PASS: real MV3 worker/offscreen; PDF parsing; Yandex MAIN-world requests; durable result/reopen/ack; untrusted proxy request rejected. Synthetic marketplace responses only.');
  } finally {
    await context.close();
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('kupleno-collect-test-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
