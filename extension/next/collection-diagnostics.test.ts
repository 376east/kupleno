import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionAttemptDiagnostics, readFailureStats } from './collection.ts';
import { parseBackup, serializeBackup } from './storage.mjs';

test('failed-attempt export keeps only typed diagnostics without messages, URLs or result rows', () => {
  const secret = 'private-diagnostic-secret';
  const stats = Object.freeze({ apiNonJsonResponses: 2, apiHtmlResponses: 2, incomplete: true });
  const attempt = { source: 'yandex', status: 'failed', startedAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:01:00.000Z',
    failureStats: stats, error: `https://market.yandex.ru/showcaptcha?token=${secret}`, diagnostic: secret, profile: secret,
    result: { rows: [{ title: secret }] } };
  const exported = collectionAttemptDiagnostics([attempt]);
  assert.equal(exported.available, true);
  assert.equal(exported.attempts.length, 1);
  assert.deepEqual(exported.attempts[0]?.failureStats, stats);
  assert.notEqual(exported.attempts[0]?.failureStats, stats);
  assert.ok(!JSON.stringify(exported).includes(secret));
  assert.deepEqual(stats, { apiNonJsonResponses: 2, apiHtmlResponses: 2, incomplete: true });
  assert.equal(collectionAttemptDiagnostics([{ ...attempt, source: secret }]).attempts.length, 0);
  assert.equal(collectionAttemptDiagnostics([{ ...attempt, status: secret }]).attempts.length, 0);
});

test('failure stats reject strings, unsafe counters, arrays and arbitrary URL-shaped keys', () => {
  for (const value of [null, [], { token: 'private-secret' }, { count: NaN }, { count: Infinity }, { count: -1 }, { count: 0.5 }, { count: Number.MAX_SAFE_INTEGER + 1 },
    { constructor: 1 }, { prototype: 1 }, { 'https://private.test/token': 1 }, Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`counter${index}`, 0]))]) {
    assert.equal(readFailureStats(value), undefined);
  }
  assert.deepEqual(readFailureStats({ count: 0, stopped: false }), { count: 0, stopped: false });
});

test('running jobs and failed jobs without stats remain valid backup metadata', () => {
  for (const [source, status] of [['yandex', 'running'], ['wildberries', 'failed'], ['ozon', 'completed'], ['yandex', 'cancelled']]) {
    const diagnostics = collectionAttemptDiagnostics([{ source, status, startedAt: 'invalid', updatedAt: null }]);
    const restored = parseBackup(serializeBackup({ rows: [], settings: {}, metadata: { collectionDiagnostics: diagnostics } })).state;
    assert.deepEqual(restored.metadata.collectionDiagnostics, diagnostics);
    assert.deepEqual(diagnostics.attempts, [{ source, status }]);
  }
});

test('diagnostic backup preserves history and settings even when collector status is unavailable', () => {
  const original = { rows: [{ rowId: 'synthetic', source: 'yandex', title: 'Synthetic book', date: '2026-01-01', amount: '100.00', marketplace_id: 'synthetic' }],
    settings: { customSetting: true }, metadata: { customMetadata: { kept: true } } };
  const before = structuredClone(original);
  const diagnostics = collectionAttemptDiagnostics(undefined);
  const restored = parseBackup(serializeBackup({ ...original, metadata: { ...original.metadata, collectionDiagnostics: diagnostics } })).state;
  assert.equal(diagnostics.available, false);
  assert.deepEqual(diagnostics.attempts, []);
  assert.deepEqual(restored.rows, original.rows);
  assert.deepEqual(restored.settings, original.settings);
  assert.deepEqual(restored.metadata, { ...original.metadata, collectionDiagnostics: diagnostics });
  assert.deepEqual(original, before);
});
