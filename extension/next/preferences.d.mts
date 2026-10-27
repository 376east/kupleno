import type { State, Purchase, Settings, Profile } from './model';
export function rowId(row: Purchase): string;
export function identifyRows(rows: Purchase[]): Purchase[];
export function settingsWithDefaults(settings?: Settings): Settings & { profiles: Profile[]; activeProfile: string; dataProfile: string };
export function effectiveRows(state: State): Purchase[];
export function editOperations(state: State, ids: string[], patch: Partial<Purchase>): State;
export function removeProfile(state: State, id: string): State;
export function applyCollectionRows(state: State, rows: Purchase[]): State;
export function budgetKey(month: string, profile?: string): string;
