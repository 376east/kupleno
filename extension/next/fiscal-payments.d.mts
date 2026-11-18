import type { FiscalPayment, Source, StoredFiscalPayment } from './model';

export function isFiscalPayment(payment: unknown): payment is FiscalPayment;
export function isFiscalPaymentList(value: unknown, stored: true): value is StoredFiscalPayment[];
export function isFiscalPaymentList(value: unknown, stored?: false): value is FiscalPayment[];
export function mergeFiscalPayments(existing: StoredFiscalPayment[], source: Source, incoming: FiscalPayment[]): StoredFiscalPayment[];
export function summarizeFiscalPayments(records: StoredFiscalPayment[], source: Source): { paid: number; refunded: number; advance: number; count: number; net: number } | undefined;
