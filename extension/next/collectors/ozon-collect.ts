import type { CollectionResult } from '../collection';
import type { Purchase } from '../model';
import { parseOzonReceipt } from './ozon.ts';

interface Receipt { id: string; url: string; date?: string; orderId?: string }
const origin = 'https://www.ozon.ru';
const cap = (size: number) => { if (size > 100000) throw Object.assign(new Error('В сборе больше 100 000 операций.'), { code: 'ROW_LIMIT_EXCEEDED' }); };
function safeUrl(value: string, receipt = false) {
  const url = new URL(value, origin);
  if (url.protocol !== 'https:' || !['www.ozon.ru','ozon.ru'].includes(url.hostname) || url.username || url.password || (receipt && !/downloadCheque/i.test(url.pathname))) throw new Error('Ozon вернул неподдерживаемую ссылку.');
  if (!receipt && !url.pathname.startsWith('/my/e-check') && url.pathname !== '/api/entrypoint-api.bx/page/json/v2') throw new Error('Ozon вернул неизвестный путь списка чеков.');
  return url.href;
}
const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\\u(002d|005f|002f|003a|003f|003d|0026|0025)|\\\//gi, (_match, code: string | undefined) => code ? String.fromCharCode(parseInt(code,16)) : '/');
export function ozonList(text: string) {
  const records = new Map<string, Receipt>();
  let next = '', knownShape = false, nodes = 0;
  function remember(value: string) {
    try {
      const url = safeUrl(decode(value), true), parsed = new URL(url);
      const id = [...parsed.searchParams].find(([key]) => /^(id|chequeid|checkid|receiptid)$/i.test(key))?.[1] || url;
      const orderId = id.match(/^(.+?)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-\d+-\d+)?$/i)?.[1];
      const previous = records.get(id);
      if (!previous || parsed.searchParams.size >= new URL(previous.url).searchParams.size) records.set(id, { id, url, orderId });
      cap(records.size);
    } catch (error) { if ((error as { code?: string }).code === 'ROW_LIMIT_EXCEEDED') throw error; }
  }
  function scanLinks(value: string) {
    // Split once into URL-sized tokens. A greedy path regex retried from every
    // slash in large inline scripts and could block the offscreen event loop.
    for (const match of decode(value).matchAll(/[^"'<>\s\\]+/g)) {
      const token = match[0];
      if (token.length <= 16000 && token.includes('downloadCheque') && /^(?:https:\/\/|\/)/.test(token)) remember(token);
    }
  }
  function walk(value: unknown, depth = 0) {
    if (++nodes > 200000 || depth > 12) throw new Error('Ответ Ozon слишком сложный для разбора.');
    if (typeof value === 'string') {
      if (value.includes('downloadCheque')) {
        if (/^(https?:)?\//.test(value)) remember(value);
        scanLinks(value);
      }
      if (/^\s*[\[{]/.test(value)) { try { walk(JSON.parse(value), depth + 1); } catch (e) { if (!(e instanceof SyntaxError)) throw e; } }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.cheques)) knownShape = true;
    if (typeof object.nextPage === 'string') next = decode(object.nextPage);
    for (const child of Object.values(object)) walk(child, depth + 1);
  }
  const normalized = decode(text);
  try { walk(JSON.parse(text)); } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
  if (!next) {
    const encoded = normalized.match(/"nextPage"\s*:\s*("(?:\\.|[^"\\])*")/);
    if (encoded) { try { next = JSON.parse(encoded[1]!); } catch { /* Unknown, not a guessed URL. */ } }
  }
  scanLinks(normalized);
  return { records: [...records.values()], next, knownShape };
}

export async function collectOzon(options: { fetch: typeof fetch; readPdf: (bytes: Uint8Array, signal?: AbortSignal) => Promise<string>; signal?: AbortSignal; onProgress?: (p: { done: number; total: number; message: string }) => void | Promise<void> }): Promise<CollectionResult> {
  const receipts = new Map<string, Receipt>(), warnings: string[] = [];
  let pages = 0, incomplete = false, emptyKnown = 0;
  for (const start of ['/my/e-check', '/my/e-check?archive=1']) {
    let url = safeUrl(start), count = 0;
    const visited = new Set<string>();
    while (url) {
      options.signal?.throwIfAborted();
      if (visited.has(url) || count >= 2000) { incomplete = true; warnings.push('Ozon: список чеков прерван из-за повторной страницы или лимита.'); break; }
      visited.add(url); count++; pages++;
      await options.onProgress?.({ done: pages - 1, total: 0, message: `Ozon: загружаем страницу чеков ${pages}…` });
      try {
        const response = await options.fetch(safeUrl(url), { signal: options.signal, credentials: 'include' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (response.url) safeUrl(response.url);
        const body = await response.text(); if (body.length > 8 * 1024 * 1024) throw new Error('Слишком большой ответ.');
        const page = ozonList(body);
        if (!page.records.length && !page.next && !page.knownShape) throw new Error('Формат списка не распознан; проверьте вход в магазин.');
        if (page.knownShape && !page.records.length) emptyKnown++;
        for (const receipt of page.records) receipts.set(receipt.id, receipt);
        cap(receipts.size);
        url = page.next ? safeUrl(`/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(new URL(safeUrl(page.next)).pathname + new URL(safeUrl(page.next)).search)}`) : '';
        await options.onProgress?.({ done: pages, total: 0, message: `Ozon: найдено ${receipts.size} чеков.` });
      } catch (e) {
        if (options.signal?.aborted || (e as { code?: string }).code === 'ROW_LIMIT_EXCEEDED') throw e;
        if (e instanceof Error && /^HTTP 40[13]$/.test(e.message)) throw new Error(`Ozon отказал в доступе к списку чеков (${e.message}). Сбор остановлен.`);
        if (e instanceof Error && /не ответил[аи]? за \d+ секунд/.test(e.message)) {
          if (!receipts.size) throw e;
          incomplete = true; warnings.push(`Ozon: ${e.message}`);
          break;
        }
        incomplete = true; warnings.push(`Ozon: список получен не полностью (${e instanceof Error ? e.message : 'ошибка ответа'}).`); break;
      }
    }
  }
  if (!receipts.size && (!emptyKnown || incomplete)) throw new Error(warnings[0] || 'Ozon: чеки не найдены. Проверьте вход в магазин.');
  const rows: Purchase[] = [];
  let failed = 0, done = 0;
  const failures = new Map<string, number>();
  for (const receipt of receipts.values()) {
    options.signal?.throwIfAborted();
    try {
      const response = await options.fetch(safeUrl(receipt.url, true), { signal: options.signal, credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (response.url) safeUrl(response.url, true);
      if (Number(response.headers.get('content-length')) > 20 * 1024 * 1024) throw new Error('PDF слишком большой.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('PDF слишком большой.');
      const parsed = parseOzonReceipt(await options.readPdf(bytes, options.signal), receipt);
      if (!parsed.length) throw new Error('Сумма и товары в PDF не распознаны');
      if (parsed.some(row => !row.date)) throw new Error('Дата в PDF не распознана');
      rows.push(...parsed); cap(rows.length);
    } catch (e) {
      if (options.signal?.aborted || (e as { code?: string }).code === 'ROW_LIMIT_EXCEEDED') throw e;
      failed++;
      // Never expose receipt contents, identifiers or URLs in diagnostics.
      const message = e instanceof Error ? e.message : '';
      const reason = /^HTTP \d{3}$/.test(message) || /^Ozon: ошибка получения PDF \((запрос|чтение файла|передача файла), [A-Za-z]+Error\)\.$/.test(message) ? message
        : ['Сумма и товары в PDF не распознаны', 'Дата в PDF не распознана', 'Файл не является PDF-чеком.', 'Запрос Ozon не разрешён.', 'PDF слишком большой.', 'Ozon не ответил. Повторите сбор позже.'].includes(message) ? message : `Ошибка PDF (${e instanceof Error ? e.name : 'Unknown'})`;
      failures.set(reason, (failures.get(reason) || 0) + 1);
      if (/^HTTP 40[13]$/.test(reason)) {
        const message = `Ozon отказал в доступе к PDF (${reason}). Сбор остановлен.`;
        if (!rows.length) throw new Error(message);
        incomplete = true; warnings.push(message); break;
      }
      if (!rows.length && reason.startsWith('Ozon: ошибка получения PDF') && failures.get(reason)! >= 3) throw new Error(`Ozon: три запроса PDF завершились одной ошибкой. Сбор остановлен. ${reason}`);
    }
    await options.onProgress?.({ done: ++done, total: receipts.size, message: `Ozon: обработано ${done} из ${receipts.size} чеков.` });
  }
  if (failed) warnings.push(`Ozon: не удалось прочитать ${failed} чеков. Ранее сохранённые операции останутся в истории.`);
  const failureDetails = [...failures].map(([reason, count]) => `${reason}: ${count}`).join('; ');
  if (!rows.length && failed) throw new Error(`${warnings.at(-1)} Причины: ${failureDetails}.${incomplete ? ` ${warnings[0]}` : ''}`);
  if (failureDetails) warnings.push(`Ozon: причины пропуска — ${failureDetails}.`);
  const unverifiedReceipts = new Set(rows.filter(row => row.parse_quality === 'unverified').map(row => row.marketplace_id)).size;
  if (unverifiedReceipts) {
    incomplete = true;
    warnings.push(`Ozon: у ${unverifiedReceipts} чеков не распознан итог. Суммы товаров требуют проверки.`);
  }
  return { rows, processedReceipts: [...new Set(rows.map(row => row.receipt_url || row.marketplace_id || '').filter(Boolean))], warnings, stats: { receipts: receipts.size, pages, failedReceipts: failed, incomplete, removed: 0, fallbackReceipts: new Set(rows.filter(row => row.parse_quality === 'fallback').map(row => row.marketplace_id)).size, unverifiedReceipts } };
}
