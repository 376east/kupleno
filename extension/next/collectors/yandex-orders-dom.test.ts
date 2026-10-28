import test from 'node:test';
import assert from 'node:assert/strict';
import { yandexOrdersDomStep } from './yandex-orders-dom.ts';

test('fixed DOM step clicks only one visible listing button and stops on fatal, ambiguity or challenge', () => {
  class Element {
    clicked = 0;
    textContent: string; attributes: Record<string, string>;
    constructor(textContent = '', attributes: Record<string, string> = {}) { this.textContent = textContent; this.attributes = attributes; }
    getClientRects() { return [1]; }
    getAttribute(key: string) { return this.attributes[key] || null; }
    hasAttribute(key: string) { return Object.hasOwn(this.attributes, key); }
    closest() { return this.attributes.form ? this : null; }
    click() { this.clicked++; }
  }
  const globals = ['document', 'location', 'HTMLElement', 'getComputedStyle'];
  const saved = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  try {
    for (const mode of ['normal', 'fatal', 'ambiguous', 'challenge', 'form', 'navigated', 'end']) {
      const button = new Element('Показать ещё', mode === 'form' ? { form: 'yes' } : {});
      const nodes: Record<string, Element[]> = {
        'h1,h2,[role="heading"]': mode === 'fatal' ? [new Element('Что-то пошло не так')] : [],
        'form[action],iframe[src]': mode === 'challenge' ? [new Element('', { action: '/checkcaptcha' })] : [],
        'a[href*="/my/order/"]': [new Element('', { href: '/my/order/123456' }), new Element('', { href: 'https://evil.test/my/order/999999' })],
        'button,[role="button"]': mode === 'end' ? [] : mode === 'ambiguous' ? [button, new Element('Показать ещё')] : [button],
      };
      const values: unknown[] = [
        { documentElement: { innerHTML: '<script>{"route":"/my/order/234567"}</script>' }, querySelectorAll: (selector: string) => nodes[selector] || [] },
        { origin: 'https://market.yandex.ru', pathname: mode === 'navigated' ? '/my/order/123456' : '/my/orders', href: 'https://market.yandex.ru/my/orders?filter=COMPLETED' },
        Element, () => ({ visibility: 'visible', display: 'block' }),
      ];
      globals.forEach((key, index) => Object.defineProperty(globalThis, key, { value: values[index], configurable: true }));
      const result = yandexOrdersDomStep();
      assert.equal(button.clicked, mode === 'normal' ? 1 : 0, mode);
      assert.equal(result.fatal, mode === 'fatal');
      assert.equal(result.ambiguous, mode === 'ambiguous');
      if (mode === 'normal' || mode === 'end') assert.deepEqual(result.orderIds, ['234567', '123456']);
      if (mode === 'normal') {
        for (let read = 0; read < 3; read++) assert.equal(yandexOrdersDomStep(['123456', '234567']).clicked, false);
        assert.equal(button.clicked, 1, 'An enabled button is not clicked again without a new ID');
        assert.equal(yandexOrdersDomStep(['123456', '999999']).clicked, true, 'A new ID permits the next click even with the same ID count');
      }
    }
  } finally { globals.forEach((key, index) => { if (saved[index]) Object.defineProperty(globalThis, key, saved[index]!); else Reflect.deleteProperty(globalThis, key); }); }
});
