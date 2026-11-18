import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyMinor, moneyDecimal, summarize, mergeCollection, largePurchases, receiptUrl, settlementReplacements } from './domain.mjs';

test('точные копейки, ноль и нераспознанная сумма различаются', () => {
  for (const minor of [0, 1, -1, 129950, -129950]) assert.equal(moneyMinor(moneyDecimal(minor)), minor);
  assert.equal(moneyMinor('1 299,50'), 129950);
  for (const value of ['', null, 'NaN', '1.2.3', '1.234', '9007199254740991']) assert.equal(moneyMinor(value), null);
});

const row = (id, extra = {}) => ({ rowId: id, source: 'wildberries', profile: 'personal', date: '2026-01-02', title: 'Товар', amount: '100.00', currency: 'RUB', marketplace_id: id, ...extra });

test('Yandex refresh preserves an annotated fiscal line when the receipt URL and order association change', () => {
  const previous = row('saved-id', { source: 'yandex', receipt_url: 'https://check.yandex.ru/?fn=1&n=2&fpd=3',
    item_index: '1', parse_quality: 'complete', note: 'Сохранённая заметка', yandex_order_id: '123456' });
  const refreshed = row('provider-id', { ...previous, rowId: 'provider-id', receipt_url: 'https://check.yandex.ru/?n=02&fpd=3&fn=1',
    note: undefined, yandex_order_id: '' });
  delete refreshed.note;
  const neighbour = row('another-line', { ...previous, rowId: 'another-line', item_index: '2' });
  const otherProfile = row('work-id', { ...previous, rowId: 'work-id', profile: 'work' });
  const existing = [previous, neighbour, otherProfile];
  const merged = mergeCollection(existing, [refreshed], { source: 'yandex' });
  assert.deepEqual(merged.map(item => item.rowId), ['another-line', 'work-id', 'saved-id']);
  assert.equal(merged.at(-1).note, previous.note);
  assert.equal(merged.at(-1).yandex_order_id, '');
  assert.deepEqual(mergeCollection(merged, [refreshed], { source: 'yandex' }), merged);
  const weakRefresh = { ...refreshed, parse_quality: 'fallback', title: 'Не удалось прочитать позиции' };
  assert.deepEqual(mergeCollection(merged, [weakRefresh], { source: 'yandex', processedReceipts: [weakRefresh.receipt_url] }), merged);
});

test('возвраты и неполные чеки учитываются, валюты не смешиваются', () => {
  const result = summarize([row('paid'), row('refund', { amount: '-20.10', type: 'refund' }), row('fallback', { amount: '7.01', parse_quality: 'fallback' }), row('gift', { amount: '0.00' }), row('dollar', { currency: 'USD' })]);
  assert.equal(result.net, 8691);
  assert.equal(result.unread, 1);
  assert.deepEqual(result.currencies, ['USD']);
  assert.equal(largePurchases([row('fallback', { parse_quality: 'fallback' })]).length, 0);
});

test('неполный сбор не удаляет историю другого магазина, профиля и старые чеки', () => {
  const original = [row('old'), row('updated'), row('work', { profile: 'work' }), row('ozon', { source: 'ozon' })];
  const incoming = [row('updated', { amount: '99.00' })];
  const merged = mergeCollection(original, incoming, { source: 'wildberries', replace: true, complete: false });
  assert.equal(merged.length, 4);
  assert.equal(merged.find(item => item.rowId === 'updated').amount, '99.00');
  assert.equal(original[1].amount, '100.00');
  assert.equal(mergeCollection(original, incoming, { source: 'wildberries', replace: true, complete: true }).length, 3);
});

test('равная сумма и название не являются идентификатором чека', () => {
  const merged = mergeCollection([row('one')], [row('two')], { source: 'wildberries' });
  assert.equal(merged.length, 2);
  assert.equal(summarize(merged).net, 20000);
});

test('старое имя WB не удваивает прочитанный чек при повторном сборе', () => {
  const original = [row('legacy', { source: 'wb', marketplace_id: 'receipt' }), row('unvisited', { source: 'wb' }), row('work', { source: 'wb', profile: 'work', marketplace_id: 'receipt' })];
  const incoming = [row('current', { marketplace_id: 'receipt', amount: '99.00' })];
  const merged = mergeCollection(original, incoming, { source: 'wildberries' });
  assert.deepEqual(merged.map(item => item.rowId), ['unvisited', 'work', 'current']);
  assert.equal(summarize(merged).net, 29900);
  assert.deepEqual(mergeCollection(merged, incoming, { source: 'wildberries' }), merged);
  assert.deepEqual(mergeCollection(original, [], { source: 'wildberries', processedReceipts: ['receipt'] }).map(item => item.rowId), ['unvisited', 'work']);
  assert.equal(original[0].source, 'wb');
});

test('повторный сбор удаляет сверенную предоплату, сохраняя непрочитанные чеки и другой профиль', () => {
  const original = [row('pre', { receipt_url: 'https://receipt.wb.ru/pre' }), row('failed'), row('work', { profile: 'work', receipt_url: 'https://receipt.wb.ru/pre' })];
  const merged = mergeCollection(original, [row('final')], { source: 'wildberries', processedReceipts: ['https://receipt.wb.ru/pre', 'final'] });
  assert.deepEqual(merged.map(row => row.rowId), ['failed', 'work', 'final']);
  assert.deepEqual(mergeCollection(merged, [row('final')], { source: 'wildberries', processedReceipts: ['https://receipt.wb.ru/pre', 'final'] }), merged);
});

test('ссылка исправленного чека имеет приоритет, исполняемые URL запрещены', () => {
  const item = row('one', { receipt_url: 'https://receipt.wb.ru/old' });
  assert.equal(receiptUrl(item, { one: { url: 'https://receipt.wb.ru/new' } }), 'https://receipt.wb.ru/new');
  assert.equal(receiptUrl(row('bad', { receipt_url: 'javascript:alert(1)' })), '');
});

for (const source of ['ozon', 'yandex']) {
  const receipt = (id, kind, extra = {}) => row(id, {
    source, receipt_url: `https://receipts.test/${id}`, [`${source}_order_id`]: 'order',
    [`${source}_settlement_kind`]: kind, item_index: '1', parse_quality: 'complete', type: 'purchase', ...extra
  });
  const collect = (existing, incoming, extra = {}) => mergeCollection(existing, incoming, { source, ...extra });
  test(`${source}: sequential prepayment/final batches reconcile in either arrival order`, () => {
    const pre = receipt('pre', 'prepayment', { date: '2026-01-01' });
    const final = receipt('final', 'full');
    for (const [first, second] of [[pre, final], [final, pre]]) {
      const result = collect(collect([], [first]), [second]);
      assert.equal(result.length, 1);
      assert.equal(result[0].rowId, 'final');
      assert.equal(summarize(result).net, 10000);
      assert.deepEqual(settlementReplacements(result), { pre: 'final' });
      assert.equal(Object.hasOwn(first, 'settlement_predecessor'), false);
    }
  });
  test(`${source}: final stays consumed across raw rereads and new identical repeat`, () => {
    const pre = receipt('pre-a', 'prepayment', { date: '2026-01-01' });
    const final = receipt('final', 'full');
    const repeat = receipt('pre-b', 'prepayment', { date: '2026-01-01' });
    let result = collect(collect([], [pre]), [final]);
    result = collect(result, [final]);
    result = collect(result, [pre]);
    assert.deepEqual(result.map(row => row.rowId), ['final']);
    result = collect(result, [repeat]);
    assert.deepEqual(result.map(row => row.rowId), ['final', 'pre-b']);
    const reread = collect(result, [repeat, pre, final]);
    assert.deepEqual(reread.map(row => row.rowId).sort(), ['final', 'pre-b']);
    assert.equal(summarize(reread).net, 20000);
    assert.deepEqual(collect(reread, [pre, repeat, final]), collect(result, [pre, repeat, final]));
    result = collect(reread, [receipt('final-b', 'full')]);
    assert.deepEqual(result.map(row => row.rowId).sort(), ['final', 'final-b']);
    assert.equal(summarize(result).net, 20000);
    result = collect(result, [final]);
    result = collect(result, [pre]);
    assert.equal(result.find(row => row.rowId === 'final-b').settlement_predecessor.rowId, 'pre-b');
    assert.deepEqual(settlementReplacements(result), { 'pre-a': 'final', 'pre-b': 'final-b' });
  });
  test(`${source}: fiscal identity keeps a consumed final and its annotations across order aliases`, () => {
    const pre = receipt('pre-a', 'prepayment', { date: '2026-01-01' });
    const final = receipt('final', 'full', { note: 'keep', futureField: { keep: true } });
    const accepted = collect(collect([], [pre]), [final]);
    const refreshed = receipt('refreshed', 'full', { receipt_url: final.receipt_url, marketplace_id: 'new-alias:receipt', [`${source}_order_id`]: 'new-alias' });
    let result = collect(accepted, [refreshed]);
    assert.equal(result[0].rowId, 'final');
    assert.equal(result[0].note, 'keep');
    assert.deepEqual(result[0].futureField, { keep: true });
    assert.deepEqual(result[0].settlement_predecessor, accepted[0].settlement_predecessor);
    const precise = collect(accepted, [{ ...refreshed, date: `${final.date.slice(0, 10)}T12:00:00Z` }]);
    assert.equal(precise[0].rowId, 'final', 'Adding time precision does not change fiscal item identity');
    assert.deepEqual(precise[0].settlement_predecessor, accepted[0].settlement_predecessor);
    for (const alias of ['order', 'new-alias']) {
      result = collect(result, [{ ...pre, rowId: 'reread-pre', [`${source}_order_id`]: alias }]);
      assert.deepEqual(result.map(row => row.rowId), ['final']);
    }
    for (const changed of [{ amount: '101.00' }, { currency: 'USD' }, { title: 'Different item' }, { item_index: '2' }, { date: '2026-03-01' }, { parse_quality: 'unverified' }, { type: 'refund', amount: '-100.00' }]) {
      assert.equal(collect(result, [{ ...pre, ...changed, [`${source}_order_id`]: 'new-alias' }]).length, 2);
    }
    assert.equal(collect(result, [pre], { profile: 'work' }).length, 2);
    const untouched = [...result, { ...pre, [`${source}_order_id`]: 'new-alias' }];
    const unrelated = receipt('unrelated', 'full', { [`${source}_order_id`]: 'unrelated-order' });
    assert.equal(collect(untouched, [unrelated]).length, 3, 'Only an updated receipt can trigger reconciliation');
    const repeat = receipt('pre-b', 'prepayment', { date: '2026-01-01', [`${source}_order_id`]: 'new-alias' });
    result = collect(result, [repeat]);
    assert.deepEqual(result.map(row => row.rowId), ['final', 'pre-b']);
    assert.equal(summarize(result).net, 20000);
    for (const changed of [{ amount: '101.00' }, { title: 'Different item' }, { item_index: '2' }, { date: '2026-02-02' }, { parse_quality: 'unverified' }]) {
      const replacement = collect(accepted, [{ ...refreshed, ...changed }]).find(row => row.rowId === 'refreshed');
      assert.ok(replacement);
      assert.equal(Object.hasOwn(replacement, 'settlement_predecessor'), false);
    }
  });
  test(`${source}: partial batches preserve other profiles, refunds, sparse and unrelated history`, () => {
    const legacy = receipt('legacy', 'prepayment', { [`${source}_order_id`]: undefined });
    const unknown = receipt('unknown', 'unknown');
    const refund = receipt('refund', 'prepayment', { amount: '-100.00', type: 'refund' });
    const differentItem = receipt('item', 'prepayment', { item_index: '2', title: 'Другой товар' });
    const differentOrder = receipt('other', 'prepayment', { [`${source}_order_id`]: 'other' });
    const work = receipt('work', 'prepayment', { profile: 'work', opaque: { keep: true } });
    const unverified = receipt('unverified', 'prepayment', { parse_quality: 'unverified' });
    const history = [legacy, unknown, refund, differentItem, differentOrder, work, unverified];
    const result = collect(history, [receipt('final', 'full')]);
    assert.equal(result.length, history.length + 1);
    assert.deepEqual(result.slice(0, history.length), history);
    const oldPair = [receipt('old-pre', 'prepayment'), receipt('old-final', 'full')];
    assert.deepEqual(collect(oldPair, [differentOrder]).slice(0, 2), oldPair);
    assert.equal(collect([receipt('pre', 'prepayment')], [receipt('refund-final', 'full', { type: 'refund', amount: '-100.00' })]).length, 2);
    assert.equal(collect([receipt('pre', 'prepayment', { date: '2026-03-01' })], [receipt('final', 'full')]).length, 2);
    for (const extra of [{ item_index: undefined }, { date: '' }, { currency: 'USD' }]) {
      assert.equal(collect([receipt('pre', 'prepayment', extra)], [receipt('final', 'full')]).length, 2);
    }
    for (const marker of [null, [], 'legacy', { receipt: 'pre', item: '1', rowId: 123 }]) {
      const malformed = receipt('final', 'full', { settlement_predecessor: marker });
      const result = collect([receipt('pre', 'prepayment')], [malformed]);
      assert.equal(result.length, 2);
      assert.deepEqual(result[1].settlement_predecessor, marker);
    }
  });
}
