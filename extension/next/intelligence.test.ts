import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPurchases } from './intelligence.ts';
import type { Purchase } from './model';
const row = (rowId: string, date: string, extra: Partial<Purchase> = {}): Purchase => ({ rowId, date, source: 'ozon', profile: 'personal', title: 'Кофе зерновой Арабика 1 кг', amount: '1000.00', receipt_url: `https://www.ozon.ru/receipt/${rowId}`, ...extra });
test('regular purchases and prices never combine different shops or profiles', () => {
  const rows = [row('a', '2026-01-01'), row('b', '2026-02-01', { source: 'wildberries' }), row('c', '2026-03-01', { profile: 'work' })];
  assert.equal(inspectPurchases(rows).flatMap(report => report.recurring).length, 0);
  const regular = inspectPurchases([row('a','2026-01-01'), row('b','2026-02-01'), row('c','2026-03-01')]);
  assert.equal(regular.flatMap(report => report.recurring).length, 1);
  assert.equal(regular[0]?.prices[0]?.unit, 'g');
  assert.equal(regular[0]?.prices[0]?.latestUnitPrice, 1);
});
test('unread receipts, excluded rows and currencies do not become duplicate product suggestions', () => {
  const report = inspectPurchases([row('a','2026-01-01'), row('b','2026-01-01', { parse_quality: 'fallback' }), row('c','2026-01-01', { currency: 'USD' }), row('d','2026-01-01', { excluded: true })]);
  assert.equal(report.flatMap(part => part.anomalies).filter(item => item.type === 'possible_duplicate').length, 0);
  const duplicates = inspectPurchases([row('a','2026-01-01'), row('b','2026-01-01')]).flatMap(part => part.anomalies);
  assert.ok(duplicates.some(item => item.type === 'possible_duplicate' && item.rows.length === 2));
});
