import { browser } from 'wxt/browser';
import { withDeadline } from '../deadline';

const resolvers = new Set([
  'src/resolvers/orders/resolveConsolidationOrders/index:resolveConsolidationOrders',
  'src/resolvers/orders/resolveConsolidationOrders:resolveConsolidationOrders',
  'src/resolvers/orderDocuments/resolveOrderReceiptsByOrderId:resolveOrderReceiptsByOrderId',
]);

/** Fixed-purpose request in the signed-in store tab; never a general fetch proxy. */
export async function yandexRequest(input: unknown, body: unknown, tabId?: number) {
  if (typeof input !== 'string' || typeof body !== 'string' || body.length > 16000) throw new Error('Некорректный запрос чеков.');
  const url = new URL(input);
  const resolver = url.searchParams.get('r') || '';
  if (url.origin !== 'https://market.yandex.ru' || url.pathname !== '/api/resolve/' || url.username || url.password || !resolvers.has(resolver)) throw new Error('Запрос к магазину не разрешён.');
  const request = JSON.parse(body);
  if (request.path !== '/my/orders?filter=COMPLETED' || !Array.isArray(request.params) || request.params.length !== 1) throw new Error('Неизвестный запрос истории.');
  const params = request.params[0];
  if (!params || typeof params !== 'object') throw new Error('Некорректные параметры истории.');
  if (resolver.includes('resolveOrderReceiptsByOrderId')) {
    if (!Number.isSafeInteger(params.orderId) || params.orderId <= 0 || typeof params.archived !== 'boolean' || Object.keys(params).some(key => !['orderId','archived'].includes(key))) throw new Error('Некорректный номер заказа.');
  } else if (params.filter !== 'COMPLETED' || params.size !== 18 || (params.pageToken !== undefined && (typeof params.pageToken !== 'string' || params.pageToken.length > 8000)) || Object.keys(params).some(key => !['filter','size','pageToken'].includes(key))) throw new Error('Некорректная страница истории.');
  const tab = tabId === undefined ? null : await browser.tabs.get(tabId).catch(() => null);
  if (!tab?.url || new URL(tab.url).origin !== 'https://market.yandex.ru') throw new Error('Вкладка сбора Яндекс Маркета закрыта или открыта другая страница. Повторите сбор.');
  const executions = await withDeadline(browser.scripting.executeScript({ target: { tabId: tabId! }, world: 'MAIN', args: [resolver, body], func: async (resolver: string, body: string) => {
    if (location.origin !== 'https://market.yandex.ru') return { status: 403, text: '', error: 'Страница магазина изменилась.' };
    const html = document.documentElement.innerHTML.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const read = (key: string) => html.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\r\\n]{1,2000})"`))?.[1] || '';
    const headers: Record<string, string> = { accept: '*/*', 'content-type': 'application/json', 'x-market-apphost-target': 'WEB', 'x-market-core-service': '<UNKNOWN>', 'x-market-page-id': read('page') || 'market:orders', 'x-requested-with': 'XMLHttpRequest', 'x-retpath-y': 'https://market.yandex.ru/my/orders?filter=COMPLETED' };
    const sk = read('sk'), version = read('-version') || read('version'), glue = read('marketFrontGlue');
    if (sk) headers.sk = sk;
    if (version) headers['x-market-app-version'] = version;
    if (glue) headers['x-market-front-glue'] = glue;
    const url = new URL('/api/resolve/', location.origin); url.searchParams.set('r', resolver);
    try {
      const response = await fetch(url, { method: 'POST', credentials: 'include', signal: AbortSignal.timeout(25000), headers, body });
      if (response.url && new URL(response.url).origin !== location.origin) return { status: 403, text: '', error: 'Нужно войти в Яндекс Маркет.' };
      if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) return { status: 413, text: '', error: 'Ответ магазина слишком большой.' };
      const text = await response.text();
      if (text.length > 8 * 1024 * 1024) return { status: 413, text: '', error: 'Ответ магазина слишком большой.' };
      return { status: response.status, text, error: '' };
    } catch { return { status: 502, text: '', error: 'Магазин не ответил. Повторите сбор позже.' }; }
  } }), 'Вкладка Яндекс Маркета не ответила за 30 секунд.');
  const result = executions[0]?.result;
  if (!result) throw new Error('Не удалось получить ответ магазина.');
  return result;
}
