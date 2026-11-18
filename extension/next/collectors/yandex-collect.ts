import type { CollectionResult, YandexOrdersDomResult, YandexDocumentsResult } from '../collection.ts';
import { readUnresolvedOrderIds, readYandexOrdersDomResult, readYandexDocumentsResult } from '../collection.ts';
import type { Purchase } from '../model';
import { parseYandexReceipt } from './yandex.ts';
import { readYandexPayment } from './fiscal.ts';
import { readYandexFiscalId } from '../domain.mjs';
import { mapConcurrent } from './pool.ts';
import type { YandexReceiptCacheSession } from './yandex-receipt-cache.ts';

export interface YandexContext { sk?: string; version?: string; marketFrontGlue?: string; pageId?: string; retpath?: string; initialOrders?: { orderIds: string[]; pageToken: string } }
const origin = 'https://market.yandex.ru';
const ordersPath = '/my/orders?filter=COMPLETED';
const orderResolvers = ['src/resolvers/orders/resolveConsolidationOrders/index:resolveConsolidationOrders', 'src/resolvers/orders/resolveConsolidationOrders:resolveConsolidationOrders'];
const receiptResolver = 'src/resolvers/orderDocuments/resolveOrderReceiptsByOrderId:resolveOrderReceiptsByOrderId';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
type Receipt = { id: string; url: string; orderId: string; type: string; date?: string };
const cap = (size: number) => { if (size > 100000) throw Object.assign(new Error('В сборе больше 100 000 операций.'), { code: 'ROW_LIMIT_EXCEEDED' }); };
// listErrorCode is the one-based position here; zero means unrecognised or absent.
const knownResolverCodes = ['RESOLVER_NOT_FOUND', 'NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED', 'TOO_MANY_REQUESTS', 'INTERNAL_SERVER_ERROR', 'TIMEOUT'];
const globalApiFailure = (error: unknown) => ['YANDEX_CHALLENGE', 'YANDEX_API_NON_JSON', 'YANDEX_API_LOGIN', 'YANDEX_API_REDIRECT', 'YANDEX_REQUEST_TIMEOUT_UNSETTLED'].includes(String(object(error).code));
const challengeError = () => Object.assign(new Error('Яндекс Маркет запросил проверку доступа. Если магазин покажет её, пройдите проверку и повторите сбор. Иначе попробуйте позже.'), { code: 'YANDEX_CHALLENGE' });
// Shape types: 0 missing, 1 null, 2 array, 3 object, 4 string, 5 number, 6 boolean, 7 other.
const shapeType = (value: unknown) => value === undefined ? 0 : value === null ? 1 : Array.isArray(value) ? 2 : typeof value === 'object' ? 3 : typeof value === 'string' ? 4 : typeof value === 'number' ? 5 : typeof value === 'boolean' ? 6 : 7;
function captureRootShape(root: Record<string, unknown>, diagnostics: Record<string, number>) {
  // Mask bits, least significant first: result, collections, type, status, captcha, message, code, redirect, url.
  const mask = ['result', 'collections', 'type', 'status', 'captcha', 'message', 'code', 'redirect', 'url'].reduce((mask, key, index) => mask | (Object.hasOwn(root, key) ? 1 << index : 0), 0);
  const receiptCollection = object(root.collections).orderReceipt;
  const shape = { responseShapeKeyMask: mask, responseShapeKeyCount: Object.keys(root).length, responseShapeResultType: shapeType(root.result),
    responseShapeCollectionsType: shapeType(root.collections), responseShapeOrderReceiptType: shapeType(receiptCollection) };
  if (!diagnostics.responseShapeCaptured) {
    Object.assign(diagnostics, shape, { responseShapeCaptured: 1, responseShapeResultCount: array(root.result).length, responseShapeReceiptCount: Object.keys(object(receiptCollection)).length });
  } else if (Object.entries(shape).some(([key, value]) => diagnostics[key] !== value)) diagnostics.responseShapeDifferent!++;
}
function isChallengeUrl(value: unknown) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value, origin);
    return url.protocol === 'https:' && !url.username && !url.password && /(^|\.)yandex\.(ru|com)$/.test(url.hostname) && /^\/(showcaptcha|checkcaptcha|captcha)(\/|$)/i.test(url.pathname);
  } catch { return false; }
}
function checkChallenge(root: Record<string, unknown>, diagnostics: Record<string, number>) {
  const captcha = root.captcha, fields = object(captcha);
  const challengeRedirect = [root.url, root.redirect].some(isChallengeUrl);
  if ([root.type, root.status].some(value => value === 'captcha' || value === 'CAPTCHA_REQUIRED' || value === 'SHOW_CAPTCHA') || captcha === true ||
      (typeof captcha === 'string' && !!captcha.trim()) || Object.keys(object(captcha)).length > 0 || challengeRedirect) {
    if (!diagnostics.challengeResponses) {
      diagnostics.captchaValueType = shapeType(captcha);
      diagnostics.captchaObjectKeys = Object.keys(fields).length;
      // Key bits: url, redirect, captcha-page, form-action, img-url, key. Values never leave this function.
      diagnostics.captchaObjectKeyMask = ['url', 'redirect', 'captcha-page', 'form-action', 'img-url', 'key'].reduce((mask, key, index) => mask | (Object.hasOwn(fields, key) ? 1 << index : 0), 0);
      // Candidate bits: root.url, root.redirect, captcha string, captcha.url, captcha.redirect, captcha-page.
      diagnostics.captchaUrlCandidateMask = [root.url, root.redirect, captcha, fields.url, fields.redirect, fields['captcha-page']].reduce<number>((mask, value, index) => mask | (isChallengeUrl(value) ? 1 << index : 0), 0);
    }
    diagnostics.challengeResponses!++;
    throw challengeError();
  }
}
function resultData(payload: unknown, diagnostics: Record<string, number>, index = 0, list = false) {
  const root = object(payload), entries = array(root.results);
  const entry = object(entries[index]);
  const errors = [root.error, entry.error].filter(Boolean);
  const value = entry.data || (index === 0 ? root.data : undefined), data = object(value);
  if (!errors.length && !Object.keys(data).length && Object.keys(root).length) captureRootShape(root, diagnostics);
  checkChallenge(root, diagnostics);
  if (root.error) diagnostics.responseRootErrors!++;
  if (entry.error) diagnostics.responseEntryErrors!++;
  const codes = { NOT_FOUND: 'resolverNotFoundErrors', FORBIDDEN: 'resolverForbiddenErrors', UNAUTHORIZED: 'resolverUnauthorizedErrors', TOO_MANY_REQUESTS: 'resolverRateLimitErrors' } as const;
  let resolverCode = 0, resolverHttpStatus = 0;
  for (const error of errors) {
    const code = typeof error === 'string' ? error : object(error).code;
    const counter = typeof code === 'string' && Object.hasOwn(codes, code) ? codes[code as keyof typeof codes] : 'resolverOtherErrors';
    diagnostics[counter]!++;
    if (typeof code === 'string' && knownResolverCodes.includes(code)) resolverCode = knownResolverCodes.indexOf(code) + 1;
    const status = [object(error).status, object(error).statusCode, code].find(value => typeof value === 'number' && [502, 503, 504].includes(value));
    if (typeof status === 'number') resolverHttpStatus = status;
  }
  if (list && errors.length) { diagnostics.listErrorCode = resolverCode; diagnostics.listErrorHttpStatus = resolverHttpStatus; }
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
  if (!Object.keys(data).length || errors.length) throw Object.assign(new Error('Яндекс Маркет вернул неизвестный формат ответа.'), { resolverCode, resolverHttpStatus });
  return data;
}
function safeReceipt(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'check.yandex.ru' || url.username || url.password) throw new Error('Неподдерживаемая ссылка на чек Яндекс Маркета.');
  return url.href;
}
export async function collectYandex(options: { fetch: typeof fetch; signal?: AbortSignal; onProgress?: (p: { done: number; total: number; message: string }) => void | Promise<void>; context?: YandexContext; knownOrderIds?: string[]; onDiagnostics?: (stats: Record<string, number | boolean>) => void; readOrdersDom?: () => Promise<YandexOrdersDomResult>; readOrderDocuments?: (orderId: string) => Promise<YandexDocumentsResult>; receiptCache?: YandexReceiptCacheSession }): Promise<CollectionResult> {
  const startedAt = Date.now();
  const timings = { listingElapsedMs: 0, metadataElapsedMs: 0, documentFallbackElapsedMs: 0, receiptFetchElapsedMs: 0, elapsedMs: 0 };
  type Stage = Exclude<keyof typeof timings, 'elapsedMs'>;
  let stage: Stage | undefined = 'listingElapsedMs', stageStartedAt = startedAt;
  const duration = (value: number) => Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value))) : 0;
  const finishStage = (next?: Stage) => {
    const now = Date.now();
    if (stage) timings[stage] = duration(timings[stage] + duration(now - stageStartedAt));
    timings.elapsedMs = duration(now - startedAt);
    stage = next; stageStartedAt = now;
  };
  const warnings: string[] = [], orderIds = new Set<string>();
  const failures = new Set<string>();
  const rememberFailure = (error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    failures.add(!/[\r\n]|https?:|token|Bearer/i.test(message) && message.length < 180 ? message : 'Не удалось обработать ответ магазина.');
  };
  let pages = 0, incomplete = false, failedOrders = 0;
  const diagnostics = { responseRootErrors: 0, responseEntryErrors: 0, responseEmptyData: 0, responseMalformedData: 0, responseMalformedResult: 0,
    responseShapeCaptured: 0, responseShapeKeyMask: 0, responseShapeKeyCount: 0, responseShapeResultType: 0, responseShapeCollectionsType: 0, responseShapeOrderReceiptType: 0,
    responseShapeResultCount: 0, responseShapeReceiptCount: 0, responseShapeDifferent: 0, challengeResponses: 0, uncheckedOrders: 0,
    captchaValueType: 0, captchaObjectKeys: 0, captchaObjectKeyMask: 0, captchaUrlCandidateMask: 0,
    responseRootNull: 0, responseRootArray: 0, responseRootPrimitive: 0, responseRootEmpty: 0, responseRootErrorsField: 0,
    responseDataMissing: 0, responseDataNull: 0, responseDataArray: 0, responseDataPrimitive: 0, responseResultsMissing: 0, responseResultsEmpty: 0, responseResultsMalformed: 0,
    resolverNotFoundErrors: 0, resolverForbiddenErrors: 0, resolverUnauthorizedErrors: 0, resolverRateLimitErrors: 0, resolverOtherErrors: 0,
    missingUrlOrders: 0, unsafeUrlOrders: 0, responseErrorOrders: 0, noReceiptOrders: 0, receiptMetadataRequests: 0, receiptMetadataOrdersRequested: 0, apiResponseStatus: 0, apiNonJsonResponses: 0, apiHtmlResponses: 0, apiOtherNonJsonResponses: 0, providerHtmlResponses: 0, providerChallengeResponses: 0, providerLoginResponses: 0, providerRedirectResponses: 0, providerChallengeOpenedResponses: 0,
    providerLiveSkResponses: 0, providerContextSkResponses: 0, providerContextSkUsedResponses: 0, transientRetries: 0, transientExhausted: 0, requestTimeoutResponses: 0, listErrorCode: 0, listErrorHttpStatus: 0, domFallbackAttempts: 0, domFallbackSteps: 0, domFallbackOrdersAdded: 0, domFallbackClicks: 0, domFallbackBlocked: 0, domFallbackLimits: 0, missingReceiptRecords: 0, missingFiscalUrlFields: 0, emptyFiscalUrls: 0, invalidFiscalUrlTypes: 0,
    domReceiptOrdersAttempted: 0, domReceiptUrlsAdded: 0, domReceiptBlocked: 0, domReceiptCompleteDialogs: 0, domReceiptLimits: 0, cachedReceipts: 0, receiptNetworkRequests: 0, cacheReadErrors: 0, cacheWriteErrors: 0,
    receiptForbiddenErrors: 0, receiptRateLimitErrors: 0, receiptHttpErrors: 0, receiptTimeoutErrors: 0, receiptNetworkErrors: 0, receiptParseErrors: 0, receiptOversizeErrors: 0, receiptRedirectErrors: 0,
    domReceiptNavigationWaits: 0, domReceiptButtonWaits: 0, domReceiptDialogWaits: 0, domReceiptLoadingWaits: 0, domReceiptErrorWaits: 0, domReceiptUnrecognizedWaits: 0, domReceiptRequestErrors: 0,
    listedOrders: 0, knownOrdersAdded: 0 };
  const pagination = { lastPageItems: 0, lastPageIds: 0, lastPageNewIds: 0, lastPageHasNextKnown: false, lastPageHasNext: false, lastPageCursorPresent: false, lastPageCursorMatchesRequest: false, repeatedCursor: false };
  const receipts = new Map<string, Receipt & { orderIds: Set<string> }>();
  const addReceipt = (receipt: Receipt): boolean => {
    const key = readYandexFiscalId(receipt.url) || receipt.url;
    const existing = receipts.get(key);
    if (existing) {
      existing.orderIds.add(receipt.orderId);
      if (existing.orderIds.size > 1) existing.orderId = '';
      return false;
    }
    receipts.set(key, { ...receipt, orderIds: new Set([receipt.orderId]) });
    cap(receipts.size);
    return true;
  };
  const failedDocumentOrderIds = new Set<string>(), failedReceiptOrderIds = new Set<string>();
  let checked = 0, failedReceipts = 0, metadataStopped = false, hasMetadataFatal = false;
  let metadataFatal: unknown, metadataStopError: unknown;
  const snapshot = (): Record<string, number | boolean> => ({ orders: orderIds.size, receipts: receipts.size, pages, failedOrders, failedReceipts, removed: 0, incomplete, ...diagnostics, ...pagination, ...timings });
  let completedStats: Record<string, number | boolean> | undefined;
  async function run(): Promise<CollectionResult> {
  const headers: Record<string, string> = { accept: '*/*', 'content-type': 'application/json', 'x-market-apphost-target': 'WEB', 'x-market-core-service': '<UNKNOWN>', 'x-market-page-id': options.context?.pageId || 'market:orders', 'x-requested-with': 'XMLHttpRequest', 'x-retpath-y': origin + ordersPath };
  if (options.context?.sk) headers.sk = options.context.sk;
  if (options.context?.version) headers['x-market-app-version'] = options.context.version;
  if (options.context?.marketFrontGlue) headers['x-market-front-glue'] = options.context.marketFrontGlue;
  async function resolve(resolver: string, params: Record<string, unknown>[]) {
    options.signal?.throwIfAborted();
    const url = new URL('/api/resolve/', origin); url.searchParams.set('r', resolver);
    const receiptRequest = resolver === receiptResolver;
    const path = receiptRequest ? `/my/order/${params[0]!.orderId}` : ordersPath;
    const retpath = origin + path;
    const requestHeaders = { ...headers, 'x-retpath-y': retpath, ...(receiptRequest ? { 'x-market-page-id': 'market:order' } : {}) };
    for (let attempt = 0; attempt < 2; attempt++) {
    options.signal?.throwIfAborted();
    if (metadataStopped) throw metadataStopError;
    if (attempt) diagnostics.transientRetries++;
    if (receiptRequest) { diagnostics.receiptMetadataRequests++; diagnostics.receiptMetadataOrdersRequested += params.length; }
    let response: Response;
    try { response = await options.fetch(url.href, { method: 'POST', credentials: 'include', referrer: retpath, signal: options.signal, headers: requestHeaders, body: JSON.stringify({ params, path }) }); }
    catch (error) {
      options.signal?.throwIfAborted();
      if (object(error).code !== 'YANDEX_REQUEST_TIMEOUT') throw error;
      diagnostics.requestTimeoutResponses++;
      if (!attempt) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
      diagnostics.transientExhausted++;
      throw Object.assign(new Error('Истекло время запроса Яндекс Маркета.'), { code: 'YANDEX_TRANSIENT_EXHAUSTED' });
    }
    diagnostics.apiResponseStatus = response.status;
    const flagged = (name: string) => response.headers.get(`x-kupleno-yandex-${name}`) === '1';
    for (const [name, counter] of [['html', 'providerHtmlResponses'], ['challenge', 'providerChallengeResponses'], ['login', 'providerLoginResponses'], ['redirected', 'providerRedirectResponses'], ['challenge-opened', 'providerChallengeOpenedResponses'], ['live-sk', 'providerLiveSkResponses'], ['context-sk', 'providerContextSkResponses'], ['context-sk-used', 'providerContextSkUsedResponses']] as const) if (flagged(name)) diagnostics[counter]++;
    const opened = diagnostics.providerChallengeOpenedResponses > 0;
    const challengeMessage = opened ? 'Яндекс Маркет открыл проверку в отдельной вкладке. Пройдите её и повторите сбор.' : challengeError().message;
    const body = await response.text(); if (body.length > 8 * 1024 * 1024) throw new Error('Ответ Яндекс Маркета слишком большой.');
    const transient = [502, 503, 504].includes(response.status) && body.length === 0 && !flagged('html') && !flagged('challenge') && !flagged('login') && !flagged('redirected') && !response.redirected && !/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '') && (!response.url || new URL(response.url).origin === origin);
    if (transient) {
      if (!attempt) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
      diagnostics.transientExhausted++;
      throw Object.assign(new Error(`Яндекс Маркет: HTTP ${response.status}.`), { code: 'YANDEX_TRANSIENT_EXHAUSTED', httpStatus: response.status });
    }
    if (!response.ok && !body.trim() && !flagged('html') && !flagged('challenge') && !flagged('login') && !flagged('redirected')) throw Object.assign(new Error(`Яндекс Маркет: HTTP ${response.status}.`), { httpStatus: response.status });
    let payload: unknown;
    try { payload = JSON.parse(body); }
    catch {
      diagnostics.apiNonJsonResponses++;
      const html = flagged('html') || /text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '') || /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(body.slice(0, 512));
      if (html) diagnostics.apiHtmlResponses++; else diagnostics.apiOtherNonJsonResponses++;
      if (flagged('challenge')) { diagnostics.challengeResponses++; throw Object.assign(new Error(challengeMessage), { code: 'YANDEX_CHALLENGE' }); }
      const message = flagged('login') ? 'Яндекс Маркет запросил вход. Войдите в магазин и повторите сбор.' : html ? 'Яндекс Маркет вернул страницу вместо истории покупок. Сбор остановлен; сохранённые покупки остаются.' : 'Ответ Яндекс Маркета не удалось прочитать. Сбор остановлен; сохранённые покупки остаются.';
      throw Object.assign(new Error(message), { code: flagged('login') ? 'YANDEX_API_LOGIN' : 'YANDEX_API_NON_JSON' });
    }
    if (flagged('challenge')) {
      const before = diagnostics.challengeResponses;
      const root = object(payload);
      try { checkChallenge(root, diagnostics); }
      catch (error) { if (object(error).code !== 'YANDEX_CHALLENGE') throw error; captureRootShape(root, diagnostics); }
      if (diagnostics.challengeResponses === before) for (const entry of array(root.results).slice(0, 8)) {
        try { checkChallenge(object(entry), diagnostics); }
        catch (error) { if (object(error).code !== 'YANDEX_CHALLENGE') throw error; break; }
      }
      if (diagnostics.challengeResponses === before) diagnostics.challengeResponses++;
      throw Object.assign(new Error(challengeMessage), { code: 'YANDEX_CHALLENGE' });
    }
    if (flagged('login')) throw Object.assign(new Error('Яндекс Маркет запросил вход. Войдите в магазин и повторите сбор.'), { code: 'YANDEX_API_LOGIN' });
    if (response.url && new URL(response.url).origin !== origin) throw Object.assign(new Error('Яндекс Маркет перенаправил запрос истории. Сбор остановлен.'), { code: 'YANDEX_API_REDIRECT' });
    if (!response.ok) throw Object.assign(new Error(`Яндекс Маркет: HTTP ${response.status}.`), { httpStatus: response.status });
    return payload;
    }
    throw new Error('Яндекс Маркет не ответил.');
  }
  let token = '';
  const initial = object(options.context?.initialOrders);
  const validInitial = Array.isArray(initial.orderIds) && initial.orderIds.length <= 100000 && initial.orderIds.every(id => typeof id === 'string' && /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0) && typeof initial.pageToken === 'string' && initial.pageToken.length <= 8000;
  if (validInitial) {
    for (const id of initial.orderIds as string[]) orderIds.add(id);
    token = initial.pageToken as string;
  } else {
  try {
    const response = await options.fetch(origin + ordersPath, { credentials: 'include', signal: options.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = (await response.text()).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    if (html.length > 12 * 1024 * 1024) throw new Error('Слишком большая страница заказов.');
    for (const match of html.matchAll(/\/my\/order\/(\d+)/g)) orderIds.add(match[1]!);
    for (const match of html.matchAll(/"(?:orderGroupIds|ordersGroupsIds)"\s*:\s*\[([^\]]*)\]/g)) for (const id of match[1]!.match(/\d{6,}/g) || []) orderIds.add(id);
    const renderedToken = html.match(/"pageToken"\s*:\s*("(?:[^"\\]|\\.)*")/)?.[1];
    if (renderedToken) try {
      const value = JSON.parse(renderedToken);
      if (typeof value === 'string' && value.length <= 8000) token = value;
    } catch { /* An unusable rendered cursor does not prevent the API bootstrap. */ }
    if (!headers.sk) headers.sk = html.match(/"sk"\s*:\s*"([^"\r\n]+)"/)?.[1] || '';
  } catch (e) { if (options.signal?.aborted) throw e; warnings.push('Яндекс Маркет: начальная страница не прочитана, проверяем API заказов.'); }
  }
  cap(orderIds.size);
  const visited = new Set<string>();
  // Rendered orders are only a seed: missing HTML pagination metadata is not the end of history.
  let requestPage = true, listingFailed = false;
  while (requestPage && pages < 2000) {
    if (visited.has(token)) { listingFailed = true; pagination.repeatedCursor = true; incomplete = true; warnings.push('Яндекс Маркет: повторилась страница заказов.'); break; }
    visited.add(token); pages++;
    await new Promise(resolve => setTimeout(resolve, 300));
    options.signal?.throwIfAborted();
    let page: Record<string, unknown> | null = null;
    let listReason = '';
    for (const resolver of orderResolvers) {
      try {
        const data = resultData(await resolve(resolver, [{ ...(token ? { pageToken: token } : {}), filter: 'COMPLETED', size: 18 }]), diagnostics, 0, true);
        const collection = object(object(data.collections).orderConsolidationResult);
        const id = Array.isArray(data.result) ? data.result[0] : data.result;
        const candidate = object(collection[String(id)] || Object.values(collection)[0]);
        if (!Array.isArray(candidate.ordersGroupsIds) && !Array.isArray(candidate.orderGroupIds)) { diagnostics.responseMalformedResult++; throw new Error('Список заказов не распознан.'); }
        page = candidate; break;
      } catch (e) {
        if (options.signal?.aborted || globalApiFailure(e)) throw e;
        const error = object(e), code = Number(error.resolverCode), status = error.httpStatus || error.resolverHttpStatus;
        const known = Number.isInteger(code) && code > 0 && code <= knownResolverCodes.length ? knownResolverCodes[code - 1] : '';
        if (typeof status === 'number' && [502, 503, 504].includes(status)) diagnostics.listErrorHttpStatus = status;
        listReason = known || (typeof status === 'number' && [502, 503, 504].includes(status) ? `HTTP ${status}` : listReason || 'неизвестный формат ответа');
        if (error.code === 'YANDEX_TRANSIENT_EXHAUSTED') break;
      }
    }
    if (!page) { listingFailed = true; if (!orderIds.size && !options.readOrdersDom) throw new Error(`Яндекс Маркет: формат списка заказов не распознан (${listReason}).`); incomplete = true; warnings.push(`Яндекс Маркет: следующие страницы заказов не прочитаны (${listReason}).`); break; }
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
      listingFailed = true;
      incomplete = true;
      warnings.push('Яндекс Маркет: не найден указатель следующей страницы заказов.');
    }
    const ambiguousEnd = !items.length && typeof page.hasNext !== 'boolean' && pagination.lastPageCursorMatchesRequest;
    if (ambiguousEnd) {
      listingFailed = true; incomplete = true;
      warnings.push('Яндекс Маркет: пустая страница не подтвердила конец списка заказов.');
    }
    requestPage = !ambiguousEnd && page.hasNext !== false && !!token && (items.length > 0 || page.hasNext === true);
    await options.onProgress?.({ done: pages, total: 0, message: `Яндекс Маркет: найдено ${orderIds.size} заказов.` });
  }
  if (requestPage && pages >= 2000) { listingFailed = true; incomplete = true; warnings.push('Яндекс Маркет: достигнут лимит страниц заказов.'); }
  if (listingFailed && options.readOrdersDom) {
    diagnostics.domFallbackAttempts++;
    const started = Date.now();
    for (let step = 0; step < 300; step++) {
      options.signal?.throwIfAborted();
      if (Date.now() - started > 120000) { diagnostics.domFallbackLimits++; break; }
      let result: YandexOrdersDomResult | undefined;
      try { result = readYandexOrdersDomResult(await options.readOrdersDom()); options.signal?.throwIfAborted(); }
      catch (error) { if (options.signal?.aborted) throw error; diagnostics.domFallbackBlocked++; break; }
      diagnostics.domFallbackSteps++;
      if (!result || result.blocked || result.fatal) { diagnostics.domFallbackBlocked++; break; }
      const before = orderIds.size;
      for (const id of result.orderIds) orderIds.add(id);
      cap(orderIds.size);
      diagnostics.domFallbackOrdersAdded += orderIds.size - before;
      if (result.ambiguous) { diagnostics.domFallbackBlocked++; break; }
      if (result.limit) { diagnostics.domFallbackLimits++; break; }
      if (result.clicked) diagnostics.domFallbackClicks++;
      await options.onProgress?.({ done: step + 1, total: 0, message: `Яндекс Маркет: список в магазине, найдено ${orderIds.size} заказов.` });
      if (!result.hasMore) break;
      if (step === 299) { diagnostics.domFallbackLimits++; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    warnings.push('Яндекс Маркет: полнота списка в магазине не подтверждена.');
  }
  if (listingFailed && !orderIds.size) throw new Error('Яндекс Маркет: список заказов не прочитан.');
  diagnostics.listedOrders = orderIds.size;
  const knownOrderIds = readUnresolvedOrderIds(options.knownOrderIds) || [];
  // A current match is required before checking old orders through the same receipt resolver.
  if (!diagnostics.domFallbackBlocked && knownOrderIds.some(id => orderIds.has(id))) {
    for (const id of knownOrderIds) orderIds.add(id);
    cap(orderIds.size);
    diagnostics.knownOrdersAdded = orderIds.size - diagnostics.listedOrders;
    if (diagnostics.knownOrdersAdded) {
      incomplete = true;
      warnings.push(`Яндекс Маркет: ранее сохранённых заказов вне текущего списка магазина — ${diagnostics.knownOrdersAdded}.`);
    }
  }
  finishStage('metadataElapsedMs');
  const states = [...orderIds].map(orderId => ({ orderId, found: false, emptyLists: 0, done: false,
    validIds: new Set<string>(), unresolved: new Map<string, 'record' | 'field' | 'empty' | 'type' | 'unsafe'>(), errors: [] as unknown[] }));
  try {
    for (const archived of [false, true]) {
      const pending = states.filter(state => !state.done);
      const batches = pending.map(state => [state]);
      await mapConcurrent(batches, 2, async batch => { try {
        if (metadataStopped) throw metadataStopError;
        await new Promise(resolve => setTimeout(resolve, 300));
        options.signal?.throwIfAborted();
        if (metadataStopped) throw metadataStopError;
        let payload: unknown;
        try {
          payload = await resolve(receiptResolver, batch.map(state => ({ orderId: Number(state.orderId), archived })));
          const root = object(payload);
          const singleData = batch.length === 1 && (!Array.isArray(root.results) || !root.results.length) && Object.keys(object(root.data)).length > 0;
          if (root.error || (!singleData && (!Array.isArray(root.results) || root.results.length !== batch.length))) {
            // Diagnose the original envelope, but never assign a shortened batch by guessed indexes.
            resultData(payload, diagnostics);
            diagnostics.responseMalformedResult++;
            throw new Error('Число ответов на запрос чеков не совпало с числом заказов.');
          }
          checkChallenge(root, diagnostics);
        } catch (error) {
          if (options.signal?.aborted || object(error).code === 'ROW_LIMIT_EXCEEDED' || globalApiFailure(error)) throw error;
          for (const state of batch) state.errors.push(error);
          payload = undefined;
        }
        for (const [index, state] of batch.entries()) {
          if (payload !== undefined) try {
            const entry = array(object(payload).results)[index];
            checkChallenge(object(entry), diagnostics);
            const data = resultData(batch.length === 1 ? payload : { results: [entry] }, diagnostics);
            if (!Array.isArray(data.result) || data.result.some(id => !(typeof id === 'string' && id.length > 0) && !Number.isSafeInteger(id))) {
              diagnostics.responseMalformedResult++; throw new Error('Список чеков заказа не распознан.');
            }
            if (!data.result.length) state.emptyLists++;
            const collection = object(object(data.collections).orderReceipt);
            for (const receiptId of data.result) {
              const id = String(receiptId), raw = collection[id], receipt = object(raw);
              if (typeof receipt.fiscalUrl !== 'string' || !receipt.fiscalUrl.trim()) {
                const reason = !raw || typeof raw !== 'object' || Array.isArray(raw) ? 'record' : !Object.hasOwn(receipt, 'fiscalUrl') ? 'field' : typeof receipt.fiscalUrl !== 'string' ? 'type' : 'empty';
                if (!state.validIds.has(id)) state.unresolved.set(id, reason);
                continue;
              }
              let url: string;
              try { url = safeReceipt(receipt.fiscalUrl); }
              catch { if (!state.validIds.has(id)) state.unresolved.set(id, 'unsafe'); continue; }
              const created = typeof receipt.createdAt === 'number' ? new Date(receipt.createdAt < 1e12 ? receipt.createdAt * 1000 : receipt.createdAt) : null;
              addReceipt({ id: String(receipt.id || receiptId), url, orderId: state.orderId, type: String(receipt.type || ''), date: created && Number.isFinite(created.valueOf()) ? created.toISOString() : undefined });
              state.validIds.add(id); state.unresolved.delete(id);
              state.found = true;
            }
          } catch (error) {
            if (options.signal?.aborted || object(error).code === 'ROW_LIMIT_EXCEEDED' || globalApiFailure(error)) throw error;
            state.errors.push(error);
          }
          if (!archived && (!state.found || state.unresolved.size) && !state.errors.some(error => object(error).code === 'YANDEX_TRANSIENT_EXHAUSTED')) continue;
          state.done = true;
          if (state.unresolved.size || (state.errors.length && !state.found)) {
            failedOrders++;
            if ([...state.unresolved.values()].some(reason => reason !== 'unsafe')) diagnostics.missingUrlOrders++;
            for (const reason of state.unresolved.values()) {
              if (reason === 'record') diagnostics.missingReceiptRecords++;
              if (reason === 'field') diagnostics.missingFiscalUrlFields++;
              if (reason === 'empty') diagnostics.emptyFiscalUrls++;
              if (reason === 'type') diagnostics.invalidFiscalUrlTypes++;
            }
            if ([...state.unresolved.values()].includes('unsafe')) diagnostics.unsafeUrlOrders++;
            if (state.errors.length) diagnostics.responseErrorOrders++;
            for (const reason of state.unresolved.values()) rememberFailure(new Error(reason !== 'unsafe' ? 'Магазин не предоставил ссылку на часть чеков.' : 'Магазин предоставил некорректную ссылку на часть чеков.'));
            for (const error of state.errors) rememberFailure(error);
          }
          if (state.emptyLists === 2) diagnostics.noReceiptOrders++;
          checked++;
          await options.onProgress?.({ done: checked, total: orderIds.size, message: `Яндекс Маркет: проверено ${checked} из ${orderIds.size} заказов.` });
        }
      } catch (error) {
        if (globalApiFailure(error)) { metadataStopped = true; metadataStopError = error; }
        else { hasMetadataFatal = true; metadataFatal = error; }
        throw error;
      } }, options.signal);
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (hasMetadataFatal) throw metadataFatal;
    if (!globalApiFailure(error)) throw error;
    if (!receipts.size) throw metadataStopError;
    incomplete = true;
    diagnostics.uncheckedOrders = orderIds.size - checked;
    warnings.push(metadataStopError instanceof Error ? metadataStopError.message : 'Яндекс Маркет остановил сбор.');
  }
  finishStage(options.readOrderDocuments && !metadataStopped ? 'documentFallbackElapsedMs' : undefined);
  if (options.readOrderDocuments && !metadataStopped) {
    const pending = states.filter(state => state.unresolved.size > 0);
    const started = Date.now();
    let stopped = false, fatal = false, failure: unknown, done = 0;
    try {
      await mapConcurrent(pending, 2, async state => { try {
        options.signal?.throwIfAborted();
        if (stopped) throw Object.assign(new Error('Чтение документов остановлено.'), { code: 'YANDEX_DOCUMENTS_STOPPED' });
        if (Date.now() - started >= 300000) { diagnostics.domReceiptLimits++; stopped = true; throw Object.assign(new Error('Достигнут лимит чтения документов.'), { code: 'YANDEX_DOCUMENTS_STOPPED' }); }
        diagnostics.domReceiptOrdersAttempted++;
        const result = readYandexDocumentsResult(await options.readOrderDocuments!(state.orderId));
        options.signal?.throwIfAborted();
        if (!result?.complete) failedDocumentOrderIds.add(state.orderId);
        if (!result || result.blocked) { diagnostics.domReceiptBlocked++; stopped = true; throw Object.assign(new Error('Документы заказа недоступны.'), { code: 'YANDEX_DOCUMENTS_STOPPED' }); }
        if (result.complete) diagnostics.domReceiptCompleteDialogs++;
        else {
          diagnostics.domReceiptLimits++;
          if (result.failureReason) {
            const counter = { navigation: 'domReceiptNavigationWaits', button: 'domReceiptButtonWaits', dialog: 'domReceiptDialogWaits', loading: 'domReceiptLoadingWaits', error: 'domReceiptErrorWaits', unrecognized: 'domReceiptUnrecognizedWaits', request: 'domReceiptRequestErrors' } as const;
            diagnostics[counter[result.failureReason]]++;
          }
        }
        for (const value of result.urls) {
          const url = safeReceipt(value);
          if (addReceipt({ id: '', url, orderId: state.orderId, type: '' })) diagnostics.domReceiptUrlsAdded++;
        }
        await options.onProgress?.({ done: ++done, total: pending.length, message: `Яндекс Маркет: проверены документы ${done} из ${pending.length} заказов.` });
      } catch (error) {
        if (object(error).code === 'YANDEX_DOCUMENTS_BLOCKED') { diagnostics.domReceiptBlocked++; stopped = true; throw Object.assign(new Error('Документы заказа недоступны.'), { code: 'YANDEX_DOCUMENTS_STOPPED' }); }
        if (object(error).code !== 'YANDEX_DOCUMENTS_STOPPED') { fatal = true; failure = error; }
        throw error;
      } }, options.signal);
    } catch (error) { options.signal?.throwIfAborted(); if (fatal) throw failure; if (object(error).code !== 'YANDEX_DOCUMENTS_STOPPED') throw error; }
    if (pending.length) { incomplete = true; warnings.push('Яндекс Маркет: покрытие отсутствующих в API чеков не подтверждено.'); }
  }
  finishStage('receiptFetchElapsedMs');
  let rowCount = 0;
  let done = 0;
  const pendingReceipts = [...receipts.values()].sort((a,b) => a.url.localeCompare(b.url));
  const cachedUrls = new Set<string>(), unavailableCache = new Set<string>();
  const cacheFailure = (error: unknown, counter: 'cacheReadErrors' | 'cacheWriteErrors') => {
    options.signal?.throwIfAborted();
    if (object(error).code === 'ROW_LIMIT_EXCEEDED') throw error;
    diagnostics[counter]++;
  };
  if (options.receiptCache) {
    await mapConcurrent(pendingReceipts, 4, async receipt => {
      try { if (await options.receiptCache!.has(receipt.url)) cachedUrls.add(receipt.url); }
      catch (error) { cacheFailure(error, 'cacheReadErrors'); unavailableCache.add(receipt.url); }
    }, options.signal);
    // Read existing entries before new downloads can evict their RAW bodies at the FIFO limit.
    pendingReceipts.sort((a,b) => Number(cachedUrls.has(b.url)) - Number(cachedUrls.has(a.url)));
  }
  const chunks = await mapConcurrent(pendingReceipts, 4, async receipt => {
    let rows: Purchase[] = [];
    let payment: ReturnType<typeof readYandexPayment>;
    let failureCounter: 'receiptForbiddenErrors' | 'receiptRateLimitErrors' | 'receiptHttpErrors' | 'receiptNetworkErrors' | 'receiptParseErrors' | 'receiptOversizeErrors' | 'receiptRedirectErrors' = 'receiptNetworkErrors';
    try {
      options.signal?.throwIfAborted();
      let html: string | undefined, parsed: Purchase[] | undefined, fromCache = false;
      if (options.receiptCache && !unavailableCache.has(receipt.url)) {
        try { html = await options.receiptCache.read(receipt.url); }
        catch (error) { cacheFailure(error, 'cacheReadErrors'); }
        options.signal?.throwIfAborted();
        if (html !== undefined) {
          try { if (html.length <= 8 * 1024 * 1024) parsed = parseYandexReceipt(html, receipt); }
          catch (error) { cacheFailure(error, 'cacheReadErrors'); }
          fromCache = !!parsed?.length && parsed.every(row => row.parse_quality === 'complete' && !!row.date);
          if (!fromCache) {
            try { await options.receiptCache.remove(receipt.url); }
            catch (error) { cacheFailure(error, 'cacheWriteErrors'); }
          }
        }
      }
      if (!fromCache) {
        diagnostics.receiptNetworkRequests++;
        const response = await options.fetch(receipt.url, { credentials: 'include', signal: options.signal });
        if (!response.ok) {
          failureCounter = response.status === 403 ? 'receiptForbiddenErrors' : response.status === 429 ? 'receiptRateLimitErrors' : 'receiptHttpErrors';
          throw new Error(`HTTP ${response.status}`);
        }
        if (response.url) { failureCounter = 'receiptRedirectErrors'; safeReceipt(response.url); }
        failureCounter = 'receiptNetworkErrors'; html = await response.text();
        if (html.length > 8 * 1024 * 1024) { failureCounter = 'receiptOversizeErrors'; throw new Error('Слишком большой чек.'); }
        failureCounter = 'receiptParseErrors';
        parsed = parseYandexReceipt(html, receipt);
      }
      failureCounter = 'receiptParseErrors';
      if (!parsed?.length || parsed.some(row => !row.date)) throw new Error('Не удалось прочитать чек.');
      rowCount += parsed.length; cap(rowCount); rows = parsed;
      if (html !== undefined) payment = readYandexPayment(html, receipt.url, parsed[0]!.date);
      if (fromCache) diagnostics.cachedReceipts++;
      else if (options.receiptCache && parsed.every(row => row.parse_quality === 'complete' && !!row.date)) {
        try { await options.receiptCache.write(receipt.url, html!); }
        catch (error) { cacheFailure(error, 'cacheWriteErrors'); }
      }
    } catch (e) {
      if (options.signal?.aborted || object(e).code === 'ROW_LIMIT_EXCEEDED') throw e;
      diagnostics[object(e).name === 'TimeoutError' ? 'receiptTimeoutErrors' : failureCounter]++;
      for (const orderId of receipt.orderIds) failedReceiptOrderIds.add(orderId);
      failedReceipts++; incomplete = true;
    }
    await options.onProgress?.({ done: ++done, total: receipts.size, message: `Яндекс Маркет: прочитано ${done} из ${receipts.size} чеков.` });
    return { rows, payment };
  }, options.signal);
  // Cache priority changes scheduling only; keep receipt order stable for row identities and annotations.
  const rows = chunks.map(({ rows }, index) => ({ rows, url: pendingReceipts[index]!.url }))
    .sort((a,b) => a.url.localeCompare(b.url)).flatMap(chunk => chunk.rows);
  const fiscalPayments = chunks.flatMap(({ payment }) => payment ? [payment] : []);
  if (!rows.length && metadataStopped) throw metadataStopError;
  if (failedOrders || failedReceipts) incomplete = true;
  if (failedOrders || failedReceipts) warnings.push(`Яндекс Маркет: ошибки у ${failedOrders} заказов и ${failedReceipts} чеков. Ранее сохранённая история остаётся.`);
  const receiptFailures = [
    ['отказ доступа', diagnostics.receiptForbiddenErrors], ['ограничение запросов', diagnostics.receiptRateLimitErrors], ['ошибка HTTP', diagnostics.receiptHttpErrors],
    ['время ожидания истекло', diagnostics.receiptTimeoutErrors], ['ошибка сети', diagnostics.receiptNetworkErrors], ['не удалось прочитать', diagnostics.receiptParseErrors],
    ['слишком большой документ', diagnostics.receiptOversizeErrors], ['неподдерживаемое перенаправление', diagnostics.receiptRedirectErrors],
  ].filter(([, count]) => Number(count) > 0).map(([label, count]) => `${label} — ${count}`).join('; ');
  if (!rows.length && (failedOrders || failedReceipts)) throw new Error(`${warnings.at(-1)} ${receiptFailures ? `Чеки: ${receiptFailures}. ` : ''}${[...failures].slice(0,3).join(' ')}`.trim());
  if (receiptFailures) warnings.push(`Яндекс Маркет: чеки — ${receiptFailures}.`);
  if (failedOrders && failures.size) warnings.push(`Яндекс Маркет: причины пропуска — ${[...failures].slice(0,3).join(' ')}`);
  const unresolvedOrderIds = readUnresolvedOrderIds([...new Set(states.filter(state => state.unresolved.size > 0).map(state => String(Number(state.orderId))))].slice(0, 1000));
  if (!unresolvedOrderIds) throw new Error('Некорректные ссылки на заказы.');
  return { rows, fiscalPayments, unresolvedOrderIds, failedDocumentOrderIds: [...failedDocumentOrderIds].slice(0, 1000), failedReceiptOrderIds: [...failedReceiptOrderIds].slice(0, 1000), processedReceipts: [...new Set(rows.map(row => row.receipt_url || row.marketplace_id || '').filter(Boolean))], warnings, stats: { orders: orderIds.size, receipts: receipts.size, pages, failedOrders, failedReceipts, removed: 0, incomplete, ...diagnostics, ...pagination, fallbackReceipts: new Set(rows.filter(row => row.parse_quality === 'fallback').map(row => row.marketplace_id)).size, unverifiedReceipts: new Set(rows.filter(row => row.parse_quality === 'unverified').map(row => row.marketplace_id)).size } };
  }
  try { const result = await run(); finishStage(); result.stats = { ...result.stats, ...timings }; completedStats = result.stats; return result; }
  catch (error) { incomplete = true; throw error; }
  finally {
    if (!completedStats) finishStage();
    diagnostics.uncheckedOrders = Math.max(diagnostics.uncheckedOrders, orderIds.size - checked);
    try { options.onDiagnostics?.({ ...snapshot(), ...completedStats }); } catch { /* Diagnostics cannot replace the collection result or its original failure. */ }
  }

}
