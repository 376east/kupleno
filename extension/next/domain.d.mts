import type { Purchase, Source } from './model';
export const SOURCES: Record<Source, { name: string; mark: string; url: string }>;
export function moneyMinor(value: unknown): number | null;
export function moneyDecimal(value: number): string;
export function formatMoney(value: number): string;
export function currencyOf(row: Purchase): string;
export function sourceOf(row: Purchase): string;
export function normalizedText(value: unknown): string;
export function isRefund(row: Purchase): boolean;
export function receiptUrl(row: Purchase, archive?: Record<string, { url: string }>): string;
export interface Filters { source?: string; profile?: string; category?: string; type?: string; from?: string; to?: string; query?: string; includeExcluded?: boolean; categoryReview?: boolean; rowIds?: string[] }
export function filterRows(rows: Purchase[], filters?: Filters): Purchase[];
export function summarize(rows: Purchase[]): { spent: number; refunded: number; net: number; count: number; unread: number; excluded: number; invalid: number; currencies: string[] };
export interface Group { key: string; amount: number; count: number; rows: Purchase[] }
export function breakdown(rows: Purchase[], key: (row: Purchase) => string): Group[];
export function monthlyTotals(rows: Purchase[]): Group[];
export function categoryTotals(rows: Purchase[]): Group[];
export function largePurchases(rows: Purchase[], limit?: number): Group[];
export function receiptKey(row: Purchase): string;
export function sourceHealth(source: string, metadata?: Record<string, unknown>): { stats: Record<string, unknown>; warnings: string[]; state: 'partial' | 'ready' | 'unknown' };
export function mergeCollection(existing: Purchase[], incoming: Purchase[], options: { source: Source; profile?: string; complete?: boolean; replace?: boolean; processedReceipts?: string[] }): Purchase[];
