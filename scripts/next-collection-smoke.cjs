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
  await fs.writeFile(path.join(build, 'test-fixtures.js'), `globalThis.fetch = async input => {
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
    let stallOzon = false;
    const ozonRequestPages = new Set();
    await context.route('https://www.ozon.ru/**', route => {
      if (route.request().isNavigationRequest()) return route.fulfill({contentType:'text/html',body:'<html><script>window.fetch = () => new Promise(() => {});</script><body>Receipt page</body></html>'});
      requests.push(route.request().url());
      ozonRequestPages.add(route.request().frame().page());
      if (stallOzon) return new Promise(() => {});
      return route.fulfill(route.request().url().includes('downloadCheque') ? { contentType: 'application/pdf', body: pdf } : { contentType: 'application/json', json: { cheques: [{ link: '/_action/downloadCheque?id=synthetic' }] } });
    });
    await context.route('https://market.yandex.ru/**', route => {
      const url = new URL(route.request().url()); requests.push(url.href);
      if (url.pathname === '/api/resolve/') {
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
    async function finish() {
      let result;
      const deadline = Date.now() + 30000;
      do {
        result = await command({ action: 'status' });
        if (['completed','failed','cancelled'].includes(result?.job?.status)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      assert.equal(result.job.status, 'completed', JSON.stringify(result));
      assert.equal(await page.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), result.job.marketTabId), false, 'Owned tab closes before acknowledgement');
      assert.equal(result.job.result.rows.length, 1);
      assert.equal(result.job.result.rows[0].amount, '100.00');
      // Result survives the app being closed/reopened, and is removed only after explicit acknowledgement.
      await page.reload();
      assert.equal((await command({ action: 'status' })).job.id, result.job.id);
      await command({ action: 'ack', id: result.job.id });
      assert.equal((await command({ action: 'status' })).job, null);
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
    const ozonStarted = await command({ action: 'start', source: 'ozon', profile: 'personal' });
    assert.equal(ozonStarted.ok, true, JSON.stringify(ozonStarted));
    const dedicatedId=ozonStarted.job.marketTabId;
    assert.equal(typeof dedicatedId,'number');
    const tabState=await page.evaluate(id=>chrome.tabs.get(id),dedicatedId);
    assert.equal(tabState.active,false);
    assert.equal(await page.evaluate(async () => (await chrome.tabs.query({active:true,currentWindow:true}))[0].id),activeBefore,'Collection must not steal the active tab');
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
    assert.equal(requests.filter(url => url.includes('/api/resolve/')).length, 1);
    const denied = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'KUPLENO_YANDEX_REQUEST', id: 'fake', url: 'https://evil.test/', body: '{}' }));
    assert.equal(denied.ok, false);
    stallOzon = true;
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
