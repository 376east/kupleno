import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { readYandexOrderDocuments } from './worker/yandex-order-documents.ts';

const orderUrl = 'https://market.yandex.ru/my/order/123456';
const button = '<button type="button">Чеки и другие документы</button>';
const inertReceipt = '<span role="button" tabindex="0"><span>Чек доставки</span><span>01 января 2026, 12:00</span></span>';
const knownEmpty = '<h4>Документы пока не готовы</h4><span>Они появятся здесь чуть позже</span>';
const dialog = `<section role="dialog"><h2>Документы по заказу</h2>
  <a href="https://check.yandex.ru/receipt?test=purchase">Чек покупки</a>
  <a href="https://check.yandex.ru/receipt?test=delivery">Чек доставки</a>
  <a href="https://check.yandex.ru/receipt?test=purchase">Повтор ссылки</a>
  <a href="https://market.yandex.ru/confirmation">Подтверждение покупки</a>
  <a href="https://user:pass@check.yandex.ru/private">Недопустимая ссылка</a>
  <a href="http://check.yandex.ru/plain">Недопустимая ссылка</a>
  <a href="https://check.yandex.ru.evil.test/fake">Недопустимая ссылка</a>
  <a href="/relative">Относительная ссылка</a>
  <a href="https://check.yandex.ru/${'x'.repeat(16001)}">Длинная ссылка</a>
</section>`;

type Api = Parameters<typeof readYandexOrderDocuments>[1]['browser'];
async function fixture(context: BrowserContext, markup = button, clickMarkup = dialog, { holdImage = false, includeOutsideLink = true } = {}) {
  let page: Page | undefined, creates = 0, removes = 0, clicks = 0, reads = 0;
  let pending = '', overrideUrl = '', status = 'complete', beforeGet: (() => void) | undefined;
  let registered = false, releases = 0;
  const calls: string[] = [];
  const api = {
    tabs: {
      async create(properties: { url: string; active: boolean }) {
        creates++;
        assert.deepEqual(properties, { url: orderUrl, active: false });
        page = await context.newPage();
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>${markup}
          ${includeOutsideLink ? '<a href="https://check.yandex.ru/outside">Вне диалога</a>' : ''}
          <script>window.clicks=0;document.querySelectorAll('button,[role="button"]').forEach(b=>b.addEventListener('click',()=>{window.clicks++;setTimeout(()=>document.body.insertAdjacentHTML('beforeend',${JSON.stringify(clickMarkup)}),10)}));</script>
        </body></html>` }));
        if (holdImage) await page.route('**/held-image.png', () => {});
        await page.goto(properties.url, { waitUntil: holdImage ? 'domcontentloaded' : 'load' });
        return { id: 7 };
      },
      async get(id: number) {
        assert.equal(id, 7);
        beforeGet?.();
        return { id, url: overrideUrl || page?.url(), status, ...(pending ? { pendingUrl: pending } : {}) };
      },
      async remove(id: number) {
        assert.equal(id, 7);
        removes++;
        clicks = await page!.evaluate('window.clicks');
        await page!.close();
      }
    },
    scripting: {
      async executeScript(injection: { target: { tabId: number }; world: string; func: (...args: never[]) => unknown; args: string[] }) {
        assert.equal(injection.target.tabId, 7);
        assert.equal(injection.world, 'ISOLATED');
        if (injection.args[1] !== 'inspect') assert.equal(registered, true, 'Ownership must be persisted before UI actions');
        calls.push(injection.args[1]!);
        if (injection.args[1] === 'read') reads++;
        const result = await page!.evaluate(({ source, args }) => (0, eval)(`(${source})`)(...args), { source: injection.func.toString(), args: injection.args });
        return [{ result }];
      }
    }
  } as unknown as Api;
  return {
    api, calls,
    async onOpened(id: number, orderId: string) { assert.equal(id, 7); assert.equal(orderId, '123456'); registered = true; },
    async onReleased(id: number, orderId: string) { assert.equal(id, 7); assert.equal(orderId, '123456'); registered = false; releases++; },
    get page() { return page!; }, get creates() { return creates; }, get removes() { return removes; }, get clicks() { return clicks; }, get reads() { return reads; },
    get releases() { return releases; },
    pending(value: string) { pending = value; }, navigate(value: string) { overrideUrl = value; }, beforeGet(callback: () => void) { beforeGet = callback; },
    loading() { status = 'loading'; }
  };
}

test('order documents helper uses only its own offline fixture tab', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  const context = await browser.newContext();
  // Every request, including unknown fixture hosts, is answered locally.
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture</title>' }));
  try {
    await t.test('validates before creating any tab', async () => {
      const f = await fixture(context);
      for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', '001', '1?x=2', 'https://example.test', null]) {
        await assert.rejects(readYandexOrderDocuments(id, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, isCurrent: () => true }), /Некорректный номер/);
      }
      assert.equal(f.creates, 0);
    });
    await t.test('already cancelled or stale jobs create no tab', async () => {
      const controller = new AbortController(); controller.abort();
      const f = await fixture(context);
      let noTabs = 0;
      const onNoTab = () => { noTabs++; };
      await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, onNoTab, isCurrent: () => false });
      assert.equal(noTabs, 1);
      await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, onNoTab, signal: controller.signal, isCurrent: () => true });
      assert.equal(noTabs, 2, 'Exactly one release for each precreate refusal');
      assert.equal(f.creates, 0);
    });
    await t.test('creation rejection, synchronous throw or missing valid ID releases the reservation exactly once', async () => {
      for (const mode of ['reject', 'throw', 'missing', 'invalid']) {
        let noTabs = 0;
        const api = {
          tabs: { create: () => {
            if (mode === 'throw') throw new Error('Synthetic create failure');
            return mode === 'reject' ? Promise.reject(new Error('Synthetic create rejection')) : Promise.resolve(mode === 'missing' ? {} : { id: -1 });
          } }
        } as unknown as Api;
        const result = await readYandexOrderDocuments(123456, {
          browser: api, isCurrent: () => true, timeoutMs: 100,
          onNoTab: () => { noTabs++; },
          onOpened: async () => { assert.fail('No tab was created'); },
          onReleased: async () => { assert.fail('Use only onNoTab for this case'); }
        });
        assert.equal(result.complete, false);
        assert.equal(noTabs, 1, mode);
      }
    });
    await t.test('pending timeout retains the reservation until the underlying late rejection', async () => {
      let rejectCreation!: (error: Error) => void;
      const creation = new Promise<never>((_, reject) => { rejectCreation = reject; });
      let noTabs = 0;
      await readYandexOrderDocuments(123456, {
        browser: { tabs: { create: () => creation } } as unknown as Api,
        isCurrent: () => true, timeoutMs: 100, onNoTab: () => { noTabs++; },
        onOpened: async () => { assert.fail('Rejected creation cannot open a tab'); },
        onReleased: async () => { assert.fail('Rejected creation cannot release a tab'); }
      });
      assert.equal(noTabs, 0, 'A still-pending create must keep its reservation');
      rejectCreation(new Error('Synthetic late create rejection'));
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(noTabs, 1);
    });
    await t.test('late-created tab is durably registered and retained when cleanup cannot inspect it', async () => {
      let resolveCreation!: (tab: { id: number }) => void;
      const creation = new Promise<{ id: number }>(resolve => { resolveCreation = resolve; });
      let registered = false, released = false, removed = false, noTabs = 0;
      let cleanupReached!: () => void;
      const cleanup = new Promise<void>(resolve => { cleanupReached = resolve; });
      const api = {
        tabs: {
          create: () => creation,
          get: async () => {
            assert.equal(registered, true, 'Register a late tab before any cleanup attempt');
            cleanupReached();
            throw new Error('Synthetic tab inspection failure');
          },
          remove: async () => { removed = true; }
        },
        scripting: { executeScript: async () => { throw new Error('No UI action expected'); } }
      } as unknown as Api;
      const result = await readYandexOrderDocuments(123456, {
        browser: api, isCurrent: () => true, timeoutMs: 100, onNoTab: () => { noTabs++; },
        onOpened: async (tabId, orderId) => { assert.equal(tabId, 7); assert.equal(orderId, '123456'); registered = true; },
        onReleased: async () => { released = true; registered = false; }
      });
      assert.equal(result.complete, false);
      assert.equal(noTabs, 0);
      resolveCreation({ id: 7 });
      await cleanup;
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(registered, true);
      assert.equal(released, false);
      assert.equal(removed, false);
      assert.equal(noTabs, 0, 'Late success retains ownership rather than reporting no tab');
    });
    await t.test('late initial blank is registered, removed and then released after the job has ended', async () => {
      let resolveCreation!: (tab: { id: number }) => void;
      const creation = new Promise<{ id: number }>(resolve => { resolveCreation = resolve; });
      const order: string[] = [];
      let released!: () => void;
      const release = new Promise<void>(resolve => { released = resolve; });
      const api = {
        tabs: {
          create: () => creation,
          get: async () => { assert.deepEqual(order, ['registered']); return { id: 7, url: 'about:blank', pendingUrl: orderUrl, status: 'loading' }; },
          remove: async (id: number) => { assert.equal(id, 7); order.push('removed'); }
        },
        scripting: { executeScript: async () => { throw new Error('No DOM action during initial blank cleanup'); } }
      } as unknown as Api;
      await readYandexOrderDocuments(123456, {
        browser: api, isCurrent: () => true, timeoutMs: 100,
        onOpened: async (id, orderId) => { assert.equal(id, 7); assert.equal(orderId, '123456'); order.push('registered'); },
        onReleased: async () => { order.push('released'); released(); }
      });
      resolveCreation({ id: 7 });
      await release;
      assert.deepEqual(order, ['registered', 'removed', 'released']);
    });
    await t.test('one click reads only real fiscal anchors in the visible order dialog', async () => {
      const f = await fixture(context);
      const result = await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 1500 });
      assert.deepEqual(result, { urls: ['https://check.yandex.ru/receipt?test=purchase', 'https://check.yandex.ru/receipt?test=delivery'], complete: true, blocked: false });
      assert.equal(f.clicks, 1);
      assert.equal(f.calls.filter(action => action === 'click').length, 1);
      assert.equal(f.removes, 1);
      assert.ok(f.reads > 0);
    });
    await t.test('one delayed retry opens documents after the first click precedes listener installation', async () => {
      const f = await fixture(context);
      const result = await readYandexOrderDocuments(123456, {
        browser: f.api, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 4500,
        onOpened: async (id, orderId) => {
          await f.onOpened(id, orderId);
          await f.page.evaluate(dialog => {
            const previous = document.querySelector('button')!;
            const button = previous.cloneNode(true) as HTMLButtonElement; previous.replaceWith(button);
            button.addEventListener('click', () => { (window as unknown as { clicks: number }).clicks++; });
            setTimeout(() => button.addEventListener('click', () => document.body.insertAdjacentHTML('beforeend', dialog)), 750);
          }, dialog);
        }
      });
      assert.deepEqual(result, { urls: ['https://check.yandex.ru/receipt?test=purchase', 'https://check.yandex.ru/receipt?test=delivery'], complete: true, blocked: false });
      assert.equal(f.clicks, 2);
      assert.equal(f.calls.filter(action => action === 'click').length, 1);
      assert.equal(f.calls.filter(action => action === 'retry').length, 1);
      assert.equal(f.releases, 1);
    });
    await t.test('a temporarily disabled documents button does not spend the retry', async () => {
      const f = await fixture(context);
      const execute = f.api.scripting.executeScript.bind(f.api.scripting);
      let held = false;
      f.api.scripting.executeScript = (async injection => {
        if ('args' in injection && injection.args?.[1] === 'retry' && !held) {
          held = true;
          await f.page.evaluate(() => { document.querySelector('button')!.disabled = true; });
          const result = await execute(injection);
          await f.page.evaluate(() => { document.querySelector('button')!.disabled = false; });
          return result;
        }
        return execute(injection);
      }) as Api['scripting']['executeScript'];
      const result = await readYandexOrderDocuments(123456, {
        browser: f.api, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 4800,
        onOpened: async (id, orderId) => {
          await f.onOpened(id, orderId);
          await f.page.evaluate(markup => {
            const previous = document.querySelector('button')!;
            const button = previous.cloneNode(true) as HTMLButtonElement;
            previous.replaceWith(button);
            button.addEventListener('click', () => {
              const state = window as unknown as { clicks: number };
              if (++state.clicks === 2) document.body.insertAdjacentHTML('beforeend', markup);
            });
          }, `<section role="dialog"><h3>Документы по заказу</h3>${knownEmpty}</section>`);
        },
      });
      assert.deepEqual(result, { urls: [], complete: true, blocked: false });
      assert.equal(f.clicks, 2);
      assert.equal(f.releases, 1);
    });
    for (const otherDialog of [false, true]) await t.test(`a ${otherDialog ? 'different' : 'documents'} dialog appearing just before retry prevents a toggle click`, async () => {
      const f = await fixture(context);
      const execute = f.api.scripting.executeScript.bind(f.api.scripting);
      f.api.scripting.executeScript = (async injection => {
        if ('args' in injection && injection.args?.[1] === 'retry') {
          await f.page.evaluate(markup => document.body.insertAdjacentHTML('beforeend', markup), otherDialog ? '<div role="dialog">Other visible dialog</div>' : dialog);
        }
        return execute(injection);
      }) as Api['scripting']['executeScript'];
      const result = await readYandexOrderDocuments(123456, {
        browser: f.api, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 3600,
        onOpened: async (id, orderId) => {
          await f.onOpened(id, orderId);
          await f.page.evaluate(() => {
            const previous = document.querySelector('button')!;
            const button = previous.cloneNode(true); previous.replaceWith(button);
            button.addEventListener('click', () => {
              (window as unknown as { clicks: number }).clicks++;
              document.querySelector('[role="dialog"]')?.remove();
            });
          });
        }
      });
      assert.equal(result.complete, !otherDialog);
      assert.deepEqual(result.urls, otherDialog ? [] : ['https://check.yandex.ru/receipt?test=purchase', 'https://check.yandex.ru/receipt?test=delivery']);
      assert.equal(f.clicks, 1, 'Serialized guard must see the new dialog before dispatching another click');
      assert.equal(f.calls.filter(action => action === 'click').length, 1);
      assert.equal(f.calls.filter(action => action === 'retry').length, 1);
      assert.equal(f.releases, 1);
    });
    await t.test('an opened loading dialog never receives a retry click after three seconds', async () => {
      const f = await fixture(context, button, '<div role="dialog" aria-busy="true">Документы по заказу</div>');
      const result = await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 3500 });
      assert.deepEqual(result, { urls: [], complete: false, blocked: false, failureReason: 'loading' });
      assert.equal(f.clicks, 1);
      assert.equal(f.calls.filter(action => action === 'click').length, 1);
      assert.equal(f.calls.includes('retry'), false);
    });
    for (const cancel of [false, true]) await t.test(`${cancel ? 'cancellation before three seconds stops' : 'a missing listener permits at most'} one delayed retry`, async () => {
      const f = await fixture(context, button, '');
      const controller = new AbortController();
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await readYandexOrderDocuments(123456, {
          browser: f.api, onReleased: f.onReleased, isCurrent: () => true, signal: controller.signal, timeoutMs: 3700,
          onOpened: async (id, orderId) => {
            await f.onOpened(id, orderId);
            if (cancel) cancelTimer = setTimeout(() => controller.abort(), 750);
          }
        });
        assert.deepEqual(result, { urls: [], complete: false, blocked: false, ...(cancel ? {} : { failureReason: 'dialog' }) });
        assert.equal(f.clicks, cancel ? 1 : 2);
        assert.equal(f.calls.filter(action => action === 'click').length, 1);
        assert.equal(f.calls.filter(action => action === 'retry').length, cancel ? 0 : 1);
        assert.equal(f.releases, 1);
      } finally { clearTimeout(cancelTimer); }
    });
    await t.test('an empty dialog does not prove documents are loaded or absent', async () => {
      const f = await fixture(context, button, '<div role="dialog">Документы по заказу</div>');
      assert.deepEqual(await readYandexOrderDocuments('123456', { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 500 }), { urls: [], complete: false, blocked: false, failureReason: 'unrecognized' });
    });
    const unpaidCancellation = '<div><h4>Отменён</h4><span>Не оплачен вовремя</span></div>';
    await t.test('an explicitly unpaid cancellation without a receipt link completes without clicking', async () => {
      const f = await fixture(context, unpaidCancellation, '', { includeOutsideLink: false });
      assert.deepEqual(await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 1500 }),
        { urls: [], complete: true, blocked: false });
      assert.equal(f.calls.filter(action => action === 'click').length, 2);
      assert.equal(f.clicks, 0);
      assert.equal(f.releases, 1);
    });
    for (const [markup, includeOutsideLink] of [
      [unpaidCancellation.replace('Не оплачен вовремя', 'Отменён по просьбе покупателя'), false],
      [unpaidCancellation.replace('<span>', '<span hidden>'), false],
      [unpaidCancellation, true],
    ] as const) {
      const f = await fixture(context, markup, '', { includeOutsideLink });
      assert.deepEqual(await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 600 }),
        { urls: [], complete: false, blocked: false, failureReason: 'button' });
    }
    for (const [name, markup] of [['final inert receipt', inertReceipt], ['known empty state', knownEmpty]]) await t.test(`${name} completes after two stable reads without waiting for the deadline`, async () => {
      const f = await fixture(context, button, `<div role="dialog">Документы по заказу${markup}</div>`);
      const result = await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 1500 });
      assert.deepEqual(result, { urls: [], complete: true, blocked: false });
      assert.equal(f.reads, 2);
      assert.equal(f.clicks, 1);
      assert.equal(f.releases, 1);
    });
    for (const [name, markup] of [
      ['hidden inert receipt', `<div hidden>${inertReceipt}</div>`],
      ['aria-hidden inert receipt', `<div aria-hidden="true">${inertReceipt}</div>`],
      ['hidden empty state', `<div style="display:none">${knownEmpty}</div>`],
      ['hidden fiscal anchor', '<a style="visibility:hidden" href="https://check.yandex.ru/hidden">Чек покупки</a>'],
      ['unknown receipt label', inertReceipt.replace('Чек доставки', 'Неизвестный документ')],
      ['empty receipt subtitle', inertReceipt.replace('01 января 2026, 12:00', '')],
      ['loading receipt subtitle', inertReceipt.replace('01 января 2026, 12:00', 'Загрузка…')],
      ['unknown receipt subtitle', inertReceipt.replace('01 января 2026, 12:00', 'Документ готовится')],
      ['invalid receipt date subtitle', inertReceipt.replace('01 января 2026, 12:00', '99 января 2026, 25:90')],
      ['active nested receipt button', inertReceipt.replace('Чек доставки', '<button>Чек доставки</button>')],
      ['provider error', `<p>Ошибка загрузки документов</p>${inertReceipt}`],
      ['only half the empty cue', '<p>Документы пока не готовы</p>']
    ]) await t.test(`${name} does not prove a final empty dialog`, async () => {
      const f = await fixture(context, button, `<div role="dialog">Документы по заказу${markup}</div>`);
      const result = await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 350 });
      assert.equal(result.complete, false);
      assert.deepEqual(result.urls, []);
    });
    await t.test('busy inert receipt rows wait for a delayed actual fiscal anchor', async () => {
      const f = await fixture(context, button, `<div role="dialog" aria-busy="true">Документы по заказу${inertReceipt}<progress></progress></div>`);
      const result = await readYandexOrderDocuments(123456, {
        browser: f.api, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 1500,
        onOpened: async (id, orderId) => {
          await f.onOpened(id, orderId);
          await f.page.evaluate(() => {
            document.querySelector('button')!.addEventListener('click', () => setTimeout(() => {
              const dialog = document.querySelector('[role="dialog"]')!;
              dialog.removeAttribute('aria-busy'); dialog.querySelector('progress')!.remove();
              dialog.insertAdjacentHTML('beforeend', '<a href="https://check.yandex.ru/ready">Чек покупки</a>');
            }, 250));
          });
        }
      });
      assert.deepEqual(result, { urls: ['https://check.yandex.ru/ready'], complete: true, blocked: false });
      assert.ok(f.reads >= 3);
    });
    await t.test('a loading receipt subtitle without an explicit busy flag waits for the actual fiscal href', async () => {
      const f = await fixture(context, button, `<div role="dialog">Документы по заказу${inertReceipt.replace('01 января 2026, 12:00', 'Загрузка…')}</div>`);
      const result = await readYandexOrderDocuments(123456, {
        browser: f.api, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 1500,
        onOpened: async (id, orderId) => {
          await f.onOpened(id, orderId);
          await f.page.evaluate(() => {
            document.querySelector('button')!.addEventListener('click', () => setTimeout(() => {
              document.querySelector('[role="dialog"]')!.insertAdjacentHTML('beforeend', '<a href="https://check.yandex.ru/loaded">Чек доставки</a>');
            }, 300));
          });
        }
      });
      assert.deepEqual(result, { urls: ['https://check.yandex.ru/loaded'], complete: true, blocked: false });
      assert.ok(f.reads >= 3);
      assert.equal(f.clicks, 1);
    });
    await t.test('cancellation between inert-row stability reads does not claim completion', async () => {
      const controller = new AbortController();
      const f = await fixture(context, button, `<div role="dialog">Документы по заказу${inertReceipt}</div>`);
      f.beforeGet(() => { if (f.reads) controller.abort(); });
      const result = await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, signal: controller.signal, isCurrent: () => true, timeoutMs: 1500 });
      assert.equal(result.complete, false);
      assert.equal(f.reads, 1);
      assert.equal(f.removes, 1);
      assert.equal(f.releases, 1);
    });
    for (const mode of ['delayed', 'growing', 'busy']) await t.test(`waits for ${mode} dialog links and two stable reads`, async () => {
      const initial = `<div role="dialog" ${mode === 'busy' ? 'aria-busy="true"' : ''}>Документы по заказу${mode === 'delayed' ? '' : '<a href="https://check.yandex.ru/first">Чек покупки</a>'}</div>`;
      const f = await fixture(context, button, initial);
      const result = await readYandexOrderDocuments(123456, {
        browser: f.api, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 1500,
        onOpened: async (id, orderId) => {
          await f.onOpened(id, orderId);
          await f.page.evaluate(mode => {
            document.querySelector('button')!.addEventListener('click', () => setTimeout(() => {
              const dialog = document.querySelector('[role="dialog"]')!;
              if (mode === 'busy') dialog.removeAttribute('aria-busy');
              else dialog.insertAdjacentHTML('beforeend', '<a href="https://check.yandex.ru/later">Чек доставки</a>');
            }, mode === 'growing' ? 150 : 250));
          }, mode);
        }
      });
      assert.equal(result.complete, true);
      assert.deepEqual(result.urls, mode === 'growing' ? ['https://check.yandex.ru/first', 'https://check.yandex.ru/later'] : mode === 'busy' ? ['https://check.yandex.ru/first'] : ['https://check.yandex.ru/later']);
      assert.ok(f.reads >= 3);
      assert.equal(f.clicks, 1);
      assert.equal(f.releases, 1);
    });
    await t.test('awaits persisted ownership and stops when the job becomes stale during it', async () => {
      const f = await fixture(context); let current = true;
      const result = await readYandexOrderDocuments(123456, {
        browser: f.api, onReleased: f.onReleased, isCurrent: () => current,
        onOpened: async (id, orderId) => { await f.onOpened(id, orderId); current = false; }
      });
      assert.equal(result.complete, false);
      assert.equal(f.calls.includes('click'), false);
      assert.equal(f.removes, 1);
      assert.equal(f.releases, 1);
    });
    await t.test('failed ownership persistence closes only the owned safe page', async () => {
      const f = await fixture(context);
      const result = await readYandexOrderDocuments(123456, {
        browser: f.api, onReleased: f.onReleased, isCurrent: () => true,
        onOpened: async () => { throw new Error('Synthetic persistence failure'); }
      });
      assert.equal(result.complete, false);
      assert.equal(f.calls.includes('click'), false);
      assert.equal(f.removes, 1);
      assert.equal(f.releases, 1);
    });
    await t.test('waits for its initial navigation without injecting into a pending tab', async () => {
      const f = await fixture(context); let gets = 0;
      f.beforeGet(() => {
        gets++;
        if (gets === 1) { f.navigate('about:blank'); f.pending(orderUrl); assert.equal(f.calls.length, 0); }
        else { f.navigate(''); f.pending(''); }
      });
      const result = await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 1500 });
      assert.equal(result.complete, true);
      assert.equal(f.clicks, 1);
    });
    await t.test('reads and closes an owned order while a subresource is still loading', async () => {
      const f = await fixture(context, button + '<img src="/held-image.png">', dialog, { holdImage: true });
      f.loading();
      const result = await readYandexOrderDocuments(123456, {
        browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 2000,
      });
      assert.equal(result.complete, true);
      assert.equal(result.urls.length, 2);
      assert.equal(f.clicks, 1);
      assert.equal(f.removes, 1);
      assert.equal(f.releases, 1);
    });
    for (const mode of ['cancel', 'timeout']) await t.test(`closes its initial blank loading tab on ${mode} before releasing ownership`, async () => {
      const controller = new AbortController();
      const f = await fixture(context);
      f.beforeGet(() => {
        f.navigate('about:blank'); f.pending(orderUrl); f.loading();
        if (mode === 'cancel') controller.abort();
      });
      const result = await readYandexOrderDocuments(123456, {
        browser: f.api, onOpened: f.onOpened, onReleased: async (id, orderId) => {
          assert.equal(f.removes, 1, 'Do not release a still-owned initial loading tab');
          await f.onReleased(id, orderId);
        }, signal: controller.signal, isCurrent: () => true, timeoutMs: 300
      });
      assert.equal(result.complete, false);
      assert.equal(f.calls.length, 0, 'Initial blank cleanup must not inject any DOM script');
      assert.equal(f.removes, 1);
      assert.equal(f.releases, 1);
    });
    for (const [name, markup] of [
      ['fatal', '<h1>Что-то пошло не так</h1>' + button],
      ['login', '<input type="password">' + button],
      ['challenge', '<iframe src="https://market.yandex.ru/showcaptcha"></iframe>' + button],
      ['ambiguous button', button + button],
      ['submit button', '<form><button>Чеки и другие документы</button></form>']
    ]) await t.test(`preserves ${name} without a click`, async () => {
      const f = await fixture(context, markup);
      assert.deepEqual(await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 1500 }), { urls: [], complete: false, blocked: true });
      assert.equal(await f.page.evaluate('window.clicks'), 0);
      assert.equal(f.removes, 0);
      assert.equal(f.releases, 1);
      await f.page.close();
    });
    await t.test('stale job and cancellation prevent the first click', async () => {
      for (const mode of ['stale', 'cancel']) {
        const controller = new AbortController(); let current = true;
        const f = await fixture(context);
        f.beforeGet(() => { if (mode === 'cancel') controller.abort(); else current = false; });
        const result = await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, signal: controller.signal, isCurrent: () => current, timeoutMs: 1500 });
        assert.equal(result.complete, false);
        assert.equal(f.clicks, 0);
        assert.equal(f.calls.includes('click'), false);
        assert.equal(f.removes, 1);
      }
    });
    for (const mode of ['navigated', 'pending']) await t.test(`preserves a ${mode} tab without a click`, async () => {
      const f = await fixture(context);
      if (mode === 'navigated') f.navigate('https://market.yandex.ru/my/order/654321');
      else f.pending('https://market.yandex.ru/my/order/654321');
      const result = await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 1500 });
      assert.equal(result.blocked, true);
      assert.equal(f.calls.length, 0);
      assert.equal(f.removes, 0);
      await f.page.close();
    });
    await t.test('navigation after the single click is preserved without reading links', async () => {
      const f = await fixture(context);
      f.beforeGet(() => { if (f.calls.includes('click')) f.navigate('https://market.yandex.ru/my/order/654321'); });
      const result = await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 1500 });
      assert.equal(result.blocked, true);
      assert.equal(f.reads, 0);
      assert.equal(f.removes, 0);
      assert.equal(await f.page.evaluate('window.clicks'), 1);
      await f.page.close();
    });
    for (const [name, markup] of [
      ['missing dialog', '<div>Документы по заказу</div>'],
      ['hidden dialog', '<div role="dialog" style="display:none">Документы по заказу</div>'],
      ['ambiguous dialog', '<div role="dialog">Документы по заказу</div><div role="dialog">Документы по заказу</div>']
    ]) await t.test(`never reports ${name} as complete`, async () => {
      const f = await fixture(context, button, markup);
      const result = await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 500 });
      assert.equal(result.complete, false);
      assert.equal(result.urls.length, 0);
      if (!f.page.isClosed()) await f.page.close();
    });
    await t.test('challenge appearing after the click is preserved', async () => {
      const f = await fixture(context, button, '<h1>Подтвердите, что вы не робот</h1>');
      const result = await readYandexOrderDocuments(123456, { browser: f.api, onOpened: f.onOpened, onReleased: f.onReleased, isCurrent: () => true, timeoutMs: 1500 });
      assert.equal(result.blocked, true);
      assert.equal(f.removes, 0);
      assert.equal(await f.page.evaluate('window.clicks'), 1);
      await f.page.close();
    });
  } finally { await context.close(); await browser.close(); }
});
