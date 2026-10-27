import { browser } from 'wxt/browser';
import { readPdf } from '../../collectors/pdf';
import { collectOzon } from '../../collectors/ozon-collect';
import { collectYandex } from '../../collectors/yandex-collect';
import type { Job, CollectionResult } from '../../collection';
import { withDeadline } from '../../deadline';

const tasks = new Map<string, { source: Job['source']; controller: AbortController; delivery?: ReturnType<typeof setTimeout> }>();

async function finish(id: string, result?: CollectionResult, error?: string, failureStats?: CollectionResult['stats']) {
  const task = tasks.get(id);
  if (!task) return;
  try {
    const response = await withDeadline(browser.runtime.sendMessage({ type: 'KUPLENO_OFFSCREEN_EVENT', action: 'finished', id, result, error, failureStats }), 'Не удалось сохранить результат.', 10000);
    if (!response?.ok) throw new Error('Не удалось сохранить результат обработки.');
    if (tasks.get(id) === task) tasks.delete(id);
  } catch {
    // Each result retries independently while the worker restarts.
    if (tasks.get(id) === task) task.delivery = setTimeout(() => void finish(id, result, error, failureStats), 2000);
  }
}

browser.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== browser.runtime.id || message?.type !== 'KUPLENO_OFFSCREEN') return;
  // A website and the report page cannot supply executable jobs or authenticated request headers.
  if (sender.url && sender.url !== browser.runtime.getURL('/background.js')) { reply({ ok: false }); return; }
  if (message.action === 'status') { reply({ ok: true, ids: [...tasks.keys()] }); return; }
  if (message.action === 'cancel') {
    const task = tasks.get(message.id);
    if (task) { task.controller.abort(); clearTimeout(task.delivery); tasks.delete(message.id); }
    reply({ ok: true }); return;
  }
  if (message.action !== 'run' || !message.job?.id) { reply({ ok: false }); return; }
  const job = message.job as Job;
  if (job.source !== 'ozon' && job.source !== 'yandex') { reply({ ok: false }); return; }
  if (tasks.has(job.id)) { reply({ ok: true }); return; }
  if ([...tasks.values()].some(task => task.source === job.source)) { reply({ ok: false }); return; }
  const controller = new AbortController();
  tasks.set(job.id, { source: job.source, controller });
  const signal = controller.signal;
  reply({ ok: true });
  const options = {
    signal,
    fetch: async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      signal.throwIfAborted();
      const url = new URL(String(input));
      if (job.source === 'ozon') {
        const response = await withDeadline(browser.runtime.sendMessage({ type: 'KUPLENO_OZON_REQUEST', id: job.id, url: url.href }), 'Ozon: обработчик запроса не ответил за 35 секунд.', 35000);
        signal.throwIfAborted();
        if (!response?.ok || response.error) throw new Error(response?.error || 'Ozon не ответил.');
        const bytes = response.binary ? Uint8Array.from(atob(response.text), c => c.charCodeAt(0)) : response.text;
        return new Response(bytes, { status: response.status });
      }
      if (job.source === 'yandex' && url.origin === 'https://market.yandex.ru' && url.pathname === '/api/resolve/') {
        const requestHeaders = new Headers(options?.headers);
        const headerContext: Record<string, string> = {};
        for (const [field, header] of [['sk', 'sk'], ['version', 'x-market-app-version'], ['marketFrontGlue', 'x-market-front-glue'], ['pageId', 'x-market-page-id']] as const) {
          const value = requestHeaders.get(header);
          if (value) headerContext[field] = value;
        }
        const response = await browser.runtime.sendMessage({ type: 'KUPLENO_YANDEX_REQUEST', id: job.id, url: url.href, body: options?.body, headerContext });
        signal.throwIfAborted();
        if (!response?.ok) throw new Error(response?.error || 'Яндекс Маркет не ответил.');
        const headers = new Headers();
        for (const [field, suffix] of [['html', 'html'], ['challenge', 'challenge'], ['login', 'login'], ['redirected', 'redirected'], ['challengeOpened', 'challenge-opened'], ['liveSk', 'live-sk'], ['contextSk', 'context-sk'], ['contextSkUsed', 'context-sk-used']] as const) {
          if (response[field] === true) headers.set(`x-kupleno-yandex-${suffix}`, '1');
        }
        if (response.error && ![...headers].length) throw new Error(response.error);
        return new Response(response.text, { status: response.status, headers });
      }
      return fetch(input, { ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
    },
    onProgress: async (progress: { done: number; total: number; message: string }) => {
      await withDeadline(browser.runtime.sendMessage({ type: 'KUPLENO_OFFSCREEN_EVENT', action: 'progress', id: job.id, progress }), 'Не удалось подтвердить ход сбора.', 10000);
    },
  };
  let lastDiagnostics: CollectionResult['stats'] | undefined;
  const task = job.source === 'ozon' ? collectOzon({ ...options, readPdf }) : collectYandex({ ...options, context: message.context, onDiagnostics: stats => { lastDiagnostics = { ...stats }; } });
  void task.then(result => finish(job.id, result)).catch(error => finish(job.id, undefined, error instanceof Error ? error.message : 'Не удалось обработать чеки.', lastDiagnostics));
});
