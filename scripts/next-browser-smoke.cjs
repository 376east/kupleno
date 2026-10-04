const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function receiptPdf(stream = 'BT /F1 16 Tf 40 750 Td (Receipt total 2590.00 RUB) Tj ET') {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function main() {
  const build = path.resolve(__dirname, '../extension/next/.output/chrome-mv3');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'kupleno-next-test-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? undefined : 'chromium',
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    headless: true,
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/app.html`);
    await page.getByRole('heading', { name: /Покупки складываются/ }).waitFor();
    const backup = {
      format: 'kupleno-backup', version: 1, createdAt: '2026-09-14T12:00:00.000Z',
      rows: [
        { rowId: 'lamp', date: '2026-08-14', source: 'ozon', title: 'Лампа для чтения', amount: '2590.00', currency: 'RUB', type: 'purchase', receipt_url: 'https://example.test/receipt', category: 'Дом', profile: 'personal' },
        { rowId: 'book', date: '2026-07-09', source: 'wildberries', title: 'Книга о фотографии', amount: '1490.00', currency: 'RUB', type: 'purchase', category: 'Книги', profile: 'personal' },
        { rowId: 'refund', date: '2026-08-15', source: 'ozon', title: 'Возврат за лампу', amount: '-590.00', currency: 'RUB', type: 'refund', profile: 'personal' },
        { rowId: 'unread', date: '2026-09-01', source: 'yandex', title: 'PDF не разобран', amount: '199.99', currency: 'RUB', type: 'purchase', parse_quality: 'fallback', profile: 'personal' },
      ],
      settings: { profiles: [{ id: 'personal', name: 'Личные' }], overrides: {}, customRules: [], budgets: { '2026-09': { total: 5000 } }, refundClaims: [], warranties: [{ id: 'saved', note: 'Сохранить гарантию' }] },
      metadata: { unknownField: { nested: 'preserved' } },
    };
    const legacy = { id: 'legacy-fixture', rows: [backup.rows[0]], settings: backup.settings, metadata: { preserved: 'legacy' } };
    await page.evaluate(async snapshot => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('kupleno-storage-v1', 1);
        request.onupgradeneeded = () => { request.result.createObjectStore('snapshots', { keyPath: 'id' }); request.result.createObjectStore('meta', { keyPath: 'key' }); };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const tx = db.transaction(['snapshots','meta'], 'readwrite');
      tx.objectStore('snapshots').put(snapshot);
      tx.objectStore('meta').put({ key: 'latestSnapshotId', value: snapshot.id });
      tx.objectStore('meta').put({ key: 'dataEpoch', value: 7 });
      tx.objectStore('meta').put({ key: 'snapshotRevision', value: 9 });
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
    }, legacy);
    await page.reload();
    await page.getByRole('heading', { name: 'Обзор', exact: true }).waitFor();
    const unchanged = await page.evaluate(async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('kupleno-storage-v1'); r.onsuccess = () => resolve(r.result); });
      const result = await new Promise(resolve => { const r = db.transaction('snapshots').objectStore('snapshots').get('legacy-fixture'); r.onsuccess = () => resolve(r.result); }); db.close(); return result;
    });
    assert.deepEqual(unchanged, legacy, 'Automatic migration must leave the legacy database untouched');
    const savedState = () => page.evaluate(async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('kupleno-storage-v2'); r.onsuccess = () => resolve(r.result); });
      try {
        const tx = db.transaction(['current', 'history', 'meta']);
        const read = name => new Promise(resolve => { const r = tx.objectStore(name).getAll(); r.onsuccess = () => resolve(r.result); });
        return await Promise.all(['current', 'history', 'meta'].map(read));
      } finally { db.close(); }
    });
    const beforeInvalidImport = await savedState();
    for (const [settings, message] of [
      [{ customRules: [{ category: {} }] }, 'Некорректное поле правила: category.'],
      [{ budgets: { '2026-10': { total: true } } }, 'Некорректная сумма бюджета.'],
      [{ anomalyDismissals: { sample: 'false' } }, 'Некорректные отметки проверки покупок.'],
      [{ recurringDecisions: { sample: true } }, 'Некорректные решения по регулярным покупкам.'],
      [{ refundClaims: [{ manualMatchRowIds: ['refund', 'refund'] }] }, 'Некорректные привязки ожидаемого возврата.'],
      [{ warranties: [{ title: {} }] }, 'Некорректное название возврата или документа.'],
      [{ refundClaims: [{ expectedAmount: 0 }] }, 'Некорректная ожидаемая сумма возврата.'],
      [{ warranties: [{ id: 'same', rowId: 'purchase-a' }, { id: 'same', rowId: 'purchase-b' }] }, 'Некорректный или повторный идентификатор документа.']
    ]) for (const version of [1, 2]) {
      const invalidState = { rows: backup.rows, settings, metadata: {} };
      const invalid = version === 1 ? { format: 'kupleno-backup', version, ...invalidState }
        : { format: 'kupleno-backup', version, state: invalidState };
      await page.locator('input[type=file]').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
      await page.getByRole('alert').getByText(message, { exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0, 'Invalid import must not offer confirmation');
      assert.deepEqual(await savedState(), beforeInvalidImport, 'Rejected import must retain current data, history and revision');
      await page.getByRole('button', { name: 'Скрыть', exact: true }).click();
    }
    for (const [patch, message] of [[{ category: {} }, 'Некорректное поле покупки: category.'], [{ excluded: 'false' }, 'Некорректная отметка исключения покупки.']]) for (const version of [1, 2]) {
      const invalidState = { rows: [{ ...backup.rows[0], ...patch }], settings: backup.settings, metadata: {} };
      const invalid = version === 1 ? { format: 'kupleno-backup', version, ...invalidState } : { format: 'kupleno-backup', version, state: invalidState };
      await page.locator('input[type=file]').setInputFiles({ name: 'invalid-row.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
      await page.getByRole('alert').getByText(message, { exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.deepEqual(await savedState(), beforeInvalidImport, 'Rejected purchase field must retain data/history/version');
      await page.getByRole('button', { name: 'Скрыть', exact: true }).click();
    }
    await page.locator('input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await page.getByRole('dialog').getByRole('button', { name: 'Загрузить историю', exact: true }).click();
    await page.getByRole('heading', { name: 'Обзор', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Покупки', exact: true }).click();
    const search = page.getByRole('searchbox');
    await search.pressSequentially('Лампа');
    assert.equal(await search.inputValue(), 'Лампа');
    assert.equal(await search.evaluate(el => el === document.activeElement), true, 'Typing must retain focus');
    await page.getByRole('button', { name: 'Лампа для чтения', exact: true }).click();
    assert.equal(await page.getByRole('link', { name: 'Открыть оригинал чека' }).getAttribute('href'), 'https://example.test/receipt');
    await page.locator('.local-receipt summary').click();
    await page.locator('.local-receipt input[type=file]').setInputFiles({ name: 'receipt.pdf', mimeType: 'application/pdf', buffer: receiptPdf() });
    await page.getByLabel('Текст чека', { exact: true }).filter({ hasText: 'Receipt total 2590.00 RUB' }).waitFor();
    await page.getByLabel('Заметка').fill('На рабочем столе');
    await page.getByLabel('Категория', { exact: true }).fill('Освещение');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByText('Освещение · На рабочем столе', { exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Лампа для чтения', exact: true }).waitFor();
    await page.getByText('Освещение · На рабочем столе', { exact: true }).waitFor();
    await page.getByRole('link', { name: 'Настройки', exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать копию', exact: true }).click()]);
    const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    assert.equal(exported.version, 2);
    assert.equal(exported.state.settings.overrides.lamp.note, 'На рабочем столе');
    assert.deepEqual(exported.state.metadata.unknownField, backup.metadata.unknownField);
    assert.deepEqual(exported.state.settings.budgets, backup.settings.budgets);
    assert.deepEqual(exported.state.settings.warranties, backup.settings.warranties);
    assert.deepEqual(exported.state.rows, backup.rows, 'Manual edits must not mutate source rows');
    await page.getByRole('button', { name: 'История изменений', exact: true }).click();
    await page.getByRole('button', { name: 'Восстановить', exact: true }).nth(1).click();
    await page.getByRole('link', { name: 'Покупки', exact: true }).click();
    await page.getByRole('button', { name: 'Лампа для чтения', exact: true }).click();
    assert.equal(await page.getByLabel('Заметка').inputValue(), '');
    await page.getByRole('button', { name: 'Ожидать возврат', exact: true }).click();
    await page.getByRole('button', { name: 'Сохранить ожидание', exact: true }).click();
    await page.getByRole('link', { name: 'Контроль', exact: true }).click();
    await page.getByRole('link', { name: 'Возвраты', exact: true }).click();
    await page.getByRole('heading', { name: 'Ожидаемые возвраты', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Покупка', exact: true }).click();
    await page.getByRole('button', { name: 'Добавить гарантию', exact: true }).click();
    await page.getByLabel('Действует до', { exact: true }).fill('2027-08-14');
    await page.getByRole('button', { name: 'Сохранить документ', exact: true }).click();
    await page.getByRole('link', { name: 'Гарантии и чеки', exact: true }).click();
    await page.getByRole('link', { name: 'Открыть документ' }).waitFor();
    await page.getByRole('link', { name: 'Бюджет', exact: true }).click();
    await page.getByLabel('Месяц', { exact: true }).fill('2026-08');
    await page.getByLabel('Общий бюджет, ₽', { exact: true }).fill('3000');
    await page.getByRole('button', { name: 'Сохранить бюджет', exact: true }).click();
    await page.getByText('Осталось по сохранённому плану', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Сохранить итог месяца', exact: true }).click();
    await page.getByText('Сохранён', { exact: true }).waitFor();
    await page.getByRole('link', { name: 'Настройки', exact: true }).click();
    const [afterControl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать копию', exact: true }).click()]);
    const controlled = JSON.parse(await fs.readFile(await afterControl.path(), 'utf8')).state;
    await page.getByRole('button', { name: 'Настроить профили', exact: true }).click();
    await page.getByLabel('Новый профиль', { exact: true }).fill('Работа');
    await page.getByRole('button', { name: 'Добавить профиль', exact: true }).click();
    await page.getByRole('dialog').locator('strong').filter({ hasText: /^Работа$/ }).waitFor();
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.getByRole('button', { name: 'Свои правила (0)', exact: true }).click();
    await page.getByRole('button', { name: 'Добавить правило', exact: true }).click();
    await page.getByLabel('Слова или фразы через запятую', { exact: true }).pressSequentially('лампа, свет');
    assert.equal(await page.getByLabel('Слова или фразы через запятую', { exact: true }).inputValue(), 'лампа, свет');
    await page.getByRole('dialog').getByLabel('Категория', { exact: true }).fill('Освещение');
    await page.getByRole('button', { name: 'Сохранить правило', exact: true }).click();
    await page.getByRole('dialog').getByText('Освещение', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.getByRole('link', { name: 'Покупки', exact: true }).click();
    await page.getByRole('button', { name: 'Лампа для чтения', exact: true }).click();
    assert.equal(await page.getByRole('dialog').getByLabel('Категория', { exact: true }).inputValue(), 'Освещение');
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Выбрать: Лампа для чтения', exact: true }).check();
    await page.getByRole('button', { name: 'Изменить выбранные (1)', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Категория', { exact: true }).fill('Подарки');
    await page.getByRole('button', { name: 'Применить к выбранным', exact: true }).click();
    await page.getByText('Подарки', { exact: true }).waitFor();
    await page.getByRole('link', { name: 'Контроль', exact: true }).click();
    await page.getByRole('link', { name: 'Проверка покупок', exact: true }).click();
    await page.getByRole('heading', { name: 'Проверка покупок', exact: true }).waitFor();
    await page.getByRole('combobox', { name: /^Что посмотреть/ }).selectOption('prices');
    await page.getByText('Подходящих покупок пока нет.', { exact: true }).waitFor();
    assert.equal(controlled.settings.refundClaims.length, 1);
    assert.equal(controlled.settings.warranties.length, 2);
    assert.equal(controlled.settings.budgets['2026-08'].total, 3000);
    assert.equal(controlled.settings.monthClosures['all\u00012026-08'].totals.netSpend, 2000);
    await page.getByRole('link', { name: 'Обзор', exact: true }).click();
    const out = process.env.KUPLENO_EVIDENCE_DIR;
    await page.locator('.notice').waitFor({ state: 'hidden', timeout: 12000 });
    for (const dark of [false, true]) {
      if (await page.locator('html').getAttribute('data-theme') !== (dark ? 'dark' : 'light')) await page.getByRole('button', { name: dark ? 'Включить тёмную тему' : 'Включить светлую тему', exact: true }).click();
      if (out) { await fs.mkdir(out, { recursive: true }); await page.screenshot({ path: path.join(out, `next-overview-${dark ? 'dark' : 'light'}.png`), fullPage: true }); }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('link', {name:'Магазины',exact:true}).click();
    const ozonPanel=page.locator('.store-panel').filter({has:page.getByRole('heading',{name:'Ozon',exact:true})});
    await ozonPanel.getByRole('button',{name:'Удалить историю',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Закрыть',exact:true}).click();
    assert.match(await ozonPanel.innerText(),/2 операций/);
    await ozonPanel.getByRole('button',{name:'Удалить историю',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Удалить историю',exact:true}).click();
    await page.getByText('История магазина удалена',{exact:true}).waitFor();
    await ozonPanel.getByText('История ещё не загружена',{exact:true}).waitFor();
    const wbPanel=page.locator('.store-panel').filter({has:page.getByRole('heading',{name:'Wildberries',exact:true})});
    assert.match(await wbPanel.innerText(),/1 операций/);
    await page.reload();
    await ozonPanel.getByText('История ещё не загружена',{exact:true}).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal page overflow on mobile');
    if (out) await page.screenshot({ path: path.join(out, 'next-mobile.png'), fullPage: true });
    const profileFixture = { ...backup, settings: {
      ...backup.settings, profiles: [{ id: 'personal', name: 'Личные' }, { id: 'work', name: 'Работа' }],
      budgets: { 'work\u00012026-10': { total: 5000 } },
      monthClosures: { 'work\u00012026-09': { status: 'closed', totals: { netSpend: 100 } } }
    }, rows: backup.rows.map(row => ({ ...row, profile: 'work' })) };
    await page.locator('input[type=file]').setInputFiles({ name: 'profiles.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(profileFixture)) });
    await page.getByRole('dialog').getByRole('button', { name: 'Загрузить историю', exact: true }).click();
    await page.getByRole('link', { name: 'Настройки', exact: true }).click();
    await page.getByRole('button', { name: 'Настроить профили', exact: true }).click();
    const beforeProfileMerge = await savedState();
    const mergeWork = () => page.getByRole('dialog').locator('.setting-row').filter({ has: page.getByText('Работа', { exact: true }) }).getByRole('button', { name: 'Объединить с другим', exact: true }).click();
    await mergeWork();
    await page.getByRole('dialog', { name: 'Объединить профили?', exact: true }).waitFor();
    assert.match(await page.getByRole('dialog').innerText(), /Бюджеты: 1.*сохранённые итоги месяцев: 1/);
    assert.deepEqual(await savedState(), beforeProfileMerge, 'Opening confirmation must not change profiles');
    assert.equal(await page.getByRole('button', { name: 'Отмена', exact: true }).evaluate(el => el === document.activeElement), true, 'Confirmation must initially focus cancellation');
    await page.getByRole('button', { name: 'Отмена', exact: true }).press('Enter');
    await page.getByRole('dialog', { name: 'Профили покупок', exact: true }).waitFor();
    assert.deepEqual(await savedState(), beforeProfileMerge, 'Cancel must retain profiles and plans');
    await mergeWork();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await savedState(), beforeProfileMerge, 'Escape must retain profiles and plans');
    await page.getByRole('button', { name: 'Настроить профили', exact: true }).click();
    await mergeWork();
    await page.getByRole('button', { name: 'Объединить профили', exact: true }).click();
    await page.getByRole('dialog', { name: 'Профили покупок', exact: true }).waitFor();
    const mergedProfiles = await savedState();
    assert.equal(mergedProfiles[0][0].state.settings.profiles.length, 1);
    assert.ok(mergedProfiles[0][0].state.rows.every(row => row.profile === 'personal'));
    assert.deepEqual(mergedProfiles[0][0].state.settings.budgets, {});
    assert.deepEqual(mergedProfiles[0][0].state.settings.monthClosures, {});
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    const corruptCurrent = () => page.evaluate(async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('kupleno-storage-v2'); r.onsuccess = () => resolve(r.result); });
      try {
        const tx = db.transaction('current', 'readwrite');
        const store = tx.objectStore('current');
        const record = await new Promise(resolve => { const r = store.get('state'); r.onsuccess = () => resolve(r.result); });
        record.state.settings.customRules = [{ category: { broken: true } }];
        store.put(record);
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
        return record.state;
      } finally { db.close(); }
    });
    const corrupt = await corruptCurrent();
    await page.reload();
    await page.getByRole('heading', { name: 'Восстановить историю', exact: true }).waitFor();
    const beforeRecovery = await savedState();
    const [rawDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать исходные данные', exact: true }).click()]);
    assert.deepEqual(JSON.parse(await fs.readFile(await rawDownload.path(), 'utf8')).state, corrupt, 'Recovery download must preserve original fields');
    await page.locator('input[type=file]').setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    assert.deepEqual(await savedState(), beforeRecovery, 'Cancelling recovery must not write');
    await page.getByRole('button', { name: 'История изменений', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Восстановить', exact: true }).first().click();
    await page.getByRole('heading', { name: 'Настройки', exact: true }).waitFor();
    assert.deepEqual((await savedState())[0][0].state, mergedProfiles[0][0].state, 'Valid snapshot must restore normal UI');
    await corruptCurrent();
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await page.getByRole('heading', { name: 'Восстановить историю', exact: true }).waitFor();
    await page.locator('input[type=file]').setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await page.getByRole('dialog').getByRole('button', { name: 'Загрузить историю', exact: true }).click();
    await page.getByRole('heading', { name: 'Обзор', exact: true }).waitFor();
    assert.deepEqual((await savedState())[0][0].state.rows, backup.rows, 'Valid backup must restore normal UI');
    const emptyProfiles = { ...backup, settings: { ...backup.settings, profiles: [], future: { keep: true } } };
    await page.locator('input[type=file]').setInputFiles({ name: 'empty-profiles.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(emptyProfiles)) });
    await page.getByRole('dialog').getByRole('button', { name: 'Загрузить историю', exact: true }).click();
    await page.getByRole('heading', { name: 'Обзор', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Покупки', exact: true }).click();
    await page.getByRole('button', { name: 'Лампа для чтения', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Лампа для чтения', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Настройки', exact: true }).click();
    await page.getByRole('button', { name: 'Настроить профили', exact: true }).click();
    await page.getByRole('dialog').locator('strong').filter({ hasText: /^Личные покупки$/ }).waitFor();
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    const importedEmptyProfiles = (await savedState())[0][0].state;
    assert.deepEqual(importedEmptyProfiles.rows, emptyProfiles.rows);
    assert.deepEqual(importedEmptyProfiles.settings, emptyProfiles.settings, 'Fallback must not rewrite imported settings');
    for (const netSpend of [null, 0, -100, 199.99]) {
      const closedMonth = { ...backup, settings: { ...backup.settings, monthClosures: { 'all\u00012026-09': { status: 'closed', totals: netSpend === null ? null : { netSpend } } } } };
      await page.locator('input[type=file]').setInputFiles({ name: 'closed-month.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(closedMonth)) });
      await page.getByRole('dialog').getByRole('button', { name: 'Загрузить историю', exact: true }).click();
      await page.getByRole('link', { name: 'Контроль', exact: true }).click();
      await page.getByRole('link', { name: 'Бюджет', exact: true }).click();
      await page.getByLabel('Месяц', { exact: true }).fill('2026-09');
      const summary = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Итог месяца', exact: true }) });
      if (netSpend === null) {
        assert.match(await summary.innerText(), /Сумма сохранённого итога недоступна/);
        assert.equal(await summary.locator('strong').count(), 0, 'Missing saved amount must not be shown as zero');
        await summary.getByRole('button', { name: 'Открыть месяц для проверки', exact: true }).click();
        await summary.getByRole('button', { name: 'Сохранить итог месяца', exact: true }).waitFor();
      } else {
        assert.equal((await summary.locator('strong').innerText()).replace(/\s/g, ''), netSpend === 0 ? '0,00₽' : netSpend === -100 ? '-100,00₽' : '199,99₽');
        if (netSpend === 199.99) {
          assert.doesNotMatch(await summary.innerText(), /Текущий итог отличается/);
        } else {
          assert.match((await summary.innerText()).replace(/\s/g, ' '), /Текущий итог отличается: 199,99 ₽/);
          assert.deepEqual((await savedState())[0][0].state.settings.monthClosures, closedMonth.settings.monthClosures, 'Viewing changed totals must preserve the saved snapshot');
        }
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: installed MV3 build; import; focused search; receipt link; PDF worker under CSP; edit; restart; export preservation; restore; expected return; warranty; budget; month closure; light/dark/mobile.');
  } finally {
    await context.close();
    // The path comes from mkdtemp with our fixed prefix and is checked before deletion.
    assert.equal(path.dirname(profile), os.tmpdir());
    assert.ok(path.basename(profile).startsWith('kupleno-next-test-'));
    await fs.rm(profile, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { receiptPdf };
