import { moneyMinor } from './domain.mjs';

const DEFAULT_DB_NAME = 'kupleno-storage-v2';
const DB_VERSION = 1;
const MAX_ROWS = 100000;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 3000000;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const HISTORY_LIMIT = 12;

const STORE = Object.freeze({
  current: 'current',
  history: 'history',
  meta: 'meta'
});
const CURRENT_KEY = 'state';
const META_EPOCH = 'epoch';
const META_REVISION = 'revision';
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function storageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateJson(value, path = '$', depth = 0, seen = { count: 0 }) {
  seen.count += 1;
  if (seen.count > MAX_JSON_NODES) {
    throw storageError('INVALID_JSON', 'Слишком большой JSON-документ.');
  }
  if (depth > MAX_JSON_DEPTH) {
    throw storageError('INVALID_JSON', 'JSON-документ слишком глубоко вложен.');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw storageError('INVALID_JSON', `Некорректное число в ${path}.`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validateJson(value[index], `${path}[${index}]`, depth + 1, seen);
    }
    return;
  }
  if (!isPlainObject(value)) {
    throw storageError('INVALID_JSON', `Недопустимое значение в ${path}.`);
  }
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw storageError('UNSAFE_KEY', `Недопустимый ключ ${key}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
      throw storageError('INVALID_JSON', `Недопустимое свойство ${path}.${key}.`);
    }
    validateJson(value[key], `${path}.${key}`, depth + 1, seen);
  }
}

function cloneJson(value) {
  validateJson(value);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw storageError('INVALID_JSON', `JSON нельзя сохранить: ${error.message}`);
  }
  if (typeof serialized !== 'string') throw storageError('INVALID_JSON', 'Некорректный JSON-документ.');
  if (new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) {
    throw storageError('DATA_TOO_LARGE', 'Данные превышают допустимый размер.');
  }
  return JSON.parse(serialized);
}

function validateDate(value, path) {
  const day = typeof value === 'string' ? value.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(value)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw storageError('INVALID_DATE', `Некорректная дата в ${path}.`);
  }
}

function validateAmount(value, path) {
  if ((typeof value !== 'number' && typeof value !== 'string') || moneyMinor(value) === null) {
    throw storageError('INVALID_AMOUNT', `Некорректная сумма в ${path}.`);
  }
}

function validateSettingDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw storageError('INVALID_SETTINGS', 'Некорректная дата в настройках.');
  try { validateDate(value, 'settings'); }
  catch { throw storageError('INVALID_SETTINGS', 'Некорректная дата в настройках.'); }
}

function validateSettings(settings) {
  for (const key of ['overrides', 'budgets', 'monthClosures', 'recurringDecisions', 'anomalyDismissals']) {
    if (own(settings, key) && !isPlainObject(settings[key])) throw storageError('INVALID_SETTINGS', `Некорректные настройки: ${key}.`);
  }
  for (const key of ['profiles', 'customRules', 'refundClaims', 'warranties']) {
    if (own(settings, key) && (!Array.isArray(settings[key]) || settings[key].some(item => !isPlainObject(item)))) {
      throw storageError('INVALID_SETTINGS', `Некорректный список настроек: ${key}.`);
    }
  }
  if (Object.values(settings.anomalyDismissals || {}).some(value => typeof value !== 'boolean')) throw storageError('INVALID_SETTINGS', 'Некорректные отметки проверки покупок.');
  if (Object.values(settings.recurringDecisions || {}).some(value => !['confirmed', 'ignored'].includes(value))) throw storageError('INVALID_SETTINGS', 'Некорректные решения по регулярным покупкам.');
  const ids = new Set();
  for (const profile of settings.profiles || []) {
    if (typeof profile.id !== 'string' || !profile.id.trim() || typeof profile.name !== 'string' || ids.has(profile.id)) {
      throw storageError('INVALID_SETTINGS', 'В копии повреждены профили.');
    }
    ids.add(profile.id);
  }
  const availableProfiles = ids.size ? ids : new Set(['personal']);
  for (const key of ['activeProfile', 'dataProfile']) {
    if (!own(settings, key)) continue;
    const id = settings[key];
    if (typeof id !== 'string' || !(availableProfiles.has(id) || (key === 'activeProfile' && id === 'all'))) {
      throw storageError('INVALID_SETTINGS', `Некорректный выбранный профиль: ${key}.`);
    }
    if (key === 'dataProfile' && id.length > 120) throw storageError('INVALID_SETTINGS', 'Идентификатор профиля для сбора длиннее 120 символов.');
  }
  for (const patch of Object.values(settings.overrides || {})) {
    if (!isPlainObject(patch)) throw storageError('INVALID_SETTINGS', 'В копии повреждены ручные изменения.');
    for (const key of ['category', 'profile', 'note']) {
      if (own(patch, key) && typeof patch[key] !== 'string') throw storageError('INVALID_SETTINGS', `Некорректное ручное поле: ${key}.`);
    }
    if (own(patch, 'excluded') && typeof patch.excluded !== 'boolean') throw storageError('INVALID_SETTINGS', 'Некорректная отметка исключения покупки.');
  }
  const claimIds = new Set();
  const documentIds = new Set();
  for (const key of ['refundClaims', 'warranties']) for (const record of settings[key] || []) {
    if (own(record, 'title') && typeof record.title !== 'string') throw storageError('INVALID_SETTINGS', 'Некорректное название возврата или документа.');
    for (const field of ['rowId', 'marketplace_id', 'source', 'profile', 'note']) {
      if (record[field] != null && typeof record[field] !== 'string') throw storageError('INVALID_SETTINGS', `Некорректное поле возврата или документа: ${field}.`);
    }
    const dates = key === 'refundClaims' ? ['requestedAt', 'dueDate', 'purchaseDate', 'confirmedAt'] : ['issuedAt', 'expiresAt', 'addedAt'];
    for (const field of dates) if (record[field] != null) validateSettingDay(record[field]);
    if (key === 'refundClaims') {
      if (own(record, 'expectedAmount') && ((typeof record.expectedAmount !== 'number' && typeof record.expectedAmount !== 'string') || moneyMinor(record.expectedAmount) === null || moneyMinor(record.expectedAmount) <= 0)) throw storageError('INVALID_SETTINGS', 'Некорректная ожидаемая сумма возврата.');
      if (record.status != null && typeof record.status !== 'string') throw storageError('INVALID_SETTINGS', 'Некорректный статус ожидаемого возврата.');
      if (record.requestedAt && record.dueDate && record.dueDate < record.requestedAt) throw storageError('INVALID_SETTINGS', 'Срок возврата раньше даты обращения.');
    } else {
      if (own(record, 'id')) {
        if (typeof record.id !== 'string' || !record.id.trim() || documentIds.has(record.id)) throw storageError('INVALID_SETTINGS', 'Некорректный или повторный идентификатор документа.');
        documentIds.add(record.id);
      }
      if (record.url != null && typeof record.url !== 'string') throw storageError('INVALID_SETTINGS', 'Некорректное поле документа: url.');
      if (own(record, 'kind') && !['receipt', 'warranty'].includes(record.kind)) throw storageError('INVALID_SETTINGS', 'Некорректный вид документа.');
      if (record.issuedAt && record.expiresAt && record.expiresAt < record.issuedAt) throw storageError('INVALID_SETTINGS', 'Срок гарантии раньше даты выдачи.');
    }
  }
  for (const claim of settings.refundClaims || []) {
    if (own(claim, 'id')) {
      if (typeof claim.id !== 'string' || !claim.id.trim() || claimIds.has(claim.id)) throw storageError('INVALID_SETTINGS', 'Некорректный или повторный идентификатор ожидаемого возврата.');
      claimIds.add(claim.id);
    }
    if (!own(claim, 'manualMatchRowIds')) continue;
    const ids = claim.manualMatchRowIds;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
      throw storageError('INVALID_SETTINGS', 'Некорректные привязки ожидаемого возврата.');
    }
  }
  for (const [key, budget] of Object.entries(settings.budgets || {})) {
    // Older flat limits and future JSON fields are not monthly plans consumed by the UI.
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key.split('\u0001').at(-1))) continue;
    if (!isPlainObject(budget)) throw storageError('INVALID_SETTINGS', 'Некорректный месячный бюджет.');
    if (own(budget, 'categories') && !isPlainObject(budget.categories)) throw storageError('INVALID_SETTINGS', 'Некорректные категории бюджета.');
    const amounts = [...Object.values(budget.categories || {})];
    if (budget.total != null) amounts.push(budget.total);
    if (amounts.some(amount => typeof amount !== 'number' || moneyMinor(amount) === null || amount < 0)) {
      throw storageError('INVALID_SETTINGS', 'Некорректная сумма бюджета.');
    }
  }
  for (const [key, closure] of Object.entries(settings.monthClosures || {})) {
    // Validate only month records read by Control; preserve unrelated future fields.
    if (!/^[^\u0001]+\u0001\d{4}-(0[1-9]|1[0-2])$/.test(key)) continue;
    if (!isPlainObject(closure)) throw storageError('INVALID_SETTINGS', 'Некорректный сохранённый итог месяца.');
    if (own(closure, 'status') && !['open', 'closed'].includes(closure.status)) throw storageError('INVALID_SETTINGS', 'Некорректный статус сохранённого месяца.');
    if (closure.totals == null) continue;
    if (!isPlainObject(closure.totals)) throw storageError('INVALID_SETTINGS', 'Некорректный сохранённый итог месяца.');
    if (closure.totals.netSpend != null && ((typeof closure.totals.netSpend !== 'number' && typeof closure.totals.netSpend !== 'string') || moneyMinor(closure.totals.netSpend) === null)) {
      throw storageError('INVALID_SETTINGS', 'Некорректная сумма сохранённого месяца.');
    }
  }
  for (const rule of settings.customRules || []) {
    for (const key of ['keywords', 'negativeKeywords', 'sources', 'tokens']) {
      if (own(rule, key) && (!Array.isArray(rule[key]) || rule[key].some(value => typeof value !== 'string'))) throw storageError('INVALID_SETTINGS', `Некорректное поле правила: ${key}.`);
    }
    for (const key of ['id', 'category', 'profile', 'keyword', 'token', 'contains', 'match']) {
      if (own(rule, key) && typeof rule[key] !== 'string') throw storageError('INVALID_SETTINGS', `Некорректное поле правила: ${key}.`);
    }
    if (own(rule, 'source') && typeof rule.source !== 'string' && (!Array.isArray(rule.source) || rule.source.some(value => typeof value !== 'string'))) {
      throw storageError('INVALID_SETTINGS', 'Некорректное поле правила: source.');
    }
    if (own(rule, 'enabled') && typeof rule.enabled !== 'boolean') throw storageError('INVALID_SETTINGS', 'Некорректное поле правила: enabled.');
    if (own(rule, 'match') && !['any', 'all', 'exact'].includes(rule.match)) throw storageError('INVALID_SETTINGS', 'Неизвестный способ совпадения правила.');
    if (own(rule, 'priority') && ((typeof rule.priority !== 'number' && typeof rule.priority !== 'string') || !String(rule.priority).trim() || !Number.isFinite(Number(rule.priority)))) {
      throw storageError('INVALID_SETTINGS', 'Некорректный приоритет правила.');
    }
    for (const key of ['amountMin', 'amountMax']) {
      if (rule[key] == null) continue;
      const amount = moneyMinor(rule[key]);
      if ((typeof rule[key] !== 'number' && typeof rule[key] !== 'string') || amount === null || amount < 0) throw storageError('INVALID_SETTINGS', `Некорректная сумма правила: ${key}.`);
    }
    if (rule.amountMin != null && rule.amountMax != null && moneyMinor(rule.amountMin) > moneyMinor(rule.amountMax)) {
      throw storageError('INVALID_SETTINGS', 'Минимальная сумма правила больше максимальной.');
    }
  }
}

function validateState(state) {
  if (!isPlainObject(state) || !Array.isArray(state.rows) || !isPlainObject(state.settings) || !isPlainObject(state.metadata)) {
    throw storageError('INVALID_STATE', 'Состояние должно содержать rows, settings и metadata.');
  }
  if (state.rows.length > MAX_ROWS) throw storageError('TOO_MANY_ROWS', 'Слишком много покупок.');
  validateJson(state);
  if (own(state, 'settlementOriginals') && (!Array.isArray(state.settlementOriginals) || state.settlementOriginals.some(row => !isPlainObject(row)))) {
    throw storageError('INVALID_STATE', 'Некорректный архив исходных строк чеков.');
  }
  validateSettings(state.settings);
  const applied = state.metadata.appliedCollections;
  if (applied != null && (!isPlainObject(applied) || ['ozon', 'wildberries', 'yandex'].some(source => applied[source] != null && typeof applied[source] !== 'string'))) {
    throw storageError('INVALID_METADATA', 'Некорректные подтверждения сбора.');
  }
  const collection = state.metadata.collection;
  if (collection != null) {
    if (!isPlainObject(collection)) throw storageError('INVALID_METADATA', 'Некорректная диагностика сбора.');
    for (const key of ['sources', 'warnings']) {
      if (collection[key] != null && (!Array.isArray(collection[key]) || collection[key].some(value => typeof value !== 'string'))) {
        throw storageError('INVALID_METADATA', `Некорректная диагностика сбора: ${key}.`);
      }
    }
    if (collection.stats != null && (!isPlainObject(collection.stats) || ['ozon', 'wildberries', 'wb', 'yandex'].some(key => collection.stats[key] != null && !isPlainObject(collection.stats[key])))) {
      throw storageError('INVALID_METADATA', 'Некорректная статистика сбора.');
    }
  }
  const rowIds = new Set();
  state.rows.forEach((row, index) => {
    if (!isPlainObject(row)) throw storageError('INVALID_ROW', `Некорректная покупка ${index + 1}.`);
    if (typeof row.rowId !== 'string' || !row.rowId.trim() || rowIds.has(row.rowId)) {
      throw storageError('INVALID_ROW', `У покупки ${index + 1} нет rowId.`);
    }
    rowIds.add(row.rowId);
    if (typeof row.title !== 'string' || typeof row.source !== 'string' || !row.source.trim()) {
      throw storageError('INVALID_ROW', `У покупки ${index + 1} повреждено название или магазин.`);
    }
    validateDate(row.date, `rows[${index}].date`);
    validateAmount(row.amount, `rows[${index}].amount`);
    for (const field of ['category', 'note', 'profile', 'currency', 'type', 'parse_quality']) {
      if (row[field] != null && typeof row[field] !== 'string') throw storageError('INVALID_ROW', `Некорректное поле покупки: ${field}.`);
    }
    if (row.excluded != null && typeof row.excluded !== 'boolean') throw storageError('INVALID_ROW', 'Некорректная отметка исключения покупки.');
    if (own(row, 'settlement_predecessor')) {
      const link = row.settlement_predecessor;
      if (!isPlainObject(link) || ['receipt', 'item', 'rowId'].some(key => typeof link[key] !== 'string' || !link[key].trim())) {
        throw storageError('INVALID_ROW', 'Некорректная связь предоплаты и окончательного чека.');
      }
    }
  });
  return cloneJson(state);
}

function emptyState() {
  return { rows: [], settings: {}, metadata: {} };
}

function assertExpectedVersion(options) {
  if (!isPlainObject(options) || !own(options, 'expectedRevision') || !own(options, 'expectedEpoch')) {
    throw storageError('EXPECTED_VERSION_REQUIRED', 'Нужны expectedRevision и expectedEpoch.');
  }
  const { expectedRevision, expectedEpoch } = options;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) {
    throw storageError('INVALID_EXPECTED_VERSION', 'Некорректные expectedRevision или expectedEpoch.');
  }
  return { expectedRevision, expectedEpoch };
}

function assertCurrentVersion(actual, expected) {
  if (actual.epoch !== expected.expectedEpoch) {
    throw storageError('STALE_DATA_EPOCH', 'Данные были очищены в другой вкладке.');
  }
  if (actual.revision !== expected.expectedRevision) {
    throw storageError('STALE_SNAPSHOT_REVISION', 'Данные изменились в другой вкладке.');
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || storageError('INDEXEDDB_ERROR', 'Ошибка IndexedDB.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || storageError('INDEXEDDB_ERROR', 'Транзакция IndexedDB отменена.'));
    transaction.onerror = () => reject(transaction.error || storageError('INDEXEDDB_ERROR', 'Ошибка транзакции IndexedDB.'));
  });
}

function openDatabase(indexedDB, dbName) {
  if (!indexedDB || typeof indexedDB.open !== 'function') {
    throw storageError('INDEXEDDB_UNAVAILABLE', 'IndexedDB недоступен.');
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE.current)) database.createObjectStore(STORE.current, { keyPath: 'key' });
      if (!database.objectStoreNames.contains(STORE.history)) database.createObjectStore(STORE.history, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(STORE.meta)) database.createObjectStore(STORE.meta, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || storageError('INDEXEDDB_ERROR', 'Не удалось открыть IndexedDB.'));
  });
}

async function versionFromMeta(metaStore) {
  const [epochRecord, revisionRecord] = await Promise.all([
    requestResult(metaStore.get(META_EPOCH)),
    requestResult(metaStore.get(META_REVISION))
  ]);
  return {
    epoch: Number.isSafeInteger(epochRecord?.value) && epochRecord.value >= 0 ? epochRecord.value : 0,
    revision: Number.isSafeInteger(revisionRecord?.value) && revisionRecord.value >= 0 ? revisionRecord.value : 0
  };
}

function makeHistoryId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function trimHistory(historyStore) {
  const records = await requestResult(historyStore.getAll());
  records.sort((left, right) => right.revision - left.revision || String(right.createdAt).localeCompare(String(left.createdAt)));
  for (const record of records.slice(HISTORY_LIMIT)) historyStore.delete(record.id);
}

function historyItem(record) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    rows: record.rows.length,
    revision: record.revision
  };
}

function envelope(state, revision, epoch) {
  return { state: cloneJson(state), revision, epoch };
}

async function readCurrent(database) {
  const transaction = database.transaction([STORE.current, STORE.meta], 'readonly');
  const current = requestResult(transaction.objectStore(STORE.current).get(CURRENT_KEY));
  const version = versionFromMeta(transaction.objectStore(STORE.meta));
  const [currentRecord, currentVersion] = await Promise.all([current, version]);
  if (!currentRecord) return null;
  return envelope(validateState(currentRecord.state), currentVersion.revision, currentVersion.epoch);
}

async function openExistingLegacy(indexedDB) {
  if (typeof indexedDB.databases !== 'function') {
    throw storageError('LEGACY_READ_UNAVAILABLE', 'Этот браузер не умеет безопасно проверить старое хранилище.');
  }
  const databases = await indexedDB.databases();
  if (!databases.some((database) => database.name === 'kupleno-storage-v1')) return null;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('kupleno-storage-v1');
    request.onupgradeneeded = () => {
      request.transaction.abort();
      reject(storageError('LEGACY_READ_UNAVAILABLE', 'Старое хранилище изменилось во время чтения.'));
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || storageError('LEGACY_READ_FAILED', 'Не удалось прочитать старое хранилище.'));
  });
}

export function serializeBackup(state) {
  const safeState = validateState(state);
  const exportedAt = new Date().toISOString();
  return JSON.stringify({
    format: 'kupleno-backup',
    version: 2,
    exportedAt,
    createdAt: exportedAt,
    state: safeState
  });
}

export function parseBackup(text) {
  if (typeof text !== 'string') throw storageError('INVALID_BACKUP', 'Резервная копия должна быть текстом.');
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw storageError('DATA_TOO_LARGE', 'Резервная копия превышает допустимый размер.');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw storageError('INVALID_BACKUP', `Не удалось прочитать резервную копию: ${error.message}`);
  }
  if (!isPlainObject(parsed) || parsed.format !== 'kupleno-backup' || (parsed.version !== 1 && parsed.version !== 2)) {
    throw storageError('UNSUPPORTED_BACKUP', 'Неподдерживаемый формат резервной копии.');
  }
  if (own(parsed, 'exportedAt')) validateDate(parsed.exportedAt, 'exportedAt');
  if (own(parsed, 'createdAt')) validateDate(parsed.createdAt, 'createdAt');
  const state = parsed.version === 2 && own(parsed, 'state')
    ? parsed.state
    : { rows: parsed.rows, settings: parsed.settings, metadata: parsed.metadata };
  return {
    format: 'kupleno-backup',
    version: parsed.version,
    exportedAt: parsed.exportedAt,
    createdAt: parsed.createdAt,
    state: validateState(state)
  };
}

export function createStore({ indexedDB = globalThis.indexedDB, dbName = DEFAULT_DB_NAME } = {}) {
  if (typeof dbName !== 'string' || !dbName.trim()) throw storageError('INVALID_DB_NAME', 'Некорректное имя базы данных.');
  let databasePromise;
  const database = () => {
    if (!databasePromise) databasePromise = openDatabase(indexedDB, dbName);
    return databasePromise;
  };

  async function writeCurrent(state, expected, { nextEpoch = null, clearHistory = false } = {}) {
    const safeState = validateState(state);
    const db = await database();
    const transaction = db.transaction([STORE.current, STORE.history, STORE.meta], 'readwrite');
    const completed = transactionDone(transaction);
    const currentStore = transaction.objectStore(STORE.current);
    const historyStore = transaction.objectStore(STORE.history);
    const metaStore = transaction.objectStore(STORE.meta);
    try {
      const actual = await versionFromMeta(metaStore);
      assertCurrentVersion(actual, expected);
      const revision = actual.revision + 1;
      const epoch = nextEpoch === null ? actual.epoch : nextEpoch;
      const createdAt = new Date().toISOString();
      currentStore.put({ key: CURRENT_KEY, state: safeState, revision, epoch, createdAt });
      if (clearHistory) {
        historyStore.clear();
      } else {
        historyStore.put({ id: makeHistoryId(), createdAt, rows: safeState.rows, state: safeState, revision });
        await trimHistory(historyStore);
      }
      metaStore.put({ key: META_EPOCH, value: epoch });
      metaStore.put({ key: META_REVISION, value: revision });
      await completed;
      return envelope(safeState, revision, epoch);
    } catch (error) {
      // A synchronous request failure does not automatically abort IndexedDB.
      try { transaction.abort(); } catch { /* Already completed or aborted. */ }
      await completed.catch(() => {});
      throw error;
    }
  }

  return Object.freeze({
    async read() {
      return readCurrent(await database());
    },

    async readRecovery() {
      const db = await database();
      const tx = db.transaction([STORE.current, STORE.meta], 'readonly');
      const [record, version] = await Promise.all([
        requestResult(tx.objectStore(STORE.current).get(CURRENT_KEY)),
        versionFromMeta(tx.objectStore(STORE.meta))
      ]);
      // Only a downloadable JSON string leaves this path; invalid state never enters normal screens.
      let rawState = record?.state;
      if (!record) {
        const legacy = await openExistingLegacy(indexedDB);
        if (legacy) try {
          if (legacy.objectStoreNames.contains('meta') && legacy.objectStoreNames.contains('snapshots')) {
            const legacyTx = legacy.transaction(['meta', 'snapshots'], 'readonly');
            const latest = await requestResult(legacyTx.objectStore('meta').get('latestSnapshotId'));
            const snapshot = latest?.value ? await requestResult(legacyTx.objectStore('snapshots').get(latest.value)) : null;
            if (snapshot) rawState = { rows: snapshot.rows, settings: snapshot.settings, metadata: snapshot.metadata };
          }
        } finally { legacy.close(); }
      }
      const backup = rawState ? JSON.stringify({ format: 'kupleno-backup', version: 2, state: rawState }) : null;
      return { ...version, backup };
    },

    async write(state, options) {
      return writeCurrent(state, assertExpectedVersion(options));
    },

    async history() {
      const db = await database();
      const transaction = db.transaction(STORE.history, 'readonly');
      const records = await requestResult(transaction.objectStore(STORE.history).getAll());
      return records
        .sort((left, right) => right.revision - left.revision || String(right.createdAt).localeCompare(String(left.createdAt)))
        .map(historyItem);
    },

    async restore(id, options) {
      const expected = assertExpectedVersion(options);
      if (typeof id !== 'string' || !id) throw storageError('INVALID_HISTORY_ID', 'Некорректный идентификатор истории.');
      const db = await database();
      const transaction = db.transaction(STORE.history, 'readonly');
      const record = await requestResult(transaction.objectStore(STORE.history).get(id));
      if (!record) throw storageError('HISTORY_NOT_FOUND', 'Снимок истории не найден.');
      return writeCurrent(record.state, expected);
    },

    async clear(options) {
      const expected = assertExpectedVersion(options);
      const db = await database();
      const readTransaction = db.transaction(STORE.meta, 'readonly');
      const actual = await versionFromMeta(readTransaction.objectStore(STORE.meta));
      return writeCurrent(emptyState(), expected, { nextEpoch: actual.epoch + 1, clearHistory: true });
    },

    async readLegacy() {
      const legacyDatabase = await openExistingLegacy(indexedDB);
      if (!legacyDatabase) return null;
      try {
        if (!legacyDatabase.objectStoreNames.contains('meta') || !legacyDatabase.objectStoreNames.contains('snapshots')) {
          throw storageError('LEGACY_READ_FAILED', 'Структура старого хранилища не поддерживается.');
        }
        const transaction = legacyDatabase.transaction(['meta', 'snapshots'], 'readonly');
        const metaStore = transaction.objectStore('meta');
        const latest = await requestResult(metaStore.get('latestSnapshotId'));
        const [epoch, revision] = await Promise.all([
          requestResult(metaStore.get('dataEpoch')),
          requestResult(metaStore.get('snapshotRevision'))
        ]);
        const snapshot = latest?.value ? await requestResult(transaction.objectStore('snapshots').get(latest.value)) : null;
        if (!snapshot) return null;
        return {
          id: snapshot.id,
          createdAt: snapshot.createdAt,
          state: validateState({ rows: snapshot.rows, settings: snapshot.settings, metadata: snapshot.metadata }),
          revision: Number.isSafeInteger(revision?.value) && revision.value >= 0 ? revision.value : 0,
          epoch: Number.isSafeInteger(epoch?.value) && epoch.value >= 0 ? epoch.value : 0
        };
      } finally {
        legacyDatabase.close();
      }
    }
  });
}
