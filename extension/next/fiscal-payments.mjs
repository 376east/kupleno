import { SOURCES } from './domain.mjs';

const MAX_PAYMENTS = 100000;
const isSignedMinor = value => Number.isSafeInteger(value);

export function isFiscalPayment(payment) {
  return !!payment && typeof payment === 'object' && !Array.isArray(payment)
    && typeof payment.id === 'string' && /^\d{1,20}:\d{1,20}:\d{1,20}$/.test(payment.id)
    && typeof payment.date === 'string' && /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?$/.test(payment.date)
    && isSignedMinor(payment.paid) && isSignedMinor(payment.advance)
    && isSignedMinor(payment.paid + payment.advance)
    && (payment.paid >= 0 && payment.advance >= 0 || payment.paid <= 0 && payment.advance <= 0);
}

export function isFiscalPaymentList(value, stored = false) {
  return Array.isArray(value) && value.length <= MAX_PAYMENTS && value.every(payment =>
    isFiscalPayment(payment) && (!stored || Object.hasOwn(SOURCES, payment.source)));
}

export function mergeFiscalPayments(existing, source, incoming) {
  const key = payment => `${payment.source}:${payment.id}`;
  const records = new Map();
  for (const record of [...existing, ...incoming.map(payment => ({ ...payment, source }))]) {
    // An incomplete run or a second listing of the same fiscal document cannot remove its payment.
    if (!records.has(key(record))) records.set(key(record), record);
  }
  if (records.size > MAX_PAYMENTS) throw new RangeError('Слишком много фискальных чеков.');
  return [...records.values()];
}

export function summarizeFiscalPayments(records, source) {
  let paid = 0, refunded = 0, advance = 0, count = 0;
  const seen = new Set();
  for (const record of records) {
    if (record.source !== source || seen.has(record.id)) continue;
    seen.add(record.id);
    count++;
    if (record.paid < 0) refunded -= record.paid;
    else paid += record.paid;
    advance += record.advance;
    if (![paid, refunded, advance].every(isSignedMinor)) return undefined;
  }
  return { paid, refunded, advance, count, net: paid - refunded };
}
