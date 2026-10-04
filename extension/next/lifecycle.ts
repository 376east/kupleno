import { categoryTotals, filterRows, isRefund, moneyDecimal, moneyMinor, normalizedText, summarize } from './domain.mjs';
import { budgetKey, effectiveRows } from './preferences.mjs';
import type { Purchase, State } from './model';

export interface Claim {
  id: string; rowId?: string | null; marketplace_id?: string | null; source?: string | null; profile?: string | null;
  title: string; expectedAmount: string | number; requestedAt: string; purchaseDate?: string | null; dueDate: string;
  status?: string; manualMatchRowIds?: string[]; confirmedAt?: string | null; note?: string | null; [key: string]: unknown;
}
export interface DocumentRecord {
  id: string; kind: 'receipt' | 'warranty'; rowId?: string | null; marketplace_id?: string | null; source?: string | null;
  profile?: string | null; title: string; issuedAt?: string | null; expiresAt?: string | null; url?: string | null;
  note?: string | null; addedAt?: string; [key: string]: unknown;
}
export interface Budget { total: number; categories: Record<string, number>; [key: string]: unknown }
const dictionary = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
export function day(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Укажите дату.');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Такой даты не существует.');
  return value;
}
export const addDays = (value: string, count: number) => new Date(Date.parse(`${day(value)}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
export function monthRange(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Укажите месяц.');
  return { from: `${month}-01`, to: new Date(Date.UTC(Number(month.slice(0,4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10) };
}
export function getBudget(state: State, month: string, profile: string): Budget {
  const raw = dictionary(dictionary(state.settings.budgets)[budgetKey(month, profile)]);
  return { ...raw, total: typeof raw.total === 'number' ? raw.total : 0, categories: dictionary(raw.categories) as Record<string, number> };
}
export function setBudget(state: State, month: string, profile: string, budget: Budget): State {
  monthRange(month);
  for (const amount of [budget.total, ...Object.values(budget.categories)]) {
    if (moneyMinor(amount) === null || amount < 0) throw new Error('Бюджет должен быть суммой в рублях от нуля.');
  }
  return { ...state, settings: { ...state.settings, budgets: { ...dictionary(state.settings.budgets), [budgetKey(month, profile)]: structuredClone(budget) } } };
}
export function budgetReport(state: State, month: string, profile: string) {
  const rows = filterRows(effectiveRows(state), { ...monthRange(month), profile });
  const totals = summarize(rows), budget = getBudget(state, month, profile);
  if (totals.invalid || totals.currencies.length) throw new Error('В этом месяце есть суммы или валюты, которые нужно проверить.');
  const limit = moneyMinor(budget.total) || 0;
  return { budget, totals, remaining: limit - totals.net, categories: categoryTotals(rows) };
}
export function closeMonth(state: State, month: string, profile: string, approved: boolean, now = today()): State {
  const rows = filterRows(effectiveRows(state), { ...monthRange(month), profile, includeExcluded: true });
  const totals = summarize(rows);
  if (totals.invalid || totals.currencies.length) throw new Error('Сначала проверьте суммы и валюты в этом месяце.');
  if (totals.unread && !approved) throw new Error('В месяце есть чеки без списка товаров. Проверьте их или подтвердите сохранение итога.');
  const categories = categoryTotals(rows).map(group => {
    const value = summarize(group.rows);
    return { category: group.key, grossSpend: Number(moneyDecimal(value.spent)), refundAmount: Number(moneyDecimal(value.refunded)), netSpend: Number(moneyDecimal(value.net)) };
  });
  const closures = dictionary(state.settings.monthClosures), key = `${profile}\u0001${month}`;
  const previous = dictionary(closures[key]);
  return { ...state, settings: { ...state.settings, monthClosures: { ...closures, [key]: {
    ...previous, version: 1, month, status: 'closed', closedAt: day(now), reopenedAt: previous.reopenedAt || null,
    previousTotals: previous.totals || previous.previousTotals || null,
    totals: { rowCount: rows.length, excludedCount: totals.excluded, purchaseCount: rows.filter(row => !row.excluded && !isRefund(row)).length, refundCount: rows.filter(row => !row.excluded && isRefund(row)).length, grossSpend: Number(moneyDecimal(totals.spent)), refundAmount: Number(moneyDecimal(totals.refunded)), netSpend: Number(moneyDecimal(totals.net)), categories },
    review: { issues: totals.unread ? [{ type: 'unread-receipt', count: totals.unread }] : [] },
  } } } };
}
export function reopenMonth(state: State, month: string, profile: string): State {
  const key = `${profile}\u0001${month}`, closures = dictionary(state.settings.monthClosures), previous = dictionary(closures[key]);
  return { ...state, settings: { ...state.settings, monthClosures: { ...closures, [key]: { ...previous, version: 1, month, status: 'open', previousTotals: previous.totals || null, totals: null, review: { issues: [] }, reopenedAt: today() } } } };
}
export function claims(state: State): Claim[] { return Array.isArray(state.settings.refundClaims) ? state.settings.refundClaims as Claim[] : []; }
export function documents(state: State): DocumentRecord[] { return Array.isArray(state.settings.warranties) ? state.settings.warranties as DocumentRecord[] : []; }
export function upsertClaim(state: State, claim: Claim): State {
  const amount = moneyMinor(claim.expectedAmount);
  if (amount === null || amount <= 0) throw new Error('Укажите ожидаемую сумму возврата больше нуля.');
  if (!claim.id || !claim.title.trim() || (!claim.rowId && !claim.marketplace_id)) throw new Error('Возврат должен быть привязан к покупке.');
  day(claim.requestedAt); day(claim.dueDate);
  if (claim.dueDate < claim.requestedAt) throw new Error('Срок возврата не может быть раньше обращения.');
  const existing = claims(state);
  const ids = new Set(claim.manualMatchRowIds || []);
  if (existing.some(item => item.id !== claim.id && item.manualMatchRowIds?.some(id => ids.has(id)))) throw new Error('Этот возврат уже привязан к другому ожиданию.');
  const result = reconcileClaims([...existing.filter(item => item.id !== claim.id), claim], effectiveRows(state));
  if (result.find(item => item.claim.id === claim.id)?.problem) throw new Error(result.find(item => item.claim.id === claim.id)!.problem);
  return { ...state, settings: { ...state.settings, refundClaims: [...existing.filter(item => item.id !== claim.id), structuredClone(claim)] } };
}
export function reconcileClaims(input: Claim[], rows: Purchase[], now = today()) {
  const refunds = rows.filter(row => isRefund(row) && !row.excluded && (row.currency || 'RUB') === 'RUB');
  const used = new Set<string>(), reserved = new Map<string, number>();
  const collision = new Set<number>();
  input.forEach((claim, index) => { for (const id of claim.manualMatchRowIds || []) {
    const previous = reserved.get(id);
    if (previous !== undefined && previous !== index) { collision.add(previous); collision.add(index); }
    reserved.set(id, index);
  } });
  return input.map((claim, index) => {
    const repeated = new Set(claim.manualMatchRowIds || []).size !== (claim.manualMatchRowIds || []).length;
    let problem = repeated ? 'Одна операция указана несколько раз.' : collision.has(index) ? 'Одна операция привязана к нескольким ожиданиям.' : '';
    const expected = moneyMinor(claim.expectedAmount) || 0;
    const compatible = (row: Purchase) => (!claim.profile || row.profile === claim.profile) && (!claim.source || row.source === claim.source) && row.date.slice(0,10) >= (claim.purchaseDate || claim.requestedAt);
    const manual = (claim.manualMatchRowIds || []).map(id => refunds.find(row => row.rowId === id));
    if (manual.some(row => !row || !compatible(row))) problem = 'Привязанная операция не найдена или относится к другой покупке.';
    const matches: Purchase[] = problem ? [] : manual.filter((row): row is Purchase => !!row);
    matches.forEach(row => used.add(row.rowId));
    let received = matches.reduce((sum, row) => sum + Math.abs(moneyMinor(row.amount) || 0), 0);
    if (!problem) for (const row of refunds) {
      if (used.has(row.rowId) || reserved.has(row.rowId) || !compatible(row)) continue;
      if (!claim.marketplace_id || row.marketplace_id !== claim.marketplace_id || normalizedText(row.title) !== normalizedText(claim.title)) continue;
      const amount = Math.abs(moneyMinor(row.amount) || 0);
      if (amount <= 0 || received + amount > expected) continue;
      matches.push(row); used.add(row.rowId); received += amount;
    }
    const candidates = refunds.filter(row => !used.has(row.rowId) && !reserved.has(row.rowId) && compatible(row) && normalizedText(row.title) === normalizedText(claim.title));
    const status = problem || claim.status === 'disputed' ? 'disputed' : received >= expected && expected > 0 ? 'received' : received > 0 ? 'partial' : now > claim.dueDate ? 'overdue' : 'pending';
    return { claim, expected, received, outstanding: Math.max(0, expected - received), matches, candidates, status, problem };
  });
}
export function upsertDocument(state: State, record: DocumentRecord): State {
  if (!record.id || !record.title.trim() || (!record.rowId && !record.marketplace_id)) throw new Error('Документ должен быть привязан к покупке.');
  if (record.issuedAt) day(record.issuedAt);
  if (record.expiresAt) day(record.expiresAt);
  if (record.issuedAt && record.expiresAt && record.expiresAt < record.issuedAt) throw new Error('Срок гарантии не может быть раньше покупки.');
  if (record.url) { const url = new URL(record.url); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Укажите безопасную ссылку HTTPS на документ.'); }
  return { ...state, settings: { ...state.settings, warranties: [...documents(state).filter(item => item.id !== record.id), structuredClone(record)] } };
}
export function archiveStatus(record: DocumentRecord, now = today()) {
  if (!record.expiresAt || record.expiresAt > addDays(now, 30)) return 'active';
  return record.expiresAt < now ? 'expired' : 'expiring';
}
