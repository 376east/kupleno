import type { Envelope, Expected, State } from './model';
import type { Job } from './collection.ts';
import { readUnresolvedOrderIds } from './collection.ts';
import { SOURCES, mergeCollection, sourceOf } from './domain.mjs';
import { applyCollectionRows, identifyRows } from './preferences.mjs';

export function applyCollectionResult(state: State, job: Job): State {
  if (job.status !== 'completed' || !job.result) throw new Error('Сбор ещё не завершён.');
  const applied = state.metadata.appliedCollections as Record<string, string> | undefined;
  if (applied?.[job.source] === job.id || state.metadata.lastAppliedCollection === job.id) return state;
  const result = job.result;
  const unresolvedOrderIds = result.unresolvedOrderIds === undefined ? undefined : readUnresolvedOrderIds(result.unresolvedOrderIds);
  if (result.unresolvedOrderIds !== undefined && (job.source !== 'yandex' || !unresolvedOrderIds)) throw new Error('Некорректные ссылки на заказы.');
  const failedDocumentOrderIds = result.failedDocumentOrderIds === undefined ? undefined : readUnresolvedOrderIds(result.failedDocumentOrderIds);
  const failedReceiptOrderIds = result.failedReceiptOrderIds === undefined ? undefined : readUnresolvedOrderIds(result.failedReceiptOrderIds);
  if ((result.failedDocumentOrderIds !== undefined && (job.source !== 'yandex' || !failedDocumentOrderIds))
    || (result.failedReceiptOrderIds !== undefined && (job.source !== 'yandex' || !failedReceiptOrderIds))) throw new Error('Некорректные ссылки на заказы.');
  const merged = mergeCollection(state.rows, result.rows, { source: job.source, profile: job.profile, processedReceipts: result.processedReceipts });
  const inProfile = (row: State['rows'][number]) => sourceOf(row) === job.source && (row.profile || 'personal') === job.profile;
  const stats = { ...result.stats, appliedRowsBefore: state.rows.filter(inProfile).length, appliedRowsReceived: result.rows.length,
    appliedRowsAfter: merged.filter(inProfile).length,
    appliedArchivedRowsBefore: Array.isArray(state.settlementOriginals) ? state.settlementOriginals.filter(inProfile).length : 0 };
  const previous = state.metadata.collection as { sources?: string[]; stats?: Record<string, unknown>; warnings?: string[]; unresolvedOrderIdsBySource?: Record<string, string[]>; failedDocumentOrderIdsBySource?: Record<string, string[]>; failedReceiptOrderIdsBySource?: Record<string, string[]> } | undefined;
  return { ...applyCollectionRows(state, identifyRows(merged)), metadata: {
    ...state.metadata, appliedCollections: { ...applied, [job.source]: job.id }, lastAppliedCollection: job.id, lastRunAt: job.updatedAt,
    collection: {
      ...previous,
      sources: [...new Set([...(previous?.sources || []), job.source])],
      stats: { ...previous?.stats, [job.source]: stats },
      ...(unresolvedOrderIds ? { unresolvedOrderIdsBySource: { ...previous?.unresolvedOrderIdsBySource, [job.source]: unresolvedOrderIds } } : {}),
      ...(failedDocumentOrderIds ? { failedDocumentOrderIdsBySource: { ...previous?.failedDocumentOrderIdsBySource, [job.source]: failedDocumentOrderIds } } : {}),
      ...(failedReceiptOrderIds ? { failedReceiptOrderIdsBySource: { ...previous?.failedReceiptOrderIdsBySource, [job.source]: failedReceiptOrderIds } } : {}),
      warnings: [...(previous?.warnings || []).filter(text => !text.startsWith(SOURCES[job.source].name)), ...result.warnings],
    },
  } };
}

export function createStateUpdater(store: { read(): Promise<Envelope | null>; readRecovery(): Promise<{ revision: number; epoch: number }>; write(state: State, expected: Expected): Promise<Envelope> }, onSaved: (value: Envelope) => void) {
  let pending = Promise.resolve();
  return (transform: (state: State) => State): Promise<void> => {
    const task = pending.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const current = await store.read() || { ...(await store.readRecovery()), state: { rows: [], settings: {}, metadata: {} } };
        const next = transform(current.state);
        if (next === current.state) { onSaved(current); return; }
        try {
          const saved = await store.write(next, { expectedRevision: current.revision, expectedEpoch: current.epoch });
          onSaved(saved); return;
        } catch (error) {
          // Only a concurrent edit is retried. Clearing the database must not resurrect old data.
          if ((error as { code?: string }).code !== 'STALE_SNAPSHOT_REVISION' || attempt >= 2) throw error;
        }
      }
    });
    pending = task.catch(() => {});
    return task;
  };
}
