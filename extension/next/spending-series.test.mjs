import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spendingSeries } from './spending-series.mjs';
const row = (date, amount, more = {}) => ({ date, amount, ...more });
test('full dates group and sort without mixing months; refunds retain exact kopecks', () => {
  const result = spendingSeries([row('2026-10-01','12.50'),row('2026-09-01','10'),row('2026-10-01','2.20',{type:'refund'}),row('2026-10-02','-1.01')]);
  assert.deepEqual(result.points, [{date:'2026-09-01',amount:1000,total:1000,count:1},{date:'2026-10-01',amount:1030,total:2030,count:2},{date:'2026-10-02',amount:-101,total:1929,count:1}]);
});
test('the chart uses the same excluded/currency/invalid-amount rules as the financial core', () => {
  const rows=[row('2026-10-01','10'),row('2026-10-01','100',{excluded:true}),row('2026-10-01','100',{currency:'USD'}),row('2026-10-01','invalid')];
  assert.equal(spendingSeries(rows).points[0].total,1000);assert.equal(rows.length,4);
});
test('invalid calendar dates are reported rather than moved into another month', () => {
  const result=spendingSeries([row('2026-02-31','10'),row('missing','10'),row('2026-10-01T12:00:00','1')]);
  assert.equal(result.undated,2);assert.equal(result.points.length,1);
});
test('unsafe cumulative sums are rejected', () => {
  assert.throws(()=>spendingSeries([row('2026-10-01','90071992547409.90'),row('2026-10-02','10')]),RangeError);
});
