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

test('keeps item totals when VAT amounts follow them in PDF layout', () => {
  const text = `Кассовый чек
01.01.2026 10:00
1. Товар первый
продолжение названия
2 x 120,00 ≡240,00
в т.ч. НДС 20% ≡40,00
ИНН продавца: 0000000000
2. Товар второй
1 x 60,00 ≡60,00
в т.ч. НДС 20% ≡10,00
3. Доставка
1 x 30,00 ≡30,00
БЕЗ НДС ≡30,00
ИТОГ ≡330,00
БЕЗ НДС ≡30,00
в т.ч. НДС 20% ≡50,00
ПОЛНЫЙ РАСЧЕТ
ПРЕДОПЛАТА ≡330,00`;
  const receipt = { id: 'fixture', url: 'https://ozon.test/fixture' };
  const rows = parseOzonReceipt(text, receipt);
  assert.deepEqual(rows.map(row => [row.title, row.amount, row.parse_quality]), [
    ['Товар первый продолжение названия', '240.00', 'complete'],
    ['Товар второй', '60.00', 'complete'],
    ['Доставка', '30.00', 'complete']
  ]);
  assert.ok(rows.every(row => row.ozon_settlement_kind === 'full'));
  const mismatch = parseOzonReceipt(text.replace('ИТОГ ≡330,00', 'ИТОГ ≡331,00'), receipt);
  assert.equal(mismatch[0]?.parse_quality, 'fallback');
  assert.equal(mismatch[0]?.raw_title, 'fallback=receipt_total_mismatch');
});

test('real item amount overrides a trailing title number but VAT preserves inline price', () => {
  const receipt = { id: 'fixture', url: 'https://ozon.test/fixture' };
  const numbered = parseOzonReceipt('1. Монитор 27\n1 x 240,00 ≡240,00\nв т.ч. НДС 20% ≡40,00\nИТОГ ≡240,00', receipt);
  assert.equal(numbered[0]?.amount, '240.00');
  assert.equal(numbered[0]?.parse_quality, 'complete');
  const inline = parseOzonReceipt('1. Товар 100,00 ₽\nв т.ч. НДС 20% ≡16,67\nИТОГ ≡100,00', receipt);
  assert.equal(inline[0]?.title, 'Товар');
  assert.equal(inline[0]?.amount, '100.00');
  assert.equal(inline[0]?.parse_quality, 'complete');
});

test('wrapped decimal product characteristics are not extra item ordinals', () => {
  const receipt = { id: 'fixture', url: 'https://ozon.test/fixture' };
  for (const detail of ['2.4 ГГц, белый', '1.5 метра, синий']) {
    const text = `01.01.2026 10:00\n1. Товар с характеристикой\n${detail}\n1 x 200,00 ≡200,00\nв т.ч. НДС 20% ≡33,33\n2. Другой товар\n1 x 80,00 ≡80,00\n3. Доставка\n1 x 20,00 ≡20,00\nИТОГ ≡300,00`;
    const rows = parseOzonReceipt(text, receipt);
    assert.deepEqual(rows.map(row => [row.title, row.amount, row.parse_quality]), [
      [`Товар с характеристикой ${detail}`, '200.00', 'complete'],
      ['Другой товар', '80.00', 'complete'], ['Доставка', '20.00', 'complete'],
    ]);
    const mismatch = parseOzonReceipt(text.replace('ИТОГ ≡300,00', 'ИТОГ ≡301,00'), receipt);
    assert.equal(mismatch[0]?.raw_title, 'fallback=receipt_total_mismatch');
  }
  const split = parseOzonReceipt('1.\nПервый товар\n≡ 50,00\n2.Второй товар\n≡ 80,00\nИТОГ ≡130,00', receipt);
  assert.deepEqual(split.map(row => [row.title, row.amount, row.parse_quality]), [['Первый товар', '50.00', 'complete'], ['Второй товар', '80.00', 'complete']]);
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
