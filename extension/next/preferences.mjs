import { moneyMinor, moneyDecimal, sourceOf, isRefund, settlementReplacements } from './domain.mjs';
import { classify } from './categories.ts';

// Retain the public row identity contract so historical annotations stay attached.
const words = value => String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]+/gi, ' ').trim();
const sourceName = value => ({ wb: 'wildberries', 'яндекс': 'yandex', 'яндекс маркет': 'yandex' }[words(value)] || words(value));
function hash(value, seed) {
  let result = seed >>> 0;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(36).padStart(7, '0');
}

export function rowId(row) {
  if (row.rowId) return String(row.rowId);
  const amount = moneyMinor(row.amount);
  const identity = [sourceName(sourceOf(row)),
    String(row.marketplace_id || row.marketplaceId || row.order_id || row.orderId || row.receipt_url || '').trim().toLowerCase(),
    String(row.item_index ?? row.itemIndex ?? row.sku ?? row.offer_id ?? '').trim().toLowerCase(),
    String(row.date || '').slice(0, 10),
    isRefund(row) ? 'refund' : 'purchase', words(row.title), moneyDecimal(amount ?? 0),
    String(row.currency || 'RUB').trim().toUpperCase()].join('\u0001');
  return `mt_${hash(identity, 2166136261)}${hash(identity, 2246822507)}`;
}

export function identifyRows(rows) {
  const used = new Set();
  return rows.map(row => {
    const base = rowId(row);
    let id = base, suffix = 1;
    while (used.has(id)) id = `${base}_${++suffix}`;
    used.add(id);
    return { ...row, rowId: id };
  });
}

export function settingsWithDefaults(settings = {}) {
  const profiles = settings.profiles?.length ? settings.profiles : [{ id: 'personal', name: 'Личные покупки' }];
  return {
    activeProfile: 'all', dataProfile: profiles[0].id,
    overrides: {}, customRules: [], budgets: {}, refundClaims: [], warranties: [],
    monthClosures: {}, recurringDecisions: {}, anomalyDismissals: {}, ...settings, profiles
  };
}

function matchesRule(row, rule) {
  if (rule.enabled === false) return false;
  const allowedSources = rule.sources || (rule.source ? [rule.source].flat() : []);
  if (allowedSources.length && !allowedSources.map(sourceName).includes(sourceName(sourceOf(row)))) return false;
  const amount = Math.abs(moneyMinor(row.amount) ?? 0);
  if (rule.amountMin != null && amount < moneyMinor(rule.amountMin)) return false;
  if (rule.amountMax != null && amount > moneyMinor(rule.amountMax)) return false;
  const title = words(row.title), padded = ` ${title} `;
  const contains = keyword => padded.includes(` ${words(keyword)} `);
  if ((rule.negativeKeywords || []).some(contains)) return false;
  const keys = (rule.keywords || rule.tokens || [rule.keyword || rule.token || rule.contains]).map(words).filter(Boolean);
  if (!keys.length) return false;
  if (rule.match === 'exact') return keys.some(key => title === key);
  return rule.match === 'all' ? keys.every(contains) : keys.some(contains);
}

export function effectiveRows(state) {
  const settings = settingsWithDefaults(state.settings);
  const rules = [...settings.customRules].sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  const profiles = new Set(settings.profiles.map(profile => profile.id));
  return identifyRows(state.rows).map(row => {
    const classification = row.parse_quality === 'fallback' || (row.category && !['unknown', 'Без категории'].includes(row.category)) ? null : classify(String(row.title || ''));
    const categorized = !row.category || row.category === 'unknown' || row.category === 'Без категории'
      ? { ...row, category: classification?.category === 'unknown' ? '' : classification?.category || '', categorySuggestion: classification?.suggestedCategory || '', categoryNeedsReview: classification?.needsReview ?? true }
      : row;
    const rule = rules.find(rule => matchesRule(row, rule));
    const ruled = { ...categorized, ...(rule?.category ? { category: rule.category, categoryNeedsReview: false } : {}), ...(rule?.profile ? { profile: rule.profile } : {}) };
    const patch = settings.overrides[row.rowId] || {};
    const result = { ...ruled };
    for (const key of ['category', 'profile', 'note', 'excluded']) if (Object.hasOwn(patch, key)) result[key] = patch[key];
    if (patch.category) result.categoryNeedsReview = false;
    if (!profiles.has(result.profile)) result.profile = settings.profiles[0].id;
    return result;
  });
}

export function editOperations(state, ids, patch) {
  const next = structuredClone(state);
  next.settings = settingsWithDefaults(next.settings);
  const existing = new Set(identifyRows(state.rows).map(row => row.rowId));
  for (const id of ids) {
    if (!existing.has(id)) throw new Error('Покупка больше не найдена. Обновите список.');
    const target = { ...next.settings.overrides[id] };
    for (const key of ['category', 'profile', 'note', 'excluded']) if (Object.hasOwn(patch, key)) target[key] = patch[key];
    next.settings.overrides[id] = target;
  }
  return next;
}

export function removeProfile(state, id) {
  const next = structuredClone(state);
  next.settings = settingsWithDefaults(next.settings);
  const settings = next.settings;
  if (!settings.profiles.some(profile => profile.id === id)) throw new Error('Профиль не найден.');
  if (settings.profiles.length < 2) throw new Error('Нельзя удалить единственный профиль.');
  settings.profiles = settings.profiles.filter(profile => profile.id !== id);
  const fallback = settings.profiles[0].id;
  next.rows = next.rows.map(row => row.profile === id ? { ...row, profile: fallback } : row);
  for (const patch of Object.values(settings.overrides)) if (patch.profile === id) patch.profile = fallback;
  for (const key of ['refundClaims', 'warranties']) for (const record of settings[key]) if (record.profile === id) record.profile = fallback;
  for (const key of ['budgets', 'monthClosures', 'recurringDecisions', 'anomalyDismissals']) {
    for (const name of Object.keys(settings[key])) if (name.startsWith(`${id}\u0001`)) delete settings[key][name];
  }
  if (settings.activeProfile === id) settings.activeProfile = fallback;
  if (settings.dataProfile === id) settings.dataProfile = fallback;
  return next;
}

export function applyCollectionRows(state, rows) {
  rows = rows.map(row => ({ ...row }));
  const originals = [...(state.settlementOriginals || [])];
  for (const row of rows) {
    const link = row.settlement_predecessor;
    if (link?.original && typeof link.original.rowId === 'string') {
      originals.push(structuredClone(link.original));
      const { original, ...reference } = link;
      row.settlement_predecessor = reference;
    }
  }
  const replacements = settlementReplacements(rows);
  const settings = structuredClone(state.settings);
  const savedRows = new Map(state.rows.map(row => [row.rowId, row]));
  const currentRows = new Map(rows.map(row => [row.rowId, row]));
  const key = (row, receipt = row.receipt_url || row.marketplace_id, item = row.item_index) => JSON.stringify([sourceOf(row), row.profile || 'personal', receipt, item]);
  const previousRows = new Map();
  for (const row of state.rows) if (row[`${sourceOf(row)}_settlement_kind`] === 'prepayment') {
    const identity = key(row);
    previousRows.set(identity, previousRows.has(identity) ? null : row);
  }
  for (const current of Object.values(replacements)) {
    const finalRow = currentRows.get(current);
    const link = finalRow.settlement_predecessor;
    const oldRow = previousRows.get(key(finalRow, link.receipt, link.item));
    if (!oldRow || currentRows.has(oldRow.rowId)) continue;
    const previous = oldRow.rowId;
    const inline = Object.fromEntries(['note', 'category', 'excluded']
      .filter(key => oldRow[key] != null).map(key => [key, oldRow[key]]));
    const savedFinal = savedRows.get(current);
    const finalInline = Object.fromEntries(['note', 'category', 'excluded']
      .filter(key => savedFinal && Object.hasOwn(savedFinal, key)).map(key => [key, savedFinal[key]]));
    const patch = { ...inline, ...settings.overrides?.[previous], ...finalInline };
    // Keep the old annotation too; an existing final-receipt edit takes precedence.
    if (Object.keys(patch).length) {
      settings.overrides ||= {};
      settings.overrides[current] = { ...patch, ...settings.overrides[current] };
    }
    // The original fiscal row can contain supported annotations or future JSON fields.
    originals.push(structuredClone(oldRow));
    for (const key of ['refundClaims', 'warranties']) for (const record of settings[key] || []) {
      if (record.rowId === previous) record.rowId = current;
    }
  }
  return { ...state, rows, settings, ...(originals.length ? { settlementOriginals: originals } : {}) };
}

export const budgetKey = (month, profile = 'all') => profile === 'all' ? month : `${profile}\u0001${month}`;
