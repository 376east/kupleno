import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { registerCollection, verifyYandexOrders, collectionJobsKey } from '../worker/collection';
import { registerLocalAudit } from '../worker/local-audit';

export default defineBackground(() => {
  registerCollection();
  if (import.meta.env.MODE === 'local-audit') registerLocalAudit(collectionJobsKey, verifyYandexOrders);
  browser.action.onClicked.addListener(async () => {
    const url = browser.runtime.getURL('/app.html');
    const tabs = await browser.tabs.query({});
    const existing = tabs.find(tab => tab.url?.split('#')[0] === url);
    if (existing?.id !== undefined) await browser.tabs.update(existing.id, { active: true });
    else await browser.tabs.create({ url });
  });
});
