import { browser } from 'wxt/browser';
import { withDeadline } from '../deadline';

const resolvers = new Set([
  'src/resolvers/orders/resolveConsolidationOrders/index:resolveConsolidationOrders',
  'src/resolvers/orders/resolveConsolidationOrders:resolveConsolidationOrders',
  'src/resolvers/orderDocuments/resolveOrderReceiptsByOrderId:resolveOrderReceiptsByOrderId',
]);

function safeChallengeUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 16000 || value !== value.trim() || /[\u0000-\u0020\\]/.test(value) || !(/^https:\/\//i.test(value) || (value.startsWith('/') && !value.startsWith('//')))) return '';
  try {
    const url = new URL(value, 'https://market.yandex.ru');
    if (url.origin !== 'https://market.yandex.ru' || url.username || url.password || !/^\/(showcaptcha|captcha)(\/|$)/i.test(url.pathname) || url.href.length > 16000) return '';
    const retpaths = url.searchParams.getAll('retpath');
    if (retpaths.length > 1) return '';
    for (const retpath of retpaths) {
      if (!retpath || retpath !== retpath.trim() || /[\u0000-\u0020\\]/.test(retpath) || /%[0-9a-f]{2}/i.test(retpath) || !(/^https:\/\//i.test(retpath) || (retpath.startsWith('/') && !retpath.startsWith('//')))) return '';
      const target = new URL(retpath, 'https://market.yandex.ru');
      if (target.origin !== 'https://market.yandex.ru' || target.username || target.password) return '';
    }
    return url.href;
  } catch { return ''; }
}

/** Fixed-purpose request in the signed-in store tab; never a general fetch proxy. */
export async function yandexRequest(input: unknown, body: unknown, tabId?: number, headerContext?: unknown, isCurrent?: () => boolean) {
  if (typeof input !== 'string' || typeof body !== 'string' || body.length > 16000) throw new Error('Некорректный запрос чеков.');
  const context: Record<string, string> = {};
  if (headerContext !== undefined) {
    if (!headerContext || typeof headerContext !== 'object' || Array.isArray(headerContext) || ![Object.prototype, null].includes(Object.getPrototypeOf(headerContext))) throw new Error('Некорректный контекст запроса Яндекс Маркета.');
    for (const [key, value] of Object.entries(headerContext)) {
      if (!['sk', 'version', 'marketFrontGlue', 'pageId'].includes(key) || typeof value !== 'string' || value.length > 2000 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('Некорректный контекст запроса Яндекс Маркета.');
      context[key] = value;
    }
  }
  const url = new URL(input);
  const resolver = url.searchParams.get('r') || '';
  if (url.origin !== 'https://market.yandex.ru' || url.pathname !== '/api/resolve/' || url.username || url.password || !resolvers.has(resolver)) throw new Error('Запрос к магазину не разрешён.');
  const request = JSON.parse(body);
  if (!Array.isArray(request.params) || request.params.length !== 1) throw new Error('Неизвестный запрос истории.');
  const params = request.params[0];
  if (!params || typeof params !== 'object') throw new Error('Некорректные параметры истории.');
  if (resolver.includes('resolveOrderReceiptsByOrderId')) {
    if (!Number.isSafeInteger(params.orderId) || params.orderId <= 0 || typeof params.archived !== 'boolean' || Object.keys(params).some(key => !['orderId','archived'].includes(key)) || request.path !== `/my/order/${params.orderId}`) throw new Error('Некорректный номер заказа.');
  } else if (request.path !== '/my/orders?filter=COMPLETED' || params.filter !== 'COMPLETED' || params.size !== 18 || (params.pageToken !== undefined && (typeof params.pageToken !== 'string' || params.pageToken.length > 8000)) || Object.keys(params).some(key => !['filter','size','pageToken'].includes(key))) throw new Error('Некорректная страница истории.');
  const tab = tabId === undefined ? null : await browser.tabs.get(tabId).catch(() => null);
  if (!tab?.url || new URL(tab.url).origin !== 'https://market.yandex.ru') throw new Error('Вкладка сбора Яндекс Маркета закрыта или открыта другая страница. Повторите сбор.');
  const requestId = crypto.randomUUID(), expiresAt = Date.now() + 25000;
  const deadlineError = new Error('Вкладка Яндекс Маркета не ответила за 30 секунд.');
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let executions;
  try { executions = await Promise.race([browser.scripting.executeScript({ target: { tabId: tabId! }, world: 'MAIN', args: [resolver, body, context, requestId, expiresAt], func: async (resolver: string, body: string, context: Record<string, string>, requestId: string, expiresAt: number) => {
    const meta = { responseStatus: 0, html: false, challenge: false, login: false, redirected: false, challengeOpened: false, challengeUrl: '', requestTimeout: false, liveSk: false, contextSk: !!context.sk, contextSkUsed: false };
    function safeChallengeUrl(value: unknown): string {
      if (typeof value !== 'string' || !value || value.length > 16000 || value !== value.trim() || /[\u0000-\u0020\\]/.test(value) || !(/^https:\/\//i.test(value) || (value.startsWith('/') && !value.startsWith('//')))) return '';
      try {
        const url = new URL(value, 'https://market.yandex.ru');
        if (url.origin !== 'https://market.yandex.ru' || url.username || url.password || !/^\/(showcaptcha|captcha)(\/|$)/i.test(url.pathname) || url.href.length > 16000) return '';
        const retpaths = url.searchParams.getAll('retpath');
        if (retpaths.length > 1) return '';
        for (const retpath of retpaths) {
          if (!retpath || retpath !== retpath.trim() || /[\u0000-\u0020\\]/.test(retpath) || /%[0-9a-f]{2}/i.test(retpath) || !(/^https:\/\//i.test(retpath) || (retpath.startsWith('/') && !retpath.startsWith('//')))) return '';
          const target = new URL(retpath, 'https://market.yandex.ru');
          if (target.origin !== 'https://market.yandex.ru' || target.username || target.password) return '';
        }
        return url.href;
      } catch { return ''; }
    }
    if (location.origin !== 'https://market.yandex.ru') return { ...meta, status: 403, text: '', error: 'Страница магазина изменилась.' };
    const html = document.documentElement.innerHTML.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    // nosemgrep: detect-non-literal-regexp -- read is scoped to this injected function and called only with fixed header names below.
    const read = (key: string) => html.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\r\\n]{1,2000})"`))?.[1] || '';
    const request = JSON.parse(body);
    const retpath = new URL(request.path, location.origin).href;
    const headers: Record<string, string> = { accept: '*/*', 'content-type': 'application/json', 'x-market-apphost-target': 'WEB', 'x-market-core-service': '<UNKNOWN>', 'x-market-page-id': resolver.includes('resolveOrderReceiptsByOrderId') ? 'market:order' : read('page') || context.pageId || 'market:orders', 'x-requested-with': 'XMLHttpRequest', 'x-retpath-y': retpath };
    const liveSk = read('sk'), sk = liveSk || context.sk, version = read('-version') || read('version') || context.version, glue = read('marketFrontGlue') || context.marketFrontGlue;
    meta.liveSk = !!liveSk;
    meta.contextSkUsed = !liveSk && !!context.sk;
    if (sk) headers.sk = sk;
    if (version) headers['x-market-app-version'] = version;
    if (glue) headers['x-market-front-glue'] = glue;
    const url = new URL('/api/resolve/', location.origin); url.searchParams.set('r', resolver);
    const state = window as Window & { __kuplenoYandexReads?: Map<string, { abort: () => void; settled: Promise<void>; meta: { responseStatus: number; html: boolean; challenge: boolean; login: boolean; redirected: boolean; challengeOpened: boolean } }> };
    const reads = state.__kuplenoYandexReads ||= new Map();
    if (Date.now() >= expiresAt) return { ...meta, requestTimeout: true, status: 502, text: '', error: 'Истекло время запроса Яндекс Маркета.' };
    const controller = new AbortController();
    let timedOut = false, settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const abort = () => { timedOut = true; controller.abort(); };
    reads.set(requestId, { abort, settled, meta });
    const timer = setTimeout(abort, Math.max(1, expiresAt - Date.now()));
    try {
      const response = await fetch(url, { method: 'POST', credentials: 'include', referrer: retpath, signal: controller.signal, headers, body });
      meta.responseStatus = response.status;
      meta.html = /text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '');
      meta.redirected = response.redirected;
      let finalUrl: URL | undefined;
      try { if (response.url) finalUrl = new URL(response.url); } catch { /* No URL is retained. */ }
      if (finalUrl && finalUrl.origin !== location.origin) meta.redirected = true;
      const knownHost = finalUrl && /(^|\.)yandex\.(ru|com)$/.test(finalUrl.hostname);
      meta.challenge = !!knownHost && /^\/(showcaptcha|checkcaptcha|captcha)(\/|$)/i.test(finalUrl!.pathname);
      meta.login = !!knownHost && (/^\/(auth|login|passport)(\/|$)/i.test(finalUrl!.pathname) || finalUrl!.hostname.startsWith('passport.'));
      if (meta.challenge) meta.challengeUrl = safeChallengeUrl(response.url);
      if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) return { ...meta, status: 413, text: '', error: 'Ответ магазина слишком большой.' };
      const text = await response.text();
      if (text.length > 8 * 1024 * 1024) return { ...meta, status: 413, text: '', error: 'Ответ магазина слишком большой.' };
      meta.html = /text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '') || /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(text.slice(0, 512));
      try {
        const payload = JSON.parse(text);
        const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const root = record(payload);
        const entries = Array.isArray(root.results) ? root.results.slice(0, 8) : [];
        for (const item of [root, ...entries.map(record)]) {
          const captcha = record(item.captcha);
          const candidates = [item.url, item.redirect, item.captcha, captcha.url, captcha.redirect, captcha['captcha-page']];
          const candidate = candidates.map(safeChallengeUrl).find(Boolean);
          const explicit = [item.type, item.status].some(value => value === 'captcha' || value === 'CAPTCHA_REQUIRED' || value === 'SHOW_CAPTCHA') || item.captcha === true || (typeof item.captcha === 'string' && !!item.captcha.trim()) || Object.keys(captcha).length > 0;
          if (explicit || candidate) { meta.challenge = true; if (!meta.challengeUrl && candidate) meta.challengeUrl = candidate; }
        }
      } catch { /* Non-JSON is classified by content type and prefix, never by arbitrary text. */ }
      if (finalUrl && finalUrl.origin !== location.origin) return { ...meta, challengeUrl: '', status: 403, text: '', error: '' };
      return { ...meta, status: response.status, text, error: '' };
    } catch { return { ...meta, requestTimeoutUnsettled: timedOut && [401, 403, 429].includes(meta.responseStatus) && !meta.html && !meta.challenge && !meta.login && !meta.redirected, requestTimeout: timedOut && !meta.html && !meta.challenge && !meta.login && !meta.redirected && ![401, 403, 429].includes(meta.responseStatus), status: meta.responseStatus || 502, text: '', error: timedOut ? 'Истекло время запроса Яндекс Маркета.' : 'Магазин не ответил. Повторите сбор позже.' }; }
    finally { clearTimeout(timer); reads.delete(requestId); settle(); if (!reads.size) delete state.__kuplenoYandexReads; }
  } }), new Promise<never>((_, reject) => { deadlineTimer = setTimeout(() => reject(deadlineError), 30000); })]); }
  catch (error) {
    if (error !== deadlineError) throw error;
    const current = await browser.tabs.get(tabId!).catch(() => null);
    const unsettled = { status: 502, text: '', error: deadlineError.message, requestTimeoutUnsettled: true };
    if (!isCurrent?.() || !current || new URL(current.pendingUrl || current.url || 'about:blank').origin !== 'https://market.yandex.ru') return unsettled;
    // A retry is safe only after this exact expired read has settled, including response.text().
    const ack = await withDeadline(browser.scripting.executeScript({ target: { tabId: tabId! }, world: 'MAIN', args: [requestId, expiresAt], func: async (requestId: string, expiresAt: number) => {
      if (location.origin !== 'https://market.yandex.ru' || Date.now() < expiresAt) return undefined;
      const state = window as Window & { __kuplenoYandexReads?: Map<string, { abort: () => void; settled: Promise<void>; meta: { responseStatus: number; html: boolean; challenge: boolean; login: boolean; redirected: boolean; challengeOpened: boolean } }> };
      const read = state.__kuplenoYandexReads?.get(requestId);
      if (!read) return undefined;
      read.abort(); await read.settled;
      return { settled: true, responseStatus: read.meta.responseStatus, html: read.meta.html, challenge: read.meta.challenge, login: read.meta.login, redirected: read.meta.redirected, challengeOpened: read.meta.challengeOpened };
    } }), 'Не удалось остановить запрос Яндекс Маркета.', 3000).catch(() => undefined);
    const fresh = await browser.tabs.get(tabId!).catch(() => null);
    if (ack?.[0]?.result?.settled !== true || !isCurrent?.() || !fresh || new URL(fresh.pendingUrl || fresh.url || 'about:blank').origin !== 'https://market.yandex.ru') return unsettled;
    const flags = ack[0]!.result!;
    return { status: flags.responseStatus || 502, text: '', error: deadlineError.message, ...flags, requestTimeoutUnsettled: [401, 403, 429].includes(flags.responseStatus) && !flags.html && !flags.challenge && !flags.login && !flags.redirected, requestTimeout: ![401, 403, 429].includes(flags.responseStatus) && !flags.html && !flags.challenge && !flags.login && !flags.redirected && !flags.challengeOpened };
  } finally { clearTimeout(deadlineTimer); }
  const result = executions[0]?.result;
  if (!result) throw new Error('Не удалось получить ответ магазина.');
  const { challengeUrl, ...publicResult } = result;
  const target = safeChallengeUrl(challengeUrl);
  if (target) {
    const current = await browser.tabs.get(tabId!).catch(() => null);
    const currentAddress = current?.pendingUrl || current?.url;
    if (currentAddress) {
      const currentUrl = new URL(currentAddress);
      if (currentUrl.origin === 'https://market.yandex.ru' && currentUrl.pathname === '/my/orders' && !currentUrl.username && !currentUrl.password) {
        await browser.tabs.update(tabId!, { url: target }).then(() => { publicResult.challengeOpened = true; }, () => {});
      }
    }
  }
  return publicResult;
}
