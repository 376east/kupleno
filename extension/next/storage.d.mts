import type { State, Envelope, Expected, Snapshot } from './model';
export function createStore(options?: { indexedDB?: IDBFactory; dbName?: string }): {
  read(): Promise<Envelope | null>;
  write(state: State, expected: Expected): Promise<Envelope>;
  history(): Promise<Snapshot[]>;
  restore(id: string, expected: Expected): Promise<Envelope>;
  clear(expected: Expected): Promise<Envelope>;
  readLegacy(): Promise<Envelope | null>;
};
export function parseBackup(text: string): { state: State; version: number };
export function serializeBackup(state: State): string;
