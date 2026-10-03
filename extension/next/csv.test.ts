import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTable, parsePurchasesCsv, exportPurchasesCsv } from './csv.ts';

test('CSV preserves multiline and quoted text and protects formulas on export', () => {
  for (const title of ['=SUM(A1:A2)', "'=literal", 'Обычный товар, "белый"\nСтрока 2']) {
    const rows = [{ rowId: 'one', source: 'ozon', date: '2026-09-01', title, amount: '-0.10', type: 'refund' }];
    const csv = exportPurchasesCsv(rows);
    const parsed = parsePurchasesCsv(csv);
    assert.equal(parsed[0]!.title, title);
    assert.equal(parsed[0]!.amount, '-0.10');
    assert.equal(parsed[0]!.rowId, 'one');
  }
});
test('CSV rejects corrupt quotes, missing columns and foreign currency', () => {
  assert.throws(() => parseTable('"value"garbage'), /кавычки/);
  assert.throws(() => parsePurchasesCsv('date,title\n2026-01-01,Товар'), /source/);
  assert.throws(() => parsePurchasesCsv('date,source,title,amount,currency\n2026-01-01,ozon,Товар,10,USD'), /рубли/);
  assert.equal(parsePurchasesCsv('date;marketplace;title;amount\n01.09.2026;wb;Товар;0')[0]!.amount, '0.00');
});
