import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetReport, closeMonth, reconcileClaims, setBudget, upsertClaim, archiveStatus } from './lifecycle.ts';
import type { State, Purchase } from './model.ts';
import type { Claim } from './lifecycle.ts';

const row = (id: string, extra = {}): Purchase => ({ rowId: id, source: 'ozon', date: '2026-08-01', title: 'Товар', amount: '100.00', profile: 'personal', marketplace_id: 'order-1', ...extra });
const claim = (id: string, extra = {}): Claim => ({ id, rowId: 'buy', title: 'Товар', source: 'ozon', profile: 'personal', marketplace_id: 'order-1', expectedAmount: 100, requestedAt: '2026-08-01', dueDate: '2026-08-15', ...extra });
test('manual refund reservations precede auto matching; one refund pays only one claim', () => {
  const refunds = [row('refund', { amount: '-100.00', type: 'refund' })];
  const result = reconcileClaims([claim('auto'), claim('manual', { manualMatchRowIds: ['refund'] })], refunds, '2026-08-16');
  assert.equal(result[0]!.received, 0);
  assert.equal(result[1]!.received, 10000);
  assert.equal(reconcileClaims([claim('a'), claim('b')], refunds)[1]!.received, 0);
  assert.equal(reconcileClaims([claim('a')], [row('other', { amount: '-100.00', marketplace_id: 'different' })])[0]!.received, 0);
});
test('budgets isolate profiles and snapshot totals; unread receipts require review', () => {
  const state: State = { rows: [row('buy'), row('work', { profile: 'work', amount: '500.00' })], settings: { profiles: [{ id: 'personal', name: 'Личные' }, { id: 'work', name: 'Работа' }] }, metadata: {} };
  const planned = setBudget(state, '2026-08', 'personal', { total: 150, categories: {} });
  assert.equal(budgetReport(planned, '2026-08', 'personal').remaining, 5000);
  const closed = closeMonth(planned, '2026-08', 'personal', false, '2026-09-01');
  assert.equal((closed.settings.monthClosures as Record<string, { totals: { netSpend: number } }>)['personal\u00012026-08']!.totals.netSpend, 100);
  assert.throws(() => closeMonth({ ...state, rows: [row('bad', { parse_quality: 'fallback' })] }, '2026-08', 'personal', false), /подтвердите/);
});
test('duplicate manual links are rejected and warranty dates are classified', () => {
  const state: State = { rows: [row('refund', { amount: '-100.00' })], settings: { refundClaims: [claim('old', { manualMatchRowIds: ['refund'] })] }, metadata: {} };
  assert.throws(() => upsertClaim(state, claim('new', { manualMatchRowIds: ['refund'] })), /уже привязан/);
  assert.equal(archiveStatus({ id: 'doc', title: 'Гарантия', kind: 'warranty', expiresAt: '2026-09-20' }, '2026-09-01'), 'expiring');
});

test('one refund repeated inside a claim cannot pay the expected amount twice', () => {
  const refunds = [row('refund', { amount: '-100.00', type: 'refund' })];
  const duplicate = claim('manual', { expectedAmount: 200, manualMatchRowIds: ['refund', 'refund'] });
  const result = reconcileClaims([duplicate], refunds)[0]!;
  assert.equal(result.status, 'disputed');
  assert.equal(result.received, 0);
  assert.equal(result.outstanding, 20000);
  assert.ok(result.problem);
  assert.throws(() => upsertClaim({ rows: refunds, settings: {}, metadata: {} }, duplicate), /несколько раз/);
});

test('claims sharing an id cannot both receive the same manually linked refund', () => {
  const refunds = [row('refund', { amount: '-100.00', type: 'refund' })];
  const duplicate = claim('same', { manualMatchRowIds: ['refund'] });
  const result = reconcileClaims([duplicate, { ...duplicate }], refunds);
  assert.ok(result.every(item => item.status === 'disputed' && item.received === 0 && item.problem));
});
