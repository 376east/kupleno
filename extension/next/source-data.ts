import type { State, Source } from './model';
import { SOURCES, sourceOf } from './domain.mjs';

export function clearSource(state: State, source: Source): State {
  const next = structuredClone(state);
  const ids = new Set(next.rows.filter(row => sourceOf(row) === source).map(row => row.rowId));
  next.rows = next.rows.filter(row => sourceOf(row) !== source);
  if (Array.isArray(next.settlementOriginals)) next.settlementOriginals = next.settlementOriginals.filter(row => sourceOf(row) !== source);
  for (const id of ids) if (next.settings.overrides) delete next.settings.overrides[id];
  for (const key of ['refundClaims','warranties']) {
    if (!Array.isArray(next.settings[key])) continue;
    next.settings[key] = (next.settings[key] as Record<string, unknown>[])
      .filter(record => sourceOf(record) !== source && !ids.has(String(record.rowId || '')))
      .map(record => ({...record, ...(Array.isArray(record.manualMatchRowIds) ? {manualMatchRowIds: record.manualMatchRowIds.filter(id => !ids.has(String(id)))} : {})}));
  }
  const collection = next.metadata.collection as {sources?: string[]; stats?: Record<string,unknown>; warnings?: string[]; unresolvedOrderIdsBySource?: Record<string, string[]>; failedDocumentOrderIdsBySource?: Record<string, string[]>; failedReceiptOrderIdsBySource?: Record<string, string[]>} | undefined;
  if (collection) {
    collection.sources = collection.sources?.filter(item => item !== source);
    if (collection.stats) delete collection.stats[source];
    for (const field of ['unresolvedOrderIdsBySource', 'failedDocumentOrderIdsBySource', 'failedReceiptOrderIdsBySource'] as const) {
      if (collection[field]) delete collection[field][source];
    }
    collection.warnings = collection.warnings?.filter(text => !text.startsWith(SOURCES[source].name));
  }
  return next;
}
