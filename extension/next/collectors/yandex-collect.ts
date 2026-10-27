import type { CollectionResult } from '../collection';
import type { Purchase } from '../model';
import { parseYandexReceipt } from './yandex.ts';
import { mapConcurrent } from './pool.ts';

export interface YandexContext { sk?: string; version?: string; marketFrontGlue?: string; pageId?: string; retpath?: string }
const origin = 'https://market.yandex.ru';
const ordersPath = '/my/orders?filter=COMPLETED';
const orderResolvers = ['src/resolvers/orders/resolveConsolidationOrders/index:resolveConsolidationOrders', 'src/resolvers/orders/resolveConsolidationOrders:resolveConsolidationOrders'];
const receiptResolver = 'src/resolvers/orderDocuments/resolveOrderReceiptsByOrderId:resolveOrderReceiptsByOrderId';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const cap = (size: number) => { if (size > 100000) throw Object.assign(new Error('В сборе больше 100 000 операций.'), { code: 'ROW_LIMIT_EXCEEDED' }); };
function resultData(payload: unknown, diagnostics: Record<string, number>, index = 0) {
  const root = object(payload), entries = array(root.results);
  const entry = object(entries[index]);
  const errors = [root.error, entry.error].filter(Boolean);
  if (root.error) diagnostics.responseRootErrors!++;
  if (entry.error) diagnostics.responseEntryErrors!++;
  const codes = { NOT_FOUND: 'resolverNotFoundErrors', FORBIDDEN: 'resolverForbiddenErrors', UNAUTHORIZED: 'resolverUnauthorizedErrors', TOO_MANY_REQUESTS: 'resolverRateLimitErrors' } as const;
  for (const error of errors) {
    const code = typeof error === 'string' ? error : object(error).code;
    const counter = typeof code === 'string' && Object.hasOwn(codes, code) ? codes[code as keyof typeof codes] : 'resolverOtherErrors';
    diagnostics[counter]!++;
  }
  const value = entry.data || (index === 0 ? root.data : undefined), data = object(value);
  if (!errors.length && !Object.keys(data).length) {
    if (value && typeof value === 'object' && !Array.isArray(value)) diagnostics.responseEmptyData!++;
    else {
      diagnostics.responseMalformedData!++;
      if (payload === null) diagnostics.responseRootNull!++;
      else if (Array.isArray(payload)) diagnostics.responseRootArray!++;
      else if (typeof payload !== 'object') diagnostics.responseRootPrimitive!++;
      else if (!Object.keys(root).length) diagnostics.responseRootEmpty!++;
      if (Object.hasOwn(root, 'errors')) diagnostics.responseRootErrorsField!++;
      const raw = Object.hasOwn(entry, 'data') ? entry.data : index === 0 ? root.data : undefined;
      const counter = raw === undefined ? 'responseDataMissing' : raw === null ? 'responseDataNull' : Array.isArray(raw) ? 'responseDataArray' : 'responseDataPrimitive';
      diagnostics[counter]!++;
      if (root.results === undefined) diagnostics.responseResultsMissing!++;
      else if (Array.isArray(root.results) && !root.results.length) diagnostics.responseResultsEmpty!++;
      else if (!Array.isArray(root.results)) diagnostics.responseResultsMalformed!++;
    }
  }
  if (!Object.keys(data).length || errors.length) throw new Error('Яндекс Маркет вернул неизвестный формат ответа.');
  return data;
}
function safeReceipt(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'check.yandex.ru' || url.username || url.password) throw new Error('Неподдерживаемая ссылка на чек Яндекс Маркета.');
  return url.href;
}
export async function collectYandex(options: { fetch: typeof fetch; signal?: AbortSignal; onProgress?: (p: { done: number; total: number; message: string }) => void | Promise<void>; context?: YandexContext }): Promise<CollectionResult> {
  const warnings: string[] = [], orderIds = new Set<string>();
  const failures = new Set<string>();
  const rememberFailure = (error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    failures.add(!/[\r\n]|https?:|token|Bearer/i.test(message) && message.length < 180 ? message : 'Не удалось обработать ответ магазина.');
  };
  let pages = 0, incomplete = false, failedOrders = 0;
  const diagnostics = { responseRootErrors: 0, responseEntryErrors: 0, responseEmptyData: 0, responseMalformedData: 0, responseMalformedResult: 0,
    responseRootNull: 0, responseRootArray: 0, responseRootPrimitive: 0, responseRootEmpty: 0, responseRootErrorsField: 0,
    responseDataMissing: 0, responseDataNull: 0, responseDataArray: 0, responseDataPrimitive: 0, responseResultsMissing: 0, responseResultsEmpty: 0, responseResultsMalformed: 0,
    resolverNotFoundErrors: 0, resolverForbiddenErrors: 0, resolverUnauthorizedErrors: 0, resolverRateLimitErrors: 0, resolverOtherErrors: 0,
    missingUrlOrders: 0, unsafeUrlOrders: 0, responseErrorOrders: 0, noReceiptOrders: 0 };
  const pagination = { lastPageItems: 0, lastPageIds: 0, lastPageNewIds: 0, lastPageHasNextKnown: false, lastPageHasNext: false, lastPageCursorPresent: false, lastPageCursorMatchesRequest: false, repeatedCursor: false };
  const headers: Record<string, string> = { accept: '*/*', 'content-type': 'application/json', 'x-market-apphost-target': 'WEB', 'x-market-core-service': '<UNKNOWN>', 'x-market-page-id': options.context?.pageId || 'market:orders', 'x-requested-with': 'XMLHttpRequest', 'x-retpath-y': origin + ordersPath };
  if (options.context?.sk) headers.sk = options.context.sk;
  if (options.context?.version) headers['x-market-app-version'] = options.context.version;
  if (options.context?.marketFrontGlue) headers['x-market-front-glue'] = options.context.marketFrontGlue;
  async function resolve(resolver: string, params: Record<string, unknown>[]) {
    options.signal?.throwIfAborted();
    const url = new URL('/api/resolve/', origin); url.searchParams.set('r', resolver);
    const response = await options.fetch(url.href, { method: 'POST', credentials: 'include', signal: options.signal, headers, body: JSON.stringify({ params, path: ordersPath }) });
    if (!response.ok) throw new Error(`Яндекс Маркет: HTTP ${response.status}.`);
    if (response.url && new URL(response.url).origin !== origin) throw new Error('Яндекс Маркет перенаправил запрос. Проверьте вход.');
    const body = await response.text(); if (body.length > 8 * 1024 * 1024) throw new Error('Ответ Яндекс Маркета слишком большой.');
    try { return JSON.parse(body) as unknown; } catch { throw new Error('Яндекс Маркет вернул страницу вместо данных. Проверьте вход.'); }
  }
  let token = '';
  try {
    const response = await options.fetch(origin + ordersPath, { credentials: 'include', signal: options.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = (await response.text()).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    if (html.length > 12 * 1024 * 1024) throw new Error('Слишком большая страница заказов.');
    for (const match of html.matchAll(/\/my\/order\/(\d+)/g)) orderIds.add(match[1]!);
    for (const match of html.matchAll(/"(?:orderGroupIds|ordersGroupsIds)"\s*:\s*\[([^\]]*)\]/g)) for (const id of match[1]!.match(/\d{6,}/g) || []) orderIds.add(id);
    if (!headers.sk) headers.sk = html.match(/"sk"\s*:\s*"([^"\r\n]+)"/)?.[1] || '';
  } catch (e) { if (options.signal?.aborted) throw e; warnings.push('Яндекс Маркет: начальная страница не прочитана, проверяем API заказов.'); }
  cap(orderIds.size);
  const visited = new Set<string>();
  // Rendered orders are only a seed: missing HTML pagination metadata is not the end of history.
  let requestPage = true;
  while (requestPage && pages < 2000) {
    if (visited.has(token)) { pagination.repeatedCursor = true; incomplete = true; warnings.push('Яндекс Маркет: повторилась страница заказов.'); break; }
    visited.add(token); pages++;
    let page: Record<string, unknown> | null = null;
    for (const resolver of orderResolvers) {
      try {
        const data = resultData(await resolve(resolver, [{ ...(token ? { pageToken: token } : {}), filter: 'COMPLETED', size: 18 }]), diagnostics);
        const collection = object(object(data.collections).orderConsolidationResult);
        const id = Array.isArray(data.result) ? data.result[0] : data.result;
        const candidate = object(collection[String(id)] || Object.values(collection)[0]);
        if (!Array.isArray(candidate.ordersGroupsIds) && !Array.isArray(candidate.orderGroupIds)) { diagnostics.responseMalformedResult++; throw new Error('Список заказов не распознан.'); }
        page = candidate; break;
      } catch (e) { if (options.signal?.aborted) throw e; }
    }
    if (!page) { if (!orderIds.size) throw new Error('Яндекс Маркет: формат списка заказов не распознан. Проверьте вход и повторите сбор.'); incomplete = true; warnings.push('Яндекс Маркет: следующие страницы заказов не прочитаны.'); break; }
    const items = Array.isArray(page.ordersGroupsIds) ? page.ordersGroupsIds : array(page.orderGroupIds);
    const ids = items.map(String).filter(id => /^\d+$/.test(id));
    pagination.lastPageItems = items.length;
    pagination.lastPageIds = ids.length;
    pagination.lastPageNewIds = new Set(ids.filter(id => !orderIds.has(id))).size;
    pagination.lastPageHasNextKnown = typeof page.hasNext === 'boolean';
    pagination.lastPageHasNext = page.hasNext === true;
    pagination.lastPageCursorPresent = typeof page.pageToken === 'string' && !!page.pageToken;
    pagination.lastPageCursorMatchesRequest = pagination.lastPageCursorPresent && page.pageToken === token;
    for (const id of ids) orderIds.add(id);
    cap(orderIds.size);
    token = typeof page.pageToken === 'string' ? page.pageToken : '';
    if (page.hasNext === true && !token) {
      incomplete = true;
      warnings.push('Яндекс Маркет: не найден указатель следующей страницы заказов.');
    }
    requestPage = page.hasNext !== false && !!token && (items.length > 0 || page.hasNext === true);
    await options.onProgress?.({ done: pages, total: 0, message: `Яндекс Маркет: найдено ${orderIds.size} заказов.` });
  }
  if (requestPage && pages >= 2000) { incomplete = true; warnings.push('Яндекс Маркет: достигнут лимит страниц заказов.'); }
  const receipts = new Map<string, { id: string; url: string; orderId: string; type: string; date?: string }>();
  let checked = 0;
  await mapConcurrent([...orderIds], 4, async orderId => {
    let found = false, emptyLists = 0;
    const validIds = new Set<string>(), unresolved = new Map<string, 'missing' | 'unsafe'>(), resolverErrors: unknown[] = [];
    for (const archived of [false, true]) {
      try {
        const data = resultData(await resolve(receiptResolver, [{ orderId: Number(orderId), archived }]), diagnostics);
        if (!Array.isArray(data.result)) { diagnostics.responseMalformedResult++; throw new Error('Список чеков заказа не распознан.'); }
        if (!data.result.length) emptyLists++;
        const collection = object(object(data.collections).orderReceipt);
        for (const receiptId of data.result) {
          const id = String(receiptId), receipt = object(collection[id]);
          if (typeof receipt.fiscalUrl !== 'string' || !receipt.fiscalUrl.trim()) {
            if (!validIds.has(id)) unresolved.set(id, 'missing');
            continue;
          }
          let url: string;
          try { url = safeReceipt(receipt.fiscalUrl); }
          catch {
            if (!validIds.has(id)) unresolved.set(id, 'unsafe');
            continue;
          }
          const created = typeof receipt.createdAt === 'number' ? new Date(receipt.createdAt < 1e12 ? receipt.createdAt * 1000 : receipt.createdAt) : null;
          receipts.set(url, { id: String(receipt.id || receiptId), url, orderId, type: String(receipt.type || ''), date: created && Number.isFinite(created.valueOf()) ? created.toISOString() : undefined });
          validIds.add(id); unresolved.delete(id);
          found = true; cap(receipts.size);
        }
        if (found && !unresolved.size) break;
      } catch (e) { if (options.signal?.aborted || (e as { code?: string }).code === 'ROW_LIMIT_EXCEEDED') throw e; resolverErrors.push(e); }
    }
    if (unresolved.size || (resolverErrors.length && !found)) {
      failedOrders++;
      if ([...unresolved.values()].includes('missing')) diagnostics.missingUrlOrders++;
      if ([...unresolved.values()].includes('unsafe')) diagnostics.unsafeUrlOrders++;
      if (resolverErrors.length) diagnostics.responseErrorOrders++;
      for (const reason of unresolved.values()) rememberFailure(new Error(reason === 'missing' ? 'Магазин не предоставил ссылку на часть чеков.' : 'Магазин предоставил некорректную ссылку на часть чеков.'));
      for (const error of resolverErrors) rememberFailure(error);
    }
    if (emptyLists === 2) diagnostics.noReceiptOrders++;
    await options.onProgress?.({ done: ++checked, total: orderIds.size, message: `Яндекс Маркет: проверено ${checked} из ${orderIds.size} заказов.` });
  }, options.signal);
  let rowCount = 0;
  let failedReceipts = 0, done = 0;
  const chunks = await mapConcurrent([...receipts.values()].sort((a,b) => a.url.localeCompare(b.url)), 4, async receipt => {
    let rows: Purchase[] = [];
    try {
      options.signal?.throwIfAborted();
      const response = await options.fetch(receipt.url, { credentials: 'include', signal: options.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (response.url) safeReceipt(response.url);
      const html = await response.text(); if (html.length > 8 * 1024 * 1024) throw new Error('Слишком большой чек.');
      const parsed = parseYandexReceipt(html, receipt);
      if (!parsed.length || parsed.some(row => !row.date)) throw new Error('Не удалось прочитать чек.');
      rowCount += parsed.length; cap(rowCount); rows = parsed;
    } catch (e) { if (options.signal?.aborted || (e as { code?: string }).code === 'ROW_LIMIT_EXCEEDED') throw e; failedReceipts++; }
    await options.onProgress?.({ done: ++done, total: receipts.size, message: `Яндекс Маркет: прочитано ${done} из ${receipts.size} чеков.` });
    return rows;
  }, options.signal);
  const rows = chunks.flat();
  if (failedOrders || failedReceipts) warnings.push(`Яндекс Маркет: ошибки у ${failedOrders} заказов и ${failedReceipts} чеков. Ранее сохранённая история остаётся.`);
  if (!rows.length && (failedOrders || failedReceipts)) throw new Error(`${warnings.at(-1)} ${[...failures].slice(0,3).join(' ')}`.trim());
  if (failedOrders && failures.size) warnings.push(`Яндекс Маркет: причины пропуска — ${[...failures].slice(0,3).join(' ')}`);
  return { rows, processedReceipts: [...new Set(rows.map(row => row.receipt_url || row.marketplace_id || '').filter(Boolean))], warnings, stats: { orders: orderIds.size, receipts: receipts.size, pages, failedOrders, failedReceipts, removed: 0, incomplete, ...diagnostics, ...pagination, fallbackReceipts: new Set(rows.filter(row => row.parse_quality === 'fallback').map(row => row.marketplace_id)).size, unverifiedReceipts: new Set(rows.filter(row => row.parse_quality === 'unverified').map(row => row.marketplace_id)).size } };
}
