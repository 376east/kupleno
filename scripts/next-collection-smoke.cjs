const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { receiptPdf } = require('./next-browser-smoke.cjs');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kupleno-collect-test-'));
  const build = path.join(root, 'extension');
  await fs.cp(path.resolve(__dirname, '../extension/next/.output/chrome-mv3'), build, { recursive: true });
  // Pregrant hosts only in the disposable synthetic test extension. Shipping manifest remains optional.
  const manifest = JSON.parse(await fs.readFile(path.join(build, 'manifest.json'), 'utf8'));
  manifest.host_permissions = manifest.optional_host_permissions;
  manifest.permissions.push('cookies');
  await fs.writeFile(path.join(build, 'manifest.json'), JSON.stringify(manifest));
  const pdf = receiptPdf('BT /F1 16 Tf 40 750 Td (01.01.2026 10:00) Tj 0 -24 Td (1. Book 100.00) Tj ET');
  // Chromium offscreen targets are not intercepted by Playwright context.route.
  // Only the disposable copy gets a local network fixture, loaded before the unchanged production module.
  await fs.writeFile(path.join(build, 'test-fixtures.js'), `
  const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
  let ozonFinished = 0;
  chrome.runtime.sendMessage = (...args) => {
    const message = args[0];
    if (message?.type === 'KUPLENO_OFFSCREEN_EVENT' && message.action === 'finished' && message.result?.rows?.[0]?.source === 'ozon' && ++ozonFinished === 2) {
      // Deliver and persist the result, but lose its acknowledgement in transit.
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        args[args.length - 1] = () => callback(undefined);
        return sendMessage(...args);
      }
      return sendMessage(...args).then(() => undefined);
    }
    return sendMessage(...args);
  };
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'market.yandex.ru' && url.pathname === '/my/orders') return new Response('<a href="/my/order/123456">Order</a>');
    if (url.hostname === 'check.yandex.ru') return new Response('<table><tr><td>1</td><td>Книга</td><td>1</td><td>100,00</td></tr><tr><td>ИТОГ</td><td>100,00</td></tr></table>');
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
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
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
      if (url.pathname === '/api/resolve/') {
        if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return route.fulfill({ json: { results: [{ data: { result: 'list', collections: { orderConsolidationResult: { list: { ordersGroupsIds: [123456], pageToken: '', hasNext: false } } } } }] } });
        yandexReceiptRequests++;
        if (holdYandex) await new Promise(resolve => { releaseYandex = resolve; });
        const body = route.request().postDataJSON(); assert.equal(body.params[0].orderId, 123456);
        return route.fulfill({ json: { results: [{ data: { result: ['r'], collections: { orderReceipt: { r: { id: 'r', fiscalUrl: 'https://check.yandex.ru/test', createdAt: 1767225600, type: 'INCOME' } } } } }] } });
      }
      return route.fulfill({ contentType: 'text/html', body: '<html><a href="/my/order/123456">Order</a></html>' });
    });
    await context.route('https://check.yandex.ru/**', route => route.fulfill({ contentType: 'text/html', body: '<table><tr><td>1</td><td>Книга</td><td>1</td><td>100,00</td></tr><tr><td>ИТОГ</td><td>100,00</td></tr></table>' }));
    await context.route('https://www.wildberries.ru/**', route => route.fulfill({contentType:'text/html',body:'<html>WB test</html>'}));
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/app.html`);
    const command = message => page.evaluate(message => chrome.runtime.sendMessage({ type: 'KUPLENO_JOB', ...message }), message);
    async function finish(source) {
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
      assert.equal(result.job.result.rows.length, 1);
      assert.equal(result.job.result.rows[0].amount, '100.00');
      assert.ok(Object.values(result.job.result.stats).every(value => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))));
      if (source === 'ozon') assert.equal(result.job.result.stats.unrecognizedListResponses, 0);
      if (source === 'yandex') {
        assert.equal(result.job.result.stats.responseRootErrors, 0);
        assert.equal(result.job.result.stats.lastPageIds, 1);
        assert.equal(result.job.result.stats.lastPageHasNextKnown, true);
        assert.equal(result.job.result.stats.repeatedCursor, false);
      }
      // Result survives the app being closed/reopened, and is removed only after explicit acknowledgement.
      await page.reload();
      assert.equal((await command({ action: 'status', ...scope })).job.id, result.job.id);
      assert.deepEqual((await command({ action: 'status', ...scope })).job.result.stats, result.job.result.stats, 'Safe diagnostics survive worker delivery and app reopen');
      await command({ action: 'ack', id: result.job.id });
      assert.equal((await command({ action: 'status', ...scope })).job, null);
    }
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
    const started = await command({ action: 'start', source: 'yandex', profile: 'personal' });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(typeof started.job.marketTabId,'number');
    await finish();
    assert.equal(yandexUser.isClosed(),false);
    assert.equal(yandexReceiptRequests, 1);
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
    await page.goto(`chrome-extension://${id}/app.html`);
    const [parallelWb, parallelYandex] = await Promise.all([
      command({ action: 'start', source: 'wildberries', profile: 'personal' }),
      command({ action: 'start', source: 'yandex', profile: 'personal' })
    ]);
    assert.equal(parallelWb.ok, true); assert.equal(parallelYandex.ok, true);
    const allRunning = await command({ action: 'status' });
    assert.equal(allRunning.jobs.filter(job => job.status === 'running').length, 3);
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
    console.log('PASS: hanging Ozon request becomes failed; live diagnostics visible; one attempt; cancellation remains responsive; site fetch override cannot intercept extension requests.');
    console.log('PASS: real MV3 worker/offscreen; PDF parsing; Yandex MAIN-world requests; durable result/reopen/ack; untrusted proxy request rejected. Synthetic marketplace responses only.');
  } finally {
    await context.close();
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('kupleno-collect-test-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
