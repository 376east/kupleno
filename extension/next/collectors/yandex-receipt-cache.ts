export const YANDEX_RECEIPT_CACHE_NAME = 'kupleno-yandex-receipts-v1';
const ttl = 7 * 24 * 60 * 60 * 1000;
const maxEntryBytes = 8 * 1024 * 1024, maxBytes = 64 * 1024 * 1024, maxEntries = 1000;
const keyPrefix = 'https://kupleno-yandex-receipts.invalid/v1/';
type Entry = { fetchedAt: number; bytes: number };
export interface YandexReceiptCacheSession {
  has(url: string): Promise<boolean>;
  read(url: string): Promise<string | undefined>;
  write(url: string, html: string): Promise<void>;
  remove(url: string): Promise<void>;
}

/** Derived RAW fiscal HTML only. The offscreen document owns this one manager. */
export class YandexReceiptCache {
  private storage: CacheStorage | undefined;
  private cache: Cache | undefined;
  private index: Map<string, Entry> | undefined;
  private bytes = 0;
  private generation = 0;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(storage?: CacheStorage) { this.storage = storage || globalThis.caches; }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const task = this.writes.then(run);
    this.writes = task.catch(() => { this.cache = undefined; this.index = undefined; this.bytes = 0; });
    return task;
  }

  private async key(url: string): Promise<string> {
    const parsed = new URL(url);
    if (url.length > 16000 || /[\u0000-\u0020\\]/.test(url) || parsed.origin !== 'https://check.yandex.ru' || parsed.username || parsed.password) throw new Error('Некорректная ссылка фискального кэша.');
    // Request normalizes URLs; hash the literal provider string instead of aliasing its variants.
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
    return keyPrefix + [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  private async ready() {
    if (this.index && this.cache) return;
    if (!this.storage) throw new Error('Фискальный кэш недоступен.');
    this.cache = await this.storage.open(YANDEX_RECEIPT_CACHE_NAME);
    const keys = await this.cache.keys();
    if (keys.length > maxEntries) {
      await this.storage.delete(YANDEX_RECEIPT_CACHE_NAME);
      this.cache = await this.storage.open(YANDEX_RECEIPT_CACHE_NAME);
      this.index = new Map(); this.bytes = 0; return;
    }
    const index = new Map<string, Entry>();
    let bytes = 0;
    for (const key of keys) {
      const response = await this.cache.match(key);
      const fetchedAt = Number(response?.headers.get('x-kupleno-fetched-at'));
      const size = Number(response?.headers.get('x-kupleno-bytes'));
      if (!key.url.startsWith(keyPrefix) || !/^[a-f0-9]{64}$/.test(key.url.slice(keyPrefix.length)) || !Number.isSafeInteger(fetchedAt) || fetchedAt <= 0 || fetchedAt > Date.now() || Date.now() - fetchedAt >= ttl || !Number.isSafeInteger(size) || size <= 0 || size > maxEntryBytes || bytes + size > maxBytes) {
        await this.cache.delete(key); continue;
      }
      index.set(key.url, { fetchedAt, bytes: size }); bytes += size;
    }
    this.index = new Map([...index].sort((a,b) => a[1].fetchedAt - b[1].fetchedAt));
    this.bytes = bytes;
  }

  private async removeKey(key: string) {
    await this.cache!.delete(key);
    const entry = this.index!.get(key);
    if (entry) { this.bytes -= entry.bytes; this.index!.delete(key); }
  }

  begin(options: { signal?: AbortSignal; bypass?: boolean } = {}): YandexReceiptCacheSession {
    const generation = this.generation;
    const current = () => { options.signal?.throwIfAborted(); return generation === this.generation; };
    const run = async <T>(url: string, stale: T, action: (key: string) => Promise<T>) => {
      options.signal?.throwIfAborted();
      const key = await this.key(url);
      return this.serialized(async () => {
        if (!current()) return stale;
        await this.ready();
        if (!current()) return stale;
        const entry = this.index!.get(key);
        if (entry && (entry.fetchedAt > Date.now() || Date.now() - entry.fetchedAt >= ttl)) await this.removeKey(key);
        if (!current()) return stale;
        return action(key);
      });
    };
    return {
      has: url => run(url, false, async key => !options.bypass && this.index!.has(key)),
      read: async url => {
        const snapshot = await run<{ key: string; entry: Entry; response: Response } | undefined>(url, undefined, async key => {
          if (options.bypass) { await this.removeKey(key); return undefined; }
          const entry = this.index!.get(key);
          if (!entry) return undefined;
          const response = await this.cache!.match(key);
          if (!response?.body) { await this.removeKey(key); return undefined; }
          return { key, entry, response };
        });
        if (!snapshot || !current()) return undefined;
        const removeSnapshot = () => run<void>(url, undefined, async key => { if (this.index!.get(key) === snapshot.entry) await this.removeKey(key); });
        // Cache.match returned an immutable response snapshot; consume its body outside the mutation queue.
        const reader = snapshot.response.body!.getReader(), chunks: Uint8Array[] = [];
        const abort = () => { void reader.cancel().catch(() => {}); };
        options.signal?.addEventListener('abort', abort, { once: true });
        let bytes = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (!current()) { await reader.cancel(); return undefined; }
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maxEntryBytes || bytes > snapshot.entry.bytes) { await reader.cancel(); await removeSnapshot(); return undefined; }
            chunks.push(chunk.value);
          }
        } finally { options.signal?.removeEventListener('abort', abort); reader.releaseLock(); }
        if (bytes !== snapshot.entry.bytes) { await removeSnapshot(); return undefined; }
        const body = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        return new TextDecoder('utf-8', { fatal: true }).decode(body);
      },
      write: (url, html) => run<void>(url, undefined, async key => {
        if (typeof html !== 'string') throw new Error('Некорректный фискальный кэш.');
        const bytes = new TextEncoder().encode(html).byteLength;
        if (!bytes || bytes > maxEntryBytes) throw new Error('Фискальный кэш превышает допустимый размер.');
        await this.removeKey(key);
        while (this.index!.size >= maxEntries || this.bytes + bytes > maxBytes) await this.removeKey(this.index!.keys().next().value!);
        if (!current()) return;
        const fetchedAt = Date.now();
        await this.cache!.put(key, new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-kupleno-fetched-at': String(fetchedAt), 'x-kupleno-bytes': String(bytes) } }));
        this.index!.set(key, { fetchedAt, bytes }); this.bytes += bytes;
        current();
      }),
      remove: url => run<void>(url, undefined, key => this.removeKey(key)),
    };
  }

  clear(): Promise<void> {
    this.generation++;
    return this.serialized(async () => {
      if (!this.storage) throw new Error('Фискальный кэш недоступен.');
      try { await this.storage.delete(YANDEX_RECEIPT_CACHE_NAME); }
      finally { this.cache = undefined; this.index = undefined; this.bytes = 0; }
    });
  }
}
