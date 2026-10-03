import { browser } from 'wxt/browser';
import { readPdf } from '../../collectors/pdf';
import { collectOzon } from '../../collectors/ozon-collect';
import { collectYandex } from '../../collectors/yandex-collect';
import type { Job, CollectionResult } from '../../collection';
import { withDeadline } from '../../deadline';

let controller: AbortController | null = null;
let jobId = '';
let running = false;
let delivery: ReturnType<typeof setTimeout> | undefined;

async function finish(id: string, result?: CollectionResult, error?: string) {
  try {
    const response = await browser.runtime.sendMessage({ type: 'KUPLENO_OFFSCREEN_EVENT', action: 'finished', id, result, error });
    if (!response?.ok) throw new Error('Не удалось сохранить результат обработки.');
  } catch {
    // Keep the completed result alive if the service worker is being restarted.
    delivery = setTimeout(() => void finish(id, result, error), 2000);
  }
}

browser.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== browser.runtime.id || message?.type !== 'KUPLENO_OFFSCREEN') return;
  // A website and the report page cannot supply executable jobs or authenticated request headers.
  if (sender.url && sender.url !== browser.runtime.getURL('/background.js')) { reply({ ok: false }); return; }
  if (message.action === 'cancel' && message.id === jobId) { controller?.abort(); clearTimeout(delivery); reply({ ok: true }); return; }
  if (message.action !== 'run' || running || !message.job?.id) { reply({ ok: false }); return; }
  const job = message.job as Job;
  if (job.source !== 'ozon' && job.source !== 'yandex') { reply({ ok: false }); return; }
  jobId = job.id; running = true; controller = new AbortController();
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
        const response = await browser.runtime.sendMessage({ type: 'KUPLENO_YANDEX_REQUEST', id: job.id, url: url.href, body: options?.body });
        signal.throwIfAborted();
        if (!response?.ok || response.error) throw new Error(response?.error || 'Яндекс Маркет не ответил.');
        return new Response(response.text, { status: response.status });
      }
      return fetch(input, { ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
    },
    onProgress: async (progress: { done: number; total: number; message: string }) => {
      await withDeadline(browser.runtime.sendMessage({ type: 'KUPLENO_OFFSCREEN_EVENT', action: 'progress', id: job.id, progress }), 'Не удалось подтвердить ход сбора.', 10000);
    },
  };
  const task = job.source === 'ozon' ? collectOzon({ ...options, readPdf }) : collectYandex({ ...options, context: message.context });
  void task.then(result => finish(job.id, result)).catch(error => finish(job.id, undefined, error instanceof Error ? error.message : 'Не удалось обработать чеки.'));
});
