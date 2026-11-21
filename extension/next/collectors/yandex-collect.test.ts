import test from 'node:test';
import assert from 'node:assert/strict';
import { collectYandex } from './yandex-collect.ts';
import { mergeCollection, summarize } from '../domain.mjs';
import type { YandexOrdersDomResult } from '../collection';
import type { YandexReceiptCacheSession } from './yandex-receipt-cache.ts';
const envelope = (data: unknown) => new Response(JSON.stringify({ results: [{ data }] }));
const batchEnvelope = (data: unknown[]) => new Response(JSON.stringify({ results: data.map(data => ({ data })) }));
const orderList = (ids: number[]) => envelope({ result: 'list', collections: { orderConsolidationResult: { list: { ordersGroupsIds: ids, hasNext: false } } } });
const receipt = '<table><tr><td>1</td><td>Книга</td><td>1</td><td>100,00</td></tr><tr><td>ИТОГ</td><td>100,00</td></tr></table>';
const domResult = (change: Partial<YandexOrdersDomResult> = {}): YandexOrdersDomResult => ({ orderIds: [], clicked: false, hasMore: false, blocked: false, ambiguous: false, limit: false, fatal: false, ...change });

test('DOM fallback waits through a hidden load-more button, unions seed IDs and keeps incompleteness explicit', async () => {
  let steps = 0;
  const result = await collectYandex({ context: { initialOrders: { orderIds: ['123456'], pageToken: 'cursor' } },
    readOrdersDom: async () => {
      steps++;
      if (steps === 1) return domResult({ orderIds: ['123456', '234567'], clicked: true, hasMore: true });
      if (steps <= 4) return domResult({ orderIds: ['123456', '234567'] });
      return domResult({ orderIds: ['123456', '234567', '345678'] });
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'check.yandex.ru') return new Response(receipt);
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return new Response(JSON.stringify({ results: [{ error: { code: 'NOT_FOUND' } }] }));
      const { orderId } = JSON.parse(String(init?.body)).params[0];
      return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: `https://check.yandex.ru/${orderId}`, createdAt: 1767225600 } } } });
    },
  });
  assert.equal(steps, 11);
  assert.equal(result.rows.length, 3);
  assert.equal(result.stats.domFallbackOrdersAdded, 2);
  assert.equal(result.stats.domFallbackClicks, 1);
  assert.equal(result.stats.incomplete, true);
  assert.match(result.warnings.join(' '), /следующие страницы заказов не прочитаны/);
});

test('fatal, ambiguous and limited DOM fallback stops after one read-only step', async () => {
  for (const stopped of [{ blocked: true, fatal: true }, { ambiguous: true }, { limit: true }]) {
    let steps = 0;
    const result = await collectYandex({ context: { initialOrders: { orderIds: ['123456'], pageToken: '' } }, readOrdersDom: async () => { steps++; return domResult(stopped); }, fetch: async input => {
      const url = new URL(String(input));
      if (url.hostname === 'check.yandex.ru') return new Response(receipt);
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return envelope({ unknown: true });
      return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/r', createdAt: 1767225600 } } } });
    } });
    assert.equal(steps, 1);
    assert.equal(result.rows.length, 1);
    assert.equal(result.stats.incomplete, true);
  }
});

test('cancellation during DOM fallback preserves its original reason', async () => {
  const controller = new AbortController(), reason = new Error('cancel DOM');
  let steps = 0;
  await assert.rejects(collectYandex({ signal: controller.signal, context: { initialOrders: { orderIds: ['123456'], pageToken: '' } }, readOrdersDom: async () => { steps++; controller.abort(reason); return domResult({ hasMore: true, clicked: true }); }, fetch: async () => envelope({ unknown: true }) }), error => error === reason);
  assert.equal(steps, 1);
});

test('missing URL reasons and unresolved references describe only unrecovered receipt identities', async () => {
  let stats: Record<string, number | boolean> | undefined;
  const result = await collectYandex({ onDiagnostics: value => { stats = value; }, fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
    return envelope({ result: ['absent', 'field', 'empty', 'type', 'valid'], collections: { orderReceipt: {
      field: {}, empty: { fiscalUrl: ' ' }, type: { fiscalUrl: 123 }, valid: { fiscalUrl: 'https://check.yandex.ru/valid', createdAt: 1767225600 },
    } } });
  } });
  assert.deepEqual(result.unresolvedOrderIds, ['123456']);
  assert.equal(result.stats.missingReceiptRecords, 1);
  assert.equal(result.stats.missingFiscalUrlFields, 1);
  assert.equal(result.stats.emptyFiscalUrls, 1);
  assert.equal(result.stats.invalidFiscalUrlTypes, 1);
  assert.equal(result.stats.missingUrlOrders, 1);
  assert.ok(!JSON.stringify(stats).includes('123456'));
});

test('actual dialog URLs add readable receipts without claiming coverage of unresolved API IDs', async () => {
  const queried: string[] = [];
  const result = await collectYandex({ readOrderDocuments: async orderId => { queried.push(orderId); return { urls: ['https://check.yandex.ru/dialog-sale', 'https://check.yandex.ru/dialog-refund'], complete: true, blocked: false }; }, fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.hostname === 'check.yandex.ru') return new Response(`<p>01.01.2026 10:00 ${url.pathname.includes('refund') ? 'ВОЗВРАТ ПРИХОДА' : ''}</p>${receipt}`);
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
    return envelope({ result: ['unresolved'], collections: { orderReceipt: { unresolved: {} } } });
  } });
  assert.deepEqual(queried, ['123456']);
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.some(row => row.amount === '-100.00'));
  assert.deepEqual(result.unresolvedOrderIds, ['123456']);
  assert.equal(result.stats.failedOrders, 1);
  assert.equal(result.stats.domReceiptUrlsAdded, 2);
  assert.equal(result.stats.domReceiptCompleteDialogs, 1);
  assert.equal(result.stats.incomplete, true);
  assert.ok(!JSON.stringify(result.stats).includes('dialog-sale'));
});

test('receipt resolver errors in both passes fall back to the order dialog unless access is restricted', async () => {
  const queried: string[] = [];
  const result = await collectYandex({ readOrderDocuments: async orderId => {
    queried.push(orderId);
    return { urls: ['https://check.yandex.ru/dialog-sale'], complete: true, blocked: false };
  }, fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.hostname === 'check.yandex.ru') return new Response(`<p>01.01.2026 10:00</p>${receipt}`);
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456, 234567]);
    const { params } = JSON.parse(String(init?.body)) as { params: Array<{ orderId: number }> };
    return Response.json({ results: params.map(({ orderId }) => ({ error: { code: orderId === 123456 ? 'UPSTREAM_ERROR' : 'FORBIDDEN' } })) });
  } });
  assert.deepEqual(queried, ['123456']);
  assert.equal(result.rows.length, 1);
  assert.equal(result.stats.domReceiptOrdersAttempted, 1);
  assert.equal(result.stats.resolverOtherErrors, 2);
  assert.equal(result.stats.resolverForbiddenErrors, 2);
  assert.equal(result.stats.incomplete, true);
});

test('four matching errors in both metadata passes move the whole queue to order dialogs', async () => {
  const ids = Array.from({ length: 10 }, (_, index) => 123456 + index);
  for (const archiveWorks of [false, true]) {
    const queried: string[] = [];
    const result = await collectYandex({ readOrderDocuments: async orderId => {
      queried.push(orderId);
      return { urls: [`https://check.yandex.ru/dialog-${orderId}`], complete: true, blocked: false };
    }, fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/my/orders') return new Response('');
      if (url.hostname === 'check.yandex.ru') return new Response(`<p>01.01.2026 10:00</p>${receipt}`);
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList(ids);
      const { orderId, archived } = JSON.parse(String(init?.body)).params[0];
      if (archiveWorks && archived) return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: `https://check.yandex.ru/api-${orderId}` } } } });
      return Response.json({ results: [{ error: { code: 'UPSTREAM_ERROR' } }] });
    } });
    assert.equal(result.stats.receiptMetadataRequests, archiveWorks ? 20 : 8);
    assert.deepEqual(queried, archiveWorks ? [] : ids.map(String));
    assert.equal(result.rows.length, ids.length);
    assert.equal(result.stats.failedOrders, 0);
  }
});

test('verified order dialogs are reused while incomplete and invalidated dialogs are reopened', async () => {
  const entries = new Map<string, string[]>();
  const opened: string[] = [];
  const fiscalUrl = 'https://check.yandex.ru/doc?fn=101&n=202&fpd=303';
  const fiscalHtml = '<div>Кассовый чек. Приход</div><div>01.01.2026 10:00</div>'
    + receipt.replace('<td>1</td>', '<td>1.</td>').replace('</table>', '<tr><td>Аванс</td><td>100,00</td></tr></table>') + '<div>ФН: 101 ФД: 202 ФП: 303</div>';
  let receiptUnavailable = false;
  const run = () => collectYandex({ orderDocumentsCache: {
    read: async id => entries.get(id), write: async (id, urls) => { entries.set(id, urls); }, remove: async id => { entries.delete(id); },
  }, readOrderDocuments: async orderId => {
    opened.push(orderId);
    return orderId === '123456' ? { urls: [fiscalUrl], complete: true, blocked: false } : { urls: [], complete: false, blocked: false };
  }, fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.hostname === 'check.yandex.ru') return new Response(fiscalHtml, { status: receiptUnavailable ? 503 : 200 });
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456, 234567]);
    return envelope({ result: ['r'], collections: { orderReceipt: { r: {} } } });
  } });
  const cold = await run();
  assert.deepEqual([...entries.keys()], ['123456']);
  assert.equal(cold.fiscalPayments?.[0]?.paid, 0);
  opened.length = 0;
  const warm = await run();
  assert.deepEqual(opened, ['234567']);
  assert.equal(warm.stats.cachedOrderDialogs, 1);
  assert.equal(warm.stats.domReceiptOrdersAttempted, 1);
  assert.deepEqual(warm.fiscalPayments, cold.fiscalPayments);
  receiptUnavailable = true;
  await assert.rejects(run());
  assert.equal(entries.has('123456'), false);
});

test('dialog duplicate of an API fiscal URL is fetched once while a distinct actual URL is parsed', async () => {
  const fetched: string[] = [];
  const result = await collectYandex({ readOrderDocuments: async () => ({ urls: ['https://check.yandex.ru/same?key=one', 'https://check.yandex.ru/distinct?key=two'], complete: true, blocked: false }), fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.hostname === 'check.yandex.ru') { fetched.push(url.href); return new Response(`<p>01.01.2026 10:00</p>${receipt}`); }
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
    return envelope({ result: ['known', 'missing'], collections: { orderReceipt: { known: { fiscalUrl: 'https://check.yandex.ru/same?key=one', createdAt: 1767225600 }, missing: {} } } });
  } });
  assert.deepEqual(fetched.sort(), ['https://check.yandex.ru/distinct?key=two', 'https://check.yandex.ru/same?key=one']);
  assert.equal(result.stats.receipts, 2);
  assert.equal(result.stats.domReceiptUrlsAdded, 1);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.unresolvedOrderIds, ['123456']);
});

test('a fiscal receipt shared by API and another order dialog is read once without assigning all goods to one order', async () => {
  const official = 'https://check.yandex.ru/?fn=0101&n=202&fpd=303';
  const alias = 'https://check.yandex.ru/?fpd=303&n=0202&fn=101';
  const fetched: string[] = [];
  const result = await collectYandex({
    readOrderDocuments: async id => {
      assert.equal(id, '234567');
      return { urls: [alias], complete: true, blocked: false };
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/my/orders') return new Response('');
      if (url.hostname === 'check.yandex.ru') {
        fetched.push(url.href);
        return new Response(`<p>01.01.2026 10:00</p>${receipt.replace('<td>1</td>', '<td>1.</td>')}`);
      }
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456, 234567]);
      const { orderId } = JSON.parse(String(init?.body)).params[0];
      return envelope({ result: ['r'], collections: { orderReceipt: { r: orderId === 123456 ? { fiscalUrl: official } : {} } } });
    },
  });
  assert.deepEqual(fetched, [official]);
  assert.equal(result.stats.receipts, 1);
  assert.equal(result.stats.domReceiptUrlsAdded, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.yandex_order_id, '');
  assert.equal(result.rows[0]?.parse_quality, 'complete');
});

test('previously seen orders recover receipts only when the current listing shares a known order', async () => {
  for (const overlap of [true, false]) {
    const fetched: number[] = [];
    const result = await collectYandex({
      knownOrderIds: ['123456', '234567'],
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/my/orders') return new Response('');
        if (url.hostname === 'check.yandex.ru') return new Response(`<p>01.01.2026 10:00</p>${receipt}`);
        if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([overlap ? 123456 : 345678]);
        const { orderId } = JSON.parse(String(init?.body)).params[0];
        fetched.push(orderId);
        return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/' + orderId } } } });
      },
    });
    assert.deepEqual(fetched.sort((a, b) => a - b), overlap ? [123456, 234567] : [345678]);
    assert.equal(result.stats.listedOrders, 1);
    assert.equal(result.stats.knownOrdersAdded, overlap ? 1 : 0);
    assert.equal(result.stats.incomplete, overlap);
    assert.equal(result.rows.length, overlap ? 2 : 1);
  }
});

test('document fallback checks orders without saved fiscal data first on the next refresh', async () => {
  const queried: string[] = [];
  await collectYandex({ knownOrderIds: ['123456', '234567'], readOrderDocuments: async orderId => {
    queried.push(orderId);
    return { urls: [`https://check.yandex.ru/dialog-${orderId}`], complete: true, blocked: false };
  }, fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.hostname === 'check.yandex.ru') return new Response(`<p>01.01.2026 10:00</p>${receipt}`);
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456, 234567, 345678]);
    return envelope({ result: ['r'], collections: { orderReceipt: { r: {} } } });
  } });
  assert.deepEqual(queried, ['345678', '123456', '234567']);
});

test('blocked document UI stops queued order pages with at most two reads in flight', async () => {
  let calls = 0, active = 0, peak = 0;
  const result = await collectYandex({ readOrderDocuments: async orderId => {
    calls++; peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return orderId === '123456' ? { urls: [], complete: false, blocked: true } : { urls: ['https://check.yandex.ru/dialog'], complete: true, blocked: false };
  }, fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.hostname === 'check.yandex.ru') return new Response(`<p>01.01.2026 10:00</p>${receipt}`);
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456, 234567, 345678]);
    return envelope({ result: ['r'], collections: { orderReceipt: { r: {} } } });
  } });
  assert.equal(calls, 2); assert.equal(peak, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.stats.domReceiptBlocked, 1);
  assert.deepEqual(result.unresolvedOrderIds, ['123456', '234567', '345678']);
});

test('document progress failures preserve falsy rejection values', async () => {
  for (const failure of [0, undefined]) {
    await assert.rejects(collectYandex({ readOrderDocuments: async () => ({ urls: ['https://check.yandex.ru/dialog'], complete: true, blocked: false }), onProgress: progress => { if (progress.message.includes('проверены документы')) throw failure; }, fetch: async input => {
      const url = new URL(String(input));
      if (url.pathname === '/my/orders') return new Response('');
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
      return envelope({ result: ['r'], collections: { orderReceipt: { r: {} } } });
    } }), error => error === failure);
  }
});

test('incomplete document reads retain only fixed failure categories in exported stats', async () => {
  const reasons = ['navigation', 'button', 'dialog', 'loading', 'error', 'unrecognized', 'request'] as const;
  const orders = reasons.map((_, index) => String(123456 + index));
  const result = await collectYandex({ context: { initialOrders: { orderIds: orders, pageToken: '' } },
    readOrderDocuments: async id => ({ urls: [], complete: false, blocked: false, failureReason: reasons[orders.indexOf(id)] }), fetch: async input => {
      const url = new URL(String(input));
      if (url.hostname === 'check.yandex.ru') return new Response(receipt);
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList(orders.map(Number));
      return envelope({ result: ['missing', 'valid'], collections: { orderReceipt: {
        missing: {}, valid: { fiscalUrl: 'https://check.yandex.ru/known', createdAt: 1767225600 },
      } } });
    },
  });
  assert.equal(result.stats.domReceiptLimits, reasons.length);
  assert.deepEqual(new Set(result.failedDocumentOrderIds), new Set(orders));
  assert.deepEqual(result.failedReceiptOrderIds, []);
  assert.equal(result.stats.incomplete, true);
  for (const key of ['NavigationWaits', 'ButtonWaits', 'DialogWaits', 'LoadingWaits', 'ErrorWaits', 'UnrecognizedWaits', 'RequestErrors']) assert.equal(result.stats[`domReceipt${key}`], 1);
  assert.ok(Object.keys(result.stats).length <= 128);
  assert.doesNotMatch(JSON.stringify(result.stats), /123456|check\.yandex/);
});

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
    return batchEnvelope(JSON.parse(String(init?.body)).params.map((param: { orderId: number }) => ({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: `https://check.yandex.ru/${param.orderId}`, createdAt: 1767225600 } } } })));
  } });
  assert.deepEqual(tokens, [undefined, 'next']);
  assert.equal(result.stats.pages, 2);
  assert.equal(result.stats.orders, 3);
  assert.equal(result.rows.length, 3);
  assert.equal(result.stats.incomplete, false);
  assert.deepEqual(result.warnings, []);
});

test('rendered pagination cursor is JSON-decoded and used for the first API continuation', async () => {
  const cursor = 'rendered"cursor\\tail';
  const tokens: unknown[] = [];
  const result = await collectYandex({ fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response(`<a href="/my/order/123456">Order</a><script>${JSON.stringify({ pageToken: cursor })}</script>`);
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    const body = JSON.parse(String(init?.body));
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) {
      tokens.push(body.params[0].pageToken);
      return orderList([234567]);
    }
    return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: `https://check.yandex.ru/${body.params[0].orderId}`, createdAt: 1767225600 } } } });
  } });
  assert.deepEqual(tokens, [cursor]);
  assert.equal(result.stats.orders, 2);
  assert.equal(result.rows.length, 2);
  assert.equal(result.stats.incomplete, false);
});

test('owned-tab seed supplies IDs and cursor without an offscreen initial GET', async () => {
  for (const empty of [false, true]) {
    let gets = 0;
    const tokens: unknown[] = [];
    const result = await collectYandex({ context: { sk: 'private-seed-sk', initialOrders: { orderIds: empty ? [] : ['123456'], pageToken: empty ? '' : 'owned-seed-cursor' } }, fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/my/orders') { gets++; throw new Error('Offscreen GET is forbidden for a valid owned seed'); }
      if (url.hostname === 'check.yandex.ru') return new Response(receipt);
      const params = JSON.parse(String(init?.body)).params[0];
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) { tokens.push(params.pageToken); return orderList([234567]); }
      return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: `https://check.yandex.ru/${params.orderId}`, createdAt: 1767225600 } } } });
    } });
    assert.equal(gets, 0);
    assert.deepEqual(tokens, [empty ? undefined : 'owned-seed-cursor']);
    assert.equal(result.rows.length, empty ? 1 : 2);
    assert.ok(!JSON.stringify(result.stats).includes('owned-seed-cursor'));
    assert.ok(!JSON.stringify(result.stats).includes('private-seed-sk'));
    assert.deepEqual(result.warnings, []);
  }
});

test('invalid owned-tab seed falls back to the compatible initial GET', async () => {
  for (const initialOrders of [
    { orderIds: ['0'], pageToken: 'wrong' }, { orderIds: ['9007199254740992'], pageToken: 'wrong' },
    { orderIds: [123456], pageToken: 'wrong' }, { orderIds: ['234567'], pageToken: 'x'.repeat(8001) },
    { orderIds: ['234567'] }, [],
  ]) {
    let gets = 0;
    const result = await collectYandex({ context: { initialOrders } as unknown as Parameters<typeof collectYandex>[0]['context'], fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/my/orders') { gets++; return new Response('<a href="/my/order/123456">Order</a><script>{"pageToken":"fallback-cursor"}</script>'); }
      if (url.hostname === 'check.yandex.ru') return new Response(receipt);
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) {
        assert.equal(JSON.parse(String(init?.body)).params[0].pageToken, 'fallback-cursor');
        return orderList([123456]);
      }
      return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/123456', createdAt: 1767225600 } } } });
    } });
    assert.equal(gets, 1);
    assert.equal(result.rows.length, 1);
    assert.equal(result.stats.orders, 1);
  }
});

test('Yandex loads at most two individual orders and four receipts concurrently', async () => {
  const active={orders:0,receipts:0}, peak={orders:0,receipts:0};
  const result=await collectYandex({fetch:async(input,init)=>{
    const url=new URL(String(input));
    if(url.pathname==='/my/orders') return new Response(Array.from({length:20},(_,i)=>`<a href="/my/order/${123456+i}">Order</a>`).join(''));
    if(url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList(Array.from({length:20},(_,i)=>123456+i));
    const kind=url.hostname==='check.yandex.ru'?'receipts':'orders';
    peak[kind]=Math.max(peak[kind],++active[kind]); await new Promise(resolve=>setTimeout(resolve,10)); active[kind]--;
    if(kind==='receipts') return new Response(receipt);
    const params=JSON.parse(String(init?.body)).params;
    assert.equal(params.length, 1);
    return batchEnvelope(params.map(({orderId}: {orderId: number}) => ({result:['r'],collections:{orderReceipt:{r:{id:orderId,fiscalUrl:`https://check.yandex.ru/${orderId}`,createdAt:1767225600}}}})));
  }});
  assert.deepEqual(peak,{orders:2,receipts:4}); assert.equal(result.rows.length,20); assert.equal(result.stats.failedOrders,0);
  assert.equal(result.stats.receiptMetadataRequests, 20);
  assert.equal(result.stats.receiptMetadataOrdersRequested, 20);
});

test('individual receipt requests preserve order identity and archive only empty or unresolved orders', async () => {
  const requests: Array<Array<{ orderId: number; archived: boolean }>> = [];
  const ids = Array.from({ length: 10 }, (_, index) => 123456 + index);
  const result = await collectYandex({ fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList(ids);
    const params: Array<{ orderId: number; archived: boolean }> = JSON.parse(String(init?.body)).params;
    requests.push(params);
    return batchEnvelope(params.map(({ orderId, archived }) => {
      if (orderId === ids[8]) return { result: [], collections: {} };
      return { result: ['same-key'], collections: { orderReceipt: { 'same-key': {
        id: String(orderId), createdAt: 1767225600, ...(orderId === ids[9] && !archived ? {} : { fiscalUrl: `https://check.yandex.ru/${orderId}` }),
      } } } };
    }));
  } });
  assert.equal(requests.length, 12);
  assert.ok(requests.every(params => params.length === 1));
  assert.deepEqual(requests.flat().filter(param => param.archived), ids.slice(8).map(orderId => ({ orderId, archived: true })));
  assert.equal(result.rows.length, 9);
  for (const row of result.rows) assert.ok(row.receipt_url?.endsWith('/' + row.yandex_order_id));
  assert.equal(result.stats.failedOrders, 0);
  assert.equal(result.stats.noReceiptOrders, 1);
  assert.equal(result.stats.missingUrlOrders, 0);
  assert.equal(result.stats.receiptMetadataRequests, 12);
  assert.equal(result.stats.receiptMetadataOrdersRequested, 12);
});

test('a single receipt request retains the established root.data response contract', async () => {
  for (const results of [undefined, [], [{}], [null]]) {
  const result = await collectYandex({ fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
    return new Response(JSON.stringify({ results, data: { result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/123456', createdAt: 1767225600 } } } } }));
  } });
  assert.equal(result.rows.length, 1);
  assert.equal(result.stats.failedOrders, 0);
  assert.equal(result.stats.receiptMetadataRequests, 1);
  assert.deepEqual(result.warnings, []);
  }
});

test('an entry error takes priority over the single root.data fallback', async () => {
  let receiptRequests = 0;
  await assert.rejects(collectYandex({ fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.hostname === 'check.yandex.ru') { receiptRequests++; return new Response(receipt); }
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
    return new Response(JSON.stringify({ results: [{ error: { code: 'FORBIDDEN' } }],
      data: { result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/123456', createdAt: 1767225600 } } } } }));
  } }), /неизвестный формат/);
  assert.equal(receiptRequests, 0);
});

test('extra or missing singleton response entries cannot borrow another receipt', async () => {
  for (const results of [[], [{}, {}], [null], [{}]]) {
    const result = await collectYandex({ fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/my/orders') return new Response('');
      if (url.hostname === 'check.yandex.ru') return new Response(receipt);
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456, 234567]);
      const { orderId } = JSON.parse(String(init?.body)).params[0];
      if (orderId === 234567) return new Response(JSON.stringify({ results }));
      return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/123456', createdAt: 1767225600 } } } });
    } });
    assert.equal(result.rows.length, 1);
    assert.equal(result.stats.failedOrders, 1);
    assert.equal(result.rows[0]?.yandex_order_id, '123456');
  }
});

test('Yandex resolver contracts, pagination, archive fallback and fiscal URLs', async () => {
  const queried: Array<{ orderId: number; archived: boolean }> = []; let pages = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    if (url.pathname === '/my/orders') return new Response('<a href="/my/order/123456">Заказ</a><script>{"pageToken":"next","hasNext":true}</script>');
    assert.equal(init?.method, 'POST'); const body = JSON.parse(String(init?.body));
    assert.ok(Array.isArray(body.params)); assert.equal(body.params.length, 1);
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) {
      assert.equal(body.path, '/my/orders?filter=COMPLETED');
      pages++;
      assert.equal(body.params[0].pageToken, pages === 1 ? 'next' : 'api-next');
      return envelope({ result: 'list', collections: { orderConsolidationResult: { list: pages === 1
        ? { ordersGroupsIds: [123456, 123457], pageToken: 'api-next', hasNext: true }
        : { ordersGroupsIds: [234567], pageToken: '', hasNext: false } } } });
    }
    assert.match(url.searchParams.get('r') || '', /resolveOrderReceiptsByOrderId/);
    assert.equal(body.path, `/my/order/${body.params[0].orderId}`);
    assert.equal(new Headers(init?.headers).get('x-market-page-id'), 'market:order');
    assert.equal(new Headers(init?.headers).get('x-retpath-y'), 'https://market.yandex.ru' + body.path);
    assert.equal(init?.referrer, 'https://market.yandex.ru' + body.path);
    return batchEnvelope(body.params.map((params: { orderId: number; archived: boolean }) => {
      queried.push(params);
      if (params.orderId === 234567 && !params.archived) return { result: [], collections: {} };
      return { result: ['fiscal'], collections: { orderReceipt: { fiscal: { id: `r${params.orderId}`, fiscalUrl: `https://check.yandex.ru/${params.orderId}`, createdAt: 1767225600, type: 'INCOME' } } } };
    }));
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
  assert.equal(result.rows.length, 1); assert.equal(result.stats.failedReceipts, 1);
  assert.equal(result.stats.incomplete, true);
  assert.equal(result.stats.receiptHttpErrors, 1);
  assert.match(result.warnings.join(' '), /ошибка HTTP — 1/);
});

test('receipt failures have separate safe categories and never expose transport messages or private links', async () => {
  const names = ['good', 'forbidden', 'rate', 'http', 'network', 'timeout', 'parse', 'size', 'redirect'];
  let diagnostics: Record<string, number | boolean> | undefined;
  const result = await collectYandex({ onDiagnostics: stats => { diagnostics = stats; },
    context: { initialOrders: { orderIds: ['123456'], pageToken: '' } }, fetch: async input => {
      const url = new URL(String(input));
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
      if (url.hostname !== 'check.yandex.ru') return envelope({ result: names, collections: { orderReceipt: Object.fromEntries(names.map(name => [name, {
        fiscalUrl: `https://check.yandex.ru/${name}?private=fiscal-secret`, createdAt: 1767225600,
      }])) } });
      if (url.pathname === '/network') throw new TypeError('https://check.yandex.ru/private?token=fiscal-secret');
      if (url.pathname === '/timeout') throw new DOMException('private=fiscal-secret', 'TimeoutError');
      if (url.pathname === '/parse') return new Response('<html>private=fiscal-secret</html>');
      if (url.pathname === '/size') return new Response('x'.repeat(8 * 1024 * 1024 + 1));
      if (url.pathname === '/redirect') {
        const response = new Response(receipt);
        Object.defineProperty(response, 'url', { value: 'https://elsewhere.test/private?token=fiscal-secret' }); return response;
      }
      return new Response(receipt, { status: ({ '/forbidden': 403, '/rate': 429, '/http': 503 } as Record<string, number>)[url.pathname] || 200 });
    },
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.stats.failedReceipts, 8);
  assert.deepEqual(result.failedReceiptOrderIds, ['123456']);
  assert.deepEqual(result.failedDocumentOrderIds, []);
  assert.equal(result.stats.incomplete, true);
  for (const name of ['Forbidden', 'RateLimit', 'Http', 'Network', 'Timeout', 'Parse', 'Oversize', 'Redirect']) assert.equal(result.stats[`receipt${name}Errors`], 1, name);
  assert.equal(diagnostics?.incomplete, true);
  assert.equal(diagnostics?.failedReceipts, 8);
  assert.ok(Object.keys(result.stats).length <= 128);
  assert.doesNotMatch(JSON.stringify([result.stats, result.warnings, diagnostics]), /fiscal-secret|elsewhere|check\.yandex/);
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
    if(!body.params[0]!.archived) return new Response('',{status:404});
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
  assert.equal(pages, 1); assert.equal(result.stats.incomplete, true); assert.match(result.warnings.join(' '), /повторилась страница/);
  assert.equal(result.rows.length, 1);
  assert.equal(result.stats.lastPageIds, 1);
  assert.equal(result.stats.lastPageNewIds, 1);
  assert.equal(result.stats.lastPageHasNextKnown, true);
  assert.equal(result.stats.lastPageHasNext, true);
  assert.equal(result.stats.lastPageCursorPresent, true);
  assert.equal(result.stats.lastPageCursorMatchesRequest, true);
  assert.equal(result.stats.repeatedCursor, true);
});

test('an echoed empty list needs an explicit end to confirm pagination', async () => {
  for (const { items, hasNext, incomplete } of [
    { items: [], hasNext: undefined, incomplete: true },
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
    assert.equal(result.stats.repeatedCursor, hasNext === true || items.length > 0);
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
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456, 234567]);
      const { orderId } = JSON.parse(String(init?.body)).params[0];
      if (orderId === 234567) return new Response(JSON.stringify(payload));
      return batchEnvelope(JSON.parse(String(init?.body)).params.map(({orderId}: {orderId: number}) => ({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: `https://check.yandex.ru/${orderId}`, createdAt: 1767225600 } } } })));
    } });
    for (const [key, value] of Object.entries(counters)) assert.equal(result.stats[key], value, key);
    assert.equal(result.stats.responseErrorOrders, 1);
    assert.equal(result.stats.noReceiptOrders, 0);
    assert.equal(result.stats.missingUrlOrders, 0);
    assert.equal(result.stats.unsafeUrlOrders, 0);
    assert.equal(result.stats.failedOrders, 1);
    assert.equal(result.stats.lastPageIds, 2);
    assert.equal(result.stats.lastPageNewIds, 2);
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
      if (orderId === 123456) return batchEnvelope(JSON.parse(String(init?.body)).params.map(({orderId}: {orderId: number}) => ({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: `https://check.yandex.ru/${orderId}`, createdAt: 1767225600 } } } })));
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
      assert.match((error as Error).message, /пройдите проверку/);
      assert.ok(!(error as Error).message.includes(secret));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('challenge stops queued metadata work after at most two in-flight individual requests', async () => {
  let calls = 0;
  await assert.rejects(collectYandex({ fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList(Array.from({ length: 20 }, (_, index) => 123456 + index));
    calls++;
    return new Response(JSON.stringify({ captcha: true }));
  } }), /пройдите проверку/);
  assert.ok(calls > 0 && calls <= 2);
});

test('challenge in a result slot stops queued orders and the archive phase', async () => {
  const ids = Array.from({ length: 17 }, (_, index) => 123456 + index);
  const requests: Array<Array<{ orderId: number; archived: boolean }>> = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const result = await collectYandex({ fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList(ids);
    const params: Array<{ orderId: number; archived: boolean }> = JSON.parse(String(init?.body)).params;
    requests.push(params);
    if (requests.length === 2) release();
    await gate;
    return new Response(JSON.stringify({ results: params.map(({ orderId }) => orderId === ids[0] ? { type: 'captcha' } : {
      data: { result: ['r'], collections: { orderReceipt: { r: { id: String(orderId), fiscalUrl: `https://check.yandex.ru/${orderId}`, createdAt: 1767225600 } } } },
    }) }));
  } });
  assert.deepEqual(requests.map(params => params.length), [1, 1]);
  assert.ok(requests.flat().every(param => param.archived === false));
  assert.equal(result.stats.receiptMetadataRequests, 2);
  assert.equal(result.stats.challengeResponses, 1);
  assert.equal(result.stats.uncheckedOrders, 16);
  assert.equal(result.stats.incomplete, true);
  assert.equal(result.rows.length, 1);
  assert.ok(result.rows.every(row => row.yandex_order_id === String(ids[1])));
});

test('metadata challenge preserves discovered receipts and marks unchecked orders incomplete', async () => {
  const result = await collectYandex({ readOrderDocuments: async () => { assert.fail('A challenge must not open document fallback pages'); }, fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456, 234567]);
    const { orderId } = JSON.parse(String(init?.body)).params[0];
    if (orderId === 123456) return batchEnvelope(JSON.parse(String(init?.body)).params.map(({orderId}: {orderId: number}) => ({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: `https://check.yandex.ru/${orderId}`, createdAt: 1767225600 } } } })));
    return new Response(JSON.stringify({ type: 'captcha', captcha: {
      url: 'https://market.yandex.ru/showcaptcha?private=private-challenge-secret',
      redirect: 'https://yandex.ru.evil.test/showcaptcha?private=private-challenge-secret',
      'captcha-page': '/showcaptcha?private=private-challenge-secret',
      'form-action': 'private-challenge-secret', 'img-url': 'private-challenge-secret', key: 'private-challenge-secret',
    } }));
  } });
  assert.equal(result.rows.length, 1);
  assert.equal(result.stats.incomplete, true);
  assert.equal(result.stats.uncheckedOrders, 1);
  assert.equal(result.stats.challengeResponses, 1);
  assert.match(result.warnings.join(' '), /пройдите проверку/);
  assert.equal(result.stats.captchaValueType, 3);
  assert.equal(result.stats.captchaObjectKeys, 6);
  assert.equal(result.stats.captchaObjectKeyMask, 63);
  assert.equal(result.stats.captchaUrlCandidateMask, 40);
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
    let started = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await assert.rejects(collectYandex({ signal: controller.signal,
      onProgress: progress => { if (!cancel && progress.message.includes('проверено')) throw failure; },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/my/orders') return new Response('');
        if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456, 234567]);
        if (++started === 2) release();
        await gate;
        const { orderId } = JSON.parse(String(init?.body)).params[0];
        if (orderId === 123456) {
          if (cancel) controller.abort(failure);
          return batchEnvelope(JSON.parse(String(init?.body)).params.map(({orderId}: {orderId: number}) => ({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: `https://check.yandex.ru/${orderId}`, createdAt: 1767225600 } } } })));
        }
        return new Response(JSON.stringify({ type: 'captcha' }));
      },
    }), error => error === failure);
  }
});

test('cancellation during the metadata pause sends no metadata request', async () => {
  const controller = new AbortController(), failure = new Error('cancelled during pause');
  let requests = 0;
  await assert.rejects(collectYandex({ signal: controller.signal,
    onProgress: progress => { if (!progress.total) setTimeout(() => controller.abort(failure), 10); },
    fetch: async input => {
      const url = new URL(String(input));
      if (url.pathname === '/my/orders') return new Response('');
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
      requests++;
      return envelope({ result: [], collections: {} });
    },
  }), error => error === failure);
  assert.equal(requests, 0);
});

test('failed list attempts publish safe diagnostics and distinguish HTML from other non-JSON', async () => {
  for (const html of [false, true]) {
    let stats: Record<string, number | boolean> | undefined;
    let calls = 0;
    await assert.rejects(collectYandex({ onDiagnostics: value => { stats = value; }, fetch: async input => {
      if (new URL(String(input)).pathname === '/my/orders') return new Response('<html>Expected orders page</html>');
      calls++;
      return new Response(html ? '<html><body>private-response-secret</body></html>' : ')]}\n{"private":"private-response-secret"}', { headers: { 'content-type': html ? 'text/html' : 'application/json' } });
    } }), html ? /страницу вместо истории/ : /не удалось прочитать/);
    assert.equal(calls, 1);
    assert.equal(stats?.apiNonJsonResponses, 1);
    assert.equal(stats?.apiHtmlResponses, html ? 1 : 0);
    assert.equal(stats?.apiOtherNonJsonResponses, html ? 0 : 1);
    assert.equal(stats?.receipts, 0);
    assert.equal(stats?.pages, 1);
    assert.equal(stats?.incomplete, true);
    assert.ok(Object.values(stats || {}).every(value => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))));
    assert.ok(!JSON.stringify(stats).includes('private-response-secret'));
  }
});

test('non-JSON metadata globally stops queued batches and archive while publishing the failed attempt', async () => {
  let calls = 0, stats: Record<string, number | boolean> | undefined;
  await assert.rejects(collectYandex({ onDiagnostics: value => { stats = value; }, fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList(Array.from({ length: 34 }, (_, index) => 123456 + index));
    calls++;
    return new Response('<html>API refusal</html>');
  } }), /страницу вместо истории/);
  assert.ok(calls > 0 && calls <= 2);
  assert.equal(stats?.receiptMetadataRequests, calls);
  assert.equal(stats?.apiNonJsonResponses, calls);
  assert.equal(stats?.uncheckedOrders, 34);
  assert.equal(stats?.incomplete, true);
});

test('non-JSON interruption preserves known rows and only confirms opening a challenge from provider metadata', async () => {
  for (const opened of [false, true]) {
    let published: Record<string, number | boolean> | undefined;
    let release!: () => void, calls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const result = await collectYandex({ onDiagnostics: value => { published = value; }, fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/my/orders') return new Response('');
      if (url.hostname === 'check.yandex.ru') return new Response(receipt);
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList(Array.from({ length: 17 }, (_, index) => 123456 + index));
      const params: Array<{ orderId: number }> = JSON.parse(String(init?.body)).params;
      if (++calls === 2) release();
      await gate;
      if (params[0]!.orderId === 123456) return batchEnvelope(params.map(({ orderId }) => ({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: `https://check.yandex.ru/${orderId}`, createdAt: 1767225600 } } } })));
      return new Response('private-challenge-secret', { headers: { 'x-kupleno-yandex-html': '1', 'x-kupleno-yandex-challenge': '1', 'x-kupleno-yandex-redirected': '1', ...(opened ? { 'x-kupleno-yandex-challenge-opened': '1' } : {}) } });
    } });
    assert.equal(calls, 2);
    assert.equal(result.rows.length, 1);
    assert.equal(result.stats.incomplete, true);
    assert.equal(result.stats.uncheckedOrders, 16);
    assert.equal(result.stats.apiHtmlResponses, 1);
    assert.equal(result.stats.providerChallengeResponses, 1);
    assert.equal(result.stats.providerRedirectResponses, 1);
    assert.equal(result.stats.providerChallengeOpenedResponses, opened ? 1 : 0);
    assert.equal(result.warnings.some(value => value.includes('открыл проверку')), opened);
    assert.equal(published?.receipts, 1);
    assert.ok(!JSON.stringify({ stats: published, warnings: result.warnings }).includes('private-challenge-secret'));
  }
});

test('diagnostics delivery preserves an original falsy progress error', async () => {
  for (const failure of [0, undefined]) {
    let stats: Record<string, number | boolean> | undefined;
    await assert.rejects(collectYandex({ onDiagnostics: value => { stats = value; }, onProgress: () => { throw failure; }, fetch: async input => {
      if (new URL(String(input)).pathname === '/my/orders') return new Response('');
      return orderList([123456]);
    } }), error => error === failure);
    assert.equal(stats?.orders, 1);
    assert.equal(stats?.incomplete, true);
  }
});

test('provider-confirmed JSON challenge retains the existing private-safe shape diagnostics on failure', async () => {
  let stats: Record<string, number | boolean> | undefined;
  await assert.rejects(collectYandex({ onDiagnostics: value => { stats = value; }, fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('');
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
    return new Response(JSON.stringify({ type: 'captcha', captcha: { url: '/showcaptcha?secret=private-response-secret' } }), {
      headers: { 'x-kupleno-yandex-challenge': '1', 'x-kupleno-yandex-challenge-opened': '1' },
    });
  } }), /открыл проверку/);
  assert.equal(stats?.responseShapeKeyMask, 20);
  assert.equal(stats?.captchaValueType, 3);
  assert.equal(stats?.captchaObjectKeyMask, 1);
  assert.equal(stats?.challengeResponses, 1);
  assert.equal(stats?.providerChallengeOpenedResponses, 1);
  assert.equal(stats?.apiNonJsonResponses, 0);
  assert.equal(stats?.responseMalformedData, 0);
  assert.ok(!JSON.stringify(stats).includes('private-response-secret'));
});

test('provider HTML or login metadata survives an empty HTTP error response', async () => {
  for (const flag of ['html', 'login']) {
    let stats: Record<string, number | boolean> | undefined;
    await assert.rejects(collectYandex({ onDiagnostics: value => { stats = value; }, fetch: async input => {
      if (new URL(String(input)).pathname === '/my/orders') return new Response('');
      return new Response('', { status: 403, headers: { [`x-kupleno-yandex-${flag}`]: '1' } });
    } }), flag === 'html' ? /страницу вместо истории/ : /запросил вход/);
    assert.equal(stats?.apiNonJsonResponses, 1);
    assert.equal(stats?.apiHtmlResponses, flag === 'html' ? 1 : 0);
    assert.equal(stats?.providerLoginResponses, flag === 'login' ? 1 : 0);
  }
});

test('provider SK presence diagnostics count flags without retaining live or captured values', async () => {
  let stats: Record<string, number | boolean> | undefined;
  const result = await collectYandex({ context: { sk: 'private-captured-sk' }, onDiagnostics: value => { stats = value; }, fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('<script>{"sk":"private-live-sk"}</script>');
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) {
      const response = orderList([123456]);
      response.headers.set('x-kupleno-yandex-live-sk', '1');
      response.headers.set('x-kupleno-yandex-context-sk', '1');
      return response;
    }
    const response = envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/r', createdAt: 1767225600 } } } });
    response.headers.set('x-kupleno-yandex-context-sk', '1');
    response.headers.set('x-kupleno-yandex-context-sk-used', '1');
    return response;
  } });
  assert.equal(result.stats.providerLiveSkResponses, 1);
  assert.equal(result.stats.providerContextSkResponses, 2);
  assert.equal(result.stats.providerContextSkUsedResponses, 1);
  assert.equal(stats?.providerContextSkUsedResponses, 1);
  assert.ok(!JSON.stringify({ stats, warnings: result.warnings }).includes('private-'));
});

test('one transient retry preserves the exact cursor and order requests, with two metadata workers', async () => {
  const listCalls: Array<{ url: string; body: string; time: number }> = [];
  const orders = new Map<number, string[]>();
  let active = 0, peak = 0;
  const result = await collectYandex({ fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('<a href="/my/order/123456">Order</a><script>{"pageToken":"rendered-cursor"}</script>');
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    const body = String(init?.body), params = JSON.parse(body).params[0];
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) {
      listCalls.push({ url: url.href, body, time: Date.now() });
      if (listCalls.length === 1) return new Response('', { status: 502, headers: { 'x-kupleno-yandex-context-sk': '1' } });
      if (params.pageToken === 'rendered-cursor') return envelope({ result: 'list', collections: { orderConsolidationResult: { list: { ordersGroupsIds: [123456], pageToken: 'next-cursor', hasNext: true } } } });
      return orderList([234567]);
    }
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    const calls = orders.get(params.orderId) || []; calls.push(body); orders.set(params.orderId, calls);
    if (calls.length === 1) return new Response('', { status: 504 });
    return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: `https://check.yandex.ru/${params.orderId}`, createdAt: 1767225600 } } } });
  } });
  assert.equal(listCalls.length, 3);
  assert.equal(listCalls[0]?.url, listCalls[1]?.url);
  assert.equal(listCalls[0]?.body, listCalls[1]?.body);
  assert.ok(listCalls[1]!.time - listCalls[0]!.time >= 900);
  assert.ok(listCalls[2]!.time - listCalls[1]!.time >= 280);
  assert.ok([...orders.values()].every(calls => calls.length === 2 && calls[0] === calls[1]));
  assert.equal(peak, 2);
  assert.equal(result.rows.length, 2);
  assert.equal(result.stats.transientRetries, 3);
  assert.equal(result.stats.transientExhausted, 0);
  assert.equal(result.stats.receiptMetadataRequests, 4);
  assert.equal(result.stats.incomplete, false);
});

test('exhausted transient retries preserve partial rows without switching resolver or archive', async () => {
  const listUrls: string[] = [], receiptBodies: string[] = [];
  const result = await collectYandex({ fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/my/orders') return new Response('<a href="/my/order/123456">Good</a><a href="/my/order/234567">Unavailable</a><script>{"pageToken":"private-cursor"}</script>');
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) { listUrls.push(url.href); return new Response('', { status: 502 }); }
    receiptBodies.push(String(init?.body));
    const { orderId, archived } = JSON.parse(String(init?.body)).params[0];
    assert.equal(archived, false);
    if (orderId === 234567) return new Response('', { status: 503 });
    return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/good', createdAt: 1767225600 } } } });
  } });
  assert.equal(listUrls.length, 2);
  assert.equal(new Set(listUrls).size, 1);
  assert.equal(receiptBodies.length, 3);
  assert.equal(result.rows.length, 1);
  assert.equal(result.stats.failedOrders, 1);
  assert.equal(result.stats.transientRetries, 2);
  assert.equal(result.stats.transientExhausted, 2);
  assert.equal(result.stats.listErrorHttpStatus, 502);
  assert.equal(result.stats.incomplete, true);
  assert.match(result.warnings.join(' '), /следующие страницы заказов не прочитаны \(HTTP 502\)/);
  assert.ok(!JSON.stringify(result.stats).includes('private-cursor'));
});

test('transient retry excludes challenge, HTML, non-JSON, authentication, rate limits and JSON errors', async () => {
  for (const makeResponse of [
    () => new Response('', { status: 503, headers: { 'x-kupleno-yandex-challenge': '1' } }),
    () => new Response('', { status: 503, headers: { 'x-kupleno-yandex-html': '1' } }),
    () => new Response('', { status: 503, headers: { 'x-kupleno-yandex-login': '1' } }),
    () => new Response('', { status: 503, headers: { 'x-kupleno-yandex-redirected': '1' } }),
    () => new Response('<html>private-server-text</html>', { status: 502 }),
    () => new Response('private-server-text', { status: 502 }),
    () => new Response('', { status: 429 }), () => new Response('', { status: 401 }), () => new Response('', { status: 403 }),
    () => new Response(JSON.stringify({ results: [{ error: { code: 'TIMEOUT', status: 503, message: 'private-server-text' } }] })),
  ]) {
    let stats: Record<string, number | boolean> | undefined;
    const urls: string[] = [];
    await assert.rejects(collectYandex({ onDiagnostics: value => { stats = value; }, fetch: async input => {
      const url = new URL(String(input));
      if (url.pathname === '/my/orders') return new Response('');
      urls.push(url.href); return makeResponse();
    } }));
    assert.equal(stats?.transientRetries, 0);
    assert.equal(new Set(urls).size, urls.length);
    assert.ok(!JSON.stringify(stats).includes('private-server-text'));
  }
});

test('list JSON resolver errors expose only known codes or numeric statuses without retrying', async () => {
  for (const error of [{ code: 'RESOLVER_NOT_FOUND', message: 'private-secret' }, { code: 'private-secret', statusCode: 504 }]) {
    const calls: string[] = [];
    const result = await collectYandex({ fetch: async input => {
      const url = new URL(String(input));
      if (url.pathname === '/my/orders') return new Response('<a href="/my/order/123456">Order</a>');
      if (url.hostname === 'check.yandex.ru') return new Response(receipt);
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) { calls.push(url.href); return new Response(JSON.stringify({ results: [{ error }] })); }
      return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/good', createdAt: 1767225600 } } } });
    } });
    assert.equal(calls.length, 2); assert.equal(new Set(calls).size, 2);
    assert.equal(result.stats.transientRetries, 0);
    assert.match(result.warnings.join(' '), error.code === 'RESOLVER_NOT_FOUND' ? /RESOLVER_NOT_FOUND/ : /HTTP 504/);
    assert.ok(!JSON.stringify({ stats: result.stats, warnings: result.warnings }).includes('private-secret'));
  }
});

test('cancellation during transient backoff preserves the original reason and sends no retry', async () => {
  const controller = new AbortController(), failure = new Error('cancel backoff');
  let stats: Record<string, number | boolean> | undefined, calls = 0;
  await assert.rejects(collectYandex({ signal: controller.signal, onDiagnostics: value => { stats = value; }, fetch: async input => {
    if (new URL(String(input)).pathname === '/my/orders') return new Response('');
    calls++; setTimeout(() => controller.abort(failure), 10);
    return new Response('', { status: 502 });
  } }), error => error === failure);
  assert.equal(calls, 1);
  assert.equal(stats?.transientRetries, 0);
  assert.equal(stats?.transientExhausted, 0);
});


test('settled structured timeouts retry the exact read once with a shared two-attempt budget', async () => {
  for (const second of ['success', 'timeout', 'http']) {
    const calls: string[] = [];
    const result = await collectYandex({ context: { initialOrders: { orderIds: ['123456', '234567'], pageToken: '' } }, fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'check.yandex.ru') return new Response(receipt);
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456, 234567]);
      const params = JSON.parse(String(init?.body)).params[0];
      if (params.orderId === 123456) return envelope({ result: ['good'], collections: { orderReceipt: { good: { fiscalUrl: 'https://check.yandex.ru/good', createdAt: 1767225600 } } } });
      assert.equal(params.archived, false);
      calls.push(String(input) + String(init?.body));
      if (calls.length === 1 || second === 'timeout') throw Object.assign(new Error('static'), { code: 'YANDEX_REQUEST_TIMEOUT' });
      if (second === 'http') return new Response('', { status: 502 });
      return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/recovered', createdAt: 1767225600 } } } });
    } });
    assert.equal(calls.length, 2);
    assert.equal(calls[0], calls[1]);
    assert.equal(result.stats.transientRetries, 1);
    assert.equal(result.stats.transientExhausted, second === 'success' ? 0 : 1);
    assert.equal(result.stats.requestTimeoutResponses, second === 'timeout' ? 2 : 1);
    assert.equal(result.rows.length, second === 'success' ? 2 : 1);
  }
});

test('unsettled outer timeout stops queued reads without retry or archive and keeps discovered rows', async () => {
  const calls: number[] = [];
  const result = await collectYandex({ context: { initialOrders: { orderIds: ['123456', '234567', '345678'], pageToken: '' } }, fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'check.yandex.ru') return new Response(receipt);
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456, 234567, 345678]);
    const params = JSON.parse(String(init?.body)).params[0]; calls.push(params.orderId);
    if (params.orderId === 234567) { await new Promise(resolve => setTimeout(resolve, 10)); throw Object.assign(new Error('static'), { code: 'YANDEX_REQUEST_TIMEOUT_UNSETTLED' }); }
    return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/good', createdAt: 1767225600 } } } });
  } });
  assert.deepEqual(calls, [123456, 234567]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.stats.transientRetries, 0);
  assert.equal(result.stats.incomplete, true);
});

test('cancellation during structured timeout backoff preserves original falsy reasons', async () => {
  for (const reason of [0, undefined]) {
    const controller = new AbortController(); let calls = 0;
    // AbortController substitutes its own DOMException for undefined; retain its actual reason.
    await assert.rejects(collectYandex({ signal: controller.signal, context: { initialOrders: { orderIds: [], pageToken: '' } }, fetch: async () => {
      calls++; setTimeout(() => controller.abort(reason), 10);
      throw Object.assign(new Error('static'), { code: 'YANDEX_REQUEST_TIMEOUT' });
    } }), error => error === controller.signal.reason);
    assert.equal(calls, 1);
  }
});


test('ambiguous echoed API end unions the complete bounded DOM tail before stopping on ambiguity', async () => {
  const apiIds = Array.from({ length: 144 }, (_, index) => 100000 + index);
  const domIds = Array.from({ length: 232 }, (_, index) => String(100000 + index));
  let apiPages = 0, domSteps = 0;
  const result = await collectYandex({ context: { initialOrders: { orderIds: [], pageToken: 'first' } },
    readOrdersDom: async () => { domSteps++; return domResult({ orderIds: domIds, ambiguous: true, hasMore: true }); },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'check.yandex.ru') return new Response(receipt);
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) {
        apiPages++;
        return envelope({ result: 'list', collections: { orderConsolidationResult: { list: apiPages === 1 ? { ordersGroupsIds: apiIds, pageToken: 'tail', hasNext: true } : { ordersGroupsIds: [], pageToken: 'tail' } } } });
      }
      return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/shared-fixture', createdAt: 1767225600 } } } });
    },
  });
  assert.equal(apiPages, 2);
  assert.equal(domSteps, 1);
  assert.equal(result.stats.orders, 232);
  assert.equal(result.stats.receiptMetadataRequests, 232);
  assert.equal(result.stats.domFallbackOrdersAdded, 88);
  assert.equal(result.stats.incomplete, true);
  assert.match(result.warnings.join(' '), /пустая страница не подтвердила конец/);
});

test('explicit API end avoids DOM fallback while fatal or blocked DOM IDs are never trusted', async () => {
  for (const state of ['explicit', 'fatal', 'blocked', 'limit']) {
    let domSteps = 0;
    const result = await collectYandex({ context: { initialOrders: { orderIds: ['123456'], pageToken: 'same' } },
      knownOrderIds: state === 'fatal' || state === 'blocked' ? ['123456', '345678'] : undefined,
      readOrdersDom: async () => { domSteps++; return domResult({ orderIds: ['234567'], ...(state === 'fatal' ? { fatal: true } : state === 'blocked' ? { blocked: true } : { limit: true }) }); },
      fetch: async input => {
        const url = new URL(String(input));
        if (url.hostname === 'check.yandex.ru') return new Response(receipt);
        if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return envelope({ result: 'list', collections: { orderConsolidationResult: { list: { ordersGroupsIds: [], pageToken: 'same', ...(state === 'explicit' ? { hasNext: false } : {}) } } } });
        return envelope({ result: ['r'], collections: { orderReceipt: { r: { fiscalUrl: 'https://check.yandex.ru/shared-fixture', createdAt: 1767225600 } } } });
      },
    });
    assert.equal(domSteps, state === 'explicit' ? 0 : 1);
    assert.equal(result.stats.orders, state === 'limit' ? 2 : 1);
    assert.equal(result.stats.knownOrdersAdded, 0);
    assert.equal(result.stats.incomplete, state !== 'explicit');
  }
});

const timingFields = ['listingElapsedMs', 'metadataElapsedMs', 'documentFallbackElapsedMs', 'receiptFetchElapsedMs', 'elapsedMs'] as const;
test('fixed stage durations are nonnegative integers in results and failure snapshots without private contents', async () => {
  let snapshot: Record<string, number | boolean> | undefined;
  const result = await collectYandex({ context: { initialOrders: { orderIds: ['123456'], pageToken: '' } }, onDiagnostics: value => { snapshot = value; },
    readOrderDocuments: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { urls: [], complete: false, blocked: false }; },
    fetch: async input => {
      const url = new URL(String(input));
      if (url.hostname === 'check.yandex.ru') { await new Promise(resolve => setTimeout(resolve, 20)); return new Response(receipt); }
      if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
      return envelope({ result: ['valid', 'missing'], collections: { orderReceipt: { valid: { fiscalUrl: 'https://check.yandex.ru/private-fixture', createdAt: 1767225600 }, missing: {} } } });
    },
  });
  for (const field of timingFields) {
    assert.ok(Number.isSafeInteger(result.stats[field]) && Number(result.stats[field]) >= 0);
    assert.equal(snapshot?.[field], result.stats[field]);
  }
  assert.ok(Number(result.stats.metadataElapsedMs) >= 580);
  assert.ok(Number(result.stats.documentFallbackElapsedMs) >= 15);
  assert.ok(Number(result.stats.receiptFetchElapsedMs) >= 15);
  assert.ok(Number(result.stats.elapsedMs) >= Number(result.stats.metadataElapsedMs));
  assert.ok(!JSON.stringify(snapshot).includes('private-fixture'));
  snapshot = undefined;
  await assert.rejects(collectYandex({ context: { initialOrders: { orderIds: [], pageToken: '' } }, onDiagnostics: value => { snapshot = value; }, fetch: async () => envelope({ unknown: true }) }));
  for (const field of timingFields) assert.ok(Number.isSafeInteger(snapshot?.[field]) && Number(snapshot?.[field]) >= 0);
  const failedStats = snapshot as Record<string, number | boolean> | undefined;
  assert.equal(failedStats?.metadataElapsedMs, 0);
  assert.equal(failedStats?.documentFallbackElapsedMs, 0);
  assert.equal(failedStats?.receiptFetchElapsedMs, 0);
});


function rawCacheFixture() {
  const bodies = new Map<string, string>(), events: string[] = [];
  const session: YandexReceiptCacheSession = {
    has: async url => bodies.has(url),
    read: async url => { events.push('read:' + url); return bodies.get(url); },
    write: async (url, html) => { events.push('write:' + url); bodies.set(url, html); },
    remove: async url => { events.push('remove:' + url); bodies.delete(url); },
  };
  return { bodies, events, session };
}
const completeFiscalHtml = receipt.replace('<td>1</td>', '<td>1.</td>');
type CacheFiscalFixture = { url: string; html: string; type?: string; id?: string };
function collectCachedFixture(documents: CacheFiscalFixture[], cache: YandexReceiptCacheSession, network: string[], events: string[] = [], signal?: AbortSignal) {
  return collectYandex({ signal, receiptCache: cache, context: { initialOrders: { orderIds: ['123456'], pageToken: '' } }, fetch: async input => {
    const url = new URL(String(input));
    if (url.hostname === 'check.yandex.ru') { network.push(url.href); events.push('fetch:' + url.href); return new Response(documents.find(document => document.url === url.href)!.html); }
    events.push('api');
    if (url.searchParams.get('r')?.includes('resolveConsolidationOrders')) return orderList([123456]);
    return envelope({ result: documents.map((_, index) => String(index)), collections: { orderReceipt: Object.fromEntries(documents.map((document, index) => [String(index), { id: document.id || String(index), fiscalUrl: document.url, type: document.type || 'INCOME', createdAt: 1767225600 }])) } });
  } });
}

test('warm RAW cache preserves prepayment rows and reparses current metadata while discovering new refunds over network', async () => {
  const cache = rawCacheFixture(), network: string[] = [], api: string[] = [];
  const sale = { url: 'https://check.yandex.ru/cache-sale', html: completeFiscalHtml.replace('Книга', 'Книга<br>Признак способа расчета: ПРЕДОПЛАТА 100%') };
  const cold = await collectCachedFixture([sale], cache.session, network, api);
  assert.equal(cold.rows[0]?.yandex_settlement_kind, 'prepayment');
  assert.equal(cache.bodies.get(sale.url), sale.html);
  network.length = 0; api.length = 0;
  const warm = await collectCachedFixture([sale], cache.session, network, api);
  assert.deepEqual(warm.rows, cold.rows);
  assert.deepEqual(network, []);
  assert.equal(api.filter(event => event === 'api').length, 2, 'Order and receipt metadata are always rediscovered');
  assert.equal(warm.stats.cachedReceipts, 1);
  assert.equal(warm.stats.receiptNetworkRequests, 0);
  assert.equal(warm.stats.receipts, 1);
  const refund = { url: 'https://check.yandex.ru/cache-new-refund', html: completeFiscalHtml, type: 'RETURN_INCOME' };
  const changed = await collectCachedFixture([{ ...sale, id: 'current-id', type: 'RETURN_INCOME' }, refund], cache.session, network);
  assert.deepEqual(network, [refund.url]);
  assert.equal(changed.stats.cachedReceipts, 1);
  assert.equal(changed.stats.receiptNetworkRequests, 1);
  assert.equal(changed.rows.find(row => row.receipt_url === sale.url)?.amount, '-100.00');
  assert.match(changed.rows.find(row => row.receipt_url === sale.url)?.marketplace_id || '', /current-id/);
  assert.ok(Object.keys(changed.stats).length <= 128);
});

test('invalid cached HTML is removed and fallback, unverified or failed network receipts are never cached', async () => {
  const cache = rawCacheFixture(), network: string[] = [];
  const url = 'https://check.yandex.ru/cache-invalid';
  cache.bodies.set(url, '<html>not a fiscal receipt</html>');
  const recovered = await collectCachedFixture([{ url, html: completeFiscalHtml }], cache.session, network);
  assert.deepEqual(network, [url]);
  assert.equal(recovered.stats.cachedReceipts, 0);
  assert.ok(cache.events.includes('remove:' + url));
  for (const html of [receipt, completeFiscalHtml.replace('<tr><td>ИТОГ</td><td>100,00</td></tr>', ''), '<html>unreadable</html>']) {
    cache.bodies.clear(); cache.events.length = 0;
    try { await collectCachedFixture([{ url, html }], cache.session, []); } catch { assert.equal(html, '<html>unreadable</html>'); }
    assert.equal(cache.bodies.size, 0);
    assert.ok(!cache.events.some(event => event.startsWith('write:')));
  }
});

test('cache storage errors fall back to network without failing valid receipts', async () => {
  for (const phase of ['has', 'read']) {
    const cache = rawCacheFixture(), network: string[] = [];
    cache.session.has = async () => { if (phase === 'has') throw new Error('synthetic cache unavailable'); return true; };
    cache.session.read = async () => { throw new Error('synthetic cache unavailable'); };
    cache.session.write = async () => { throw new Error('synthetic cache unavailable'); };
    const result = await collectCachedFixture([{ url: 'https://check.yandex.ru/cache-errors', html: completeFiscalHtml }], cache.session, network);
    assert.equal(network.length, 1);
    assert.equal(result.stats.cacheReadErrors, 1);
    assert.equal(result.stats.cacheWriteErrors, 1);
    assert.equal(result.stats.failedReceipts, 0);
    assert.equal(result.rows.length, 1);
  }
});

test('cache cancellation and row limits are never swallowed as optional storage failures', async () => {
  const cache = rawCacheFixture(), controller = new AbortController(), network: string[] = [];
  cache.session.read = async () => { controller.abort(0); return undefined; };
  await assert.rejects(collectCachedFixture([{ url: 'https://check.yandex.ru/cache-cancel', html: completeFiscalHtml }], cache.session, network, [], controller.signal), error => error === 0);
  assert.deepEqual(network, []);
  for (const phase of ['has', 'read', 'write']) {
    const limited = rawCacheFixture(), failure = Object.assign(new Error('limit'), { code: 'ROW_LIMIT_EXCEEDED' });
    if (phase === 'has') limited.session.has = async () => { throw failure; };
    if (phase === 'read') limited.session.read = async () => { throw failure; };
    if (phase === 'write') limited.session.write = async () => { throw failure; };
    await assert.rejects(collectCachedFixture([{ url: 'https://check.yandex.ru/cache-limit', html: completeFiscalHtml }], limited.session, []), error => error === failure);
  }
});

test('cached receipts are consumed before new downloads can evict late-sorting RAW entries', async () => {
  const cache = rawCacheFixture(), network: string[] = [], events = cache.events;
  const known = { url: 'https://check.yandex.ru/z-known', html: completeFiscalHtml };
  cache.bodies.set(known.url, known.html);
  cache.session.write = async (url, html) => { cache.bodies.clear(); cache.bodies.set(url, html); };
  const documents = Array.from({ length: 5 }, (_, index) => ({ url: `https://check.yandex.ru/a-new-${index}`, html: completeFiscalHtml })).concat([known]);
  const result = await collectCachedFixture(documents, cache.session, network, events);
  assert.ok(!network.includes(known.url));
  assert.equal(network.length, 5);
  assert.equal(result.stats.cachedReceipts, 1);
  assert.equal(result.rows.length, 6);
  assert.ok(events.indexOf('read:' + known.url) < events.findIndex(event => event.startsWith('fetch:')));
  const cold = await collectCachedFixture(documents, rawCacheFixture().session, []);
  assert.deepEqual(result.rows, cold.rows, 'Cache scheduling cannot change row order or identities');
  assert.deepEqual(result.processedReceipts, cold.processedReceipts);
});


test('CacheStorage AbortError without collection cancellation remains an optional I/O failure', async () => {
  for (const phase of ['has', 'read', 'write', 'remove']) {
    const cache = rawCacheFixture(), network: string[] = [], controller = new AbortController();
    const failure = new DOMException('Synthetic cache I/O abort', 'AbortError');
    const url = 'https://check.yandex.ru/cache-io-abort';
    if (phase === 'has') cache.session.has = async () => { throw failure; };
    if (phase === 'read') cache.session.read = async () => { throw failure; };
    if (phase === 'write') cache.session.write = async () => { throw failure; };
    if (phase === 'remove') { cache.bodies.set(url, '<html>invalid cached body</html>'); cache.session.remove = async () => { throw failure; }; }
    const result = await collectCachedFixture([{ url, html: completeFiscalHtml }], cache.session, network, [], controller.signal);
    assert.equal(controller.signal.aborted, false);
    assert.equal(network.length, 1);
    assert.equal(result.stats.failedReceipts, 0);
    assert.equal(result.stats.cacheReadErrors, phase === 'has' || phase === 'read' ? 1 : 0);
    assert.equal(result.stats.cacheWriteErrors, phase === 'write' || phase === 'remove' ? 1 : 0);
    assert.equal(result.rows.length, 1);
  }
});
