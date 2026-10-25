// Static scenes only. The encoder adds the authored 0.25-second fades.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

(async () => {
  const project = path.resolve(process.env.KUPLENO_DEMO_PROJECT || path.join(__dirname, '../../work/demo-composition'));
  const output = path.join(project, 'frames');
  await fs.mkdir(output, { recursive: true });
  const source = await fs.readFile(path.join(project, 'index.html'), 'utf8');
  // No remote scripts are needed to capture the eight still compositions.
  const html = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const snapshot = path.join(project, 'static-scenes.html');
  await fs.writeFile(snapshot, html);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(snapshot).href);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('.clip').count(), 8);
    assert.equal(await page.locator('img').evaluateAll(images => images.every(img => img.complete && img.naturalWidth > 0)), true);
    const scenes = ['intro', 'overview', 'purchases', 'details', 'stores', 'control', 'returns', 'closing'];
    const times = [2, 8, 15, 20, 26, 32, 36, 40];
    for (const [i, scene] of scenes.entries()) {
      await page.locator('.clip').evaluateAll((elements, id) => elements.forEach(el => { el.style.display = el.id === id ? 'block' : 'none'; }), scene);
      await page.screenshot({ path: path.join(output, `frame-${String(i).padStart(2, '0')}-at-${times[i]}s.png`) });
    }
    console.log(`PASS: eight static scenes, local fonts and screenshots: ${output}`);
  } finally {
    await browser.close();
    await fs.unlink(snapshot);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
