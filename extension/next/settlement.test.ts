import assert from 'node:assert/strict';
import test from 'node:test';
import { parseYandexReceipt } from './collectors/yandex.ts';
import { parseOzonReceipt } from './collectors/ozon.ts';
import { mergeCollection, summarize } from './domain.mjs';
import { applyCollectionRows, effectiveRows, identifyRows } from './preferences.mjs';
import { parseBackup, serializeBackup } from './storage.mjs';
import type { Purchase, State, Source } from './model';

const items: [string, number][] = [['Книга', 100], ['Полотенце', 200]];
function parse(source: Source, id: string, kind: string, goods: [string, number][]) {
  const total = goods.reduce((sum, [, price]) => sum + price, 0);
  const label = kind === 'prepayment' ? 'ПРЕДОПЛАТА 100%' : 'ПОЛНЫЙ РАСЧЕТ';
  if (source === 'yandex') {
    const html = goods.map(([title, price], index) => `<tr><td>${index + 1}.</td><td>${title}<div>Признак способа расчета: ${label}</div></td><td>${price}.00</td><td>1</td><td>${price}.00</td></tr>`).join('') + `<tr><td>Итого</td><td>${total}.00</td></tr>`;
    return parseYandexReceipt(html, { id, url: `https://check.yandex.ru/${id}`, orderId: 'order', date: '2026-01-01' });
  }
  const text = `${label}\n01.01.2026 10:00\n${goods.map(([title, price], index) => `${index + 1}. ${title} ${price},00 ₽`).join('\n')}\nИТОГ ${total},00`;
  return parseOzonReceipt(text, { id, url: `https://ozon.test/${id}`, orderId: 'order', date: '2026-01-01' });
}
function collect(state: State, rows: Purchase[], source: Source) {
  return applyCollectionRows(state, identifyRows(mergeCollection(state.rows, rows, { source })));
}
for (const source of ['yandex', 'ozon'] as const) {
  test(`${source}: split and reordered real receipts reconcile independently of line numbers`, () => {
    const pre = parse(source, 'pre', 'prepayment', items);
    const finals = [...parse(source, 'final-book', 'full', [items[0]!]), ...parse(source, 'final-towel', 'full', [items[1]!])];
    assert.deepEqual(pre.map(row => row.item_index), ['1', '2']);
    assert.deepEqual(finals.map(row => row.item_index), ['1', '1']);
    let state = collect({ rows: [], settings: {}, metadata: {} }, pre, source);
    state = collect(state, finals, source);
    assert.equal(summarize(effectiveRows(state)).net, 30000);
    assert.equal(state.rows.length, 2);
    state = collect(state, [...pre, ...finals], source);
    assert.equal(summarize(effectiveRows(state)).net, 30000, 'Full reread must not restore advances');
    const reordered = collect(collect({ rows: [], settings: {}, metadata: {} }, pre, source), parse(source, 'final-all', 'full', [...items].reverse()), source);
    assert.equal(summarize(effectiveRows(reordered)).net, 30000);
    const identical = [items[0]!, items[0]!];
    const preTwice = parse(source, 'pre-twice', 'prepayment', identical), finalTwice = parse(source, 'final-twice', 'full', identical);
    let repeated = collect(collect({ rows: [], settings: {}, metadata: {} }, preTwice, source), finalTwice, source);
    repeated = collect(repeated, [...preTwice, ...finalTwice], source);
    assert.equal(summarize(effectiveRows(repeated)).net, 20000, 'Same-receipt identical items retain separate consumed markers');
    assert.equal(repeated.rows.length, 2);
  });

  test(`${source}: inline annotations, exclusion and unknown JSON survive settlement, backup and reread`, () => {
    for (const version of [1, 2]) {
    const pre = { ...parse(source, 'pre', 'prepayment', [items[0]!])[0]!, note: 'Моя заметка', category: 'Моя категория', excluded: true, extraUserJson: { keep: ['original'] } };
    const saved = { rows: [pre], settings: {}, metadata: {} };
    const initial: State = parseBackup(JSON.stringify(version === 1 ? { format: 'kupleno-backup', version, ...saved } : { format: 'kupleno-backup', version, state: saved })).state;
    const before = structuredClone(initial);
    let state = collect(initial, parse(source, 'final', 'full', [items[0]!]), source);
    assert.deepEqual(initial, before);
    let effective = effectiveRows(state)[0]!;
    assert.equal(effective.note, pre.note); assert.equal(effective.category, pre.category); assert.equal(effective.excluded, true);
    assert.equal(summarize(effectiveRows(state)).net, 0);
    assert.deepEqual((state.settlementOriginals as Purchase[])[0]!.extraUserJson, pre.extraUserJson);
    state.rows[0]!.finalUserJson = { keep: true };
    state = parseBackup(serializeBackup(state)).state;
    state = collect(state, parse(source, 'final', 'full', [items[0]!]), source);
    effective = effectiveRows(state)[0]!;
    assert.equal(effective.note, pre.note); assert.equal(effective.category, pre.category); assert.equal(effective.excluded, true);
    assert.equal(summarize(effectiveRows(state)).net, 0);
    assert.deepEqual((state.settlementOriginals as Purchase[])[0]!.extraUserJson, pre.extraUserJson);
    assert.deepEqual(state.rows[0]!.finalUserJson, { keep: true });
    const finalId = state.rows[0]!.rowId;
    const existingEdit = collect({ ...initial, settings: { overrides: { [finalId]: { note: 'Правка итогового чека', category: 'Приоритетная категория', excluded: false } } } }, parse(source, 'final', 'full', [items[0]!]), source);
    assert.equal(effectiveRows(existingEdit)[0]!.note, 'Правка итогового чека');
    assert.equal(effectiveRows(existingEdit)[0]!.excluded, false);
    }
  });

  test(`${source}: archiving keeps the accepted JSON depth and old nested snapshots migrate`, () => {
    let extra: unknown = 'keep';
    for (let i = 0; i < 16; i++) extra = { child: extra };
    const pre = { ...parse(source, 'deep-pre', 'prepayment', [items[0]!])[0]!, extra };
    const initial = parseBackup(serializeBackup({ rows: [pre], settings: {}, metadata: {} })).state;
    const next = collect(initial, parse(source, 'deep-final', 'full', [items[0]!]), source);
    assert.deepEqual(parseBackup(serializeBackup(next)).state.settlementOriginals, [pre]);
    const shallow = parse(source, 'legacy-pre', 'prepayment', [items[0]!])[0]!;
    const final = parse(source, 'legacy-final', 'full', [items[0]!])[0]!;
    const legacy = { rows: [{ ...final, settlement_predecessor: { receipt: shallow.receipt_url, item: shallow.item_index, rowId: shallow.rowId, original: shallow } }], settings: {}, metadata: {} };
    const migrated = collect(legacy, [final], source);
    assert.deepEqual(migrated.settlementOriginals, [shallow]);
    assert.equal(Object.hasOwn(migrated.rows[0]!.settlement_predecessor as object, 'original'), false);
  });

  test(`${source}: saved final inline edits outrank advance edits when only the advance is reread`, () => {
    for (const version of [1, 2]) {
      const pre = { ...parse(source, 'pre-inline', 'prepayment', [items[0]!])[0]!, note: 'PRE', category: 'PRE-CATEGORY', excluded: true };
      const final = { ...parse(source, 'final-inline', 'full', [items[0]!])[0]!, note: 'FINAL', category: 'FINAL-CATEGORY', excluded: false };
      const saved = { rows: [pre, final], settings: {}, metadata: {} };
      const initial = parseBackup(JSON.stringify(version === 1 ? { format: 'kupleno-backup', version, ...saved } : { format: 'kupleno-backup', version, state: saved })).state;
      let state = initial;
      for (let reread = 0; reread < 3; reread++) {
        state = collect(state, [pre], source);
        state = parseBackup(serializeBackup(state)).state;
        const effective = effectiveRows(state)[0]!;
        assert.equal(effective.note, 'FINAL');
        assert.equal(effective.category, 'FINAL-CATEGORY');
        assert.equal(effective.excluded, false);
        assert.equal(summarize(effectiveRows(state)).net, 10000);
      }
      const overridden = collect({ ...initial, settings: { overrides: { [final.rowId]: { note: 'OVERRIDE', category: 'OVERRIDE-CATEGORY', excluded: true } } } }, [pre], source);
      assert.equal(effectiveRows(overridden)[0]!.note, 'OVERRIDE');
      assert.equal(effectiveRows(overridden)[0]!.category, 'OVERRIDE-CATEGORY');
      assert.equal(summarize(effectiveRows(overridden)).net, 0);
    }
  });
}
