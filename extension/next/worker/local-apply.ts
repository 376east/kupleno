import { applyCollectionResult, createStateUpdater } from '../collection-state';
import type { Envelope, Purchase, State } from '../model';
import { readYandexFiscalId, sourceOf } from '../domain.mjs';
import { summarizeFiscalPayments } from '../fiscal-payments.mjs';
import { createStore } from '../storage.mjs';
import { handleCollectionCommand } from './collection';

const rowKey = (row: Purchase) => JSON.stringify([sourceOf(row), row.profile || 'personal', row.rowId]);
const allRows = (state: State) => [...state.rows, ...(Array.isArray(state.settlementOriginals) ? state.settlementOriginals as Purchase[] : [])];
const fiscalKey = (payment: NonNullable<State['fiscalPayments']>[number]) => `${payment.source}:${payment.id}`;
const marketReceipts = (state: State) => new Set(allRows(state).flatMap(row => {
  const id = sourceOf(row) === 'yandex' && typeof row.receipt_url === 'string' ? readYandexFiscalId(row.receipt_url) : null;
  return id ? [id] : [];
}));

function compareHistory(before: State, after: State) {
  const savedRows = new Set(allRows(after).map(rowKey));
  const previousPayments = before.fiscalPayments || [];
  const payments = after.fiscalPayments || [];
  const index = new Map(payments.map(payment => [fiscalKey(payment), payment]));
  const previousKeys = new Set(previousPayments.map(fiscalKey));
  const marketRows = after.rows.filter(row => sourceOf(row) === 'yandex');
  const otherRowsBefore = before.rows.filter(row => sourceOf(row) !== 'yandex');
  const otherRowsAfter = after.rows.filter(row => sourceOf(row) !== 'yandex');
  const otherPayments = (state: State) => (state.fiscalPayments || []).filter(payment => payment.source !== 'yandex');
  const receiptsBefore = marketReceipts(before), receiptsAfter = marketReceipts(after);
  return {
    rowsBefore: before.rows.length, rowsAfter: after.rows.length,
    marketRowsBefore: before.rows.filter(row => sourceOf(row) === 'yandex').length, marketRowsAfter: marketRows.length,
    missingPreviousRows: allRows(before).filter(row => !savedRows.has(rowKey(row))).length,
    duplicateMarketRows: marketRows.length - new Set(marketRows.map(rowKey)).size,
    marketReceiptsBefore: receiptsBefore.size, marketReceiptsAfter: receiptsAfter.size,
    missingPreviousReceipts: [...receiptsBefore].filter(id => !receiptsAfter.has(id)).length,
    paymentsBefore: previousPayments.length, paymentsAfter: payments.length,
    missingPreviousPayments: previousPayments.filter(payment => !index.has(fiscalKey(payment))).length,
    changedPreviousPayments: previousPayments.filter(payment => {
      const current = index.get(fiscalKey(payment));
      return current && (current.paid !== payment.paid || current.advance !== payment.advance);
    }).length,
    duplicatePayments: payments.length - index.size,
    newMarketPayments: payments.filter(payment => payment.source === 'yandex' && !previousKeys.has(fiscalKey(payment))).length,
    marketAmountsBefore: summarizeFiscalPayments(previousPayments, 'yandex'),
    marketAmountsAfter: summarizeFiscalPayments(payments, 'yandex'),
    otherStoresUnchanged: JSON.stringify(otherRowsBefore) === JSON.stringify(otherRowsAfter)
      && JSON.stringify(otherPayments(before)) === JSON.stringify(otherPayments(after)),
  };
}

function safe(result: ReturnType<typeof compareHistory>) {
  return result.otherStoresUnchanged && result.missingPreviousRows === 0 && result.duplicateMarketRows === 0
    && result.missingPreviousReceipts === 0 && result.missingPreviousPayments === 0
    && result.changedPreviousPayments === 0 && result.duplicatePayments === 0;
}

export async function applyPendingMarketJob(id: string, orders: number) {
  const command = { type: 'KUPLENO_JOB', action: 'status', id } as const;
  const response = await handleCollectionCommand(command);
  const job = response.ok ? response.job : null;
  const store = createStore();
  const initial = await store.read();
  if (!initial) return { status: 'history_unavailable' };
  if (wasApplied(initial.state, id)) return { status: 'already_applied_without_comparison' };
  if (job?.id !== id || job.source !== 'yandex' || job.status !== 'completed' || !job.result) return { status: 'pending_result_unavailable' };
  if (job.result.stats.orders !== orders || job.result.stats.failedOrders !== 0 || job.result.stats.failedReceipts !== 0) return { status: 'unexpected_collection_result' };

  let before: State | undefined, saved: Envelope | undefined, rejected: ReturnType<typeof compareHistory> | undefined;
  const update = createStateUpdater(store, value => { saved = value; });
  try {
    await update(current => {
      before = current;
      const next = applyCollectionResult(current, job);
      if (next === current) return current;
      const comparison = compareHistory(current, next);
      if (!safe(comparison)) {
        rejected = comparison;
        throw new Error('Проверка обновления истории не прошла.');
      }
      return next;
    });
  } catch (error) {
    if (rejected) return { status: 'rejected_before_write', comparison: rejected };
    throw error;
  }
  if (!before || !saved || wasApplied(before, id)) return { status: 'already_applied_without_comparison' };
  const observed = await store.read();
  if (!observed || observed.revision < saved.revision || !wasApplied(observed.state, id)) return { status: 'saved_result_unverified' };
  const comparison = compareHistory(before, observed.state);
  if (!safe(comparison)) return { status: 'saved_comparison_failed', comparison };
  const ack = await handleCollectionCommand({ type: 'KUPLENO_JOB', action: 'ack', id }).catch(() => null);
  return { status: 'applied', comparison, acknowledged: ack?.ok === true, savedRevision: saved.revision, verifiedRevision: observed.revision };
}

function wasApplied(state: State, id: string) {
  return (state.metadata.appliedCollections as Record<string, unknown> | undefined)?.yandex === id;
}
