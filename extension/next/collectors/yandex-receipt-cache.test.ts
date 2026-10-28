import test from 'node:test';
import assert from 'node:assert/strict';
import { YandexReceiptCache, YANDEX_RECEIPT_CACHE_NAME } from './yandex-receipt-cache.ts';

type Stored = { html: string; headers: Headers };
function fixture() {
  const stores = new Map<string, Map<string, Stored>>();
  const state = { matches: 0, beforePut: undefined as (() => Promise<void>) | undefined, afterPut: undefined as (() => Promise<void>) | undefined, body: undefined as ((entry: Stored) => Response) | undefined };
  const storage = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name)!;
      return {
        keys: async () => [...entries.keys()].map(key => new Request(key)),
        match: async (input: Request | string) => {
          state.matches++;
          const entry = entries.get(typeof input === 'string' ? input : input.url);
          return entry && (state.body ? state.body(entry) : new Response(entry.html, { headers: entry.headers }));
        },
        put: async (input: Request | string, response: Response) => {
          await state.beforePut?.();
          entries.set(typeof input === 'string' ? input : input.url, { html: await response.text(), headers: new Headers(response.headers) });
          await state.afterPut?.();
        },
        delete: async (input: Request | string) => entries.delete(typeof input === 'string' ? input : input.url),
      };
    },
    delete: async (name: string) => stores.delete(name),
  } as unknown as CacheStorage;
  return { storage, stores, state };
}
const url = (n: number) => `https://check.yandex.ru/receipt?synthetic=${n}`;

test('RAW cache roundtrip hashes literal URLs and preserves other cache namespaces', async () => {
  const f = fixture(), manager = new YandexReceiptCache(f.storage), session = manager.begin();
  const html = '<html>Предоплата &amp; raw</html>';
  await session.write(url(1), html);
  assert.equal(await session.has(url(1)), true);
  assert.equal(await session.read(url(1)), html);
  assert.equal(await session.has(url(1) + '#different-literal'), false);
  assert.equal(await session.has('https://CHECK.yandex.ru/receipt?synthetic=1'), false);
  const keys = [...f.stores.get(YANDEX_RECEIPT_CACHE_NAME)!.keys()];
  assert.ok(keys.every(key => /^https:\/\/kupleno-yandex-receipts\.invalid\/v1\/[a-f0-9]{64}$/.test(key)));
  assert.ok(!JSON.stringify(keys).includes('synthetic'));
  const foreign = await f.storage.open('other-source');
  await foreign.put('https://example.invalid/other', new Response('unchanged'));
  await manager.clear();
  assert.equal(f.stores.has(YANDEX_RECEIPT_CACHE_NAME), false);
  assert.equal(await (await foreign.match('https://example.invalid/other'))?.text(), 'unchanged');
});

test('TTL, future timestamps and malformed byte metadata become misses', async () => {
  const original = Date.now;
  let now = 1000000;
  Date.now = () => now;
  try {
    const f = fixture(), manager = new YandexReceiptCache(f.storage), session = manager.begin();
    await session.write(url(1), 'raw');
    now += 7 * 24 * 60 * 60 * 1000;
    assert.equal(await session.read(url(1)), undefined);
    await session.write(url(2), 'raw');
    now--;
    assert.equal(await new YandexReceiptCache(f.storage).begin().has(url(2)), false);
    await session.write(url(3), 'raw');
    const entry = [...f.stores.get(YANDEX_RECEIPT_CACHE_NAME)!.values()][0]!;
    entry.headers.set('x-kupleno-bytes', 'invalid');
    assert.equal(await new YandexReceiptCache(f.storage).begin().read(url(3)), undefined);
  } finally { Date.now = original; }
});

test('byte and FIFO limits serialize concurrent writes without scanning bodies on each write', async () => {
  const f = fixture(), manager = new YandexReceiptCache(f.storage), session = manager.begin();
  let active = 0, peak = 0;
  f.state.beforePut = async () => { peak = Math.max(peak, ++active); await Promise.resolve(); active--; };
  const html = 'x'.repeat(8 * 1024 * 1024);
  for (let index = 0; index < 8; index++) await session.write(url(index), html);
  await Promise.all([session.write(url(8), html), session.write(url(9), html)]);
  assert.equal(peak, 1);
  assert.equal(await session.has(url(0)), false);
  assert.equal(await session.has(url(1)), false);
  assert.equal(f.stores.get(YANDEX_RECEIPT_CACHE_NAME)!.size, 8);
  assert.equal(f.state.matches, 0, 'Existing in-memory header index does not rescan response bodies');
  await assert.rejects(session.write(url(10), 'я'.repeat(4 * 1024 * 1024 + 1)), /размер/);
  assert.equal(await session.has(url(10)), false);
});

test('1000-entry bound evicts FIFO even when all entries fit the byte budget', async () => {
  const f = fixture(), session = new YandexReceiptCache(f.storage).begin();
  for (let index = 0; index < 1001; index++) await session.write(url(index), 'raw');
  assert.equal(f.stores.get(YANDEX_RECEIPT_CACHE_NAME)!.size, 1000);
  assert.equal(await session.has(url(0)), false);
  assert.equal(await session.has(url(1000)), true);
  assert.equal(f.state.matches, 0);
});

test('clear invalidates queued and late session writes before deletion settles', async () => {
  const f = fixture(), manager = new YandexReceiptCache(f.storage), old = manager.begin();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.state.beforePut = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
  const writing = old.write(url(1), 'raw');
  await started;
  const clearing = manager.clear(), late = old.write(url(2), 'late');
  release();
  await Promise.all([writing, clearing, late]);
  assert.equal(await old.has(url(1)), false);
  assert.equal(await old.read(url(1)), undefined);
  assert.equal(f.stores.has(YANDEX_RECEIPT_CACHE_NAME), false);
  f.state.beforePut = undefined;
  const fresh = manager.begin(); await fresh.write(url(3), 'fresh');
  assert.equal(await fresh.read(url(3)), 'fresh');
});

test('bypass removes the old exact entry and accepts a later valid refresh', async () => {
  const f = fixture(), manager = new YandexReceiptCache(f.storage);
  await manager.begin().write(url(1), 'old');
  const forced = manager.begin({ bypass: true });
  assert.equal(await forced.has(url(1)), false);
  assert.equal(await forced.read(url(1)), undefined);
  assert.equal(await manager.begin().read(url(1)), undefined);
  await forced.write(url(1), 'fresh');
  assert.equal(await manager.begin().read(url(1)), 'fresh');
});

test('warm body reads remain parallel and cancellation preserves the original reason', async () => {
  const f = fixture(), manager = new YandexReceiptCache(f.storage), session = manager.begin();
  for (let index = 0; index < 4; index++) await session.write(url(index), 'raw');
  let active = 0, peak = 0;
  const gate = new Promise<void>(resolve => setTimeout(resolve, 30));
  f.state.body = entry => new Response(new ReadableStream({ async start(controller) {
    peak = Math.max(peak, ++active); await gate; active--;
    controller.enqueue(new TextEncoder().encode(entry.html)); controller.close();
  } }), { headers: entry.headers });
  assert.deepEqual(await Promise.all([0,1,2,3].map(index => session.read(url(index)))), ['raw','raw','raw','raw']);
  assert.equal(peak, 4);
  const controller = new AbortController(); controller.abort(0);
  await assert.rejects(manager.begin({ signal: controller.signal }).read(url(0)), error => error === 0);
  assert.equal(await session.read(url(0)), 'raw');
});

test('cache API failures reject and a failed mutation does not poison the queue', async () => {
  const f = fixture(), manager = new YandexReceiptCache(f.storage), session = manager.begin();
  f.state.beforePut = async () => { throw new Error('synthetic unavailable'); };
  await assert.rejects(session.write(url(1), 'raw'), /unavailable/);
  f.state.beforePut = undefined;
  await session.write(url(1), 'raw');
  assert.equal(await session.read(url(1)), 'raw');
});


test('an uncertain failed cache mutation rebuilds its header index before reuse', async () => {
  const f = fixture(), manager = new YandexReceiptCache(f.storage), session = manager.begin();
  f.state.afterPut = async () => { throw new DOMException('Synthetic uncertain storage write', 'AbortError'); };
  await assert.rejects(session.write(url(1), 'raw'), error => error instanceof DOMException && error.name === 'AbortError');
  f.state.afterPut = undefined;
  assert.equal(await session.has(url(1)), true);
  assert.equal(await session.read(url(1)), 'raw');
  await session.write(url(2), 'second');
  assert.equal(await session.read(url(2)), 'second');
});
