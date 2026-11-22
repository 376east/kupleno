export const SOURCES = Object.freeze({
  ozon: { name: 'Ozon', mark: 'O', url: 'https://www.ozon.ru/my/e-check?archive=1' },
  wildberries: { name: 'Wildberries', mark: 'WB', url: 'https://www.wildberries.ru/lk/receipts/get' },
  yandex: { name: 'Яндекс Маркет', mark: 'Я', url: 'https://market.yandex.ru/my/orders?filter=COMPLETED' }
});

// All aggregation uses integer kopecks. The stored source amount remains untouched.
export function moneyMinor(value) {
  const text = String(value ?? '').trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const result = (Number(match[2]) * 100 + Number((match[3] || '').padEnd(2, '0'))) * (match[1] ? -1 : 1);
  return Number.isSafeInteger(result) ? result : null;
}

export function moneyDecimal(minor) {
  if (!Number.isSafeInteger(minor)) throw new TypeError('Сумма должна быть целым числом копеек.');
  return `${minor < 0 ? '-' : ''}${Math.floor(Math.abs(minor) / 100)}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;
}

const moneyFormatter = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });
export const formatMoney = (minor) => moneyFormatter.format(minor / 100);
export const currencyOf = (row) => String(row.currency || 'RUB').toUpperCase();
export const sourceOf = (row) => {
  const source = row.source || row.marketplace || '';
  return source === 'wb' ? 'wildberries' : source;
};
export const normalizedText = (value) => String(value ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const isRefund = (row) => row.type === 'refund' || row.is_return === '1' || moneyMinor(row.amount) < 0;

export function receiptUrl(row, archive = {}) {
  for (const value of [archive[row.rowId]?.url, row.receipt_url]) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch { /* A missing source link is a normal incomplete-record state. */ }
  }
  return '';
}

export function filterRows(rows, filters = {}) {
  const rowIds = filters.rowIds ? new Set(filters.rowIds) : null;
  const query = normalizedText(filters.query);
  return rows.filter(row => {
    if (rowIds && !rowIds.has(row.rowId)) return false;
    if (filters.categoryReview && (!row.categoryNeedsReview || row.parse_quality === 'fallback')) return false;
    if (!filters.includeExcluded && row.excluded === true) return false;
    if (filters.source && sourceOf(row) !== filters.source) return false;
    if (filters.profile && filters.profile !== 'all' && row.profile !== filters.profile) return false;
    if (filters.category && row.category !== filters.category) return false;
    if (filters.type && (isRefund(row) ? 'refund' : 'purchase') !== filters.type) return false;
    const date = String(row.date || '').slice(0, 10);
    if (filters.from && date < filters.from) return false;
    if (filters.to && date > filters.to) return false;
    return !query || normalizedText(`${row.title} ${row.marketplace_id || ''} ${row.note || ''}`).includes(query);
  });
}

export function summarize(rows) {
  let spent = 0, refunded = 0, unread = 0, excluded = 0, invalid = 0;
  const currencies = new Set();
  for (const row of rows) {
    if (row.excluded === true) { excluded++; continue; }
    if (currencyOf(row) !== 'RUB') { currencies.add(currencyOf(row)); continue; }
    const amount = moneyMinor(row.amount);
    if (amount === null) { invalid++; continue; }
    if (isRefund(row)) refunded += Math.abs(amount);
    else spent += amount;
    if (row.parse_quality === 'fallback') unread++;
    if (!Number.isSafeInteger(spent) || !Number.isSafeInteger(refunded)) throw new RangeError('Итог превышает допустимую сумму.');
  }
  return { spent, refunded, net: spent - refunded, count: rows.length - excluded, unread, excluded, invalid, currencies: [...currencies] };
}

export function breakdown(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    if (row.excluded === true || currencyOf(row) !== 'RUB') continue;
    const amount = moneyMinor(row.amount);
    if (amount === null) continue;
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, { key, amount: 0, count: 0, rows: [] });
    const group = groups.get(key);
    group.amount += isRefund(row) ? -Math.abs(amount) : amount;
    if (!Number.isSafeInteger(group.amount)) throw new RangeError('Итог превышает допустимую сумму.');
    group.count++;
    group.rows.push(row);
  }
  return [...groups.values()];
}

export const monthlyTotals = (rows) => breakdown(rows, row => String(row.date).slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key));
export const categoryTotals = (rows) => breakdown(rows, row => row.category || 'Без категории').sort((a, b) => b.amount - a.amount);

export function largePurchases(rows, limit = 6) {
  return breakdown(rows.filter(row => row.parse_quality !== 'fallback'), row => `${sourceOf(row)}\u0001${row.profile || ''}\u0001${normalizedText(row.title)}`)
    .filter(group => group.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

export function fiscalIdentity(parts) {
  if (parts.some(part => typeof part !== 'string' || !/^\d{1,20}$/.test(part))) return undefined;
  return parts.map(part => part.replace(/^0+(?=\d)/, '')).join(':');
}

export function readYandexFiscalId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://check.yandex.ru' || parsed.username || parsed.password) return undefined;
    const fields = ['fn', 'n', 'fpd'].map(key => parsed.searchParams.getAll(key));
    if (fields.some(values => values.length !== 1)) return undefined;
    return fiscalIdentity(fields.map(([value]) => value));
  } catch {
    return undefined;
  }
}

export function receiptKey(row) {
  const identity = row.receipt_url || row.marketplace_id;
  return identity ? `${sourceOf(row)}\u0001${row.profile || 'personal'}\u0001${identity}` : '';
}

// Reconcile only explicit receipt evidence; sparse legacy rows remain visible.
const settlementIdentity = row => typeof row.receipt_url === 'string' && row.receipt_url
  ? row.receipt_url : typeof row.marketplace_id === 'string' ? row.marketplace_id : '';
const settlementKind = row => row[`${sourceOf(row)}_settlement_kind`];
function settlementSignature(row) {
  const source = sourceOf(row), order = row[`${source}_order_id`];
  const amount = moneyMinor(row.amount), item = row.item_index;
  if (!['ozon', 'yandex'].includes(source) || typeof order !== 'string' || !order.trim()
    || typeof item !== 'string' || !item || !settlementIdentity(row) || !normalizedText(row.title)
    || typeof row.rowId !== 'string' || !row.rowId
    || amount === null || amount <= 0 || isRefund(row) || row.parse_quality === 'fallback'
    || row.parse_quality === 'unverified' || !/^\d{4}-\d{2}-\d{2}(?:$|[ T])/.test(String(row.date || ''))) return '';
  return JSON.stringify([source, row.profile || 'personal', order, normalizedText(row.title), amount, currencyOf(row)]);
}
function predecessor(row) {
  const value = row.settlement_predecessor;
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.receipt === 'string' && value.receipt && typeof value.item === 'string' && value.item
    && typeof value.rowId === 'string' && value.rowId ? value : null;
}
const predecessorKey = value => JSON.stringify([value.receipt, value.item]);
const settlementDate = row => String(row.date).replace('T', ' ').slice(0, 16);
const settlementContent = row => JSON.stringify([sourceOf(row), row.profile || 'personal', normalizedText(row.title), moneyMinor(row.amount), currencyOf(row)]);
const finalReceiptIdentity = row => JSON.stringify([receiptKey(row), row.item_index, settlementContent(row), String(row.date).slice(0, 10)]);

function yandexFiscalLine(row) {
  if (sourceOf(row) !== 'yandex' || row.import_origin === 'csv' || row.parse_quality !== 'complete'
    || typeof row.item_index !== 'string' || !/^\d+$/.test(row.item_index) || moneyMinor(row.amount) === null) return '';
  const id = readYandexFiscalId(row.receipt_url);
  return id ? JSON.stringify([id, row.item_index, settlementContent(row), isRefund(row), settlementDate(row)]) : '';
}

export function reconcileSettlementReceipts(input, activeReceipts) {
  const rows = input.map(row => ({ ...row })), groups = new Map(), linked = new Map(), removed = new Set();
  for (const row of rows) {
    const signature = settlementSignature(row);
    if (!signature || settlementKind(row) !== 'full') continue;
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(row);
    const previous = predecessor(row);
    if (previous) {
      const key = JSON.stringify([predecessorKey(previous), settlementContent(row)]);
      if (!linked.has(key)) linked.set(key, []);
      linked.get(key).push(row);
    }
  }
  for (const early of rows) {
    const signature = settlementSignature(early);
    if (!signature || settlementKind(early) !== 'prepayment') continue;
    const identity = predecessorKey({ receipt: settlementIdentity(early), item: early.item_index });
    // A saved fiscal link survives mutable provider order aliases; new pairs still require an order match.
    const known = linked.get(JSON.stringify([identity, settlementContent(early)]));
    const candidates = known || groups.get(signature) || [];
    const final = candidates.find(row => {
      if (activeReceipts && !activeReceipts.has(receiptKey(early)) && !activeReceipts.has(receiptKey(row))) return false;
      if (settlementIdentity(row) === settlementIdentity(early) || settlementDate(early) > settlementDate(row)) return false;
      const previous = predecessor(row);
      return previous ? predecessorKey(previous) === identity : !Object.hasOwn(row, 'settlement_predecessor');
    });
    if (final) {
      // The final stays consumed on future batches, including a refresh of either receipt.
      if (!predecessor(final)) final.settlement_predecessor = { receipt: settlementIdentity(early), item: early.item_index, rowId: early.rowId };
      removed.add(early);
    }
  }
  return { rows: rows.filter(row => !removed.has(row)), removed: removed.size };
}

export function settlementReplacements(rows) {
  return Object.fromEntries(rows.flatMap(row => {
    const previous = predecessor(row);
    return previous && settlementSignature(row) && settlementKind(row) === 'full' && row.rowId && previous.rowId !== row.rowId
      ? [[previous.rowId, row.rowId]] : [];
  }));
}

// A partial fetch may update known receipts, but cannot erase unvisited history.
export function mergeCollection(existing, incoming, { source, profile = 'personal', complete = false, replace = false, processedReceipts = [] } = {}) {
  if (!Object.hasOwn(SOURCES, source)) throw new TypeError('Неизвестный магазин.');
  if (incoming.some(row => sourceOf(row) !== source)) throw new TypeError('В результате смешаны разные магазины.');
  const priorFinals = new Map(existing.filter(row => predecessor(row) && settlementSignature(row) && settlementKind(row) === 'full')
    .map(row => [finalReceiptIdentity(row), row]));
  const priorFiscalLines = new Map();
  const priorCompleteFiscalIds = new Set();
  if (source === 'yandex') for (const row of existing) {
    if ((row.profile || 'personal') !== profile) continue;
    const key = yandexFiscalLine(row);
    if (key) {
      priorFiscalLines.set(key, priorFiscalLines.has(key) ? null : row);
      priorCompleteFiscalIds.add(readYandexFiscalId(row.receipt_url));
    }
  }
  const skippedFiscalIds = new Set();
  const accepted = source === 'yandex' && priorCompleteFiscalIds.size ? incoming.filter(row => {
    if (!['fallback', 'unverified'].includes(row.parse_quality)) return true;
    const id = readYandexFiscalId(row.receipt_url);
    if (!priorCompleteFiscalIds.has(id)) return true;
    skippedFiscalIds.add(id);
    return false;
  }) : incoming;
  const replacedFiscalRows = new Set();
  const additions = accepted.map(row => {
    const addition = { ...row, source, profile };
    const matchingLine = source === 'yandex' ? priorFiscalLines.get(yandexFiscalLine(addition)) : undefined;
    if (matchingLine && !replacedFiscalRows.has(matchingLine)) {
      replacedFiscalRows.add(matchingLine);
      return { ...matchingLine, ...addition, rowId: matchingLine.rowId };
    }
    const previous = settlementSignature(addition) && settlementKind(addition) === 'full' ? priorFinals.get(finalReceiptIdentity(addition)) : undefined;
    return previous ? { ...previous, ...addition, rowId: previous.rowId, settlement_predecessor: previous.settlement_predecessor } : addition;
  });
  const incomingReceipts = new Set(additions.map(receiptKey).filter(Boolean));
  for (const identity of processedReceipts) {
    if (typeof identity !== 'string' || !identity || identity.length > 8192) throw new TypeError('Некорректная ссылка обработанного чека.');
    if (skippedFiscalIds.size && skippedFiscalIds.has(readYandexFiscalId(identity))) continue;
    incomingReceipts.add(`${source}\u0001${profile}\u0001${identity}`);
  }
  const incomingIds = new Set(additions.map(row => row.rowId).filter(Boolean));
  const retained = existing.filter(row => {
    if (sourceOf(row) !== source || (row.profile || 'personal') !== profile) return true;
    if (replacedFiscalRows.has(row)) return false;
    if (replace && complete && row.import_origin !== 'csv'
      && !(skippedFiscalIds.size && skippedFiscalIds.has(readYandexFiscalId(row.receipt_url)))) return false;
    const key = receiptKey(row);
    return key ? !incomingReceipts.has(key) : !incomingIds.has(row.rowId);
  });
  if (retained.length + additions.length > 100000) throw new RangeError('Сбор остановлен: больше 100 000 операций.');
  return reconcileSettlementReceipts([...retained, ...additions], incomingReceipts).rows;
}

export function sourceHealth(source, metadata = {}) {
  const collection = metadata.collection || {};
  const stats = collection.stats?.[source] || {};
  const warnings = (collection.warnings || []).filter(value => String(value).startsWith(SOURCES[source]?.name));
  const incomplete = stats.incomplete || stats.limitReached || stats.paginationIncomplete || Number(stats.failedOrders) > 0 || Number(stats.failedReceipts) > 0 || Number(stats.fallbackReceipts) > 0 || Number(stats.unverifiedReceipts) > 0;
  const checked = stats.receipts === 0 || Boolean(stats.receipts);
  return { stats, warnings, state: incomplete || warnings.length ? 'partial' : checked ? 'ready' : 'unknown' };
}
