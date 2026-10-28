const { chromium } = require('playwright');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const output = process.env.KUPLENO_VISION_OUTPUT;
const record = process.argv.includes('--record') || process.env.KUPLENO_VISION_RECORD === '1';
const rows = [
  ['one', '2026-09-12', '10.01', 'Тестовый светильник'],
  ['two', '2026-09-12', '10.01', 'Тестовый светильник'],
  ['refund', '2026-09-13', '-3.33', 'Тестовый частичный возврат'],
  ['small', '2026-09-14', '0.29', 'Тестовая мелочь'],
  ['excluded', '2026-09-15', '99.99', 'Тестовая исключённая покупка'],
  ['personal', '2026-09-16', '2.02', 'Тестовая личная покупка'],
].map(([rowId, date, amount, title]) => ({ rowId, date, amount, title, source: 'ozon', currency: 'RUB',
  profile: rowId === 'personal' ? 'personal' : 'work', type: rowId === 'refund' ? 'refund' : 'purchase',
  receipt_url: `https://example.test/${rowId}`, marketplace_id: rowId, parse_quality: 'complete', future: { keep: true } }));
const sample = { rows, settings: {
  profiles: [{ id: 'personal', name: 'Личные' }, { id: 'work', name: 'Работа' }],
  dataProfile: 'work', activeProfile: 'all', overrides: { excluded: { excluded: true }, one: { note: 'Синтетический набор', future: ['keep'] } },
  budgets: { 'work\u00012026-09': { total: 50.01, categories: { Дом: 20.02 }, future: true } },
  monthClosures: { 'all\u00012026-09': { status: 'closed', totals: { netSpend: 19 }, future: ['keep'] } },
  refundClaims: [{ id: 'claim', rowId: 'one', source: 'ozon', profile: 'work', title: rows[0].title,
    expectedAmount: '3.33', requestedAt: '2026-09-12', dueDate: '2026-09-30', manualMatchRowIds: ['refund'], future: true }],
  warranties: [{ id: 'doc', rowId: 'one', source: 'ozon', profile: 'work', title: 'Тестовая гарантия', kind: 'warranty',
    issuedAt: '2026-09-12', expiresAt: '2028-09-12', url: 'https://example.test/document', future: { keep: true } }],
  future: { keep: true }
}, metadata: { synthetic: true, collection: { sources: ['ozon'], stats: { ozon: { receipts: 6 } }, warnings: [], future: { keep: true } }, future: ['keep'] } };
const backup = (state, version) => JSON.stringify(version === 1 ? { format: 'kupleno-backup', version, ...state } : { format: 'kupleno-backup', version, state });
const money = text => text.replace(/\s/g, '');
(async () => {
  if (record && !output) throw new Error('Recording requires KUPLENO_VISION_OUTPUT');
  if (output) await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'kupleno-integrity-'));
  const build = path.resolve(__dirname, '../extension/next/.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(profile, { headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? undefined : 'chromium',
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`], viewport: { width: 1440, height: 1000 },
    ...(record ? { recordVideo: { dir: output, size: { width: 1440, height: 1000 } } } : {}) });
  let video, detailVideo;
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message)); video = page.video();
    const url = `chrome-extension://${new URL(worker.url()).host}/app.html`;
    const pause = async () => { if (record) await page.waitForTimeout(1500); };
    const shot = async name => { if (output) await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' }); };
    const upload = async (state, version) => page.locator('input[type=file]').first().setInputFiles({ name: `synthetic-v${version}.json`, mimeType: 'application/json', buffer: Buffer.from(backup(state, version)) });
    const confirm = () => page.getByRole('dialog').getByRole('button', { name: 'Загрузить историю', exact: true }).click();
    let savedPage = page;
    const saved = () => savedPage.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('kupleno-storage-v2'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try {
        const tx = db.transaction(['current', 'history', 'meta']);
        return await Promise.all(['current', 'history', 'meta'].map(name => new Promise((resolve, reject) => { const r = tx.objectStore(name).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); })));
      } finally { db.close(); }
    });
    await page.goto(url); await page.getByRole('heading', { name: 'История покупок', exact: true }).waitFor();
    await upload(sample, 1); await confirm(); await page.getByRole('heading', { name: 'Обзор', exact: true }).waitFor();
    assert.equal(money(await page.locator('.expense-report .kpi-value').first().innerText()), '19,00₽');
    assert.deepEqual((await page.locator('.expense-report .kpi-value').allInnerTexts()).map(money), ['19,00₽', '22,33₽', '3,33₽']);
    assert.equal((await saved())[0][0].state.rows.length, 6, 'Identical real repeat and excluded purchase remain');
    await pause(); await shot('overview-desktop');
    const before = await saved();
    const changed = { ...sample, metadata: { ...sample.metadata, retry: true } };
    await upload(changed, 2);
    await page.evaluate(() => { window.__originalIntegrityPut = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'history') throw new DOMException('Тестовый отказ записи истории', 'QuotaExceededError');
      return window.__originalIntegrityPut.apply(this, args);
    }; });
    try { await confirm(); await page.getByRole('dialog').getByRole('alert').getByText('Тестовый отказ записи истории', { exact: true }).waitFor(); }
    finally { await page.evaluate(() => { IDBObjectStore.prototype.put = window.__originalIntegrityPut; delete window.__originalIntegrityPut; }); }
    assert.deepEqual(await saved(), before, 'Failed import retains current/history/meta atomically');
    await pause(); await shot('atomic-import-error');
    await confirm(); await page.getByRole('heading', { name: 'Обзор', exact: true }).waitFor();
    assert.deepEqual((await saved())[0][0].state, changed);
    await page.getByRole('link', { name: 'Настройки', exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать копию', exact: true }).click()]);
    const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    assert.equal(exported.version, 2);
    const { collectionDiagnostics, ...exportedMetadata } = exported.state.metadata;
    assert.equal(collectionDiagnostics.available, true);
    assert.deepEqual(collectionDiagnostics.attempts, []);
    assert.ok(Number.isFinite(Date.parse(collectionDiagnostics.capturedAt)));
    assert.deepEqual({ ...exported.state, metadata: exportedMetadata }, changed, 'Export adds only the diagnostic snapshot');
    assert.deepEqual((await saved())[0][0].state, changed, 'Export never writes diagnostics into the saved history');
    await page.close();
    const reopened = await context.newPage(); detailVideo = reopened.video(); await reopened.goto(url);
    savedPage = reopened;
    // Use a separate new tab, not only a React refresh, to prove persisted state.
    await reopened.getByRole('heading', { name: 'Обзор', exact: true }).waitFor();
    assert.equal(money(await reopened.locator('.expense-report .kpi-value').first().innerText()), '19,00₽');
    reopened.on('pageerror', error => errors.push(error.message));
    await reopened.locator('.overview-filters summary').click();
    await reopened.getByRole('combobox', { name: 'Магазин', exact: true }).selectOption('ozon');
    await reopened.getByRole('combobox', { name: 'Профиль', exact: true }).selectOption('work');
    assert.equal(money(await reopened.locator('.expense-report .kpi-value').first().innerText()), '16,98₽');
    await reopened.locator('.overview-filters summary').click();
    const day = reopened.getByRole('button', { name: /^Покупки за 12 сент/ });
    await day.waitFor(); assert.equal(money(await day.locator('strong').innerText()), '20,02₽');
    await day.focus(); await reopened.keyboard.press('Enter');
    await reopened.getByRole('heading', { name: 'Покупки', exact: true }).waitFor();
    assert.equal(await reopened.getByLabel('С даты', { exact: true }).inputValue(), '2026-09-12');
    assert.equal(await reopened.getByRole('combobox', { name: 'Профиль', exact: true }).inputValue(), 'work');
    assert.equal(await reopened.locator('.purchases-table tbody tr:not(.journal-month)').count(), 2);
    if (record) await reopened.waitForTimeout(1500);
    if (output) await reopened.screenshot({ path: path.join(output, 'journal-day-desktop.png') });
    const purchase = reopened.getByRole('button', { name: 'Тестовый светильник', exact: true }).first();
    await purchase.focus();
    assert.equal(await purchase.evaluate(el => getComputedStyle(el).outlineStyle), 'solid', 'Keyboard focus stays visible');
    await reopened.keyboard.press('Enter');
    assert.equal(money(await reopened.locator('.receipt-total strong').innerText()), '10,01₽');
    assert.equal(await reopened.getByRole('link', { name: 'Открыть оригинал чека' }).getAttribute('href'), 'https://example.test/one');
    if (output) await reopened.screenshot({ path: path.join(output, 'receipt-desktop.png') });
    if (record) await reopened.waitForTimeout(1500);
    await reopened.keyboard.press('Escape');
    assert.equal(await purchase.evaluate(el => el === document.activeElement), true);
    await reopened.getByRole('link', { name: 'Обзор', exact: true }).click();
    assert.equal(money(await reopened.locator('.expense-report .kpi-value').first().innerText()), '20,02₽', 'Overview keeps the selected day and profile');
    await reopened.evaluate(async () => { const tab = await chrome.tabs.getCurrent(); await chrome.tabs.setZoom(tab.id, 2); });
    assert.equal(await reopened.evaluate(async () => { const tab = await chrome.tabs.getCurrent(); return chrome.tabs.getZoom(tab.id); }), 2);
    // ResponsiveContainer updates after ResizeObserver, not when setZoom resolves.
    await reopened.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth, null, { timeout: 5000 }).catch(async error => {
      console.error('Zoom overflow', await reopened.evaluate(() => ({ innerWidth, scrollWidth: document.documentElement.scrollWidth,
        elements: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map(el => ({ tag: el.tagName, className: String(el.className), width: el.getBoundingClientRect().width })) })));
      throw error;
    });
    assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Real browser zoom 200% fits');
    if (output) await reopened.screenshot({ path: path.join(output, 'overview-zoom-200.png') });
    await reopened.evaluate(async () => { const tab = await chrome.tabs.getCurrent(); await chrome.tabs.setZoom(tab.id, 1); });
    await reopened.setViewportSize({ width: 390, height: 844 });
    await reopened.emulateMedia({ reducedMotion: 'reduce' });
    await reopened.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth, null, { timeout: 5000 });
    for (const theme of ['light', 'dark']) {
      if (await reopened.locator('html').getAttribute('data-theme') !== theme) await reopened.getByRole('button', { name: theme === 'dark' ? 'Включить тёмную тему' : 'Включить светлую тему', exact: true }).click();
      assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (output) await reopened.screenshot({ path: path.join(output, `overview-mobile-${theme}.png`) });
    }
    // Source deletion must clear derived RAW first, and keep the DB intact if that fails.
    const mixed = structuredClone(sample);
    mixed.rows.push({ rowId: 'synthetic-yandex', source: 'yandex', profile: 'personal', date: '2026-01-01', title: 'Синтетический чек', amount: '100.00', currency: 'RUB', type: 'purchase', marketplace_id: 'synthetic-yandex' },
      { rowId: 'synthetic-wb', source: 'wildberries', profile: 'personal', date: '2026-01-01', title: 'Синтетическая покупка', amount: '50.00', currency: 'RUB', type: 'purchase', marketplace_id: 'synthetic-wb' });
    await reopened.getByRole('link', { name: 'Настройки', exact: true }).click();
    await reopened.locator('input[type=file]').first().setInputFiles({ name: 'synthetic-cache-clear.json', mimeType: 'application/json', buffer: Buffer.from(backup(mixed, 2)) });
    await reopened.getByRole('dialog').getByRole('button', { name: 'Загрузить историю', exact: true }).click();
    await reopened.getByRole('heading', { name: 'Обзор', exact: true }).waitFor();
    const cacheName = 'kupleno-yandex-receipts-v1';
    await reopened.evaluate(async name => {
      const cache = await caches.open(name);
      await cache.put('https://kupleno-yandex-receipts.invalid/v1/' + 'a'.repeat(64), new Response('<div>synthetic-raw-cache-only</div>'));
      const other = await caches.open('synthetic-other-store-cache');
      await other.put('https://example.test/other-store', new Response('Other store fixture'));
    }, cacheName);
    await reopened.getByRole('link', { name: 'Магазины', exact: true }).click();
    const yandexPanel = reopened.locator('.store-panel').filter({ has: reopened.getByRole('heading', { name: 'Яндекс Маркет', exact: true }) });
    const wbPanel = reopened.locator('.store-panel').filter({ has: reopened.getByRole('heading', { name: 'Wildberries', exact: true }) });
    await yandexPanel.getByRole('button', { name: 'Перечитать чеки', exact: true }).waitFor();
    await context.route('https://market.yandex.ru/**', route => route.abort('blockedbyclient'));
    await reopened.evaluate(() => {
      window.__cacheOriginalMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__cacheOriginalPermissionRequest = chrome.permissions.request.bind(chrome.permissions);
      chrome.permissions.request = async () => true;
      chrome.runtime.sendMessage = (message, ...args) => {
        if (message?.type === 'KUPLENO_JOB' && message.action === 'start' && message.source === 'yandex') {
          window.__cacheForceCommand = message;
          return new Promise(resolve => { window.__cacheReleaseForce = () => resolve({ ok: false, error: 'Синтетический перехват команды' }); });
        }
        return window.__cacheOriginalMessage(message, ...args);
      };
    });
    try {
      await yandexPanel.getByRole('button', { name: 'Перечитать чеки', exact: true }).click();
      await reopened.waitForFunction(() => typeof window.__cacheReleaseForce === 'function');
      assert.equal((await reopened.evaluate(() => window.__cacheForceCommand)).refreshReceipts, true);
      assert.equal(await yandexPanel.getByRole('button', { name: 'Перечитать чеки', exact: true }).isDisabled(), true);
      assert.equal(await wbPanel.getByRole('button', { name: 'Обновить покупки', exact: true }).isEnabled(), true, 'Force reread blocks only its own store');
      await reopened.evaluate(() => window.__cacheReleaseForce());
      await reopened.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'Перечитать чеки')?.disabled);
    } finally { await reopened.evaluate(() => {
      chrome.runtime.sendMessage = window.__cacheOriginalMessage; chrome.permissions.request = window.__cacheOriginalPermissionRequest;
      delete window.__cacheOriginalMessage; delete window.__cacheOriginalPermissionRequest;
    }); }
    const beforeClear = await saved();
    await worker.evaluate(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      globalThis.__restoreSyntheticCacheClear = () => { chrome.runtime.sendMessage = send; };
      chrome.runtime.sendMessage = (message, ...args) => message?.type === 'KUPLENO_OFFSCREEN' && message.action === 'clearReceiptCache'
        ? Promise.resolve({ ok: false }) : send(message, ...args);
    });
    try {
      await yandexPanel.getByRole('button', { name: 'Удалить историю', exact: true }).click();
      await reopened.getByRole('dialog').getByRole('button', { name: 'Удалить историю', exact: true }).click();
      await reopened.getByRole('dialog').getByRole('alert').getByText(/Не удалось очистить локальные копии чеков/).waitFor();
      assert.deepEqual(await saved(), beforeClear, 'Cache clear failure preserves current/history/meta and allows retry');
      assert.equal(await reopened.evaluate(name => caches.has(name), cacheName), true);
    } finally { await worker.evaluate(() => { globalThis.__restoreSyntheticCacheClear(); delete globalThis.__restoreSyntheticCacheClear; }); }
    await reopened.getByRole('dialog').getByRole('button', { name: 'Удалить историю', exact: true }).click();
    await reopened.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await reopened.evaluate(name => caches.has(name), cacheName), false);
    assert.equal(await reopened.evaluate(() => caches.has('synthetic-other-store-cache')), true, 'Source clear does not erase other CacheStorage namespaces');
    const afterClear = (await saved())[0][0].state;
    assert.deepEqual(afterClear.rows, mixed.rows.filter(row => row.source !== 'yandex'), 'Deleting Yandex preserves all other store rows and fields');
    assert.equal(afterClear.rows.some(row => row.source === 'yandex'), false);
    console.log('PASS: Yandex force-reread UI is per-store; failed cache clear preserves DB; retry clears RAW before source history and preserves other stores.');
    assert.deepEqual(errors, []);
    if (output) await fs.writeFile(path.join(output, 'scenario.json'), JSON.stringify({ synthetic: true, expectedKopecks: { all: 1900, work: 1698, day: 2002, item: 1001 }, atomicFailure: 'QuotaExceededError after current.put', backupVersions: [1, 2], newTabReopen: true, browserZoom: 2, mobile: 390, reducedMotion: true }, null, 2));
    await reopened.close();
    console.log('PASS: installed MV3; v1/v2 exact cents; atomic failure/retry; unknown fields and links; export/new-tab reopen; day/profile filters; keyboard/Escape; 200% browser zoom; mobile themes/reduced motion. Synthetic data only.');
  } finally {
    await context.close();
    if (record && video) await fs.copyFile(await video.path(), path.join(output, 'integrity-flow.webm'));
    if (record && detailVideo) await fs.copyFile(await detailVideo.path(), path.join(output, 'integrity-detail.webm'));
    assert.equal(path.dirname(profile), os.tmpdir()); assert.ok(path.basename(profile).startsWith('kupleno-integrity-'));
    await fs.rm(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
