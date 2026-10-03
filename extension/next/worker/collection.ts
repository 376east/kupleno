import { browser } from 'wxt/browser';
import { collectWildberries } from '../collectors/wildberries';
import type { Job, Command, JobResponse } from '../collection';
import { SOURCES } from '../domain.mjs';
import type { Source } from '../model';
import { yandexRequest } from './yandex-request';
import { ozonRequest } from './ozon-request';
import { withDeadline } from '../deadline';

const key = 'kupleno-next-job';
let current: Job | null = null;
let running: AbortController | null = null;
let queue = Promise.resolve();
let writes = Promise.resolve();
const init = browser.storage.local.get(key).then(async data => {
  current = data[key] as Job || null;
  if (current?.status === 'running') {
    const contexts = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [browser.runtime.getURL('/offscreen.html')] });
    if (current.source !== 'wildberries' && contexts.length) return;
    current = { ...current, status: 'failed', error: 'Браузер прервал сбор. Запустите его ещё раз; сохранённая история не изменилась.', updatedAt: new Date().toISOString() };
    await browser.storage.local.set({ [key]: current });
    await closeCollectionTab(current);
  }
});

async function ensureOffscreen() {
  const contexts = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [browser.runtime.getURL('/offscreen.html')] });
  if (!contexts.length) await browser.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Разбор PDF-чеков локальным PDF worker без открытых служебных вкладок.' });
}

async function closeCollectionTab(job: Job | null) {
  if (!job || job.marketTabId === undefined) return;
  const tab = await browser.tabs.get(job.marketTabId).catch(() => null);
  if (!tab?.url) return;
  const url = new URL(tab.url);
  // Only the receipt tab created by this job; preserve tabs the user navigated away.
  const expected = new URL(SOURCES[job.source].url);
  if (url.hostname.replace(/^www\./, '') === expected.hostname.replace(/^www\./, '') && url.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '')) await browser.tabs.remove(job.marketTabId).catch(() => {});
}

async function marketContext(source: Source) {
  let tab = await browser.tabs.create({ url: SOURCES[source].url, active: false });
  const ownedId = tab.id;
  try {
  const deadline = Date.now() + 20000;
  while (tab.status !== 'complete' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    tab = await browser.tabs.get(tab.id!);
  }
  if (tab.id === undefined || tab.status !== 'complete') throw new Error(`${SOURCES[source].name}: страница ещё загружается. Повторите сбор после загрузки.`);
  if (source === 'ozon') return { marketTabId: tab.id };
  if (source !== 'yandex') return { marketTabId: tab.id };
  const result = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
    const html = document.documentElement.innerHTML.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    // nosemgrep: detect-non-literal-regexp -- read is scoped to this injected function and called only with fixed header names below.
    const read = (key: string) => html.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\r\\n]{1,2000})"`))?.[1] || '';
    return { sk: read('sk'), version: read('-version') || read('version'), marketFrontGlue: read('marketFrontGlue'), pageId: read('page') || 'market:orders', retpath: location.href };
  } });
  return { ...result[0]?.result, marketTabId: tab.id };
  } catch (error) {
    if (ownedId !== undefined) await closeCollectionTab({ source, marketTabId: ownedId } as Job);
    throw error;
  }
}

async function persist(change: Job | null | ((job: Job | null) => Job | null)) {
  const task = writes.then(async () => {
    const job = typeof change === 'function' ? change(current) : change;
    await browser.storage.local.set({ [key]: job });
    current = job;
  });
  writes = task.catch(() => {});
  await task;
}

async function wbToken(tabId?: number): Promise<string> {
  // Only this named authentication cookie is accessed; never saved in job state.
  for (const url of ['https://www.wildberries.ru/', 'https://wildberries.ru/', 'https://astro.wildberries.ru/']) {
    const cookie = await browser.cookies.get({ url, name: 'wbid-sdk-id-token' });
    let value = cookie?.value || '';
    try { value = decodeURIComponent(value); } catch { /* A malformed cookie is not a session. */ }
    if (value && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
      try { const body = JSON.parse(atob(value.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))); if (!body.exp || body.exp * 1000 > Date.now()) return value; } catch { /* Continue with page storage. */ }
    }
  }
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

async function execute(job: Job, controller: AbortController) {
  try {
    const token = await wbToken(job.marketTabId);
    const result = await collectWildberries({
      token, signal: controller.signal,
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]) }),
      onProgress: async progress => {
        await persist(value => value?.id === job.id && value.status === 'running'
          ? { ...value, progress: { done: progress.done, total: progress.total }, message: progress.message, updatedAt: new Date().toISOString() } : value);
      },
    });
    if (current?.id === job.id && current.status === 'running') {
      // The durable result and completed status are one write. The app acknowledges only after its DB transaction.
      await persist(value => value?.id === job.id && value.status === 'running'
        ? { ...value, status: 'completed', result, message: `Собрано ${result.rows.length} операций`, updatedAt: new Date().toISOString() } : value);
    }
  } catch (error) {
    if (current?.id === job.id && current.status === 'running') {
      const diagnostic = error instanceof Error ? error.message : 'Сбор не завершён.';
      const message = diagnostic.startsWith('WB_LIST_UNKNOWN_PAYLOAD') ? 'Wildberries изменил формат списка чеков. Скопируйте сведения об ошибке — в них есть структура ответа для исправления сборщика.'
        : diagnostic === 'WB_SESSION_NOT_FOUND' ? 'Не удалось получить сессию Wildberries из открытой вкладки. Откройте страницу чеков WB и повторите сбор.'
        : /WB_(TOKEN_REQUIRED|LIST_HTTP_401)/.test(diagnostic) ? 'Wildberries отклонил сессию. Обновите страницу магазина и повторите сбор.'
        : diagnostic === 'WB_LIST_HTTP_403' ? 'Wildberries отказал в доступе к чекам (403). Откройте страницу чеков и проверьте, доступны ли они в магазине.'
        : diagnostic === 'WB_LIST_NON_JSON' ? 'Wildberries вернул страницу вместо списка чеков. Откройте магазин, проверьте вход и повторите сбор.'
        : diagnostic.startsWith('WB_LIST_HTTP_') ? `Wildberries временно не отдал историю (код ${diagnostic.split('_').at(-1)}). Повторите сбор позже.` : diagnostic;
      await persist(value => value?.id === job.id && value.status === 'running'
        ? { ...value, status: controller.signal.aborted ? 'cancelled' : 'failed', error: message, diagnostic: diagnostic.slice(0, 2000), updatedAt: new Date().toISOString() } : value);
    }
  } finally { await closeCollectionTab(job); if (running === controller) running = null; }
}

async function handle(command: Command): Promise<JobResponse> {
  await init;
  if (command.action === 'status') {
    if (current?.status === 'running' && Date.now() - Date.parse(current.updatedAt) > 180000) {
      running?.abort();
      const stale = current;
      await persist({ ...stale, status: 'failed', error: 'Сбор не отвечает больше трёх минут. Обновите вкладку магазина и запустите снова; сохранённая история не изменилась.', updatedAt: new Date().toISOString() });
      await closeCollectionTab(stale);
      if (stale.source !== 'wildberries') await withDeadline(browser.offscreen.closeDocument(), 'Не удалось закрыть обработчик.', 5000).catch(() => {});
    }
    return { ok: true, job: current };
  }
  if (command.action === 'ack') {
    if (current?.id === command.id && current.status === 'completed') { await closeCollectionTab(current); await persist(null); }
    return { ok: true, job: current };
  }
  if (command.action === 'cancel') {
    running?.abort();
    // Persist cancellation before talking to a possibly frozen offscreen page.
    if (current?.status === 'running') await persist({ ...current, status: 'cancelled', message: 'Сбор отменён', updatedAt: new Date().toISOString() });
    if (current && current.source !== 'wildberries') {
      await withDeadline(browser.runtime.sendMessage({ type: 'KUPLENO_OFFSCREEN', action: 'cancel', id: current.id }), 'Обработчик не ответил на отмену.', 1000).catch(() => {});
      await withDeadline(browser.offscreen.closeDocument(), 'Не удалось закрыть обработчик.', 5000).catch(() => {});
    }
    await closeCollectionTab(current);
    return { ok: true, job: current };
  }
  if (command.action !== 'start') return { ok: false, error: 'Неизвестная команда сбора.' };
  if (!Object.hasOwn(SOURCES, command.source)) return { ok: false, error: 'Неизвестный магазин.' };
  if (typeof command.profile !== 'string' || !command.profile || command.profile.length > 120) return { ok: false, error: 'Выберите профиль для сбора.' };
  if (current?.status === 'running' || current?.status === 'completed') return { ok: false, error: 'Сначала завершите сохранение предыдущего сбора.' };
  await closeCollectionTab(current);
  const context = await marketContext(command.source);
  const job: Job = { id: crypto.randomUUID(), source: command.source, profile: command.profile, ...('marketTabId' in context ? { marketTabId: context.marketTabId as number } : {}), status: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), message: `Подключаем ${SOURCES[command.source].name}…`, progress: { done: 0, total: 0 } };
  await persist(job);
  if (job.source !== 'wildberries') {
    try {
      await ensureOffscreen();
      const reply = await withDeadline(browser.runtime.sendMessage({ type: 'KUPLENO_OFFSCREEN', action: 'run', job, context }), 'Обработчик чеков не ответил за 30 секунд. Повторите сбор.');
      if (!reply?.ok) throw new Error('Обработчик чеков занят. Повторите сбор.');
    } catch (e) {
      await persist({ ...job, status: 'failed', error: e instanceof Error ? e.message : 'Не удалось запустить обработку чеков.' });
      await browser.offscreen.closeDocument().catch(() => {});
      await closeCollectionTab(job);
    }
    return { ok: true, job: current };
  }
  const controller = new AbortController(); running = controller;
  void execute(job, controller).catch(error => console.error('Не удалось сохранить состояние сбора', error instanceof Error ? error.name : 'Error'));
  return { ok: true, job };
}

export function registerCollection() {
  browser.runtime.onMessage.addListener((message: unknown, sender, reply) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'KUPLENO_OZON_REQUEST') {
      if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL('/offscreen.html') || !('id' in message) || !('url' in message)) { reply({ ok: false }); return; }
      void init.then(async () => {
        if (!current || current.id !== message.id || current.source !== 'ozon' || current.status !== 'running') throw new Error('Сбор уже завершён.');
        return ozonRequest(message.url, current.marketTabId);
      }).then(result => reply({ ok: true, ...result })).catch(error => reply({ ok: false, error: error instanceof Error ? error.message : 'Магазин не ответил.' }));
      return true;
    }
    if (message && typeof message === 'object' && 'type' in message && message.type === 'KUPLENO_YANDEX_REQUEST') {
      if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL('/offscreen.html') || !('id' in message) || !('url' in message) || !('body' in message)) { reply({ ok: false }); return; }
      void init.then(async () => {
        if (!current || current.id !== message.id || current.source !== 'yandex' || current.status !== 'running') throw new Error('Сбор уже завершён.');
        return yandexRequest(message.url, message.body, current.marketTabId);
      }).then(result => reply({ ok: true, ...result })).catch(error => reply({ ok: false, error: error instanceof Error ? error.message : 'Магазин не ответил.' }));
      return true;
    }
    if (message && typeof message === 'object' && 'type' in message && message.type === 'KUPLENO_OFFSCREEN_EVENT') {
      if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL('/offscreen.html')) { reply({ ok: false }); return; }
      if (!('id' in message) || typeof message.id !== 'string' || !('action' in message) || typeof message.action !== 'string') { reply({ ok: false }); return; }
      const event = message as { id: string; action: string; progress?: Job['progress'] & { message: string }; result?: Job['result']; error?: string };
      queue = queue.then(async () => {
        try {
          await init;
          if (current?.id !== event.id || current.status !== 'running') { reply({ ok: true }); return; }
          if (event.action === 'progress' && event.progress) {
            if (!Number.isSafeInteger(event.progress.done) || !Number.isSafeInteger(event.progress.total) || event.progress.done < 0 || event.progress.total < 0) throw new Error('Некорректный ход сбора.');
            await persist({ ...current, message: String(event.progress.message).slice(0,1000), progress: { done: event.progress.done, total: event.progress.total }, updatedAt: new Date().toISOString() });
          } else if (event.action === 'finished') {
            if (!event.error && !event.result) throw new Error('Обработчик не передал результат.');
            if (event.result && (!Array.isArray(event.result.rows) || event.result.rows.length > 100000 || !Array.isArray(event.result.warnings) || !event.result.stats || typeof event.result.stats !== 'object')) throw new Error('Некорректный результат сбора.');
            await persist({ ...current, status: event.error ? 'failed' : 'completed', ...(event.result ? { result: event.result } : {}), ...(event.error ? { error: event.error } : {}), updatedAt: new Date().toISOString() });
            await closeCollectionTab(current);
            reply({ ok: true });
            await browser.offscreen.closeDocument().catch(() => {});
            return;
          }
          reply({ ok: true });
        } catch { reply({ ok: false }); }
      });
      return true;
    }
    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'KUPLENO_JOB') return;
    const trustedUrl = browser.runtime.getURL('/app.html');
    if (sender.id !== browser.runtime.id || sender.url?.split('#')[0] !== trustedUrl) { reply({ ok: false, error: 'Источник команды не разрешён.' }); return; }
    queue = queue.then(async () => { try { reply(await handle(message as Command)); } catch (error) { reply({ ok: false, error: error instanceof Error ? error.message : 'Хранилище сбора недоступно.' }); } });
    return true;
  });
}
