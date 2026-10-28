import type { browser } from 'wxt/browser';
import type { YandexDocumentsFailureReason, YandexDocumentsResult } from '../collection.ts';
import { withDeadline } from '../deadline.ts';

export type YandexOrderDocumentsResult = YandexDocumentsResult;
type Step = { state: 'waiting' | 'clicked' | 'read' | 'safe' | 'blocked' | 'unsafe'; urls: string[]; readKey?: string; failureReason?: YandexDocumentsFailureReason };

/** Serialized into one owned order page; selectors and actions are fixed. */
export function yandexOrderDocumentsStep(expectedUrl: string, action: 'click' | 'retry' | 'read' | 'inspect'): Step {
  const result = (state: Step['state'], urls: string[] = [], failureReason?: YandexDocumentsFailureReason): Step => ({ state, urls, ...(failureReason ? { failureReason } : {}) });
  const navigating = () => !!(window as Window & { navigation?: { transition?: unknown } }).navigation?.transition;
  if (location.href !== expectedUrl || location.origin !== 'https://market.yandex.ru') return result('unsafe');
  if (navigating()) return result('unsafe');
  if (document.readyState !== 'complete') return result('waiting', [], 'navigation');
  const visible = (element: Element) => !element.closest('[hidden],[aria-hidden="true"]') && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
  const text = (element: Element) => (element.textContent || '').replace(/\s+/g, ' ').trim();
  if ([...document.querySelectorAll('h1,h2,[role="heading"]')].some(element => visible(element)
    && /^(?:кажется,?\s+)?что-то пошло не так|^войдите в (?:аккаунт|яндекс)|^подтвердите,? что вы не робот/i.test(text(element)))) return result('blocked');
  for (const element of document.querySelectorAll('form[action],iframe[src],input[type="password"]')) {
    if (!visible(element)) continue;
    if (element.matches('input[type="password"]')) return result('blocked');
    try {
      const url = new URL(element.getAttribute('action') || element.getAttribute('src') || '', location.href);
      if (/(^|\.)yandex\.(ru|com)$/.test(url.hostname)
        && (/^\/(showcaptcha|checkcaptcha|captcha|auth|login|passport)(\/|$)/i.test(url.pathname) || url.hostname.startsWith('passport.'))) return result('blocked');
    } catch { /* Unrelated markup is not an admission signal. */ }
  }
  if (action === 'inspect') return result('safe');
  if (action === 'click' || action === 'retry') {
    if (action === 'retry' && [...document.querySelectorAll('[role="dialog"]')].some(visible)) return result('waiting', [], 'dialog');
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(element => visible(element) && text(element) === 'Чеки и другие документы');
    if (buttons.length > 1) return result('blocked');
    const button = buttons[0];
    if (!button || button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true') return result('waiting', [], 'button');
    if (!(button instanceof HTMLElement) || button.closest('form,a[href]') || button.getAttribute('type') === 'submit') return result('blocked');
    if (location.href !== expectedUrl || document.readyState !== 'complete' || navigating()) return result('unsafe');
    button.click();
    return result('clicked');
  }
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(element => visible(element) && text(element).includes('Документы по заказу'));
  if (dialogs.length > 1) return result('blocked');
  if (!dialogs.length) return result('waiting', [], 'dialog');
  if (dialogs[0]!.getAttribute('aria-busy') === 'true'
    || [...dialogs[0]!.querySelectorAll('progress,[role="progressbar"],[aria-busy="true"]')].some(visible)) return result('waiting', [], 'loading');
  const labels = [...dialogs[0]!.querySelectorAll('h1,h2,h3,p,span,div')].filter(visible).map(text);
  if (labels.includes('Ошибка загрузки документов') || labels.includes('Повторить загрузку')) return result('waiting', [], 'error');
  const anchors = [...dialogs[0]!.querySelectorAll('a[href]')];
  if (anchors.length > 1000) return result('blocked');
  const urls = new Set<string>();
  for (const anchor of anchors) {
    if (!visible(anchor)) continue;
    const href = anchor.getAttribute('href') || '';
    if (!/^https:\/\//i.test(href) || href.length > 16000 || /[\u0000-\u0020\\]/.test(href)) continue;
    try {
      const url = new URL(href);
      if (url.origin === 'https://check.yandex.ru' && !url.username && !url.password) urls.add(href);
    } catch { /* Never construct a fiscal URL from other page data. */ }
  }
  if (urls.size) return result('read', [...urls]);
  if (labels.includes('Документы пока не готовы') && labels.includes('Они появятся здесь чуть позже')) return { ...result('read'), readKey: 'known-empty' };
  const rows = [...dialogs[0]!.querySelectorAll('span[role="button"]')].filter(visible);
  if (rows.length > 1000) return result('blocked');
  const inert = rows.filter(row => {
    const children = [...row.children];
    return row.getAttribute('tabindex') === '0' && !row.hasAttribute('href') && children.length === 2
      && children.every(child => child.tagName === 'SPAN' && visible(child))
      && ['Чек покупки', 'Чек доставки'].includes(text(children[0]!)) && text(row).length <= 256
      && /^(?:0[1-9]|[12]\d|3[01]) (?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря) \d{4}, (?:[01]\d|2[0-3]):[0-5]\d$/.test(text(children[1]!))
      && !row.querySelector('a[href],button,input,select,textarea,[role="button"]');
  });
  // Provider's final receipt-group rows have no URL when the document is unavailable.
  return inert.length && inert.length === rows.length
    ? { ...result('read'), readKey: JSON.stringify(inert.map(text)) } : result('waiting', [], 'unrecognized');
}

/** Complete means this order's explicit dialog was read, not full account coverage. */
export async function readYandexOrderDocuments(orderId: unknown, options: {
  browser: Pick<typeof browser, 'tabs' | 'scripting'>;
  signal?: AbortSignal;
  isCurrent: () => boolean;
  timeoutMs?: number;
  onOpened: (tabId: number, orderId: string) => Promise<void>;
  onReleased: (tabId: number, orderId: string) => Promise<void>;
  onNoTab?: () => void;
}): Promise<YandexOrderDocumentsResult> {
  const id = typeof orderId === 'number' ? String(orderId) : orderId;
  if (typeof id !== 'string' || !/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('Некорректный номер заказа Яндекс Маркета.');
  const duration = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(30000, options.timeoutMs!)) : 20000;
  const deadline = Date.now() + duration, expectedUrl = `https://market.yandex.ru/my/order/${id}`;
  const empty = (blocked = false, failureReason?: YandexDocumentsFailureReason): YandexOrderDocumentsResult => ({ urls: [], complete: false, blocked, ...(failureReason ? { failureReason } : {}) });
  const stopped = () => options.signal?.aborted || !options.isCurrent();
  let latestReason: YandexDocumentsFailureReason = 'navigation';
  const incomplete = () => empty(false, stopped() ? undefined : latestReason);
  const current = () => !options.signal?.aborted && options.isCurrent() && Date.now() < deadline;
  const exact = (tab: { url?: string; pendingUrl?: string; status?: string } | null) => !!tab && !tab.pendingUrl && tab.url === expectedUrl && tab.status === 'complete';
  const timeoutMessage = 'Время чтения документов истекло.';
  const bounded = <T>(task: Promise<T>) => withDeadline(task, timeoutMessage, Math.max(1, deadline - Date.now()));
  const api = options.browser;
  let tabId: number | undefined, preserve = false, ended = false, creationStarted = false, noTabReported = false;
  const validTabId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const noTab = () => { if (!noTabReported) { noTabReported = true; options.onNoTab?.(); } };
  const closeOwn = async (id: number) => {
    try {
      const tab = await withDeadline(api.tabs.get(id), 'Вкладка не ответила.', 1000);
      if (tab.url === 'about:blank' && tab.pendingUrl === expectedUrl && tab.status === 'loading') {
        await withDeadline(api.tabs.remove(id), 'Вкладка не ответила.', 1000);
        return true;
      }
      if (!exact(tab)) return true;
      const checks = await withDeadline(api.scripting.executeScript({ target: { tabId: id }, world: 'ISOLATED', func: yandexOrderDocumentsStep, args: [expectedUrl, 'inspect'] }), 'Вкладка не ответила.', 1000);
      if (checks[0]?.result?.state !== 'safe') return true;
      if (exact(await withDeadline(api.tabs.get(id), 'Вкладка не ответила.', 1000))) await withDeadline(api.tabs.remove(id), 'Вкладка не ответила.', 1000);
      return true;
    } catch { return false; /* Keep durable ownership when cleanup could not inspect the tab. */ }
  };
  try {
    if (!current()) { noTab(); return empty(); }
    const creation = api.tabs.create({ url: expectedUrl, active: false });
    creationStarted = true;
    void creation.then(async tab => {
      if (!validTabId(tab.id)) { noTab(); return; }
      if (!ended) return;
      // Late creation still needs durable ownership, even after the UI task expired.
      try { await options.onOpened(tab.id, id); } catch { /* Still attempt safe cleanup if the caller no longer has this job. */ }
      if (await closeOwn(tab.id)) await options.onReleased(tab.id, id);
    }, noTab).catch(() => {});
    tabId = (await bounded(creation)).id;
    if (!validTabId(tabId)) { tabId = undefined; noTab(); return empty(); }
    await bounded(options.onOpened(tabId, id));
    let clicked = false, loaded = false, previousUrls = '';
    let clickedAt = 0, retried = false, missingDialog = false;
    while (current()) {
      const tab = await bounded(api.tabs.get(tabId));
      const initialNavigation = !loaded && tab.pendingUrl === expectedUrl && (!tab.url || tab.url === 'about:blank');
      if (!initialNavigation && ((tab.pendingUrl && (loaded || tab.pendingUrl !== expectedUrl)) || (tab.url && tab.url !== expectedUrl))) { preserve = true; return empty(true); }
      if (exact(tab)) {
        loaded = true;
        if (!current()) return incomplete();
        const retry: boolean = clicked && missingDialog && !retried && Date.now() - clickedAt >= 3000;
        const action: 'click' | 'retry' | 'read' = !clicked ? 'click' : retry ? 'retry' : 'read';
        if (retry) retried = true;
        const executions: { result?: Step }[] = await bounded(api.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: yandexOrderDocumentsStep, args: [expectedUrl, action] }));
        const step = executions[0]?.result;
        if (step?.state === 'waiting') latestReason = step.failureReason || 'unrecognized';
        if (!current()) return incomplete();
        if (!step || step.state === 'blocked' || step.state === 'unsafe') { preserve = true; return empty(true); }
        if (action === 'read') missingDialog = step.state === 'waiting' && step.failureReason === 'dialog';
        if (step.state === 'clicked') {
          clicked = true; clickedAt ||= Date.now(); latestReason = 'dialog';
        }
        if (step.state === 'read') {
          const identity = JSON.stringify([[...step.urls].sort(), step.readKey || '']);
          if (identity === previousUrls) return { urls: step.urls, complete: true, blocked: false };
          previousUrls = identity;
        } else previousUrls = '';
      } else latestReason = 'navigation';
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
    return incomplete();
  } catch (error) { if (!creationStarted) noTab(); return empty(false, stopped() ? undefined : error instanceof Error && error.message === timeoutMessage ? latestReason : 'request'); }
  finally {
    ended = true;
    if (tabId !== undefined && (preserve || await closeOwn(tabId))) {
      try { await withDeadline(options.onReleased(tabId, id), 'Не удалось освободить вкладку документов.', 1000); }
      catch { return empty(false, stopped() ? undefined : 'request'); }
    }
  }
}
