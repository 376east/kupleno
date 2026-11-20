import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { rowId, identifyRows, effectiveRows, editOperations, removeProfile, settingsWithDefaults, applyCollectionRows } from './preferences.mjs';
import { mergeCollection } from './domain.mjs';
import { parseBackup, serializeBackup } from './storage.mjs';
const require = createRequire(import.meta.url);
require('../preferences.js');
const legacy = globalThis.KuplenoPreferences;
const row = { source: 'ozon', title: 'Кофе', amount: '109.99', date: '2026-01-01 12:30', item_index: '1', marketplace_id: 'receipt-a', currency: 'RUB', type: 'purchase' };

test('пустой список профилей получает fallback без изменения исходных данных', () => {
  const source = { rows: [row], settings: { profiles: [], future: { keep: true } }, metadata: {} };
  const before = structuredClone(source);
  const settings = settingsWithDefaults(source.settings);
  assert.deepEqual(settings.profiles, [{ id: 'personal', name: 'Личные покупки' }]);
  assert.equal(settings.dataProfile, 'personal');
  assert.equal(effectiveRows(source)[0].profile, 'personal');
  assert.deepEqual(settings.future, source.settings.future);
  assert.deepEqual(source, before);
});

test('идентичность строк и суффиксы совместимы со старой версией', () => {
  for (const sample of [row, { ...row, type: 'refund', amount: '-50.00' }, { ...row, title: 'Наушники — чёрные', source: 'wildberries' }]) {
    assert.equal(rowId(sample), legacy.stableRowId(sample));
  }
  assert.deepEqual(identifyRows([row, row]).map(row => row.rowId), legacy.withStableRowIds([row, row]).map(row => row.rowId));
  assert.equal(rowId({ ...row, rowId: 'already-linked' }), 'already-linked');
});

test('ручные категории выше правил, исходная строка не меняется', () => {
  const source = { rows: [row], settings: { customRules: [{ keywords: ['кофе'], category: 'Еда' }] }, metadata: {} };
  const edited = editOperations(source, [rowId(row)], { category: 'Подарки', note: 'Для друга' });
  assert.equal(effectiveRows(source)[0].category, 'Еда');
  assert.equal(effectiveRows(edited)[0].category, 'Подарки');
  assert.equal(source.rows[0].category, undefined);
});

test('удаление профиля переносит связи операций и документов', () => {
  const source = { rows: [{ ...row, rowId: 'one', profile: 'work' }], metadata: {}, settings: {
    profiles: [{ id: 'personal', name: 'Личные' }, { id: 'work', name: 'Работа' }], overrides: { one: { profile: 'work' } },
    refundClaims: [{ id: 'r', rowId: 'one', profile: 'work', manualMatchRowIds: ['refund-1'] }], warranties: [{ rowId: 'one', profile: 'work' }]
  } };
  const next = removeProfile(source, 'work');
  assert.equal(next.settings.refundClaims[0].profile, 'personal');
  assert.deepEqual(next.settings.refundClaims[0].manualMatchRowIds, ['refund-1']);
  assert.equal(next.settings.warranties[0].rowId, 'one');
  assert.equal(source.rows[0].profile, 'work');
});

test('при объединении профилей архивный чек остаётся доступен для дочитывания заказа', async () => {
  const { knownYandexOrderIds } = await import('./collection-state.ts');
  const archived = { ...row, rowId: 'pre', source: 'yandex', profile: 'work', yandex_order_id: '123456',
    receipt_url: 'https://check.yandex.ru/?fn=1&n=2&fpd=3', future: { keep: true } };
  const neighbour = { ...archived, rowId: 'other', profile: 'family', yandex_order_id: '234567' };
  const source = { rows: [], settlementOriginals: [archived, neighbour], metadata: {}, settings: {
    profiles: ['personal', 'work', 'family'].map(id => ({ id, name: id })),
  } };
  const merged = parseBackup(serializeBackup(removeProfile(source, 'work'))).state;
  assert.deepEqual(merged.settlementOriginals, [{ ...archived, profile: 'personal' }, neighbour]);
  assert.deepEqual(knownYandexOrderIds(merged, 'personal'), ['123456']);
  assert.deepEqual(knownYandexOrderIds(merged, 'family'), ['234567']);
  assert.equal(archived.profile, 'work');
});

test('settlement migrates annotations and purchase links while retaining original backup fields', () => {
  const prepayment = { ...row, rowId: 'pre', receipt_url: 'https://example.test/pre', ozon_order_id: 'order', ozon_settlement_kind: 'prepayment' };
  const final = { ...prepayment, rowId: 'final', receipt_url: 'https://example.test/final', date: '2026-01-02', ozon_settlement_kind: 'full' };
  const original = { rows: [prepayment], metadata: { future: true }, settings: {
    overrides: { pre: { note: 'Старая заметка', category: 'Дом', future: ['keep'] }, final: { note: 'Заметка итогового чека' } },
    warranties: [{ id: 'doc', rowId: 'pre', future: { keep: true } }],
    refundClaims: [{ id: 'claim', rowId: 'pre', manualMatchRowIds: ['refund'], future: ['keep'] }],
    future: { keep: true }
  } };
  const snapshot = structuredClone(original);
  const merged = mergeCollection(original.rows, [final], { source: 'ozon', profile: 'personal' });
  const next = applyCollectionRows(original, merged);
  assert.equal(next.rows.length, 1);
  assert.equal(next.settings.warranties[0].rowId, 'final');
  assert.equal(next.settings.refundClaims[0].rowId, 'final');
  assert.deepEqual(next.settings.refundClaims[0].manualMatchRowIds, ['refund']);
  assert.equal(next.settings.overrides.final.note, 'Заметка итогового чека');
  assert.equal(next.settings.overrides.final.category, 'Дом');
  assert.deepEqual(next.settings.overrides.pre, original.settings.overrides.pre);
  assert.deepEqual(parseBackup(serializeBackup(next)).state, next);
  assert.deepEqual(original, snapshot);
  const reset = structuredClone(next);
  delete reset.settings.overrides.final;
  const refreshed = applyCollectionRows(reset, mergeCollection(reset.rows, [], { source: 'wildberries' }));
  assert.equal(refreshed.settings.overrides.final, undefined, 'Reset must not resurrect the old annotation');
});

test('settlement resolves source/profile/receipt/item rather than overlapping raw row IDs', () => {
  const receipt = (rowId, profile, kind) => ({ ...row, rowId, profile, receipt_url: `https://example.test/${kind}`, ozon_order_id: 'order', ozon_settlement_kind: kind });
  const work = receipt('pre', 'work', 'prepayment');
  const personal = receipt('pre_2', 'personal', 'prepayment');
  const original = { rows: [work, personal], metadata: {}, settings: {
    overrides: { pre: { note: 'Рабочая' }, pre_2: { note: 'Личная' } },
    warranties: [{ rowId: 'pre', profile: 'work' }, { rowId: 'pre_2', profile: 'personal' }]
  } };
  const merged = identifyRows(mergeCollection(original.rows, [receipt('pre', 'personal', 'prepayment'), receipt('final', 'personal', 'full')], { source: 'ozon', profile: 'personal' }));
  const next = applyCollectionRows(original, merged);
  assert.equal(next.settings.overrides.final.note, 'Личная');
  assert.equal(next.settings.overrides.pre.note, 'Рабочая');
  assert.deepEqual(next.settings.warranties.map(item => item.rowId), ['pre', 'final']);
});
