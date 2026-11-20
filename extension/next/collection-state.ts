import type { Envelope, Expected, State } from './model';
import type { Job } from './collection.ts';
import { readUnresolvedOrderIds } from './collection.ts';
import { SOURCES, mergeCollection, readYandexFiscalId, sourceOf } from './domain.mjs';
import { applyCollectionRows, identifyRows, settingsWithDefaults } from './preferences.mjs';
import { isFiscalPaymentList, mergeFiscalPayments } from './fiscal-payments.mjs';

function yandexFiscalIds(rows: State['rows']): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.receipt_url !== 'string' || row.import_origin === 'csv') continue;
    const id = readYandexFiscalId(row.receipt_url);
    if (id) ids.add(id);
  }
  return ids;
}

export function knownYandexOrderIds(state: State, profile: string): string[] {
  const orders = new Map<string, string>();
  const archived = Array.isArray(state.settlementOriginals) ? state.settlementOriginals : [];
  for (const row of [...state.rows, ...archived]) {
    if (sourceOf(row) !== 'yandex' || (row.profile || 'personal') !== profile || row.import_origin === 'csv') continue;
    const id = row.yandex_order_id;
    if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || !readYandexFiscalId(row.receipt_url)) continue;
    const date = typeof row.date === 'string' ? row.date : '';
    if (!orders.has(id) || date > orders.get(id)!) orders.set(id, date);
  }
  return [...orders].sort((a, b) => b[1].localeCompare(a[1]) || Number(b[0]) - Number(a[0])).slice(0, 1000).map(([id]) => id);
}

export function applyCollectionResult(state: State, job: Job): State {
  if (job.status !== 'completed' || !job.result) throw new Error('Сбор ещё не завершён.');
  const applied = state.metadata.appliedCollections as Record<string, string> | undefined;
  if (applied?.[job.source] === job.id || state.metadata.lastAppliedCollection === job.id) return state;
  const result = job.result;
  if (result.fiscalPayments !== undefined && !isFiscalPaymentList(result.fiscalPayments)) throw new Error('Некорректные оплаты по чекам.');
  const unresolvedOrderIds = result.unresolvedOrderIds === undefined ? undefined : readUnresolvedOrderIds(result.unresolvedOrderIds);
  if (result.unresolvedOrderIds !== undefined && (job.source !== 'yandex' || !unresolvedOrderIds)) throw new Error('Некорректные ссылки на заказы.');
  const failedDocumentOrderIds = result.failedDocumentOrderIds === undefined ? undefined : readUnresolvedOrderIds(result.failedDocumentOrderIds);
  const failedReceiptOrderIds = result.failedReceiptOrderIds === undefined ? undefined : readUnresolvedOrderIds(result.failedReceiptOrderIds);
  if ((result.failedDocumentOrderIds !== undefined && (job.source !== 'yandex' || !failedDocumentOrderIds))
    || (result.failedReceiptOrderIds !== undefined && (job.source !== 'yandex' || !failedReceiptOrderIds))) throw new Error('Некорректные ссылки на заказы.');
  const { profiles } = settingsWithDefaults(state.settings);
  // The profile can be merged while the collector still holds the original job.
  const profile = profiles.find(candidate => candidate.id === job.profile)?.id ?? profiles[0]!.id;
  const merged = mergeCollection(state.rows, result.rows, { source: job.source, profile, processedReceipts: result.processedReceipts });
  const inProfile = (row: State['rows'][number]) => sourceOf(row) === job.source && (row.profile || 'personal') === profile;
  const previousRows = state.rows.filter(inProfile);
  const archivedRows = Array.isArray(state.settlementOriginals) ? state.settlementOriginals.filter(inProfile) : [];
  const warnings = [...result.warnings];
  const coverage: { appliedKnownReceiptsMissing?: number; incomplete?: boolean } = {};
  if (job.source === 'yandex') {
    const previousIds = yandexFiscalIds([...previousRows, ...archivedRows]);
    const refreshedIds = yandexFiscalIds(result.rows);
    const missing = [...previousIds].filter(id => !refreshedIds.has(id)).length;
    if (missing) {
      coverage.appliedKnownReceiptsMissing = missing;
      coverage.incomplete = true;
      warnings.push(`Яндекс Маркет: в этот раз не прочитано ранее сохранённых чеков — ${missing}. Они остались в истории.`);
    }
  }
  const stats = { ...result.stats, ...coverage, appliedRowsBefore: previousRows.length, appliedRowsReceived: result.rows.length,
    appliedRowsAfter: merged.filter(inProfile).length,
    appliedArchivedRowsBefore: archivedRows.length };
  const previous = state.metadata.collection as { sources?: string[]; stats?: Record<string, unknown>; warnings?: string[]; unresolvedOrderIdsBySource?: Record<string, string[]>; failedDocumentOrderIdsBySource?: Record<string, string[]>; failedReceiptOrderIdsBySource?: Record<string, string[]> } | undefined;
  const payments = result.fiscalPayments?.length ? mergeFiscalPayments(state.fiscalPayments || [], job.source, result.fiscalPayments) : state.fiscalPayments;
  return { ...applyCollectionRows(state, identifyRows(merged)), ...(payments ? { fiscalPayments: payments } : {}), metadata: {
    ...state.metadata, appliedCollections: { ...applied, [job.source]: job.id }, lastAppliedCollection: job.id, lastRunAt: job.updatedAt,
    collection: {
      ...previous,
      sources: [...new Set([...(previous?.sources || []), job.source])],
      stats: { ...previous?.stats, [job.source]: stats },
      ...(unresolvedOrderIds ? { unresolvedOrderIdsBySource: { ...previous?.unresolvedOrderIdsBySource, [job.source]: unresolvedOrderIds } } : {}),
      ...(failedDocumentOrderIds ? { failedDocumentOrderIdsBySource: { ...previous?.failedDocumentOrderIdsBySource, [job.source]: failedDocumentOrderIds } } : {}),
      ...(failedReceiptOrderIds ? { failedReceiptOrderIdsBySource: { ...previous?.failedReceiptOrderIdsBySource, [job.source]: failedReceiptOrderIds } } : {}),
      warnings: [...(previous?.warnings || []).filter(text => !text.startsWith(SOURCES[job.source].name)), ...warnings],
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
