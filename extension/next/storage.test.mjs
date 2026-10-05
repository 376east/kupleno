import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { parseBackup, serializeBackup } from './storage.mjs';

const state = {
  rows: [{
    rowId: 'wb:receipt:42',
    source: 'wb',
    title: 'Тестовая покупка',
    date: '2026-09-14T10:15:00.000Z',
    amount: '001.50',
    unknownLegacyField: { keep: true }
  }],
  settings: { currency: 'RUB', unknownSetting: ['keep'] },
  metadata: { importedAt: '2026-09-14T10:20:00.000Z', unknownMetadata: 7 },
  futureTopLevelField: { preserve: true }
};

test('v2 export round-trips unknown fields and exact amount', () => {
  const parsed = parseBackup(serializeBackup(state));
  assert.equal(parsed.format, 'kupleno-backup');
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed.state, state);
  assert.equal(parsed.state.rows[0].amount, '001.50');
});

test('v1 backup remains readable without changing purchase fields', () => {
  const v1 = JSON.stringify({
    format: 'kupleno-backup',
    version: 1,
    exportedAt: '2026-09-14T10:20:00.000Z',
    createdAt: '2026-09-14T10:20:00.000Z',
    rows: state.rows,
    settings: state.settings,
    metadata: state.metadata
  });
  const parsed = parseBackup(v1);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.state, {
    rows: state.rows,
    settings: state.settings,
    metadata: state.metadata
  });
});

test('purchase fields reject UI-breaking types and misleading exclusion flags', () => {
  for (const patch of [{ category: {} }, { note: [] }, { profile: 1 }, { currency: false }, { type: {} }, { parse_quality: [] }, { excluded: 'false' }]) for (const version of [1, 2]) {
    const sample = { ...state, rows: [{ ...state.rows[0], ...patch }] };
    const backup = version === 1 ? { format: 'kupleno-backup', version, ...sample } : { format: 'kupleno-backup', version, state: sample };
    assert.throws(() => parseBackup(JSON.stringify(backup)), error => error.code === 'INVALID_ROW');
  }
  for (const patch of [
    { category: null, note: null, profile: null, currency: null, type: null, parse_quality: null, excluded: null },
    { category: 'Новая категория', note: '', profile: 'future', currency: 'future', type: 'future', parse_quality: 'future', excluded: false }
  ]) {
    const sample = { ...state, rows: [{ ...state.rows[0], ...patch, future: { keep: true } }] };
    assert.deepEqual(parseBackup(serializeBackup(sample)).state, sample);
    assert.deepEqual(parseBackup(JSON.stringify({ format: 'kupleno-backup', version: 1, ...sample })).state.rows, sample.rows);
  }
});

test('backup rejects dangerous JSON keys', () => {
  assert.throws(
    () => parseBackup('{"format":"kupleno-backup","version":2,"state":{"rows":[],"settings":{"__proto__":{}},"metadata":{}}}'),
    (error) => error.code === 'UNSAFE_KEY'
  );
});

test('backup rejects corrupt settings and duplicate identities before saving', () => {
  for (const settings of [{ customRules: 'broken' }, { overrides: { x: { note: {} } } }, { profiles: [{ id: 'x', name: 'A' }, { id: 'x', name: 'B' }] }]) {
    assert.throws(() => serializeBackup({ ...state, settings }), error => error.code === 'INVALID_SETTINGS');
  }
  assert.throws(() => serializeBackup({ ...state, rows: [...state.rows, ...state.rows] }), error => error.code === 'INVALID_ROW');
});

test('selected profiles must refer to available profiles before import or write', () => {
  for (const key of ['activeProfile', 'dataProfile']) for (const value of [null, true, {}, [], '', 'deleted', ...(key === 'dataProfile' ? ['all'] : [])]) {
    const sample = { ...state, settings: { profiles: [{ id: 'work', name: 'Работа' }], [key]: value } };
    assert.throws(() => serializeBackup(sample), error => error.code === 'INVALID_SETTINGS');
    for (const version of [1, 2]) {
      const backup = version === 1 ? { format: 'kupleno-backup', version, ...sample } : { format: 'kupleno-backup', version, state: sample };
      assert.throws(() => parseBackup(JSON.stringify(backup)), error => error.code === 'INVALID_SETTINGS');
    }
  }
  for (const settings of [{}, { profiles: [] }, { profiles: [], dataProfile: 'personal', activeProfile: 'all' },
    { dataProfile: 'personal', activeProfile: 'personal' }, { profiles: [{ id: 'work', name: 'Работа' }], dataProfile: 'work', activeProfile: 'work', future: true }]) {
    const sample = { ...state, settings };
    assert.deepEqual(parseBackup(serializeBackup(sample)).state, sample);
    assert.deepEqual(parseBackup(JSON.stringify({ format: 'kupleno-backup', version: 1, ...sample })).state.settings, settings);
  }
});

test('import rejects malformed rule fields in both backup formats', () => {
  const invalid = [
    { category: { label: 'Еда' } }, { profile: [] }, { source: 42 }, { source: ['ozon', {}] },
    { keyword: [] }, { enabled: 'false' }, { priority: 'high' }, { amountMin: 'broken' },
    { amountMax: -1 }, { amountMin: '20', amountMax: '10' }, { match: 'contains' }
  ];
  for (const rule of invalid) for (const version of [1, 2]) {
    const sample = { ...state, settings: { customRules: [rule] } };
    const backup = version === 1 ? { format: 'kupleno-backup', version, ...sample }
      : { format: 'kupleno-backup', version, state: sample };
    assert.throws(() => parseBackup(JSON.stringify(backup)), error => error.code === 'INVALID_SETTINGS', JSON.stringify(rule));
  }
});

test('valid legacy and current rules preserve unknown fields and numeric strings', () => {
  const sample = { ...state, settings: { customRules: [
    { keyword: 'кофе', source: ['ozon', 'wb'], category: 'Еда', priority: '10', amountMin: '0', amountMax: '100.00', future: { keep: true } },
    { tokens: ['книга'], sources: ['yandex'], match: 'all', enabled: false, profile: 'personal', category: '', negativeKeywords: ['подарок'] }
  ] } };
  assert.deepEqual(parseBackup(serializeBackup(sample)).state, sample);
  assert.deepEqual(parseBackup(JSON.stringify({ format: 'kupleno-backup', version: 1, ...sample })).state,
    { rows: sample.rows, settings: sample.settings, metadata: sample.metadata });
});

test('analysis decisions reject misleading values in both backup formats', () => {
  for (const settings of [
    { anomalyDismissals: { sample: 'false' } }, { anomalyDismissals: { sample: {} } },
    { anomalyDismissals: { sample: null } }, { anomalyDismissals: { sample: 1 } },
    { recurringDecisions: { sample: true } }, { recurringDecisions: { sample: {} } },
    { recurringDecisions: { sample: 'maybe' } }, { recurringDecisions: { sample: null } }
  ]) for (const version of [1, 2]) {
    const sample = { ...state, settings };
    const backup = version === 1 ? { format: 'kupleno-backup', version, ...sample } : { format: 'kupleno-backup', version, state: sample };
    assert.throws(() => parseBackup(JSON.stringify(backup)), error => error.code === 'INVALID_SETTINGS');
  }
  const sample = { ...state, settings: { anomalyDismissals: { checked: true, unchecked: false }, recurringDecisions: { accepted: 'confirmed', hidden: 'ignored' }, future: { keep: true } } };
  assert.deepEqual(parseBackup(serializeBackup(sample)).state, sample);
});

test('monthly budgets reject corrupt amounts and containers in v1/v2', () => {
  const invalid = [true, [], { total: true }, { total: '100' }, { total: -1 },
    { categories: [] }, { categories: { Еда: 'broken' } }, { categories: { Еда: -1 } }, { categories: { Еда: null } }];
  for (const budget of invalid) for (const version of [1, 2]) {
    const sample = { ...state, settings: { budgets: { 'work\u00012026-10': budget } } };
    const backup = version === 1 ? { format: 'kupleno-backup', version, ...sample }
      : { format: 'kupleno-backup', version, state: sample };
    assert.throws(() => parseBackup(JSON.stringify(backup)), error => error.code === 'INVALID_SETTINGS', JSON.stringify(budget));
  }
});

test('budget validation retains legacy flat limits, absent total and unknown fields', () => {
  const sample = { ...state, settings: { budgets: {
    Еда: 3000, future: ['keep'],
    '2026-10': { total: null, categories: { Еда: 100.01 }, future: { keep: true } },
    'personal\u00012026-11': { categories: {} }, '2026-12': { total: 0 }
  } } };
  assert.deepEqual(parseBackup(serializeBackup(sample)).state, sample);
  assert.deepEqual(parseBackup(JSON.stringify({ format: 'kupleno-backup', version: 1, ...sample })).state.settings, sample.settings);
});

test('month closures reject UI-breaking containers, statuses and amounts before import or write', () => {
  const invalid = [true, [], 'closed', null, { status: 'clsoed' }, { status: true }, { status: null },
    { totals: [] }, { totals: 100 }, { totals: { netSpend: true } }, { totals: { netSpend: {} } },
    { totals: { netSpend: 'broken' } }];
  for (const closure of invalid) {
    const sample = { ...state, settings: { monthClosures: { 'all\u00012026-09': closure } } };
    assert.throws(() => serializeBackup(sample), error => error.code === 'INVALID_SETTINGS');
    for (const version of [1, 2]) {
      const backup = version === 1 ? { format: 'kupleno-backup', version, ...sample }
        : { format: 'kupleno-backup', version, state: sample };
      assert.throws(() => parseBackup(JSON.stringify(backup)), error => error.code === 'INVALID_SETTINGS', JSON.stringify(closure));
    }
  }
});

test('month closures preserve sparse legacy totals, refunds and future fields', () => {
  for (const totals of [undefined, null, {}, { netSpend: null }, { netSpend: 0 }, { netSpend: -100 }, { netSpend: '199.99', future: true }]) {
    const closure = { status: 'closed', future: { keep: true }, ...(totals === undefined ? {} : { totals }) };
    const sample = { ...state, settings: { monthClosures: { 'all\u00012026-09': closure, future: ['keep'] } } };
    assert.deepEqual(parseBackup(serializeBackup(sample)).state, sample);
    assert.deepEqual(parseBackup(JSON.stringify({ format: 'kupleno-backup', version: 1, ...sample })).state.settings, sample.settings);
  }
});

test('refund link validation rejects corrupt lists but preserves valid sparse legacy records', () => {
  for (const manualMatchRowIds of ['refund', 42, null, ['refund', 'refund'], [''], [false]]) {
    const sample = { ...state, settings: { refundClaims: [{ manualMatchRowIds }] } };
    assert.throws(() => parseBackup(JSON.stringify({ format: 'kupleno-backup', version: 2, state: sample })), error => error.code === 'INVALID_SETTINGS');
  }
  const sample = { ...state, settings: { refundClaims: [{ id: 'legacy', future: { keep: true } }, { id: 'current', manualMatchRowIds: ['refund-a', 'refund-b'] }] } };
  assert.deepEqual(parseBackup(serializeBackup(sample)).state, sample);
  assert.throws(() => serializeBackup({ ...state, settings: { refundClaims: [{ id: 'same' }, { id: 'same' }] } }), error => error.code === 'INVALID_SETTINGS');
});

test('import rejects malformed consumed refund and document fields', () => {
  for (const key of ['refundClaims', 'warranties']) for (const record of [
    { title: {} }, { note: [] }, { source: 42 }, { profile: false }, { rowId: {} }
  ]) for (const version of [1, 2]) {
    const sample = { ...state, settings: { [key]: [record] } };
    const backup = version === 1 ? { format: 'kupleno-backup', version, ...sample }
      : { format: 'kupleno-backup', version, state: sample };
    assert.throws(() => parseBackup(JSON.stringify(backup)), error => error.code === 'INVALID_SETTINGS');
  }
  for (const settings of [
    { refundClaims: [{ expectedAmount: {} }] }, { refundClaims: [{ expectedAmount: 0 }] },
    { refundClaims: [{ requestedAt: '2026-02-30' }] }, { refundClaims: [{ requestedAt: '2026-10-05', dueDate: '2026-10-04' }] },
    { warranties: [{ expiresAt: 'tomorrow' }] }, { warranties: [{ issuedAt: '2026-10-05', expiresAt: '2026-10-04' }] },
    { warranties: [{ url: {} }] }, { warranties: [{ kind: [] }] },
    { warranties: [{ id: '' }] }, { warranties: [{ id: null }] },
    { warranties: [{ id: 'same', rowId: 'purchase-a' }, { id: 'same', rowId: 'purchase-b' }] }
  ]) assert.throws(() => serializeBackup({ ...state, settings }), error => error.code === 'INVALID_SETTINGS');
});

test('sparse legacy records and nullable fields preserve unknown data', () => {
  const sample = { ...state, settings: {
    refundClaims: [{ future: { keep: true } }, { id: 'claim', title: 'Книга', expectedAmount: '100.01', requestedAt: '2026-10-05', dueDate: '2026-10-20', note: null, purchaseDate: null, manualMatchRowIds: [] }],
    warranties: [{ future: { keep: true } }, { id: 'saved', note: 'Сохранить' }, { id: 'doc', title: 'Гарантия', kind: 'warranty', issuedAt: '2026-10-05', expiresAt: null, rowId: null, marketplace_id: null, source: null, profile: null, url: null, future: ['keep'] }]
  } };
  assert.deepEqual(parseBackup(serializeBackup(sample)).state, sample);
  assert.deepEqual(parseBackup(JSON.stringify({ format: 'kupleno-backup', version: 1, ...sample })).state.settings, sample.settings);
});

test('IndexedDB store keeps epochs, history and legacy database read-only', async (t) => {
  const source = await readFile(new URL('./storage.mjs', import.meta.url), 'utf8');
  const domain = await readFile(new URL('./domain.mjs', import.meta.url), 'utf8');
  const server = createServer((request, response) => {
    if (request.url === '/storage.mjs' || request.url === '/domain.mjs') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(request.url === '/storage.mjs' ? source : domain);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>storage test</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const { port } = server.address();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}`);
    await page.evaluate(async ({ sampleState }) => {
      const { createStore } = await import('/storage.mjs');
      const dbName = `kupleno-next-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const fail = (message) => { throw new Error(message); };
      const expectCode = async (promise, code) => {
        try {
          await promise;
          fail(`Expected ${code}`);
        } catch (error) {
          if (error.code !== code) fail(`Expected ${code}, got ${error.code || error.message}`);
        }
      };
      const openLegacy = () => new Promise((resolve, reject) => {
        const request = indexedDB.open('kupleno-storage-v1', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('snapshots', { keyPath: 'id' });
          db.createObjectStore('history', { keyPath: 'order', autoIncrement: true });
          db.createObjectStore('meta', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const legacy = await openLegacy();
      try {
        const transaction = legacy.transaction(['snapshots', 'meta'], 'readwrite');
        transaction.objectStore('snapshots').put({ id: 'legacy-1', ...sampleState });
        transaction.objectStore('meta').put({ key: 'latestSnapshotId', value: 'legacy-1' });
        transaction.objectStore('meta').put({ key: 'dataEpoch', value: 9 });
        transaction.objectStore('meta').put({ key: 'snapshotRevision', value: 6 });
        await new Promise((resolve, reject) => {
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        legacy.close();
      }

      const store = createStore({ dbName });
      if (await store.read()) fail('A new database must not have a current state');
      const legacyRecovery = await store.readRecovery();
      if (legacyRecovery.revision !== 0 || JSON.parse(legacyRecovery.backup).state.rows[0].amount !== '001.50') fail('Legacy recovery must keep raw data and use target database version');
      const legacySnapshot = await store.readLegacy();
      if (legacySnapshot.epoch !== 9 || legacySnapshot.revision !== 6) fail('Legacy version was not read');
      if (legacySnapshot.state.rows[0].amount !== '001.50') fail('Legacy amount was changed');
      const first = await store.write(sampleState, { expectedRevision: 0, expectedEpoch: 0 });
      if (first.revision !== 1 || first.epoch !== 0) fail('First write version is wrong');
      for (const settings of [
        { customRules: [{ category: {} }] }, { budgets: { '2026-10': { total: true } } },
        { refundClaims: [{ manualMatchRowIds: ['refund', 'refund'] }] },
        { monthClosures: { 'all\u00012026-09': { status: 'clsoed' } } },
        { monthClosures: { 'all\u00012026-09': { status: 'closed', totals: { netSpend: true } } } },
        { dataProfile: 'deleted' }, { dataProfile: {} }, { activeProfile: 'deleted' }
      ]) {
        const invalid = { ...sampleState, settings };
        await expectCode(store.write(invalid, { expectedRevision: 1, expectedEpoch: 0 }), 'INVALID_SETTINGS');
        if (JSON.stringify(await store.read()) !== JSON.stringify(first)) fail('Rejected settings changed the current state');
        if ((await store.history()).length !== 1) fail('Rejected settings changed history');
      }
      await expectCode(store.write(sampleState, { expectedRevision: 0, expectedEpoch: 0 }), 'STALE_SNAPSHOT_REVISION');
      const secondState = { ...sampleState, metadata: { ...sampleState.metadata, changed: true } };
      const second = await store.write(secondState, { expectedRevision: 1, expectedEpoch: 0 });
      const history = await store.history();
      if (history.length !== 2 || history[0].revision !== 2) fail('History was not saved');
      if (history[0].rows !== sampleState.rows.length) fail('History must expose a row count, not private purchase objects');
      const restored = await store.restore(history[1].id, { expectedRevision: 2, expectedEpoch: 0 });
      if (restored.revision !== 3 || restored.state.metadata.changed !== undefined) fail('Restore failed');
      const cleared = await store.clear({ expectedRevision: 3, expectedEpoch: 0 });
      if (cleared.revision !== 4 || cleared.epoch !== 1 || cleared.state.rows.length !== 0) fail('Clear failed');
      await expectCode(store.write(sampleState, { expectedRevision: 3, expectedEpoch: 0 }), 'STALE_DATA_EPOCH');
      if ((await store.history()).length !== 0) fail('Clear did not remove history');
      await store.write(sampleState, { expectedRevision: 4, expectedEpoch: 1 });
      const corrupt = { ...sampleState, settings: { customRules: [{ category: {} }] } };
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        const tx = db.transaction('current', 'readwrite');
        tx.objectStore('current').put({ key: 'state', state: corrupt });
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
      } finally { db.close(); }
      await expectCode(store.read(), 'INVALID_SETTINGS');
      const recovery = await store.readRecovery();
      if (JSON.stringify(JSON.parse(recovery.backup).state) !== JSON.stringify(corrupt)) fail('Recovery export changed original fields');
      if (recovery.revision !== 5 || recovery.epoch !== 1) fail('Recovery version is wrong');
      await expectCode(store.write(corrupt, { expectedRevision: 5, expectedEpoch: 1 }), 'INVALID_SETTINGS');
      const repaired = await store.write(sampleState, { expectedRevision: 5, expectedEpoch: 1 });
      if (repaired.revision !== 6) fail('Recovery write did not increment version');
      await expectCode(store.write(sampleState, { expectedRevision: recovery.revision, expectedEpoch: recovery.epoch }), 'STALE_SNAPSHOT_REVISION');
      const validHistory = (await store.history()).find(item => item.revision === 5);
      const historyRecovery = await store.restore(validHistory.id, { expectedRevision: 6, expectedEpoch: 1 });
      if (historyRecovery.revision !== 7 || JSON.stringify(historyRecovery.state) !== JSON.stringify(sampleState)) fail('Recovery from valid history failed');
      await store.clear({ expectedRevision: 7, expectedEpoch: 1 });
      await expectCode(store.write(sampleState, { expectedRevision: recovery.revision, expectedEpoch: recovery.epoch }), 'STALE_DATA_EPOCH');
    }, { sampleState: state });
  } finally {
    await page.close();
    await browser.close();
  }
});
