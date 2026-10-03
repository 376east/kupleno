// @ts-ignore Node-only test runtime.
import assert from 'node:assert/strict';
// @ts-ignore Node-only test runtime.
import test from 'node:test';
// @ts-ignore Node-only fixture read.
import { readFile } from 'node:fs/promises';
import { parseYandexReceipt, reconcileYandexReceipts } from './yandex.ts';

test('real receipt markup: decomposed Й, Итого and seller metadata', () => {
  const html = '<tr><td>2.</td><td>Полотенце<br><div>АГЕНТ</div><div>ИНН Поставщика: 0000000000</div><div>Признак способа расчета: ПОЛНЫЙ РАСЧЕТ</div></td><td>100.00</td><td>1</td><td>100.00</td></tr><tr><td>Итого</td><td>100.00</td></tr>';
  const [row] = parseYandexReceipt(html, {id:'final',url:'https://check.yandex.ru/example',orderId:'order',date:'2026-01-02'});
  assert.equal(row?.title,'Полотенце');
  assert.equal(row?.parse_quality,'complete');
  assert.equal(row?.yandex_settlement_kind,'full');
  const early={...row!,rowId:'pre',date:'2026-01-01',item_index:'1',yandex_settlement_kind:'prepayment'};
  assert.equal(reconcileYandexReceipts([early,row!]).removed,1);
  assert.equal(reconcileYandexReceipts([{...early,profile:'other'},{...row!,profile:'personal'}]).removed,0);
});
test('all existing yandex fixtures', async () => { const fixtures = JSON.parse(await readFile(new URL('../../fixtures/yandex-receipts.json', import.meta.url), 'utf8')); for (const f of fixtures) { const rows = parseYandexReceipt(f.html, { id: 'fixture', url: 'https://check.yandex.ru/x', type: f.type }); assert.equal(rows.length, f.expected.rows); if (rows.length) { const first = rows[0]!; assert.equal(first.amount, f.expected.amount); assert.equal(first.type, f.expected.type); assert.equal(first.parse_quality, f.expected.quality); } } });
test('one final does not remove two prepayments or refunds', () => { const r = (kind: string, id: string, type = 'purchase') => ({ rowId:'',source:'yandex',date:'2026-01-01',title:'Товар',amount:type==='refund'?'-100.00':'100.00',type,yandex_order_id:'o',yandex_settlement_kind:kind,item_index:'1' }); const result = reconcileYandexReceipts([r('prepayment','a'),r('prepayment','b'),r('full','c'),r('full','d','refund')]); assert.equal(result.removed,1); assert.equal(result.rows.length,3); });
