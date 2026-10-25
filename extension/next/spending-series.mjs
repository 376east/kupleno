import { breakdown } from './domain.mjs';

export function spendingSeries(rows) {
  const valid = rows.filter(row => {
    const day = String(row.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    const date = new Date(`${day}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
  });
  let total = 0;
  const points = breakdown(valid, row => row.date.slice(0, 10)).sort((a, b) => a.key.localeCompare(b.key)).map(day => {
    total += day.amount;
    if (!Number.isSafeInteger(total)) throw new RangeError('Итог превышает допустимую сумму.');
    return { date: day.key, amount: day.amount, total, count: day.count };
  });
  return { points, undated: rows.length - valid.length };
}
