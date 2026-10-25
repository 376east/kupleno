import type { Purchase } from './model';
export type SpendingPoint = { date: string; amount: number; total: number; count: number };
export function spendingSeries(rows: Purchase[]): { points: SpendingPoint[]; undated: number };
