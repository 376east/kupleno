import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCollectionResult, createStateUpdater } from './collection-state.ts';
import type { Job } from './collection';
import type { Envelope, Expected, State, Source } from './model';

const empty = (): State => ({ rows: [], settings: {}, metadata: {} });
const job = (source: Source): Job => ({ id: `${source}-job`, source, profile: 'personal', status: 'completed', startedAt: '2026-01-01', updatedAt: '2026-01-01', message: '', progress: { done: 1, total: 1 }, result: {
  rows: [{ rowId: source, source, title: source, date: '2026-01-01', amount: '100.00', marketplace_id: source }], stats: { receipts: 1 }, warnings: []
} });
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
