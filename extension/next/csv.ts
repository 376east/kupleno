import { moneyDecimal, moneyMinor } from './domain.mjs';
import { identifyRows } from './preferences.mjs';
import type { Purchase } from './model';

const columns = ['rowId', 'date', 'source', 'title', 'amount', 'currency', 'type', 'category', 'marketplace_id', 'item_index', 'profile', 'note', 'excluded', 'receipt_url', 'parse_quality'];

export function parseTable(input: string): string[][] {
  if (input.length > 20 * 1024 * 1024) throw new Error('Таблица больше 20 МБ.');
  const text = input.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const separator = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const result: string[][] = [];
  let row: string[] = [], value = '', quoted = false, closed = false;
  const cell = () => {
    row.push(value); value = ''; closed = false;
    if (row.length > 50) throw new Error('В таблице больше 50 столбцов.');
  };
  const line = () => {
    cell();
    if (row.some(value => value.trim())) result.push(row);
    row = [];
    if (result.length > 100001) throw new Error('В таблице больше 100 000 операций.');
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { value += '"'; index++; }
        else { quoted = false; closed = true; }
      } else value += char;
    } else if (char === separator) cell();
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[index + 1] === '\n') index++; line(); }
    else if (char === '"' && !value && !closed) quoted = true;
    else if (closed || char === '"') throw new Error('В таблице нарушены кавычки. Сохраните её заново в CSV.');
    else value += char;
    if (value.length > 20000) throw new Error('Поле таблицы длиннее 20 000 символов.');
  }
  if (quoted) throw new Error('В таблице не закрыта кавычка.');
  if (value || row.length || closed) line();
  return result;
}

const formulaPrefix = /^[=+\-@\t\r']/;
const decode = (value: string) => value.startsWith("'") && formulaPrefix.test(value.slice(1)) ? value.slice(1) : value;

export function parsePurchasesCsv(text: string, profile = 'personal'): Purchase[] {
  const table = parseTable(text);
  const aliases: Record<string, string> = { marketplace: 'source', is_return: 'type', rowid: 'rowId' };
  const headers = (table.shift() || []).map(value => { const key = value.trim().toLowerCase(); return aliases[key] || key; });
  if (new Set(headers).size !== headers.length) throw new Error('В таблице повторяются названия столбцов.');
  for (const key of ['date', 'source', 'title', 'amount']) if (!headers.includes(key)) throw new Error(`В таблице нет столбца ${key}.`);
  const rows: Purchase[] = table.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`В строке ${index + 2} неверное число столбцов.`);
    const data = Object.fromEntries(headers.map((key, column) => [key, decode(cells[column] || '')]));
    if (['__proto__', 'prototype', 'constructor'].some(key => Object.hasOwn(data, key))) throw new Error('Недопустимое имя столбца.');
    const cents = moneyMinor(data.amount);
    if (cents === null) throw new Error(`В строке ${index + 2} неверная сумма.`);
    const source = ({ wb: 'wildberries', 'яндекс': 'yandex', 'яндекс маркет': 'yandex' } as Record<string, string>)[data.source!.toLowerCase()] || data.source!.toLowerCase();
    if (!['ozon', 'wildberries', 'yandex'].includes(source)) throw new Error(`В строке ${index + 2} неизвестный магазин.`);
    const currency = (data.currency || 'RUB').toUpperCase();
    if (currency !== 'RUB') throw new Error(`Строка ${index + 2}: импорт CSV поддерживает рубли. Для переноса всей базы используйте резервную копию.`);
    const type = ['refund', 'return', 'возврат', '1'].includes(data.type?.toLowerCase() || '') || cents < 0 ? 'refund' : 'purchase';
    const date = data.date!.replace(/^(\d{2})\.(\d{2})\.(\d{4})/, '$3-$2-$1');
    if (!/^\d{4}-\d{2}-\d{2}/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error(`В строке ${index + 2} неверная дата.`);
    const excluded = (data.excluded || '').toLowerCase();
    if (!['', '0', '1', 'false', 'true', 'да', 'нет'].includes(excluded)) throw new Error(`В строке ${index + 2} неверная отметка исключения.`);
    return { ...data, rowId: data.rowId || '', title: data.title!, date, source, type, amount: moneyDecimal(type === 'refund' ? -Math.abs(cents) : cents), currency, profile: data.profile || profile, excluded: ['1', 'true', 'да'].includes(excluded), import_origin: 'csv' };
  });
  return identifyRows(rows);
}

export function exportPurchasesCsv(rows: Purchase[]): string {
  const escape = (value: unknown, numeric = false) => {
    let text = String(value ?? '');
    if (!numeric && formulaPrefix.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return '\uFEFF' + columns.map(key => escape(key)).join(',') + '\r\n' + rows.map(row => columns.map(key => {
    if (key === 'amount') { const cents = moneyMinor(row.amount); return escape(cents === null ? row.amount : moneyDecimal(cents), cents !== null); }
    return escape(row[key]);
  }).join(',')).join('\r\n');
}
