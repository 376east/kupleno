import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOzonReceipt, reconcileOzonReceipts } from './ozon.ts';
// @ts-ignore Node test helper only.
import { readFile } from 'node:fs/promises';

test('parses zero price, fallback mismatch and unverified receipt', () => {
  const base = { id: 'ORDER-1-12345678-1234-1234-1234-123456789abc', url: 'https://ozon.test/receipt', orderId: 'ORDER-1' };
  const zero = parseOzonReceipt('01.01.2026 10:00\n1. Подарок 0,00 ₽\nИТОГ 0,00', base);
  assert.equal(zero[0]?.amount, '0.00');
  const mismatch = parseOzonReceipt('1. Товар 90,00 ₽\nИТОГ 100,00', base);
  assert.equal(mismatch[0]?.parse_quality, 'fallback');
  const unknown = parseOzonReceipt('1. Товар 100,00 ₽', base);
  assert.equal(unknown[0]?.parse_quality, 'unverified');
});

test('reconciles only proven same-order prepayment/final pair', () => {
  const row = (kind: string, id: string, amount = '100.00') => ({ rowId: '', source: 'ozon', date: '2026-01-01', title: 'Товар', amount, marketplace_id: id, ozon_order_id: 'ORDER-1', item_index: '1', ozon_settlement_kind: kind, type: 'purchase' });
  const result = reconcileOzonReceipts([row('prepayment', 'pre'), row('full', 'final'), { ...row('prepayment', 'other'), ozon_order_id: 'ORDER-2' }]);
  assert.equal(result.removed, 1);
  assert.equal(result.rows.length, 2);
  const oneFinal = reconcileOzonReceipts([row('prepayment', 'pre-a'), { ...row('prepayment', 'pre-b'), item_index: '1' }, row('full', 'final')]);
  assert.equal(oneFinal.removed, 1);
  assert.equal(oneFinal.rows.length, 2);
});

test('preserves unknown settlement rows without guessing a prepayment', () => {
  const row = (kind: string, id: string, index: string) => ({ rowId: '', source: 'ozon', date: '2026-01-01', title: 'Товар', amount: '100.00', marketplace_id: id, ozon_order_id: 'ORDER-1', item_index: index, ozon_settlement_kind: kind, type: 'purchase' });
  const result = reconcileOzonReceipts([row('unknown', 'early-a', '1'), row('unknown', 'early-b', '2'), row('full', 'final', '1')]);
  assert.equal(result.removed, 0);
  assert.equal(result.rows.length, 3);
});

test('full settlement wins over advance wording and title stops at amount', () => {
  const rows = parseOzonReceipt('ПОЛНЫЙ РАСЧЕТ ЗАЧЕТ АВАНСА\n1. Товар\n≡ 100,00\nслужебная строка\nИТОГ ≡ 100,00', { id: 'r', url: 'https://ozon.test/r' });
  assert.equal(rows[0]?.ozon_settlement_kind, 'full');
  assert.equal(rows[0]?.title, 'Товар');
});

test('passes every existing Ozon receipt fixture', async () => {
  const fixtures = JSON.parse(await readFile(new URL('../../fixtures/ozon-receipts.json', import.meta.url), 'utf8')) as Array<{ text: string; expected: { rows: number; amount?: string; type?: string; quality?: string } }>;
  for (const fixture of fixtures) {
    const rows = parseOzonReceipt(fixture.text, { id: 'fixture', url: 'https://ozon.test/fixture' });
    assert.equal(rows.length, fixture.expected.rows);
    if (rows.length) {
      assert.equal(rows[0]?.amount, fixture.expected.amount);
      assert.equal(rows[0]?.type, fixture.expected.type);
      assert.equal(rows[0]?.parse_quality, fixture.expected.quality);
    }
  }
});
