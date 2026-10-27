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
