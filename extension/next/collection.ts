import type { FiscalPayment, Purchase, Source } from './model';

export const storeOrigins: Record<Source, string[]> = {
  ozon: ['https://www.ozon.ru/*', 'https://ozon.ru/*'],
  wildberries: ['https://www.wildberries.ru/*', 'https://wildberries.ru/*', 'https://astro.wildberries.ru/*', 'https://receipt.wb.ru/*'],
  yandex: ['https://market.yandex.ru/*', 'https://check.yandex.ru/*'],
};
export interface CollectionResult { rows: Purchase[]; stats: Record<string, number | boolean>; warnings: string[]; fiscalPayments?: FiscalPayment[]; processedReceipts?: string[]; unresolvedOrderIds?: string[]; failedDocumentOrderIds?: string[]; failedReceiptOrderIds?: string[] }
export interface YandexOrdersDomResult { orderIds: string[]; clicked: boolean; hasMore: boolean; blocked: boolean; ambiguous: boolean; limit: boolean; fatal: boolean }
export type YandexDocumentsFailureReason = 'navigation' | 'button' | 'dialog' | 'loading' | 'error' | 'unrecognized' | 'request';
export interface YandexDocumentsResult { urls: string[]; complete: boolean; blocked: boolean; failureReason?: YandexDocumentsFailureReason }
export interface DocumentTab { tabId: number; orderId: string; ownerJobId: string }
export function readDocumentTabs(value: unknown): DocumentTab[] | undefined {
  if (!Array.isArray(value) || value.length > 64 || value.some(item => !item || typeof item !== 'object' || !Number.isSafeInteger(item.tabId) || item.tabId < 0 || typeof item.orderId !== 'string' || !/^[1-9]\d*$/.test(item.orderId) || !Number.isSafeInteger(Number(item.orderId)) || typeof item.ownerJobId !== 'string' || !/^[A-Za-z0-9-]{1,120}$/.test(item.ownerJobId))) return undefined;
  if (new Set(value.map(item => item.tabId)).size !== value.length) return undefined;
  return value.map(({ tabId, orderId, ownerJobId }) => ({ tabId, orderId, ownerJobId }));
}
export function readYandexDocumentsResult(value: unknown): YandexDocumentsResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = value as YandexDocumentsResult;
  if (!Array.isArray(result.urls) || result.urls.length > 1000 || typeof result.complete !== 'boolean' || typeof result.blocked !== 'boolean') return undefined;
  if (result.failureReason !== undefined && (result.complete || !['navigation', 'button', 'dialog', 'loading', 'error', 'unrecognized', 'request'].includes(result.failureReason))) return undefined;
  let size = 0;
  for (const item of result.urls) {
    if (typeof item !== 'string' || item.length > 16000 || (size += item.length) > 8 * 1024 * 1024) return undefined;
    try { const url = new URL(item); if (url.protocol !== 'https:' || url.hostname !== 'check.yandex.ru' || url.username || url.password) return undefined; } catch { return undefined; }
  }
  return { urls: [...new Set(result.urls)], complete: result.complete, blocked: result.blocked, ...(result.failureReason ? { failureReason: result.failureReason } : {}) };
}
export function readUnresolvedOrderIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) return undefined;
  return [...new Set(value)] as string[];
}
export function readYandexOrdersDomResult(value: unknown): YandexOrdersDomResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = value as YandexOrdersDomResult;
  if (!Array.isArray(result.orderIds) || result.orderIds.length > 100000 || result.orderIds.some(id => typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) ||
      ['clicked', 'hasMore', 'blocked', 'ambiguous', 'limit', 'fatal'].some(key => typeof (result as unknown as Record<string, unknown>)[key] !== 'boolean')) return undefined;
  return { orderIds: [...new Set(result.orderIds)], clicked: result.clicked, hasMore: result.hasMore, blocked: result.blocked, ambiguous: result.ambiguous, limit: result.limit, fatal: result.fatal };
}
export interface Job {
  id: string; source: Source; profile: string; status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string; updatedAt: string; message: string;
  marketTabId?: number;
  refreshReceipts?: boolean;
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
export type Command = { type: 'KUPLENO_JOB'; action: 'status' | 'cancel'; source?: Source; id?: string } | { type: 'KUPLENO_JOB'; action: 'start'; source: Source; profile: string; refreshReceipts?: boolean } | { type: 'KUPLENO_JOB'; action: 'ack'; id: string } | { type: 'KUPLENO_JOB'; action: 'clearReceiptCache'; source: 'yandex' };
export type JobResponse = { ok: true; job: Job | null; jobs: Job[] } | { ok: false; error: string };
