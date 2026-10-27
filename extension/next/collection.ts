import type { Purchase, Source } from './model';

export const storeOrigins: Record<Source, string[]> = {
  ozon: ['https://www.ozon.ru/*', 'https://ozon.ru/*'],
  wildberries: ['https://www.wildberries.ru/*', 'https://wildberries.ru/*', 'https://astro.wildberries.ru/*', 'https://receipt.wb.ru/*'],
  yandex: ['https://market.yandex.ru/*', 'https://check.yandex.ru/*'],
};
export interface CollectionResult { rows: Purchase[]; stats: Record<string, number | boolean>; warnings: string[]; processedReceipts?: string[] }
export interface Job {
  id: string; source: Source; profile: string; status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string; updatedAt: string; message: string;
  marketTabId?: number;
  progress: { done: number; total: number }; error?: string; diagnostic?: string; failureStats?: CollectionResult['stats']; result?: CollectionResult;
}
export function readFailureStats(value: unknown): CollectionResult['stats'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 128 || entries.some(([key, item]) => ['constructor', 'prototype'].includes(key) || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) ||
    !(typeof item === 'boolean' || (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)))) return undefined;
  return Object.fromEntries(entries) as CollectionResult['stats'];
}
export function collectionAttemptDiagnostics(value: unknown) {
  const available = Array.isArray(value) && value.length <= 3;
  const attempts = available ? value.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const job = item as Job;
    if (typeof job.source !== 'string' || !Object.hasOwn(storeOrigins, job.source) || !['running', 'completed', 'failed', 'cancelled'].includes(job.status)) return [];
    const time = (input: unknown) => typeof input === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input) && Number.isFinite(Date.parse(input)) ? input : undefined;
    const startedAt = time(job.startedAt), updatedAt = time(job.updatedAt), failureStats = readFailureStats(job.failureStats);
    return [{ source: job.source, status: job.status, ...(startedAt ? { startedAt } : {}), ...(updatedAt ? { updatedAt } : {}), ...(failureStats ? { failureStats } : {}) }];
  }) : [];
  return { capturedAt: new Date().toISOString(), available, attempts };
}
export type Command = { type: 'KUPLENO_JOB'; action: 'status' | 'cancel'; source?: Source; id?: string } | { type: 'KUPLENO_JOB'; action: 'start'; source: Source; profile: string } | { type: 'KUPLENO_JOB'; action: 'ack'; id: string };
export type JobResponse = { ok: true; job: Job | null; jobs: Job[] } | { ok: false; error: string };
