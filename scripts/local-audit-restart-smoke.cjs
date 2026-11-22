const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kupleno-audit-restart-'));
  const extension = path.join(root, 'extension');
  const profile = path.join(root, 'profile');
  const output = path.join(__dirname, '../extension/next/.output');
  let context;
  const launch = args => chromium.launchPersistentContext(profile, {
    channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? undefined : 'chromium',
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args,
  });
  try {
    await fs.cp(path.join(output, 'chrome-mv3'), extension, { recursive: true });
    context = await launch([`--load-extension=${extension}`]);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 8000 });
    const id = new URL(worker.url()).host;
    await worker.evaluate(async () => {
      if (chrome.runtime.getManifest().permissions.includes('downloads')) throw new Error('Normal Preview requests downloads.');
      await chrome.storage.local.set({ syntheticInstalledData: true });
    });
    await context.close();
    context = undefined;

    await fs.cp(path.join(output, 'chrome-mv3-local-audit'), extension, { recursive: true });
    await fs.writeFile(path.join(extension, 'local-audit.json'), JSON.stringify({ run: 'synthetic-restart', orderIds: ['123456'] }));
    // CLI-loaded extensions in Chromium's test harness require this flag again.
    context = await launch([`--load-extension=${extension}`]);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/app.html`);
    const restartedWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 5000 });
    assert.match(restartedWorker.url(), /\/local-audit-background[.]js$/);
    const deadline = Date.now() + 12000;
    let diagnostic;
    do {
      const { state, files } = await page.evaluate(async () => ({
        state: await chrome.storage.local.get(['syntheticInstalledData', 'kupleno-local-audit-result']),
        files: (await chrome.downloads.search({})).map(({ state, filename, error }) => ({ state, filename, error })),
      }));
      diagnostic = JSON.stringify({ state, files, workers: context.serviceWorkers().length });
      assert.equal(state.syntheticInstalledData, true);
      const file = files.find(item => item.state === 'complete');
      if (file) {
        const report = JSON.parse(await fs.readFile(file.filename, 'utf8'));
        assert.equal(report.run, 'synthetic-restart');
        assert.equal(report.status, 'permission_required');
        console.log('PASS: startup report after replacing the build in the same test profile and extension path; storage persists and absent scope is reported.');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error('Automatic restart report missing: ' + diagnostic);
  } finally {
    await context?.close();
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('kupleno-audit-restart-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
