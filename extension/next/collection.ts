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
  progress: { done: number; total: number }; error?: string; diagnostic?: string; result?: CollectionResult;
}
export type Command = { type: 'KUPLENO_JOB'; action: 'status' | 'cancel' } | { type: 'KUPLENO_JOB'; action: 'start'; source: Source; profile: string } | { type: 'KUPLENO_JOB'; action: 'ack'; id: string };
export type JobResponse = { ok: true; job: Job | null } | { ok: false; error: string };
