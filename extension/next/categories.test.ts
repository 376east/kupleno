import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { classify } from './categories.ts';
import benchmark from '../category-benchmark.json' with { type: 'json' };
import refinements from '../category-rules.json' with { type: 'json' };
const legacy = createRequire(import.meta.url)('../categories.js');
legacy.setSpendCategoryRules(refinements);
test('typed categorizer preserves decisions on the entire existing independent benchmark', () => {
  for (const item of benchmark.cases) {
    const before = legacy.classifySpendCategory(item.title), after = classify(item.title);
    assert.equal(after.category, before.category, item.title);
    assert.equal(after.needsReview, before.needsReview, item.title);
    assert.equal(after.confidence, before.confidence, item.title);
  }
});
test('ambiguous names and unread receipts are never confidently classified', () => {
  for (const title of ['Набор', 'Масло', 'Ozon PDF не разобран (123)']) assert.equal(classify(title).needsReview, true);
  assert.notEqual(classify('Кофейный столик для гостиной').category, 'Продукты');
});
