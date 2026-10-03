import type { Purchase } from './model';
export interface ProductGroup { id: string; key: string; name: string; rowIndexes: number[] }
export interface Anomaly { type: string; groupId: string; name: string; rowIndexes: number[]; reason: string; changePercent?: number }
export interface Recurring { groupId: string; key: string; name: string; occurrenceCount: number; intervalDays: number; averageAmount: number; estimatedAnnualAmount: number }
export interface PriceHistory { groupId: string; key: string; name: string; unit: string; latestUnitPrice: number; changePercent: number | null; observations: { rowIndex: number; date: string; amount: number; quantity: number; unitPrice: number; quantitySource: string }[] }
export function analyze(rows: Purchase[], options?: Record<string, number>): { groups: ProductGroup[]; anomalies: Anomaly[]; recurring: Recurring[]; priceHistory: PriceHistory[] };
export function normalizeProductIdentity(row: Purchase | string): { key: string };
