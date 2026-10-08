import test from 'node:test';
import assert from 'node:assert/strict';
import { clearSource } from './source-data.ts';
import type { State } from './model';
test('clearing one store preserves other stores and removes its linked records', () => {
  const rows=['ozon','yandex'].map(source=>({source,rowId:source,date:'2026-01-01',title:'Товар',amount:'100.00'}));
  const state:State={rows,settings:{overrides:{ozon:{note:'one'},yandex:{note:'two'}},warranties:[{rowId:'ozon'},{rowId:'yandex'}],refundClaims:[{source:'ozon'},{source:'yandex',manualMatchRowIds:['ozon','yandex']}]},metadata:{collection:{sources:['ozon','yandex'],stats:{ozon:{receipts:1},yandex:{receipts:1}},warnings:['Ozon: error','Яндекс Маркет: error']}}};
  const next=clearSource(state,'ozon');
  assert.deepEqual(next.rows,[rows[1]]);
  assert.deepEqual(next.settings.overrides,{yandex:{note:'two'}});
  assert.deepEqual(next.settings.warranties,[{rowId:'yandex'}]);
  assert.deepEqual(next.settings.refundClaims,[{source:'yandex',manualMatchRowIds:['yandex']}]);
  assert.deepEqual(next.metadata.collection,{sources:['yandex'],stats:{yandex:{receipts:1}},warnings:['Яндекс Маркет: error']});
  assert.equal(state.rows.length,2);
});

test('clearing WB includes legacy rows and records without deleting other stores', () => {
  const state: State = {
    rows: ['wb', 'wildberries', 'ozon'].map(source => ({ source, rowId: source, date: '2026-01-01', title: 'Товар', amount: '100.00' })),
    settings: { overrides: { wb: { note: 'old' }, ozon: { note: 'keep' } }, warranties: [{ source: 'wb' }, { rowId: 'wb' }, { rowId: 'ozon' }], refundClaims: [{ source: 'wb' }, { source: 'ozon', manualMatchRowIds: ['wb', 'ozon'] }] }, metadata: {},
  };
  const next = clearSource(state, 'wildberries');
  assert.deepEqual(next.rows, [state.rows[2]]);
  assert.deepEqual(next.settings.overrides, { ozon: { note: 'keep' } });
  assert.deepEqual(next.settings.warranties, [{ rowId: 'ozon' }]);
  assert.deepEqual(next.settings.refundClaims, [{ source: 'ozon', manualMatchRowIds: ['ozon'] }]);
  assert.equal(state.rows.length, 3);
});
