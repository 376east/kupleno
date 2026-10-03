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
export const sourceOf = (row) => row.source || row.marketplace || '';
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

export function receiptKey(row) {
  const identity = row.receipt_url || row.marketplace_id;
  return identity ? `${sourceOf(row)}\u0001${row.profile || 'personal'}\u0001${identity}` : '';
}

// A partial fetch may update known receipts, but cannot erase unvisited history.
export function mergeCollection(existing, incoming, { source, profile = 'personal', complete = false, replace = false, processedReceipts = [] } = {}) {
  if (!Object.hasOwn(SOURCES, source)) throw new TypeError('Неизвестный магазин.');
  if (incoming.some(row => sourceOf(row) !== source)) throw new TypeError('В результате смешаны разные магазины.');
  const additions = incoming.map(row => ({ ...row, source, profile }));
  const incomingReceipts = new Set(additions.map(receiptKey).filter(Boolean));
  for (const identity of processedReceipts) {
    if (typeof identity !== 'string' || !identity || identity.length > 8192) throw new TypeError('Некорректная ссылка обработанного чека.');
    incomingReceipts.add(`${source}\u0001${profile}\u0001${identity}`);
  }
  const incomingIds = new Set(additions.map(row => row.rowId).filter(Boolean));
  const retained = existing.filter(row => {
    if (sourceOf(row) !== source || (row.profile || 'personal') !== profile) return true;
    if (replace && complete && row.import_origin !== 'csv') return false;
    const key = receiptKey(row);
    return key ? !incomingReceipts.has(key) : !incomingIds.has(row.rowId);
  });
  if (retained.length + additions.length > 100000) throw new RangeError('Сбор остановлен: больше 100 000 операций.');
  return [...retained, ...additions];
}

export function sourceHealth(source, metadata = {}) {
  const collection = metadata.collection || {};
  const stats = collection.stats?.[source] || {};
  const warnings = (collection.warnings || []).filter(value => String(value).startsWith(SOURCES[source]?.name));
  const incomplete = stats.incomplete || stats.limitReached || stats.paginationIncomplete || Number(stats.failedOrders) > 0 || Number(stats.failedReceipts) > 0 || Number(stats.fallbackReceipts) > 0 || Number(stats.unverifiedReceipts) > 0;
  return { stats, warnings, state: incomplete || warnings.length ? 'partial' : stats.receipts ? 'ready' : 'unknown' };
}
