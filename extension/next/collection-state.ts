import type { Envelope, Expected, State } from './model';
import type { Job } from './collection';
import { SOURCES, mergeCollection } from './domain.mjs';
import { applyCollectionRows, identifyRows } from './preferences.mjs';

export function applyCollectionResult(state: State, job: Job): State {
  if (job.status !== 'completed' || !job.result) throw new Error('Сбор ещё не завершён.');
  const applied = state.metadata.appliedCollections as Record<string, string> | undefined;
  if (applied?.[job.source] === job.id || state.metadata.lastAppliedCollection === job.id) return state;
  const result = job.result;
  const merged = mergeCollection(state.rows, result.rows, { source: job.source, profile: job.profile, processedReceipts: result.processedReceipts });
  const previous = state.metadata.collection as { sources?: string[]; stats?: Record<string, unknown>; warnings?: string[] } | undefined;
  return { ...applyCollectionRows(state, identifyRows(merged)), metadata: {
    ...state.metadata, appliedCollections: { ...applied, [job.source]: job.id }, lastAppliedCollection: job.id, lastRunAt: job.updatedAt,
    collection: {
      ...previous,
      sources: [...new Set([...(previous?.sources || []), job.source])],
      stats: { ...previous?.stats, [job.source]: result.stats },
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
