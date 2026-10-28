import type { YandexOrdersDomResult } from '../collection';

/** One fixed read-only listing step; no caller-controlled selectors or navigation. */
export function yandexOrdersDomStep(waitingForIds: string[] | null = null): YandexOrdersDomResult {
  const result: YandexOrdersDomResult = { orderIds: [], clicked: false, hasMore: false, blocked: false, ambiguous: false, limit: false, fatal: false };
  if (location.origin !== 'https://market.yandex.ru' || location.pathname !== '/my/orders' || new URL(location.href).searchParams.get('filter') !== 'COMPLETED') return { ...result, blocked: true };
  const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
  const label = (element: Element) => (element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/ё/g, 'е');
  if ([...document.querySelectorAll('h1,h2,[role="heading"]')].some(element => visible(element) && label(element) === 'что-то пошло не так')) return { ...result, blocked: true, fatal: true };
  for (const element of document.querySelectorAll('form[action],iframe[src]')) {
    if (!visible(element)) continue;
    try {
      const url = new URL(element.getAttribute('action') || element.getAttribute('src') || '', location.href);
      if (/(^|\.)yandex\.(ru|com)$/.test(url.hostname) && /^\/(showcaptcha|checkcaptcha|captcha)(\/|$)/i.test(url.pathname)) return { ...result, blocked: true };
    } catch { /* Unrelated markup is not a challenge URL. */ }
  }
  const ids = new Set<string>();
  const html = document.documentElement?.innerHTML || '';
  if (html.length > 12 * 1024 * 1024) return { ...result, limit: true };
  for (const match of html.matchAll(/\/my\/order\/([1-9]\d*)/g)) {
    if (Number.isSafeInteger(Number(match[1]))) ids.add(match[1]!);
    if (ids.size > 100000) return { ...result, limit: true };
  }
  for (const element of document.querySelectorAll('a[href*="/my/order/"]')) {
    try {
      const url = new URL(element.getAttribute('href') || '', location.href), id = url.pathname.match(/^\/my\/order\/([1-9]\d*)\/?$/)?.[1];
      if (url.origin === location.origin && id && Number.isSafeInteger(Number(id))) ids.add(id);
      if (ids.size > 100000) return { ...result, limit: true };
    } catch { /* Invalid links are not order IDs. */ }
  }
  result.orderIds = [...ids];
  const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(element => visible(element) && label(element) === 'показать еще');
  result.hasMore = buttons.length > 0;
  if (buttons.length > 1) return { ...result, ambiguous: true };
  if (waitingForIds) {
    const previous = new Set(waitingForIds);
    if (!result.orderIds.some(id => !previous.has(id))) return result;
  }
  const button = buttons[0];
  if (!button || button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true') return result;
  if (!(button instanceof HTMLElement) || button.closest('form,a[href]') || button.getAttribute('type') === 'submit') return { ...result, blocked: true };
  // No await between the final location check and this single listing-only action.
  if (location.origin !== 'https://market.yandex.ru' || location.pathname !== '/my/orders') return { ...result, blocked: true };
  button.click(); result.clicked = true;
  return result;
}
