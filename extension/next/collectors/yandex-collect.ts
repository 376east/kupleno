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
function resultData(payload: unknown, index = 0) {
  const root = object(payload), entries = array(root.results);
  const entry = object(entries[index]);
  const data = object(entry.data || (index === 0 ? root.data : undefined));
  if (!Object.keys(data).length || root.error || entry.error) throw new Error('Яндекс Маркет вернул неизвестный формат ответа.');
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
  let token = '', hasNext = false;
  try {
    const response = await options.fetch(origin + ordersPath, { credentials: 'include', signal: options.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = (await response.text()).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    if (html.length > 12 * 1024 * 1024) throw new Error('Слишком большая страница заказов.');
    for (const match of html.matchAll(/\/my\/order\/(\d+)/g)) orderIds.add(match[1]!);
    for (const match of html.matchAll(/"(?:orderGroupIds|ordersGroupsIds)"\s*:\s*\[([^\]]*)\]/g)) for (const id of match[1]!.match(/\d{6,}/g) || []) orderIds.add(id);
    const encoded = html.match(/"pageToken"\s*:\s*("(?:\\.|[^"\\])*")/);
    if (encoded) token = JSON.parse(encoded[1]!);
    hasNext = /"hasNext"\s*:\s*true/.test(html);
    if (!headers.sk) headers.sk = html.match(/"sk"\s*:\s*"([^"\r\n]+)"/)?.[1] || '';
  } catch (e) { if (options.signal?.aborted) throw e; warnings.push('Яндекс Маркет: начальная страница не прочитана, проверяем API заказов.'); }
  cap(orderIds.size);
  if (hasNext && !token) { incomplete = true; warnings.push('Яндекс Маркет: не найден указатель следующей страницы заказов.'); }
  const visited = new Set<string>();
  let requestPage = !orderIds.size || (hasNext && !!token);
  while (requestPage && pages < 2000) {
    if (visited.has(token)) { incomplete = true; warnings.push('Яндекс Маркет: повторилась страница заказов.'); break; }
    visited.add(token); pages++;
    let page: Record<string, unknown> | null = null;
    for (const resolver of orderResolvers) {
      try {
        const data = resultData(await resolve(resolver, [{ ...(token ? { pageToken: token } : {}), filter: 'COMPLETED', size: 18 }]));
        const collection = object(object(data.collections).orderConsolidationResult);
        const id = Array.isArray(data.result) ? data.result[0] : data.result;
        const candidate = object(collection[String(id)] || Object.values(collection)[0]);
        if (!Array.isArray(candidate.ordersGroupsIds) && !Array.isArray(candidate.orderGroupIds)) throw new Error('Список заказов не распознан.');
        page = candidate; break;
      } catch (e) { if (options.signal?.aborted) throw e; }
    }
    if (!page) { if (!orderIds.size) throw new Error('Яндекс Маркет: формат списка заказов не распознан. Проверьте вход и повторите сбор.'); incomplete = true; warnings.push('Яндекс Маркет: следующие страницы заказов не прочитаны.'); break; }
    for (const id of array(page.ordersGroupsIds || page.orderGroupIds)) if (/^\d+$/.test(String(id))) orderIds.add(String(id));
    cap(orderIds.size);
    token = typeof page.pageToken === 'string' ? page.pageToken : '';
    if (page.hasNext === true && !token) {
      incomplete = true;
      warnings.push('Яндекс Маркет: не найден указатель следующей страницы заказов.');
    }
    requestPage = page.hasNext !== false && !!token;
    await options.onProgress?.({ done: pages, total: 0, message: `Яндекс Маркет: найдено ${orderIds.size} заказов.` });
  }
  if (requestPage && pages >= 2000) { incomplete = true; warnings.push('Яндекс Маркет: достигнут лимит страниц заказов.'); }
  const receipts = new Map<string, { id: string; url: string; orderId: string; type: string; date?: string }>();
  let checked = 0;
  await mapConcurrent([...orderIds], 4, async orderId => {
    let found = false, errored = false, invalidReceipt = false;
    for (const archived of [false, true]) {
      try {
        const data = resultData(await resolve(receiptResolver, [{ orderId: Number(orderId), archived }]));
        if (!Array.isArray(data.result)) throw new Error('Список чеков заказа не распознан.');
        const collection = object(object(data.collections).orderReceipt);
        for (const receiptId of data.result) {
          const receipt = object(collection[String(receiptId)]);
          if (typeof receipt.fiscalUrl !== 'string' || !receipt.fiscalUrl.trim()) { invalidReceipt = true; rememberFailure(new Error('Магазин не предоставил ссылку на часть чеков.')); continue; }
          let url: string;
          try { url = safeReceipt(receipt.fiscalUrl); }
          catch {
            invalidReceipt = true;
            rememberFailure(new Error('Магазин предоставил некорректную ссылку на часть чеков.'));
            continue;
          }
          const created = typeof receipt.createdAt === 'number' ? new Date(receipt.createdAt < 1e12 ? receipt.createdAt * 1000 : receipt.createdAt) : null;
          receipts.set(url, { id: String(receipt.id || receiptId), url, orderId, type: String(receipt.type || ''), date: created && Number.isFinite(created.valueOf()) ? created.toISOString() : undefined });
          found = true; cap(receipts.size);
        }
        if (found && !invalidReceipt) break;
      } catch (e) { if (options.signal?.aborted || (e as { code?: string }).code === 'ROW_LIMIT_EXCEEDED') throw e; errored = true; rememberFailure(e); }
    }
    if (invalidReceipt || (errored && !found)) failedOrders++;
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
  return { rows, processedReceipts: [...new Set(rows.map(row => row.receipt_url || row.marketplace_id || '').filter(Boolean))], warnings, stats: { orders: orderIds.size, receipts: receipts.size, pages, failedOrders, failedReceipts, removed: 0, incomplete, fallbackReceipts: new Set(rows.filter(row => row.parse_quality === 'fallback').map(row => row.marketplace_id)).size, unverifiedReceipts: new Set(rows.filter(row => row.parse_quality === 'unverified').map(row => row.marketplace_id)).size } };
}
