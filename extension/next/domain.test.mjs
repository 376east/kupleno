import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyMinor, moneyDecimal, summarize, mergeCollection, largePurchases, receiptUrl } from './domain.mjs';

test('точные копейки, ноль и нераспознанная сумма различаются', () => {
  for (const minor of [0, 1, -1, 129950, -129950]) assert.equal(moneyMinor(moneyDecimal(minor)), minor);
  assert.equal(moneyMinor('1 299,50'), 129950);
  for (const value of ['', null, 'NaN', '1.2.3', '1.234', '9007199254740991']) assert.equal(moneyMinor(value), null);
});

const row = (id, extra = {}) => ({ rowId: id, source: 'wildberries', profile: 'personal', date: '2026-01-02', title: 'Товар', amount: '100.00', currency: 'RUB', marketplace_id: id, ...extra });

test('возвраты и неполные чеки учитываются, валюты не смешиваются', () => {
  const result = summarize([row('paid'), row('refund', { amount: '-20.10', type: 'refund' }), row('fallback', { amount: '7.01', parse_quality: 'fallback' }), row('gift', { amount: '0.00' }), row('dollar', { currency: 'USD' })]);
  assert.equal(result.net, 8691);
  assert.equal(result.unread, 1);
  assert.deepEqual(result.currencies, ['USD']);
  assert.equal(largePurchases([row('fallback', { parse_quality: 'fallback' })]).length, 0);
});

test('неполный сбор не удаляет историю другого магазина, профиля и старые чеки', () => {
  const original = [row('old'), row('updated'), row('work', { profile: 'work' }), row('ozon', { source: 'ozon' })];
  const incoming = [row('updated', { amount: '99.00' })];
  const merged = mergeCollection(original, incoming, { source: 'wildberries', replace: true, complete: false });
  assert.equal(merged.length, 4);
  assert.equal(merged.find(item => item.rowId === 'updated').amount, '99.00');
  assert.equal(original[1].amount, '100.00');
  assert.equal(mergeCollection(original, incoming, { source: 'wildberries', replace: true, complete: true }).length, 3);
});

test('равная сумма и название не являются идентификатором чека', () => {
  const merged = mergeCollection([row('one')], [row('two')], { source: 'wildberries' });
  assert.equal(merged.length, 2);
  assert.equal(summarize(merged).net, 20000);
});

test('повторный сбор удаляет сверенную предоплату, сохраняя непрочитанные чеки и другой профиль', () => {
  const original = [row('pre', { receipt_url: 'https://receipt.wb.ru/pre' }), row('failed'), row('work', { profile: 'work', receipt_url: 'https://receipt.wb.ru/pre' })];
  const merged = mergeCollection(original, [row('final')], { source: 'wildberries', processedReceipts: ['https://receipt.wb.ru/pre', 'final'] });
  assert.deepEqual(merged.map(row => row.rowId), ['failed', 'work', 'final']);
  assert.deepEqual(mergeCollection(merged, [row('final')], { source: 'wildberries', processedReceipts: ['https://receipt.wb.ru/pre', 'final'] }), merged);
});

test('ссылка исправленного чека имеет приоритет, исполняемые URL запрещены', () => {
  const item = row('one', { receipt_url: 'https://receipt.wb.ru/old' });
  assert.equal(receiptUrl(item, { one: { url: 'https://receipt.wb.ru/new' } }), 'https://receipt.wb.ru/new');
  assert.equal(receiptUrl(row('bad', { receipt_url: 'javascript:alert(1)' })), '');
});
