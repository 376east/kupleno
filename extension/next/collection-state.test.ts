import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCollectionResult, createStateUpdater, knownYandexOrderIds } from './collection-state.ts';
import type { Job } from './collection';
import type { Envelope, Expected, State, Source } from './model';
import { readUnresolvedOrderIds, collectionAttemptDiagnostics, readDocumentTabs, readYandexDocumentsResult } from './collection.ts';
import { parseBackup, serializeBackup } from './storage.mjs';
import { summarizeFiscalPayments } from './fiscal-payments.mjs';
import { clearSource } from './source-data.ts';
import { sourceHealth } from './domain.mjs';
import { removeProfile } from './preferences.mjs';

const empty = (): State => ({ rows: [], settings: {}, metadata: {} });
const job = (source: Source): Job => ({ id: `${source}-job`, source, profile: 'personal', status: 'completed', startedAt: '2026-01-01', updatedAt: '2026-01-01', message: '', progress: { done: 1, total: 1 }, result: {
  rows: [{ rowId: source, source, title: source, date: '2026-01-01', amount: '100.00', marketplace_id: source }], stats: { receipts: 1 }, warnings: []
} });

test('a job started before a profile merge refreshes the same receipt without duplicating history', () => {
  const completed = { ...job('yandex'), profile: 'work' };
  const receipt = { ...completed.result!.rows[0]!, profile: 'work', receipt_url: 'https://check.yandex.ru/?fn=1&n=2&fpd=3',
    parse_quality: 'complete', item_index: '1', yandex_order_id: '123456' };
  const state: State = { ...empty(), rows: [receipt], settings: {
    profiles: ['personal', 'work', 'family'].map(id => ({ id, name: id })),
    dataProfile: 'family', overrides: { [receipt.rowId]: { note: 'Сохранить заметку' } },
  } };
  const before = parseBackup(serializeBackup(removeProfile(state, 'work'))).state;
  completed.result!.rows = [receipt];
  const after = applyCollectionResult(before, completed);
  assert.deepEqual(after.rows, [{ ...receipt, profile: 'personal' }]);
  assert.deepEqual(after.settings.overrides, before.settings.overrides);
  assert.equal(after.settings.dataProfile, 'family');
  assert.deepEqual(knownYandexOrderIds(after, 'personal'), ['123456']);
  assert.equal(applyCollectionResult(after, completed), after);
});

test('fiscal payments survive a repeat, partial collection and backup without counting the advance twice', () => {
  const ozon = job('ozon');
  const date = '2026-01-01 10:00';
  const first = { id: '101:1:301', date, paid: 10000, advance: 0 };
  const settlement = { id: '101:2:302', date, paid: 2000, advance: 10000 };
  const refund = { id: '101:3:303', date, paid: -2000, advance: 0 };
  ozon.result!.fiscalPayments = [first, settlement, refund, settlement];
  const saved = applyCollectionResult(empty(), ozon);
  const repeat = { ...ozon, id: 'later', result: { ...ozon.result!, fiscalPayments: [settlement], stats: { incomplete: true } } };
  const later = applyCollectionResult(saved, repeat);
  const yandex = job('yandex');
  yandex.result!.fiscalPayments = [first];
  const both = applyCollectionResult(later, yandex);
  const restored = parseBackup(serializeBackup(both)).state;
  assert.deepEqual(restored.fiscalPayments, both.fiscalPayments);
  assert.deepEqual(summarizeFiscalPayments(restored.fiscalPayments!, 'ozon'), { paid: 12000, refunded: 2000, advance: 10000, count: 3, net: 10000 });
  assert.equal(summarizeFiscalPayments(restored.fiscalPayments!, 'yandex')?.net, 10000);
  assert.deepEqual(clearSource(restored, 'ozon').fiscalPayments, [{ ...first, source: 'yandex' }]);
  assert.equal(parseBackup(serializeBackup(empty())).state.fiscalPayments, undefined);
  assert.throws(() => serializeBackup({ ...both, fiscalPayments: [{ ...first, source: 'ozon', paid: 0.5 }] }), /оплаты по чекам/);
});

test('Yandex cannot report a complete refresh when previously saved fiscal documents disappeared', () => {
  const completed = job('yandex');
  const first = 'https://check.yandex.ru/?fn=1&n=2&fpd=3';
  const old = 'https://check.yandex.ru/?fn=1&n=4&fpd=5';
  const row = completed.result!.rows[0]!;
  const archived = 'https://check.yandex.ru/?fn=1&n=8&fpd=9';
  const state: State = { ...empty(), settlementOriginals: [{ ...row, rowId: 'archived', receipt_url: archived }], rows: [
    { ...row, rowId: 'first', receipt_url: first },
    { ...row, rowId: 'missing', receipt_url: old },
    { ...row, rowId: 'other-profile', profile: 'work', receipt_url: 'https://check.yandex.ru/?fn=1&n=6&fpd=7' },
    { ...row, rowId: 'legacy-without-fiscal-id', receipt_url: 'https://check.yandex.ru/legacy' },
  ] };
  const aliased = 'https://check.yandex.ru/?fpd=3&fn=01&n=2';
  completed.result!.rows = [{ ...row, rowId: 'refreshed-first', receipt_url: aliased }];
  const saved = applyCollectionResult(state, completed);
  const partial = sourceHealth('yandex', saved.metadata);
  assert.equal(partial.state, 'partial');
  assert.equal(partial.stats.appliedKnownReceiptsMissing, 2);
  assert.match(partial.warnings[0]!, /не прочитано ранее сохранённых чеков — 2/);
  assert.equal(saved.rows.find(row => row.rowId === 'missing')?.receipt_url, old);
  assert.deepEqual(saved.settlementOriginals, state.settlementOriginals);
  assert.equal(completed.result!.stats.incomplete, undefined);

  const repaired = applyCollectionResult(saved, { ...completed, id: 'repaired', result: {
    ...completed.result!, rows: [...completed.result!.rows, { ...row, rowId: 'missing', receipt_url: old }, { ...row, rowId: 'archived', receipt_url: archived }],
  } });
  assert.equal(sourceHealth('yandex', repaired.metadata).state, 'ready');
  assert.equal(sourceHealth('yandex', repaired.metadata).stats.appliedKnownReceiptsMissing, undefined);
});

test('only saved Yandex fiscal orders in the selected profile seed recovery', () => {
  const row = { ...job('yandex').result!.rows[0]!, receipt_url: 'https://check.yandex.ru/?fn=1&n=2&fpd=3' };
  const state = { ...empty(), settlementOriginals: [{ ...row, yandex_order_id: '101' }], rows: [
    { ...row, yandex_order_id: '101' }, { ...row, yandex_order_id: '999', profile: 'work' },
    { ...row, yandex_order_id: '123', import_origin: 'csv' }, { ...row, yandex_order_id: '121', receipt_url: 'https://check.yandex.ru/opaque' },
    { ...row, yandex_order_id: '102', date: '2026-02-02' }, { ...row, yandex_order_id: '090' },
  ] };
  assert.deepEqual(knownYandexOrderIds(state, 'personal'), ['102', '101']);
  assert.deepEqual(knownYandexOrderIds(state, 'work'), ['999']);
});

test('unresolved order references are bounded and source metadata preserves neighbours', () => {
  const state = empty();
  state.metadata.collection = { unresolvedOrderIdsBySource: { ozon: ['111111'] } };
  const completed = job('yandex'); completed.result!.unresolvedOrderIds = ['123456', '234567'];
  const saved = applyCollectionResult(state, completed);
  assert.deepEqual((saved.metadata.collection as { unresolvedOrderIdsBySource: unknown }).unresolvedOrderIdsBySource, { ozon: ['111111'], yandex: ['123456', '234567'] });
  assert.ok(!JSON.stringify(collectionAttemptDiagnostics([completed])).includes('234567'));
  for (const invalid of [['0'], ['-1'], ['9007199254740992'], ['https://check.yandex.ru/private'], [123456], new Array(1001).fill('123456')]) {
    assert.equal(readUnresolvedOrderIds(invalid), undefined);
    const broken = job('yandex'); broken.result!.unresolvedOrderIds = invalid as string[];
    assert.throws(() => applyCollectionResult(state, broken), /Некорректные ссылки/);
  }
});
test('failed document and receipt order references are bounded, source-specific and preserve legacy metadata', () => {
  for (const field of ['failedDocumentOrderIds', 'failedReceiptOrderIds'] as const) {
    const metadataField = `${field}BySource`;
    const state = empty();
    state.metadata.collection = { [metadataField]: { ozon: ['111111'], yandex: ['222222'] }, futureField: { retained: true } };
    const legacy = applyCollectionResult(state, job('yandex'));
    assert.deepEqual((legacy.metadata.collection as Record<string, unknown>)[metadataField], { ozon: ['111111'], yandex: ['222222'] });
    for (const ids of [['123456', '123456', '234567'], []]) {
      const completed = job('yandex'); completed.result![field] = ids;
      const saved = applyCollectionResult(state, completed);
      assert.deepEqual((saved.metadata.collection as Record<string, unknown>)[metadataField], { ozon: ['111111'], yandex: [...new Set(ids)] });
      assert.deepEqual((saved.metadata.collection as Record<string, unknown>).futureField, { retained: true });
      assert.ok(!JSON.stringify(collectionAttemptDiagnostics([completed])).includes('234567'));
    }
    for (const invalid of [['0'], ['-1'], ['9007199254740992'], ['https://check.yandex.ru/private'], [123456], new Array(1001).fill('123456'), null, {}]) {
      const broken = job('yandex'); broken.result![field] = invalid as string[];
      assert.throws(() => applyCollectionResult(state, broken), /Некорректные ссылки/);
    }
    const foreign = job('ozon'); foreign.result![field] = [];
    assert.throws(() => applyCollectionResult(state, foreign), /Некорректные ссылки/);
  }
});

function memoryStore(initial: Envelope | null = { state: empty(), revision: 0, epoch: 0 }) {
  let value = initial;
  return {
    read: async () => value && structuredClone(value),
    readRecovery: async () => ({ revision: value?.revision || 0, epoch: value?.epoch || 0 }),
    write: async (state: State, expected: Expected) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(expected.expectedRevision, value?.revision || 0);
      assert.equal(expected.expectedEpoch, value?.epoch || 0);
      value = { state: structuredClone(state), revision: (value?.revision || 0) + 1, epoch: value?.epoch || 0 };
      return structuredClone(value);
    }
  };
}

test('concurrent results serialize against fresh state and stay idempotent after reopen', async () => {
  const store = memoryStore();
  const update = createStateUpdater(store, () => {});
  const jobs = ['ozon', 'wildberries', 'yandex'].map(source => job(source as Source));
  const acknowledged: string[] = [];
  await Promise.all(jobs.map(finished => update(state => applyCollectionResult(state, finished)).then(() => { acknowledged.push(finished.id); })));
  const saved = (await store.read())!;
  assert.equal(saved.revision, 3);
  assert.deepEqual(saved.state.rows.map(row => row.source).sort(), ['ozon', 'wildberries', 'yandex']);
  assert.equal(acknowledged.length, 3);
  const reopened = createStateUpdater(store, () => {});
  await Promise.all(jobs.map(finished => reopened(state => applyCollectionResult(state, finished))));
  assert.deepEqual(await store.read(), saved);
});

test('failed save never acknowledges, does not poison queue, and can be retried', async () => {
  const store = memoryStore();
  const write = store.write;
  let fail = true;
  store.write = async (...args) => { if (fail) throw new Error('disk unavailable'); return write(...args); };
  const update = createStateUpdater(store, () => {});
  let ack = false;
  await assert.rejects(update(state => applyCollectionResult(state, job('ozon'))).then(() => { ack = true; }), /disk/);
  assert.equal(ack, false);
  assert.equal((await store.read())!.revision, 0);
  fail = false;
  await update(state => applyCollectionResult(state, job('wildberries')));
  await update(state => applyCollectionResult(state, job('ozon')));
  assert.equal((await store.read())!.state.rows.length, 2);
});

test('application counts record the actual source/profile base without changing collector stats', () => {
  const finished = job('yandex');
  const original = { rowId: 'old', source: 'yandex', profile: 'personal', title: 'old', date: '2026-01-01', amount: '100.00', marketplace_id: 'old' };
  const state: State = { ...empty(), rows: [original, { ...original, rowId: 'work', profile: 'work' }, { ...original, rowId: 'ozon', source: 'ozon' }],
    settlementOriginals: [original, { ...original, profile: 'work' }] };
  const result = applyCollectionResult(state, finished);
  const collection = result.metadata.collection as { stats: Record<string, Record<string, number | boolean>> };
  assert.deepEqual(collection.stats.yandex, { receipts: 1, appliedRowsBefore: 1, appliedRowsReceived: 1, appliedRowsAfter: 2, appliedArchivedRowsBefore: 1 });
  assert.deepEqual(finished.result!.stats, { receipts: 1 });
  assert.deepEqual(result.settlementOriginals, state.settlementOriginals);
  const cleared = applyCollectionResult(empty(), finished).metadata.collection as typeof collection;
  assert.equal(cleared.stats.yandex!.appliedRowsBefore, 0);
  assert.equal(cleared.stats.yandex!.appliedRowsAfter, 1);
});

test('external revision is reread before retry and its history is preserved', async () => {
  const store = memoryStore();
  const write = store.write;
  let raced = false;
  store.write = async (state, expected) => {
    if (!raced) {
      raced = true;
      await write(applyCollectionResult(empty(), job('yandex')), expected);
      throw Object.assign(new Error('concurrent edit'), { code: 'STALE_SNAPSHOT_REVISION' });
    }
    return write(state, expected);
  };
  await createStateUpdater(store, () => {})(state => applyCollectionResult(state, job('ozon')));
  assert.deepEqual((await store.read())!.state.rows.map(row => row.source).sort(), ['ozon', 'yandex']);
});

test('clear is not retried and first collection works on an empty database', async () => {
  const store = memoryStore(null);
  const update = createStateUpdater(store, () => {});
  await update(state => applyCollectionResult(state, job('ozon')));
  assert.equal((await store.read())!.state.rows.length, 1);
  store.write = async () => { throw Object.assign(new Error('cleared'), { code: 'STALE_DATA_EPOCH' }); };
  await assert.rejects(update(state => applyCollectionResult(state, job('yandex'))), /cleared/);
  assert.equal((await store.read())!.state.rows.length, 1);
});


test('document registry and fixed result validators reject foreign identities and links', () => {
  const record = { tabId: 2, orderId: '123', ownerJobId: 'own-job' };
  assert.deepEqual(readDocumentTabs([{ ...record, secret: 'discard' }]), [record]);
  for (const value of [[{ ...record, orderId: '0' }], [{ ...record, orderId: 'https://market.yandex.ru' }], [record, record], Array(65).fill(record), [{ ...record, ownerJobId: '../foreign' }]]) assert.equal(readDocumentTabs(value), undefined);
  assert.deepEqual(readYandexDocumentsResult({ urls: ['https://check.yandex.ru/doc'], complete: true, blocked: false, secret: 'discard' }), { urls: ['https://check.yandex.ru/doc'], complete: true, blocked: false });
  for (const failureReason of ['navigation', 'button', 'dialog', 'loading', 'error', 'unrecognized', 'request']) {
    const expected = { urls: [], complete: false, blocked: false, failureReason };
    assert.deepEqual(readYandexDocumentsResult({ ...expected, url: 'https://private.test/secret', orderId: '123', html: '<p>secret</p>', error: 'secret' }), expected);
    assert.equal(readYandexDocumentsResult({ ...expected, complete: true }), undefined);
  }
  for (const failureReason of ['https://private.test/secret', '123', '<p>secret</p>', '', null, {}, 1]) assert.equal(readYandexDocumentsResult({ urls: [], complete: false, blocked: false, failureReason }), undefined);
  for (const urls of [['https://evil.test/doc'], ['https://user:secret@check.yandex.ru/doc'], ['http://check.yandex.ru/doc']]) assert.equal(readYandexDocumentsResult({ urls, complete: true, blocked: false }), undefined);
});


test('additional actual fiscal receipt preserves an existing row identity and annotations', () => {
  const completed = job('yandex');
  const original = { ...completed.result!.rows[0]!, rowId: 'immutable-fiscal-row', receipt_url: 'https://check.yandex.ru/existing?key=one', marketplace_id: 'existing:1' };
  const state: State = { rows: [original], metadata: {}, settings: { overrides: { 'immutable-fiscal-row': { note: 'Kept note', category: 'Kept category' } } } };
  completed.result!.rows = [{ ...original }, { ...original, rowId: 'new-fiscal-row', receipt_url: 'https://check.yandex.ru/distinct?key=two', marketplace_id: 'new:1' }];
  const saved = applyCollectionResult(state, completed);
  assert.equal(saved.rows.length, 2);
  assert.equal(saved.rows.find(row => row.receipt_url === original.receipt_url)?.rowId, original.rowId);
  assert.deepEqual(saved.settings.overrides?.[original.rowId], state.settings.overrides?.[original.rowId]);
});
