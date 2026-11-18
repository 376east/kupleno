export type Source = 'ozon' | 'wildberries' | 'yandex';
export interface FiscalPayment { id: string; date: string; paid: number; advance: number }
export interface StoredFiscalPayment extends FiscalPayment { source: Source }
export interface Purchase {
  rowId: string; date: string; source: string; title: string;
  amount: string | number; currency?: string; type?: string;
  profile?: string; category?: string; note?: string; excluded?: boolean;
  receipt_url?: string; marketplace_id?: string; parse_quality?: string;
  [key: string]: unknown;
}
export interface Profile { id: string; name: string }
export interface Settings {
  profiles?: Profile[]; activeProfile?: string; dataProfile?: string;
  overrides?: Record<string, Partial<Purchase>>;
  [key: string]: unknown;
}
export interface State { rows: Purchase[]; settings: Settings; metadata: Record<string, unknown>; fiscalPayments?: StoredFiscalPayment[]; [key: string]: unknown }
export interface Envelope { state: State; revision: number; epoch: number }
export interface Expected { expectedRevision: number; expectedEpoch: number }
export interface Snapshot { id: string; createdAt: string; rows: number; revision: number }
