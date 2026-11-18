import test from 'node:test';
import assert from 'node:assert/strict';
import { readOzonPayment, readWildberriesPayment, readYandexPayment } from './fiscal.ts';

const date = '2026-01-01 10:00';
const ozon = (kind: string, payment: string) => `${kind}\nИТОГ\n≡120,00\n${payment}\nФП\nФН:\n101\nФД: 202\nФПД: 303`;

test('Ozon counts split tender and gives refunds and delivery payouts a negative sign', () => {
  const payment = 'Безналичными\n≡20,00\nЗачёт предварительной оплаты\n≡100,00';
  assert.deepEqual(readOzonPayment(ozon('Приход', payment), date), { id: '101:202:303', date, paid: 2000, advance: 10000 });
  for (const kind of ['Расход', 'Возврат прихода']) {
    assert.deepEqual(readOzonPayment(ozon(kind, payment), date), { id: '101:202:303', date, paid: -2000, advance: -10000 });
  }
  assert.equal(readOzonPayment(ozon('Приход', payment.replace('≡20,00', '≡21,00')), date), undefined);
  assert.equal(readOzonPayment(ozon('Приход', 'Кредит\n≡120,00'), date), undefined);
});

test('Market verifies the fiscal identity in the response and records advance-only settlement as zero cash', () => {
  const html = '<div>Кассовый чек. Приход</div><table><tr><td>ИТОГ</td><td>120,00</td></tr><tr><td>Аванс</td><td>120,00</td></tr></table><div>ФН: 101 ФД: 202 ФП: 303</div>';
  const url = 'https://check.yandex.ru/doc?fn=000101&n=202&fpd=303';
  assert.deepEqual(readYandexPayment(html, url, date), { id: '101:202:303', date, paid: 0, advance: 12000 });
  assert.equal(readYandexPayment(html, url.replace('fpd=303', 'fpd=304'), date), undefined);
  assert.equal(readYandexPayment(html.replace('Приход', 'Заказ'), url, date), undefined);
});

test('Wildberries requires a fiscal header, supported currency and matched tender total', () => {
  const property = (label: string, value: string) => `<div class="property-name gray ">${label}</div><div class="property-value gray">${value}</div>`;
  const html = '<div class="check-header-column first">Возврат прихода<br></div>'
    + property('Итого', '120.00') + property('Электронными', '120.00')
    + property('№ ФН', '101') + property('№ ФД', '202') + property('ФПД', '303');
  assert.deepEqual(readWildberriesPayment(html, date, 'RUB'), { id: '101:202:303', date, paid: -12000, advance: 0 });
  assert.equal(readWildberriesPayment(html, date, 'BYN'), undefined);
  assert.equal(readWildberriesPayment(html.replace('Электронными', 'Неизвестно'), date, 'RUB'), undefined);
});
