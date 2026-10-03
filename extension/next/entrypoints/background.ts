import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { registerCollection } from '../worker/collection';

export default defineBackground(() => {
  registerCollection();
  browser.action.onClicked.addListener(async () => {
    const url = browser.runtime.getURL('/app.html');
    const tabs = await browser.tabs.query({});
    const existing = tabs.find(tab => tab.url?.split('#')[0] === url);
    if (existing?.id !== undefined) await browser.tabs.update(existing.id, { active: true });
    else await browser.tabs.create({ url });
  });
});
