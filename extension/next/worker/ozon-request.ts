import { browser } from 'wxt/browser';
import { withDeadline } from '../deadline';
import { fetchOzonPdf } from './ozon-pdf';

export async function ozonRequest(input: unknown, tabId?: number) {
  if (typeof input !== 'string' || input.length > 16000) throw new Error('Некорректная ссылка Ozon.');
  const url = new URL(input);
  const receipt = /\/downloadCheque$/i.test(url.pathname);
  const allowedPath = receipt || /^\/my\/e-check\/?$/.test(url.pathname) || url.pathname === '/api/entrypoint-api.bx/page/json/v2';
  if (url.protocol !== 'https:' || !['ozon.ru','www.ozon.ru'].includes(url.hostname) || url.username || url.password || !allowedPath) throw new Error('Запрос Ozon не разрешён.');
  if (url.pathname.includes('/api/')) {
    const page = new URL(url.searchParams.get('url') || '', 'https://www.ozon.ru');
    if (page.origin !== 'https://www.ozon.ru' || !/^\/my\/e-check\/?$/.test(page.pathname)) throw new Error('Неизвестная страница чеков Ozon.');
  }
  if (tabId === undefined) throw new Error('Перезапустите сбор Ozon: вкладка этого сбора не найдена.');
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !['https://ozon.ru','https://www.ozon.ru'].includes(new URL(tab.url).origin)) throw new Error('Вкладка сбора Ozon закрыта или открыта другая страница. Повторите сбор.');
  if (receipt) return withDeadline(fetchOzonPdf(url.href), 'Ozon не отдал PDF за 30 секунд.');
  const execution = await withDeadline(browser.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', injectImmediately: true, args: [url.href, receipt], func: async (url: string, binary: boolean) => {
    if (location.protocol !== 'https:' || !['www.ozon.ru','ozon.ru'].includes(location.hostname)) return { status: 403, text: '', binary, error: 'Страница Ozon изменилась.' };
    let stage = 'запрос';
    try {
      const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(25000), headers: { accept: binary ? 'application/pdf,*/*' : 'text/html,application/json,*/*' } });
      const final = new URL(response.url || url);
      if (final.protocol !== 'https:' || !['ozon.ru','www.ozon.ru'].includes(final.hostname)) return { status: 403, text: '', binary, error: 'Ozon перенаправил запрос. Проверьте вход.' };
      const max = (binary ? 20 : 8) * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > max) return { status: 413, text: '', binary, error: 'Ответ Ozon слишком большой.' };
      if (!response.ok) return { status: response.status, text: '', binary, error: '' };
      if (!binary) {
        const text = await response.text();
        return text.length <= max ? { status: response.status, text, binary, error: '' } : { status: 413, text: '', binary, error: 'Страница чеков слишком большая.' };
      }
      stage = 'чтение файла';
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > max) return { status: 413, text: '', binary, error: 'PDF слишком большой.' };
      stage = 'передача файла';
      let encoded = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      return { status: response.status, text: btoa(encoded), binary, error: '' };
    } catch (error) { const name = error instanceof Error && /^[A-Za-z]+Error$/.test(error.name) ? error.name : 'Error'; return { status: 502, text: '', binary, error: name === 'TimeoutError' ? 'Вкладка Ozon не ответила за 25 секунд. Повторите сбор.' : `Ozon: ошибка получения ${binary ? 'PDF' : 'страницы'} (${stage}, ${name}).` }; }
  } }), 'Вкладка Ozon не ответила за 30 секунд. Обновите её и повторите сбор.');
  const result = execution[0]?.result;
  if (!result) throw new Error('Не удалось получить ответ Ozon.');
  return result;
}
