import test from 'node:test';
import assert from 'node:assert/strict';
import { withDeadline } from './deadline.ts';
test('a non-responsive browser bridge times out and a successful response survives', async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 'Магазин не ответил', 10), /Магазин не ответил/);
  assert.equal(await withDeadline(Promise.resolve(42), 'timeout', 10), 42);
});
