import test from 'node:test';
import assert from 'node:assert/strict';
import { collectYandex } from './yandex-collect.ts';
import { mergeCollection, summarize } from '../domain.mjs';
const envelope = (data: unknown) => new Response(JSON.stringify({ results: [{ data }] }));
const orderList = (ids: number[]) => envelope({ result: 'list', collections: { orderConsolidationResult: { list: { ordersGroupsIds: ids, hasNext: false } } } });
const receipt = '<table><tr><td>1</td><td>Книга</td><td>1</td><td>100,00</td></tr><tr><td>ИТОГ</td><td>100,00</td></tr></table>';

test('initial HTML without pagination metadata still enumerates all API pages', async () => {
  const tokens: (string | undefined)[] = [];
  const result = await collectYandex({ fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('<a href="/my/order/123456">Заказ</a>');
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    const params = JSON.parse(String(init?.body)).params[0];
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) {
      tokens.push(params.pageToken);
      return envelope({ result: 'list', collections: { orderConsolidationResult: { list: params.pageToken
        ? { ordersGroupsIds: [345678], hasNext: false }
        : { ordersGroupsIds: [123456, 234567], pageToken: 'next', hasNext: true } } } });
    }
    return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: `https://check.yandex.ru/${params.orderId}`, createdAt: 1767225600 } } } });
  } });
  assert.deepEqual(tokens, [undefined, 'next']);
  assert.equal(result.stats.pages, 2);
  assert.equal(result.stats.orders, 3);
  assert.equal(result.rows.length, 3);
  assert.equal(result.stats.incomplete, false);
  assert.deepEqual(result.warnings, []);
});

test('Yandex loads four orders and four receipts concurrently', async () => {
  const active={orders:0,receipts:0}, peak={orders:0,receipts:0};
  const result=await collectYandex({fetch:async(input,init)=>{
    const url=new URL(String(input));
    if(url.pathname==='/my/orders') return new Response(Array.from({length:6},(_,i)=>`<a href="/my/order/${123456+i}">Order</a>`).join(''));
    if(url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList(Array.from({length:6},(_,i)=>123456+i));
    const kind=url.hostname==='check.yandex.ru'?'receipts':'orders';
    peak[kind]=Math.max(peak[kind],++active[kind]); await new Promise(resolve=>setTimeout(resolve,10)); active[kind]--;
    if(kind==='receipts') return new Response(receipt);
    const orderId=JSON.parse(String(init?.body)).params[0].orderId;
    return envelope({result:['r'],collections:{orderReceipt:{r:{id:orderId,fiscalUrl:`https://check.yandex.ru/${orderId}`,createdAt:1767225600}}}});
  }});
  assert.deepEqual(peak,{orders:4,receipts:4}); assert.equal(result.rows.length,6); assert.equal(result.stats.failedOrders,0);
});
test('Yandex resolver contracts, pagination, archive fallback and fiscal URLs', async () => {
  const queried: Array<{ orderId: number; archived: boolean }> = []; let pages = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    if (url.pathname === '/my/orders') return new Response('<a href="/my/order/123456">Заказ</a><script>{"pageToken":"next","hasNext":true}</script>');
    assert.equal(init?.method, 'POST'); const body = JSON.parse(String(init?.body));
    assert.equal(body.path, '/my/orders?filter=COMPLETED'); assert.ok(Array.isArray(body.params));
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) {
      pages++;
      assert.equal(body.params[0].pageToken, pages === 1 ? undefined : 'api-next');
      return envelope({ result: 'list', collections: { orderConsolidationResult: { list: pages === 1
        ? { ordersGroupsIds: [123456, 123457], pageToken: 'api-next', hasNext: true }
        : { ordersGroupsIds: [234567], pageToken: '', hasNext: false } } } });
    }
    assert.match(url.searchParams.get('r') || '', /resolveOrderReceiptsByOrderId/);
    const params = body.params[0]; queried.push(params);
    if (params.orderId === 234567 && !params.archived) return envelope({ result: [], collections: {} });
    return envelope({ result: ['fiscal'], collections: { orderReceipt: { fiscal: { id: `r${params.orderId}`, fiscalUrl: `https://check.yandex.ru/${params.orderId}`, createdAt: 1767225600, type: 'INCOME' } } } });
  };
  const result = await collectYandex({ fetch });
  assert.equal(pages, 2); assert.deepEqual(queried, [{ orderId: 123456, archived: false }, { orderId: 123457, archived: false }, { orderId: 234567, archived: false }, { orderId: 234567, archived: true }]);
  assert.equal(result.rows.length, 3); assert.equal(result.rows[0]?.amount, '100.00'); assert.equal(result.stats.receipts, 3); assert.deepEqual(result.warnings, []);
});
test('Yandex rejects unknown payload instead of reporting successful empty collection', async () => {
  await assert.rejects(collectYandex({ fetch: async () => new Response(JSON.stringify({ error: 'expired' })) }), /формат списка заказов/);
});

test('failed API pagination keeps HTML orders but cannot claim complete history', async () => {
  const result = await collectYandex({ fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('<a href="/my/order/123456">Заказ</a>');
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return new Response('', { status: 503 });
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/r', createdAt: 1767225600 } } } });
  } });
  assert.equal(result.rows.length, 1);
  assert.equal(result.stats.orders, 1);
  assert.equal(result.stats.pages, 1);
  assert.equal(result.stats.incomplete, true);
  assert.match(result.warnings.join(' '), /страницы заказов не прочитаны/);
});
test('Yandex reports partial receipt failure and retains parsed operations', async () => {
  const result = await collectYandex({ fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('<a href="/my/order/123456">Заказ</a>');
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
    if (url.pathname === '/api/resolve/') return envelope({ result: ['a','b'], collections: { orderReceipt: {
      a: { fiscalUrl: 'https://check.yandex.ru/a', createdAt: 1767225600 }, b: { fiscalUrl: 'https://check.yandex.ru/b', createdAt: 1767225600 },
    } } });
    return new Response(receipt, { status: url.pathname === '/b' ? 500 : 200 });
  } });
  assert.equal(result.rows.length, 1); assert.equal(result.stats.failedReceipts, 1); assert.equal(result.warnings.length, 1);
});

test('explicit final page stops even when token repeats; archived recovery is not a failed order', async () => {
  let pages=0;
  const result=await collectYandex({fetch:async (input, init) => {
    const url=new URL(String(input));
    if(url.pathname==='/my/orders') return new Response('<script>{"pageToken":"same","hasNext":true}</script>');
    if(url.hostname==='check.yandex.ru') return new Response(receipt);
    const body=JSON.parse(String(init?.body));
    if(url.searchParams.get('r')?.includes('resolveConsolidationOrders')) {
      pages++;
      return envelope({result:'list',collections:{orderConsolidationResult:{list:{ordersGroupsIds:[123456],pageToken:'same',hasNext:false}}}});
    }
    if(!body.params[0].archived) return new Response('',{status:404});
    return envelope({result:['r'],collections:{orderReceipt:{r:{fiscalUrl:'https://check.yandex.ru/r',createdAt:1767225600}}}});
  }});
  assert.equal(pages,1); assert.equal(result.stats.failedOrders,0); assert.equal(result.stats.incomplete,false); assert.deepEqual(result.warnings,[]);
  assert.equal(result.stats.responseErrorOrders, 0);
});

test('missing receipt URL does not discard subsequent receipts of the same order', async () => {
  const result = await collectYandex({ fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('<a href="/my/order/123456">Order</a>');
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    return envelope({ result: ['missing','valid'], collections: { orderReceipt: {
      missing: { id: 'missing' }, valid: { fiscalUrl: 'https://check.yandex.ru/valid', createdAt: 1767225600 }
    } } });
  } });
  assert.equal(result.rows.length, 1);
  assert.equal(result.stats.failedOrders, 1);
  assert.match(result.warnings.join(' '), /не предоставил ссылку/);
});

test('archived URL recovery clears only the matching receipt failure', async () => {
  for (const fiscalUrl of [undefined, 'https://example.com/private-check']) {
    for (const unrecovered of [false, true]) {
      const archivedRequests: boolean[] = [];
      const result = await collectYandex({ fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/my/orders') return new Response('');
        if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
        if (url.hostname === 'check.yandex.ru') return new Response(receipt);
        const { archived } = JSON.parse(String(init?.body)).params[0];
        archivedRequests.push(archived);
        return envelope({ result: archived ? ['r'] : ['r', ...(unrecovered ? ['missing'] : [])], collections: { orderReceipt: {
          r: { fiscalUrl: archived ? 'https://check.yandex.ru/recovered' : fiscalUrl, createdAt: 1767225600 },
          ...(unrecovered ? { missing: {} } : {}),
        } } });
      } });
      assert.deepEqual(archivedRequests, [false, true]);
      assert.equal(result.rows.length, 1);
      assert.equal(result.stats.receipts, 1);
      assert.equal(result.stats.failedOrders, unrecovered ? 1 : 0);
      assert.equal(result.stats.failedReceipts, 0);
      assert.equal(result.stats.missingUrlOrders, unrecovered ? 1 : 0);
      assert.equal(result.stats.unsafeUrlOrders, 0);
      assert.equal(result.stats.responseErrorOrders, 0);
      if (unrecovered) {
        assert.match(result.warnings.join(' '), /не предоставил ссылку/);
        assert.doesNotMatch(result.warnings.join(' '), /некорректную ссылку/);
      } else assert.deepEqual(result.warnings, []);
    }
  }
});

test('repeated cursor with hasNext true stops and marks history incomplete', async () => {
  let pages = 0;
  const result = await collectYandex({ fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('<script>{"pageToken":"same","hasNext":true}</script>');
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) {
      pages++; return envelope({ result: 'list', collections: { orderConsolidationResult: { list: { ordersGroupsIds: [123456], pageToken: 'same', hasNext: true } } } });
    }
    return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/r', createdAt: 1767225600 } } } });
  } });
  assert.equal(pages, 2); assert.equal(result.stats.incomplete, true); assert.match(result.warnings.join(' '), /повторилась страница/);
  assert.equal(result.rows.length, 1);
  assert.equal(result.stats.lastPageIds, 1);
  assert.equal(result.stats.lastPageNewIds, 0);
  assert.equal(result.stats.lastPageHasNextKnown, true);
  assert.equal(result.stats.lastPageHasNext, true);
  assert.equal(result.stats.lastPageCursorPresent, true);
  assert.equal(result.stats.lastPageCursorMatchesRequest, true);
  assert.equal(result.stats.repeatedCursor, true);
});

test('only a raw empty final list ends pagination when the store echoes its cursor', async () => {
  for (const { items, hasNext, incomplete } of [
    { items: [], hasNext: undefined, incomplete: false },
    { items: [], hasNext: false, incomplete: false },
    { items: [], hasNext: true, incomplete: true },
    { items: ['invalid-order-id'], hasNext: undefined, incomplete: true },
  ]) {
    let pages = 0;
    const result = await collectYandex({ fetch: async input => {
      const url = new URL(String(input));
      if (url.pathname === '/my/orders') return new Response('');
      if (url.hostname === 'check.yandex.ru') return new Response(receipt);
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) {
        pages++;
        return envelope({ result: 'list', collections: { orderConsolidationResult: { list: pages === 1
          ? { ordersGroupsIds: [123456], pageToken: 'private-cursor', hasNext: true }
          : { ordersGroupsIds: items, pageToken: 'private-cursor', ...(hasNext === undefined ? {} : { hasNext }) }
        } } });
      }
      return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/r', createdAt: 1767225600 } } } });
    } });
    assert.equal(pages, 2);
    assert.equal(result.rows.length, 1);
    assert.equal(result.stats.lastPageItems, items.length);
    assert.equal(result.stats.lastPageIds, 0);
    assert.equal(result.stats.lastPageNewIds, 0);
    assert.equal(result.stats.lastPageHasNextKnown, hasNext !== undefined);
    assert.equal(result.stats.lastPageCursorMatchesRequest, true);
    assert.equal(result.stats.incomplete, incomplete);
    assert.equal(result.stats.repeatedCursor, incomplete);
    if (!incomplete) assert.deepEqual(result.warnings, []);
    assert.ok(!JSON.stringify(result.stats).includes('private-cursor'));
  }
});

test('Yandex diagnostics distinguish resolver envelopes and malformed data without retaining their contents', async () => {
  const secret = 'private-response-secret';
  const cases: Array<{ payload: unknown; counters: Record<string, number> }> = [
    { payload: { error: { code: 'NOT_FOUND', message: secret } }, counters: { responseRootErrors: 2, resolverNotFoundErrors: 2 } },
    { payload: { results: [{ error: { code: 'FORBIDDEN', message: secret } }] }, counters: { responseEntryErrors: 2, resolverForbiddenErrors: 2 } },
    { payload: { results: [{ error: 'UNAUTHORIZED', message: secret }] }, counters: { responseEntryErrors: 2, resolverUnauthorizedErrors: 2 } },
    { payload: { error: { code: 'TOO_MANY_REQUESTS', details: secret } }, counters: { responseRootErrors: 2, resolverRateLimitErrors: 2 } },
    { payload: { error: { code: secret, message: secret } }, counters: { responseRootErrors: 2, resolverOtherErrors: 2 } },
    { payload: { error: { code: '__proto__', message: secret } }, counters: { responseRootErrors: 2, resolverOtherErrors: 2 } },
    { payload: { results: [{ data: {} }] }, counters: { responseEmptyData: 2 } },
    { payload: {}, counters: { responseMalformedData: 2, responseRootEmpty: 2, responseDataMissing: 2, responseResultsMissing: 2 } },
    { payload: null, counters: { responseMalformedData: 2, responseRootNull: 2, responseDataMissing: 2 } },
    { payload: [secret], counters: { responseMalformedData: 2, responseRootArray: 2, responseDataMissing: 2 } },
    { payload: secret, counters: { responseMalformedData: 2, responseRootPrimitive: 2, responseDataMissing: 2 } },
    { payload: { errors: [{ message: secret }] }, counters: { responseMalformedData: 2, responseRootErrorsField: 2, responseDataMissing: 2 } },
    { payload: { results: [] }, counters: { responseMalformedData: 2, responseDataMissing: 2, responseResultsEmpty: 2 } },
    { payload: { results: null }, counters: { responseMalformedData: 2, responseDataMissing: 2, responseResultsMalformed: 2 } },
    { payload: { results: [{}] }, counters: { responseMalformedData: 2, responseDataMissing: 2 } },
    { payload: { results: [{ data: null }] }, counters: { responseMalformedData: 2, responseDataNull: 2 } },
    { payload: { results: [{ data: [secret] }] }, counters: { responseMalformedData: 2, responseDataArray: 2 } },
    { payload: { data: null }, counters: { responseMalformedData: 2, responseDataNull: 2, responseResultsMissing: 2 } },
    { payload: { results: [{ data: secret }] }, counters: { responseMalformedData: 2, responseDataPrimitive: 2 } },
    { payload: { results: [{ data: false }] }, counters: { responseMalformedData: 2, responseDataPrimitive: 2 } },
    { payload: { results: [{ data: { result: secret } }] }, counters: { responseMalformedResult: 2 } },
  ];
  for (const { payload, counters } of cases) {
    const result = await collectYandex({ fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/my/orders') return new Response('');
      if (url.hostname === 'check.yandex.ru') return new Response(receipt);
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456, 234567, 345678]);
      const { orderId } = JSON.parse(String(init?.body)).params[0];
      if (orderId === 234567) return new Response(JSON.stringify(payload));
      if (orderId === 345678) return envelope({ result: [], collections: {} });
      return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/r', createdAt: 1767225600 } } } });
    } });
    for (const [key, value] of Object.entries(counters)) assert.equal(result.stats[key], value, key);
    assert.equal(result.stats.responseErrorOrders, 1);
    assert.equal(result.stats.noReceiptOrders, 1);
    assert.equal(result.stats.missingUrlOrders, 0);
    assert.equal(result.stats.unsafeUrlOrders, 0);
    assert.equal(result.stats.failedOrders, 1);
    assert.equal(result.stats.lastPageIds, 3);
    assert.equal(result.stats.lastPageNewIds, 3);
    assert.equal(result.stats.lastPageHasNextKnown, true);
    assert.equal(result.stats.lastPageHasNext, false);
    assert.equal(result.stats.lastPageCursorPresent, false);
    assert.equal(result.stats.lastPageCursorMatchesRequest, false);
    assert.equal(result.stats.repeatedCursor, false);
    assert.ok(Object.values(result.stats).every(value => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))));
    assert.ok(!JSON.stringify({ stats: result.stats, warnings: result.warnings }).includes(secret));
  }
});

test('unsafe or malformed receipt URL does not discard valid neighbours', async () => {
  for (const fiscalUrl of ['not a URL', 'https://example.com/private-check']) {
    const result = await collectYandex({ fetch: async input => {
      const url = new URL(String(input));
      if (url.pathname === '/my/orders') return new Response('<a href="/my/order/123456">Order</a>');
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
      if (url.hostname === 'check.yandex.ru') return new Response(receipt);
      return envelope({ result: ['bad', 'valid'], collections: { orderReceipt: {
        bad: { fiscalUrl }, valid: { fiscalUrl: 'https://check.yandex.ru/valid', createdAt: 1767225600 }
      } } });
    } });
    assert.equal(result.rows.length, 1);
    assert.equal(result.stats.failedOrders, 1);
    assert.equal(result.stats.unsafeUrlOrders, 1);
    assert.equal(result.stats.missingUrlOrders, 0);
    assert.ok(result.warnings.length > 0);
    assert.ok(!result.warnings.join(' ').includes('private-check'));
  }
});

test('API page promising more orders without a token is explicitly incomplete', async () => {
  const result = await collectYandex({ fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) {
      return envelope({ result: 'list', collections: { orderConsolidationResult: { list: { ordersGroupsIds: [123456], hasNext: true } } } });
    }
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/r', createdAt: 1767225600 } } } });
  } });
  assert.equal(result.rows.length, 1);
  assert.equal(result.stats.incomplete, true);
  assert.match(result.warnings.join(' '), /следующей страницы/);
});

test('Yandex passes raw receipt pairs to persisted reconciliation across batches', async () => {
  const batch = (ids: string[]) => collectYandex({ fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('<a href="/my/order/123456">Заказ</a>');
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
    if (url.pathname === '/api/resolve/') return envelope({ result: ids, collections: { orderReceipt: Object.fromEntries(ids.map(id => [id, {
      id, fiscalUrl: `https://check.yandex.ru/${id}`, createdAt: 1767225600, type: 'INCOME'
    }])) } });
    const kind = url.pathname === '/pre' ? 'ПРЕДОПЛАТА' : 'ПОЛНЫЙ РАСЧЕТ';
    return new Response(`<table><tr><td>1.</td><td>Товар Признак способа расчета: ${kind}</td><td>100,00</td></tr><tr><td>ИТОГ</td><td>100,00</td></tr></table>`);
  } });
  const pair = await batch(['pre', 'final']);
  assert.equal(pair.rows.length, 2);
  assert.equal(pair.stats.removed, 0);
  const first = await batch(['pre']), second = await batch(['final']);
  const merged = mergeCollection(first.rows, second.rows, { source: 'yandex', processedReceipts: second.processedReceipts });
  assert.equal(merged.length, 1);
  assert.equal(summarize(merged).net, 10000);
  assert.equal(mergeCollection(merged, pair.rows, { source: 'yandex', processedReceipts: pair.processedReceipts }).length, 1);
});

test('unknown root shape captures fixed fields once and ignores changing contents and collection counts', async () => {
  const secret = 'private-shape-secret';
  for (const different of [false, true]) {
    const result = await collectYandex({ fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/my/orders') return new Response('');
      if (url.hostname === 'check.yandex.ru') return new Response(receipt);
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456, 234567]);
      const { orderId, archived } = JSON.parse(String(init?.body)).params[0];
      if (orderId === 123456) return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/r', createdAt: 1767225600 } } } });
      return new Response(JSON.stringify({ result: archived ? [secret, 'another'] : [secret],
        collections: { orderReceipt: archived ? { [secret]: {}, another: {} } : { [secret]: {} } },
        type: archived ? 'changed-value' : secret, [secret]: secret, ...(archived && different ? { status: secret } : {}) }));
    } });
    assert.equal(result.stats.responseShapeCaptured, 1);
    assert.equal(result.stats.responseShapeKeyMask, 7);
    assert.equal(result.stats.responseShapeKeyCount, 4);
    assert.equal(result.stats.responseShapeResultType, 2);
    assert.equal(result.stats.responseShapeCollectionsType, 3);
    assert.equal(result.stats.responseShapeOrderReceiptType, 3);
    assert.equal(result.stats.responseShapeResultCount, 1);
    assert.equal(result.stats.responseShapeReceiptCount, 1);
    assert.equal(result.stats.responseShapeDifferent, different ? 1 : 0);
    assert.equal(result.stats.failedOrders, 1);
    assert.ok(Object.values(result.stats).every(value => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))));
    assert.ok(!JSON.stringify({ stats: result.stats, warnings: result.warnings }).includes(secret));
  }
});

test('explicit challenge stops order pagination without retrying another resolver or exposing its URL', async () => {
  const secret = 'private-challenge-secret';
  for (const payload of [
    { type: 'captcha' }, { status: 'CAPTCHA_REQUIRED' }, { type: 'SHOW_CAPTCHA' },
    { captcha: true }, { captcha: { url: secret } }, { captcha: secret },
    { status: 'redirect', url: `https://yandex.ru/showcaptcha?secret=${secret}` },
    { redirect: `https://market.yandex.com/CAPTCHA/check?secret=${secret}` },
    { url: `/showcaptcha?secret=${secret}` }, { redirect: `/checkcaptcha/verify?secret=${secret}` },
  ]) {
    let calls = 0;
    await assert.rejects(collectYandex({ fetch: async input => {
      if (new URL(String(input)).pathname === '/my/orders') return new Response('<a href="/my/order/123456">Order</a>');
      calls++;
      return new Response(JSON.stringify(payload));
    } }), error => {
      assert.match((error as Error).message, /откройте магазин и пройдите проверку/);
      assert.ok(!(error as Error).message.includes(secret));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('challenge stops queued metadata work after at most four in-flight requests', async () => {
  let calls = 0;
  await assert.rejects(collectYandex({ fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList(Array.from({ length: 20 }, (_, index) => 123456 + index));
    calls++;
    return new Response(JSON.stringify({ captcha: true }));
  } }), /пройдите проверку/);
  assert.ok(calls > 0 && calls <= 4);
});

test('metadata challenge preserves discovered receipts and marks unchecked orders incomplete', async () => {
  const result = await collectYandex({ fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456, 234567, 345678, 456789, 567890]);
    const { orderId } = JSON.parse(String(init?.body)).params[0];
    if (orderId === 123456) return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/r', createdAt: 1767225600 } } } });
    return new Response(JSON.stringify({ status: 'CAPTCHA_REQUIRED', url: 'private-challenge-secret' }));
  } });
  assert.equal(result.rows.length, 1);
  assert.equal(result.stats.incomplete, true);
  assert.equal(result.stats.uncheckedOrders, 4);
  assert.equal(result.stats.challengeResponses, 3);
  assert.match(result.warnings.join(' '), /пройдите проверку/);
  assert.ok(!JSON.stringify({ stats: result.stats, warnings: result.warnings }).includes('private-challenge-secret'));
});

test('empty captcha metadata and unrelated redirect URLs do not block valid envelopes', async () => {
  for (const metadata of [
    { captcha: false }, { captcha: null }, { captcha: {} }, { captcha: '' },
    { status: 'redirect', url: 'https://check.yandex.ru/receipt' },
    { status: 'redirect', url: '/receipt' },
    { url: 'https://yandex.ru.example.com/showcaptcha' }, { redirect: 'https://user@yandex.ru/showcaptcha' },
  ]) {
    const result = await collectYandex({ fetch: async input => {
      const url = new URL(String(input));
      if (url.pathname === '/my/orders') return new Response('');
      if (url.hostname === 'check.yandex.ru') return new Response(receipt);
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
      return new Response(JSON.stringify({ ...metadata, results: [{ data: { result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/r', createdAt: 1767225600 } } } } }] }));
    } });
    assert.equal(result.rows.length, 1);
    assert.equal(result.stats.challengeResponses, 0);
    assert.equal(result.stats.responseShapeCaptured, 0);
    assert.deepEqual(result.warnings, []);
  }
});

test('concurrent challenge does not swallow cancellation or an unrelated progress failure', async () => {
  for (const { cancel, failure } of [
    { cancel: false, failure: new Error('progress failed') },
    { cancel: false, failure: 0 }, { cancel: false, failure: undefined },
    { cancel: true, failure: new Error('caller cancelled') },
  ]) {
    const controller = new AbortController();
    await assert.rejects(collectYandex({ signal: controller.signal,
      onProgress: progress => { if (!cancel && progress.message.includes('проверено')) throw failure; },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/my/orders') return new Response('');
        if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456, 234567, 345678, 456789]);
        const { orderId } = JSON.parse(String(init?.body)).params[0];
        if (orderId === 123456) {
          if (cancel) controller.abort(failure);
          return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/r', createdAt: 1767225600 } } } });
        }
        return new Response(JSON.stringify({ type: 'captcha' }));
      },
    }), error => error === failure);
  }
});
