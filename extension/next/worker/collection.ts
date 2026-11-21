import { browser } from 'wxt/browser';
import { collectWildberries } from '../collectors/wildberries';
import type { Job, Command, JobResponse } from '../collection';
import { readFailureStats } from '../collection';
import { SOURCES } from '../domain.mjs';
import { isFiscalPaymentList } from '../fiscal-payments.mjs';
import type { Source } from '../model';
import { yandexRequest } from './yandex-request';
import { ozonRequest } from './ozon-request';
import { withDeadline } from '../deadline';
import { yandexOrdersDomStep } from '../collectors/yandex-orders-dom';
import { readUnresolvedOrderIds, readYandexOrdersDomResult } from '../collection';
import { readDocumentTabs, readYandexDocumentsResult, type DocumentTab } from '../collection';
import { closeYandexOrderTab, readYandexOrderDocuments } from './yandex-order-documents';

const key = 'kupleno-next-jobs';
const legacyKey = 'kupleno-next-job';
const documentTabsKey = 'kupleno-next-yandex-document-tabs';
let documentTabs: DocumentTab[] = [], documentStoreValid = true;
const documentReservations = new Set<AbortController>();
const documentRequests = new Map<string, Set<AbortController>>();
let jobs: Partial<Record<Source, Job>> = {};
const running = new Map<string, AbortController>();
let writes = Promise.resolve();
let offscreenCreation: Promise<void> | undefined;
const domRuns = new Map<string, { steps: number; startedAt: number; seen: Set<string>; waitingForIds?: string[] }>();
const jobById = (id: unknown) => Object.values(jobs).find(job => job.id === id);
const init = browser.storage.local.get([key, legacyKey, documentTabsKey]).then(async data => {
  const legacy = data[legacyKey] as Job | undefined;
  if (data[key]) jobs = data[key] as typeof jobs;
  else if (legacy && Object.hasOwn(SOURCES, legacy.source)) jobs = { [legacy.source]: legacy };
  const tracked = data[documentTabsKey] === undefined ? [] : readDocumentTabs(data[documentTabsKey]);
  documentStoreValid = !!tracked;
  documentTabs = tracked || [];
  if (documentStoreValid) await cleanupDocumentTabs();
  const contexts = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [browser.runtime.getURL('/offscreen.html')] });
  const alive: string[] = contexts.length ? await withDeadline(browser.runtime.sendMessage({ type: 'KUPLENO_OFFSCREEN', action: 'status' }), 'Обработчик не ответил.', 3000).then(reply => reply?.ids || [], () => []) : [];
  for (const job of Object.values(jobs)) {
    if (job.status !== 'running' || (job.source !== 'wildberries' && alive.includes(job.id))) continue;
    jobs[job.source] = { ...job, status: 'failed', error: 'Браузер прервал сбор. Запустите его ещё раз; сохранённая история не изменилась.', updatedAt: new Date().toISOString() };
    await closeCollectionTab(job);
  }
  await browser.storage.local.set({ [key]: jobs });
  await browser.storage.local.remove(legacyKey);
});

async function ensureOffscreen() {
  if (!offscreenCreation) offscreenCreation = (async () => {
    const contexts = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [browser.runtime.getURL('/offscreen.html')] });
    if (!contexts.length) await browser.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Локальный разбор чеков нескольких магазинов.' });
  })().finally(() => { offscreenCreation = undefined; });
  await offscreenCreation;
}

function response(selected?: Job | null): JobResponse {
  const values = Object.values(jobs);
  const pending = values.filter(job => job.status === 'running' || job.status === 'completed');
  // Old callers can still control a single pending job, never an arbitrary parallel one.
  const legacy = pending.length === 1 ? pending[0]! : pending.length ? null : values.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null;
  return { ok: true, job: selected === undefined ? legacy : selected, jobs: values };
}

async function closeCollectionTab(job: Job | null) {
  if (job) domRuns.delete(job.id);
  if (job) await cleanupDocumentTabs(job.id);
  if (!job || job.marketTabId === undefined) return;
  const tab = await browser.tabs.get(job.marketTabId).catch(() => null);
  const targetUrl = tab?.pendingUrl || tab?.url;
  if (!targetUrl) return;
  const url = new URL(targetUrl);
  // Only the receipt tab created by this job; preserve tabs the user navigated away.
  const expected = new URL(SOURCES[job.source].url);
  if (url.hostname.replace(/^www\./, '') === expected.hostname.replace(/^www\./, '') && url.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '')) await browser.tabs.remove(job.marketTabId).catch(() => {});
}

function readYandexContext(early: boolean) {
  const ordersPage = location.origin === 'https://market.yandex.ru' && location.pathname === '/my/orders';
  if (early && (!ordersPage || document.readyState === 'loading')) return null;
  const html = document.documentElement.innerHTML.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  // nosemgrep: detect-non-literal-regexp -- read is scoped to this injected function and called only with fixed header names below.
  const read = (key: string) => html.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\r\\n]{1,2000})"`))?.[1] || '';
  let initialOrders: { orderIds: string[]; pageToken: string } | undefined;
  if (ordersPage) {
    const ids = new Set<string>();
    const add = (id: string) => {
      if (/^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0) ids.add(id);
      if (ids.size > 100000) throw new Error('Слишком много заказов на странице Яндекс Маркета.');
    };
    for (const match of html.matchAll(/\/my\/order\/(\d+)/g)) add(match[1]!);
    for (const match of html.matchAll(/"(?:orderGroupIds|ordersGroupsIds)"\s*:\s*\[([^\]]*)\]/g)) for (const id of match[1]!.match(/\d+/g) || []) add(id);
    let pageToken = '';
    const raw = html.match(/"pageToken"\s*:\s*("(?:[^"\\]|\\.)*")/)?.[1];
    if (raw) try { const value = JSON.parse(raw); if (typeof value === 'string' && value.length <= 8000) pageToken = value; } catch { /* API bootstrap remains available. */ }
    initialOrders = { orderIds: [...ids], pageToken };
  }
  return { sk: read('sk'), version: read('-version') || read('version'), marketFrontGlue: read('marketFrontGlue'), pageId: read('page') || 'market:orders', retpath: location.href, ...(initialOrders ? { initialOrders } : {}) };
}

async function marketContext(job: Job, controller: AbortController) {
  const { source } = job;
  const { signal } = controller;
  signal.throwIfAborted();
  let tab = await browser.tabs.create({ url: SOURCES[source].url, active: false });
  const ownedId = tab.id;
  const loadingMessage = `${SOURCES[source].name}: страница ещё загружается. Повторите сбор после загрузки.`;
  if (ownedId === undefined) throw new Error(loadingMessage);
  try {
    await persist(source, current => current?.id === job.id ? { ...current, marketTabId: ownedId } : current);
    const deadline = Date.now() + 20000;
    do {
      signal.throwIfAborted();
      if (source !== 'yandex' && tab.status === 'complete') return { marketTabId: ownedId };
      const currentUrl = new URL(tab.url || 'about:blank');
      const ordersPage = currentUrl.origin === 'https://market.yandex.ru' && currentUrl.pathname === '/my/orders';
      if (source === 'yandex' && !tab.pendingUrl && (tab.status === 'complete' || ordersPage)) {
        // A slow image or iframe can leave the tab loading after the orders DOM is ready.
        const early = tab.status !== 'complete';
        const read = browser.scripting.executeScript({ target: { tabId: ownedId }, func: readYandexContext, args: [early], injectImmediately: early });
        const result = await withDeadline(early ? read.catch(() => null) : read, loadingMessage, Math.max(1, deadline - Date.now()));
        signal.throwIfAborted();
        const context = result?.[0]?.result;
        if (!early || context) return { ...context, marketTabId: ownedId };
      }
      await new Promise(resolve => setTimeout(resolve, 250));
      signal.throwIfAborted();
      tab = await browser.tabs.get(ownedId);
    } while (Date.now() < deadline);
    throw new Error(loadingMessage);
  } catch (error) {
    await closeCollectionTab({ source, marketTabId: ownedId } as Job);
    throw error;
  }
}

async function persist(source: Source, change: Job | null | ((job: Job | null) => Job | null)) {
  const task = writes.then(async () => {
    const job = typeof change === 'function' ? change(jobs[source] || null) : change;
    const next = { ...jobs };
    if (job) next[source] = job; else delete next[source];
    await browser.storage.local.set({ [key]: next });
    jobs = next;
  });
  writes = task.catch(() => {});
  await task;
}

async function writeDocumentTabs(change: (value: DocumentTab[]) => DocumentTab[]) {
  const task = writes.then(async () => {
    if (!documentStoreValid) throw new Error('Учёт вкладок документов недоступен.');
    const next = readDocumentTabs(change(documentTabs));
    if (!next) throw new Error('Некорректный учёт вкладок документов.');
    await browser.storage.local.set({ [documentTabsKey]: next });
    documentTabs = next;
  });
  writes = task.catch(() => {});
  await task;
}

async function cleanupDocumentTabs(ownerJobId?: string, tabId?: number) {
  if (ownerJobId) for (const controller of documentRequests.get(ownerJobId) || []) controller.abort();
  for (const record of documentTabs.filter(item => (!ownerJobId || item.ownerJobId === ownerJobId) && (tabId === undefined || item.tabId === tabId))) {
    let released = false;
    try {
      released = await closeYandexOrderTab(browser, record.tabId, `https://market.yandex.ru/my/order/${record.orderId}`);
    } catch {
      try { released = !(await browser.tabs.query({})).some(tab => tab.id === record.tabId); } catch { /* Retain ownership while tab APIs are unavailable. */ }
    }
    if (released) await writeDocumentTabs(value => value.filter(item => !(item.tabId === record.tabId && item.ownerJobId === record.ownerJobId && item.orderId === record.orderId)));
  }
}

async function wbSessionCookie(): Promise<string> {
  // Only this named authentication cookie is accessed; never saved in job state.
  for (const url of ['https://www.wildberries.ru/', 'https://wildberries.ru/', 'https://astro.wildberries.ru/']) {
    const cookie = await browser.cookies.get({ url, name: 'wbid-sdk-id-token' });
    let value = cookie?.value || '';
    try { value = decodeURIComponent(value); } catch { /* A malformed cookie is not a session. */ }
    if (value && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
      try { const body = JSON.parse(atob(value.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))); if (!body.exp || body.exp * 1000 > Date.now()) return value; } catch { /* Continue with page storage. */ }
    }
  }
  return '';
}

async function wbToken(tabId?: number): Promise<string> {
  const cookie = await wbSessionCookie();
  if (cookie) return cookie;
  const tab = tabId === undefined ? null : await browser.tabs.get(tabId).catch(() => null);
  if (tab?.url && !['https://www.wildberries.ru','https://wildberries.ru'].includes(new URL(tab.url).origin)) throw new Error('WB_SESSION_NOT_FOUND');
  if (tab?.id !== undefined) {
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // WB also keeps its own session token in page storage. Return only a token whose claims identify WB.
        for (const store of [localStorage, sessionStorage]) {
          let size = 0;
          for (let index = 0; index < store.length && size < 1024 * 1024; index++) {
            const value = store.getItem(store.key(index) || '') || ''; size += value.length;
            for (const token of value.match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || []) {
              try {
                const body = token.split('.')[1]!;
                const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
                const hints = [payload.iss, payload.aud, payload.client_id].join(' ');
                if (payload.exp && payload.exp * 1000 <= Date.now()) continue;
                if (/wb\.ru|wildberries/i.test(hints) || payload.client_id === 'wb' || (payload.user && payload.session_id && payload.validation_key)) return token;
              } catch { /* Unrelated values are not collected or returned. */ }
            }
          }
        }
        return '';
      },
    });
    const token = results[0]?.result;
    if (typeof token === 'string' && token) return token;
  }
  throw new Error('WB_SESSION_NOT_FOUND');
}

async function execute(job: Job, controller: AbortController, sessionCookie: string) {
  try {
    const token = sessionCookie || await wbToken(job.marketTabId);
    const result = await collectWildberries({
      token, signal: controller.signal,
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]) }),
      onProgress: async progress => {
        await persist(job.source, value => value?.id === job.id && value.status === 'running'
          ? { ...value, progress: { done: progress.done, total: progress.total }, message: progress.message, updatedAt: new Date().toISOString() } : value);
      },
    });
    if (jobs[job.source]?.id === job.id && jobs[job.source]?.status === 'running') {
      // The durable result and completed status are one write. The app acknowledges only after its DB transaction.
      await persist(job.source, value => value?.id === job.id && value.status === 'running'
        ? { ...value, status: 'completed', result, message: `Собрано ${result.rows.length} операций`, updatedAt: new Date().toISOString() } : value);
    }
  } catch (error) {
    if (jobs[job.source]?.id === job.id && jobs[job.source]?.status === 'running') {
      const diagnostic = error instanceof Error ? error.message : 'Сбор не завершён.';
      const message = diagnostic.startsWith('WB_LIST_UNKNOWN_PAYLOAD') ? 'Wildberries изменил формат списка чеков. Скопируйте сведения об ошибке — в них есть структура ответа для исправления сборщика.'
        : diagnostic === 'WB_SESSION_NOT_FOUND' ? 'Не удалось получить сессию Wildberries из открытой вкладки. Откройте страницу чеков WB и повторите сбор.'
        : /WB_(TOKEN_REQUIRED|LIST_HTTP_401)/.test(diagnostic) ? 'Wildberries отклонил сессию. Обновите страницу магазина и повторите сбор.'
        : diagnostic === 'WB_LIST_HTTP_403' ? 'Wildberries отказал в доступе к чекам (403). Откройте страницу чеков и проверьте, доступны ли они в магазине.'
        : diagnostic === 'WB_LIST_NON_JSON' ? 'Wildberries вернул страницу вместо списка чеков. Откройте магазин, проверьте вход и повторите сбор.'
        : diagnostic.startsWith('WB_LIST_HTTP_') ? `Wildberries временно не отдал историю (код ${diagnostic.split('_').at(-1)}). Повторите сбор позже.` : diagnostic;
      await persist(job.source, value => value?.id === job.id && value.status === 'running'
        ? { ...value, status: controller.signal.aborted ? 'cancelled' : 'failed', error: message, diagnostic: diagnostic.slice(0, 2000), updatedAt: new Date().toISOString() } : value);
    }
  } finally { await closeCollectionTab(job); running.delete(job.id); }
}

async function handle(command: Command): Promise<JobResponse> {
  await init;
  if (command.action === 'status') {
    for (const stale of Object.values(jobs)) {
      if (stale.status !== 'running' || Date.now() - Date.parse(stale.updatedAt) <= 180000) continue;
      running.get(stale.id)?.abort();
      await persist(stale.source, value => value?.id === stale.id && value.status === 'running'
        ? { ...value, status: 'failed', error: 'Сбор не отвечает больше трёх минут. Повторите его.', updatedAt: new Date().toISOString() } : value);
      if (stale.source !== 'wildberries') await withDeadline(browser.runtime.sendMessage({ type: 'KUPLENO_OFFSCREEN', action: 'cancel', id: stale.id }), 'Обработчик не ответил.', 1000).catch(() => {});
      await closeCollectionTab(stale);
    }
    return response(command.id ? jobById(command.id) || null : command.source ? jobs[command.source] || null : undefined);
  }
  if (command.action === 'ack') {
    const job = jobById(command.id);
    if (job?.status === 'completed') {
      await closeCollectionTab(job);
      if (job.source !== 'wildberries') {
        const contexts = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [browser.runtime.getURL('/offscreen.html')] });
        if (contexts.length) {
          // A lost finished reply can leave this exact delivery alive after its result was saved.
          const released = await withDeadline(browser.runtime.sendMessage({ type: 'KUPLENO_OFFSCREEN', action: 'cancel', id: job.id }), 'Не удалось подтвердить завершение обработки. Повторите сохранение.', 3000);
          if (!released?.ok) throw new Error('Не удалось освободить обработчик этого сбора. Повторите сохранение.');
        }
      }
      await persist(job.source, value => value?.id === job.id && value.status === 'completed' ? null : value);
    }
    return response();
  }
  if (command.action === 'cancel') {
    const pending = Object.values(jobs).filter(job => job.status === 'running');
    const job = command.id ? jobById(command.id) : command.source ? jobs[command.source] : pending.length === 1 ? pending[0] : undefined;
    if (!job && !command.id && !command.source && pending.length > 1) return { ok: false, error: 'Выберите магазин для остановки сбора.' };
    if (!job || job.status !== 'running') return response(job || null);
    running.get(job.id)?.abort();
    await persist(job.source, value => value?.id === job.id && value.status === 'running'
      ? { ...value, status: 'cancelled', message: 'Сбор отменён', updatedAt: new Date().toISOString() } : value);
    if (job.source !== 'wildberries') await withDeadline(browser.runtime.sendMessage({ type: 'KUPLENO_OFFSCREEN', action: 'cancel', id: job.id }), 'Обработчик не ответил на отмену.', 1000).catch(() => {});
    await closeCollectionTab(job);
    return response(jobs[job.source] || null);
  }
  if (command.action === 'clearReceiptCache') {
    if (command.source !== 'yandex') return { ok: false, error: 'Неизвестный кэш чеков.' };
    await ensureOffscreen();
    const cleared = await withDeadline(browser.runtime.sendMessage({ type: 'KUPLENO_OFFSCREEN', action: 'clearReceiptCache' }), 'Не удалось очистить локальные копии чеков.', 10000);
    if (!cleared?.ok) throw new Error('Не удалось очистить локальные копии чеков. Повторите удаление истории.');
    return response();
  }
  if (command.action !== 'start') return { ok: false, error: 'Неизвестная команда сбора.' };
  if (!Object.hasOwn(SOURCES, command.source)) return { ok: false, error: 'Неизвестный магазин.' };
  if (typeof command.profile !== 'string' || !command.profile || command.profile.length > 120) return { ok: false, error: 'Выберите профиль для сбора.' };
  if ('refreshReceipts' in command && (command.source !== 'yandex' || typeof command.refreshReceipts !== 'boolean')) return { ok: false, error: 'Некорректный режим чтения чеков.' };
  const knownOrderIds = command.source === 'yandex' ? readUnresolvedOrderIds(command.knownOrderIds) : undefined;
  if ('knownOrderIds' in command && !knownOrderIds) return { ok: false, error: 'Некорректные номера сохранённых заказов.' };
  const job: Job = { id: crypto.randomUUID(), source: command.source, profile: command.profile, ...(command.refreshReceipts === true ? { refreshReceipts: true } : {}), status: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), message: `Подключаем ${SOURCES[command.source].name}…`, progress: { done: 0, total: 0 } };
  // Reserve this source before opening a tab; other sources can start immediately.
  await persist(job.source, previous => {
    if (previous?.status === 'running' || previous?.status === 'completed') throw new Error('Сначала завершите сохранение предыдущего сбора этого магазина.');
    return job;
  });
  const controller = new AbortController(); running.set(job.id, controller);
  try {
    const sessionCookie = job.source === 'wildberries' ? await wbSessionCookie() : '';
    controller.signal.throwIfAborted();
    const context = sessionCookie ? {} : await marketContext(job, controller);
    controller.signal.throwIfAborted();
    const active = jobById(job.id);
    if (!active || active.status !== 'running') { await closeCollectionTab(active || null); running.delete(job.id); return response(active || null); }
    if (job.source === 'wildberries') {
      void execute(active, controller, sessionCookie).catch(error => console.error('Не удалось сохранить состояние сбора', error instanceof Error ? error.name : 'Error'));
    } else {
      await ensureOffscreen();
      controller.signal.throwIfAborted();
      const reply = await withDeadline(browser.runtime.sendMessage({ type: 'KUPLENO_OFFSCREEN', action: 'run', job: active, context, knownOrderIds }), 'Обработчик чеков не ответил за 30 секунд. Повторите сбор.');
      if (!reply?.ok) throw new Error('Обработчик чеков занят. Повторите сбор.');
      running.delete(job.id);
    }
  } catch (error) {
    await persist(job.source, value => value?.id === job.id && value.status === 'running'
      ? { ...value, status: controller.signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : 'Не удалось запустить сбор.', updatedAt: new Date().toISOString() } : value);
    await closeCollectionTab(jobById(job.id) || null);
    running.delete(job.id);
  }
  return response(jobById(job.id) || null);
}

export function registerCollection() {
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status !== 'complete') return;
    void init.then(async () => {
      const owner = documentTabs.find(item => item.tabId === tabId);
      if (owner && jobById(owner.ownerJobId)?.status !== 'running') await cleanupDocumentTabs(undefined, tabId);
    }).catch(() => { /* Keep ownership for a later cleanup. */ });
  });
  browser.runtime.onMessage.addListener((message: unknown, sender, reply) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'KUPLENO_YANDEX_DOCUMENTS') {
      if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL('/offscreen.html') || !('id' in message) || !('orderId' in message) || !readUnresolvedOrderIds([message.orderId])) { reply({ ok: false }); return; }
      void init.then(async () => {
        const current = jobById(message.id);
        if (!current || current.source !== 'yandex' || current.status !== 'running' || !documentStoreValid) throw new Error('Сбор документов недоступен.');
        if (new Set([...documentRequests.values()].flatMap(values => [...values]).concat([...documentReservations])).size >= 2 || documentTabs.length + documentReservations.size >= 64) throw new Error('Достигнут лимит вкладок документов.');
        const controller = new AbortController(), active = documentRequests.get(current.id) || new Set<AbortController>();
        active.add(controller); documentRequests.set(current.id, active); documentReservations.add(controller);
        let registered: number | undefined;
        try {
          const result = await readYandexOrderDocuments(message.orderId, { browser, signal: controller.signal,
            onNoTab: () => { documentReservations.delete(controller); },
            isCurrent: () => jobById(current.id)?.status === 'running' && (registered === undefined || documentTabs.some(item => item.tabId === registered && item.ownerJobId === current.id)),
            onOpened: async (tabId, orderId) => {
              await writeDocumentTabs(value => {
                if (value.some(item => item.tabId === tabId)) throw new Error('Вкладка документов уже зарегистрирована.');
                return [...value, { tabId, orderId, ownerJobId: current.id }];
              });
              registered = tabId;
              documentReservations.delete(controller);
            },
            onReleased: async (tabId, orderId) => {
              await writeDocumentTabs(value => value.filter(item => !(item.tabId === tabId && item.orderId === orderId && item.ownerJobId === current.id)));
              documentReservations.delete(controller);
            },
          });
          const safe = readYandexDocumentsResult(result);
          if (!safe) throw new Error('Документы заказа не распознаны.');
          return safe;
        } finally { active.delete(controller); if (!active.size) documentRequests.delete(current.id); }
      }).then(result => reply({ ok: true, result })).catch(() => reply({ ok: false, error: 'Не удалось прочитать документы заказа Яндекс Маркета.' }));
      return true;
    }
    if (message && typeof message === 'object' && 'type' in message && message.type === 'KUPLENO_YANDEX_ORDERS_DOM') {
      if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL('/offscreen.html') || !('id' in message) || !('step' in message) || typeof message.step !== 'number' || !Number.isSafeInteger(message.step) || message.step < 1 || message.step > 300) { reply({ ok: false }); return; }
      void init.then(async () => {
        const current = jobById(message.id);
        if (!current || current.source !== 'yandex' || current.status !== 'running' || current.marketTabId === undefined) throw new Error('Сбор уже завершён.');
        const budget: { steps: number; startedAt: number; seen: Set<string>; waitingForIds?: string[] } = domRuns.get(current.id) || { steps: 0, startedAt: Date.now(), seen: new Set<string>() };
        if (message.step !== budget.steps + 1) throw new Error('Чтение списка Яндекс Маркета прервано.');
        domRuns.set(current.id, budget);
        if (++budget.steps > 300 || Date.now() - budget.startedAt > 120000) throw new Error('Достигнут лимит чтения списка Яндекс Маркета.');
        const tab = await browser.tabs.get(current.marketTabId);
        const address = new URL(tab.pendingUrl || tab.url || 'about:blank');
        if (address.origin !== 'https://market.yandex.ru' || address.pathname !== '/my/orders' || address.searchParams.get('filter') !== 'COMPLETED') throw new Error('Страница списка Яндекс Маркета изменилась.');
        const live = jobById(current.id);
        if (live?.status !== 'running' || live.marketTabId !== current.marketTabId) throw new Error('Сбор уже завершён.');
        const executions = await withDeadline(browser.scripting.executeScript({ target: { tabId: current.marketTabId }, func: yandexOrdersDomStep, args: [budget.waitingForIds || null] }), 'Список Яндекс Маркета не ответил.', 5000);
        const result = readYandexOrdersDomResult(executions[0]?.result);
        if (!result) throw new Error('Список Яндекс Маркета не распознан.');
        const fresh = result.orderIds.some(id => !budget.seen.has(id));
        for (const id of result.orderIds) budget.seen.add(id);
        if (budget.seen.size > 100000) throw new Error('Слишком много заказов в списке Яндекс Маркета.');
        if (result.clicked) budget.waitingForIds = [...budget.seen];
        else if (fresh) budget.waitingForIds = undefined;
        return result;
      }).then(result => reply({ ok: true, result })).catch(() => reply({ ok: false, error: 'Не удалось продолжить чтение списка Яндекс Маркета.' }));
      return true;
    }
    if (message && typeof message === 'object' && 'type' in message && message.type === 'KUPLENO_OZON_REQUEST') {
      if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL('/offscreen.html') || !('id' in message) || !('url' in message)) { reply({ ok: false }); return; }
      void init.then(async () => {
        const current = jobById(message.id);
        if (!current || current.source !== 'ozon' || current.status !== 'running') throw new Error('Сбор уже завершён.');
        return ozonRequest(message.url, current.marketTabId);
      }).then(result => reply({ ok: true, ...result })).catch(error => reply({ ok: false, error: error instanceof Error ? error.message : 'Магазин не ответил.' }));
      return true;
    }
    if (message && typeof message === 'object' && 'type' in message && message.type === 'KUPLENO_YANDEX_REQUEST') {
      if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL('/offscreen.html') || !('id' in message) || !('url' in message) || !('body' in message)) { reply({ ok: false }); return; }
      void init.then(async () => {
        const current = jobById(message.id);
        if (!current || current.source !== 'yandex' || current.status !== 'running') throw new Error('Сбор уже завершён.');
        const requestTabId = current.marketTabId;
        return yandexRequest(message.url, message.body, requestTabId, 'headerContext' in message ? message.headerContext : undefined, () => { const live = jobById(current.id); return live?.id === current.id && live.source === 'yandex' && live.status === 'running' && live.marketTabId === requestTabId; });
      }).then(result => reply({ ok: true, ...result })).catch(error => reply({ ok: false, error: error instanceof Error ? error.message : 'Магазин не ответил.' }));
      return true;
    }
    if (message && typeof message === 'object' && 'type' in message && message.type === 'KUPLENO_OFFSCREEN_EVENT') {
      if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL('/offscreen.html')) { reply({ ok: false }); return; }
      if (!('id' in message) || typeof message.id !== 'string' || !('action' in message) || typeof message.action !== 'string') { reply({ ok: false }); return; }
      const event = message as { id: string; action: string; progress?: Job['progress'] & { message: string }; result?: Job['result']; error?: string; failureStats?: unknown };
      void (async () => {
        try {
          await init;
          const current = jobById(event.id);
          if (current?.id !== event.id || current.status !== 'running') { reply({ ok: true }); return; }
          if (event.action === 'progress' && event.progress) {
            const progress = event.progress;
            if (!Number.isSafeInteger(progress.done) || !Number.isSafeInteger(progress.total) || progress.done < 0 || progress.total < 0) throw new Error('Некорректный ход сбора.');
            await persist(current.source, value => value?.id === event.id && value.status === 'running' ? { ...value, message: String(progress.message).slice(0,1000), progress: { done: progress.done, total: progress.total }, updatedAt: new Date().toISOString() } : value);
          } else if (event.action === 'finished') {
            if (!event.error && !event.result) throw new Error('Обработчик не передал результат.');
            if (event.result && (!Array.isArray(event.result.rows) || event.result.rows.length > 100000 || !Array.isArray(event.result.warnings) || !event.result.stats || typeof event.result.stats !== 'object')) throw new Error('Некорректный результат сбора.');
            if (event.result?.fiscalPayments !== undefined && !isFiscalPaymentList(event.result.fiscalPayments)) throw new Error('Некорректные оплаты по чекам.');
            if (event.result?.unresolvedOrderIds !== undefined && (current.source !== 'yandex' || !readUnresolvedOrderIds(event.result.unresolvedOrderIds))) throw new Error('Некорректные ссылки на заказы.');
            for (const field of ['failedDocumentOrderIds', 'failedReceiptOrderIds'] as const) {
              if (event.result?.[field] !== undefined && (current.source !== 'yandex' || !readUnresolvedOrderIds(event.result[field]))) throw new Error('Некорректные ссылки на заказы.');
            }
            const failureStats = readFailureStats(event.failureStats);
            if (event.failureStats !== undefined && (!event.error || !failureStats)) throw new Error('Некорректная диагностика сбора.');
            await persist(current.source, value => value?.id === event.id && value.status === 'running' ? { ...value, status: event.error ? 'failed' : 'completed', ...(event.result ? { result: event.result } : {}), ...(event.error ? { error: event.error } : {}), ...(failureStats ? { failureStats } : {}), updatedAt: new Date().toISOString() } : value);
            await closeCollectionTab(current);
            reply({ ok: true });
            return;
          }
          reply({ ok: true });
        } catch { reply({ ok: false }); }
      })();
      return true;
    }
    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'KUPLENO_JOB') return;
    const trustedUrl = browser.runtime.getURL('/app.html');
    if (sender.id !== browser.runtime.id || sender.url?.split('#')[0] !== trustedUrl) { reply({ ok: false, error: 'Источник команды не разрешён.' }); return; }
    void handle(message as Command).then(reply, error => reply({ ok: false, error: error instanceof Error ? error.message : 'Хранилище сбора недоступно.' }));
    return true;
  });
}
