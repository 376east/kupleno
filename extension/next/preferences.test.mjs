import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { rowId, identifyRows, effectiveRows, editOperations, removeProfile } from './preferences.mjs';
const require = createRequire(import.meta.url);
require('../preferences.js');
const legacy = globalThis.KuplenoPreferences;
const row = { source: 'ozon', title: 'Кофе', amount: '109.99', date: '2026-01-01 12:30', item_index: '1', marketplace_id: 'receipt-a', currency: 'RUB', type: 'purchase' };

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
