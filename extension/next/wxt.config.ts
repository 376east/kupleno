import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'wxt';
import { localAuditRevision, localAuditWorker, storeOrigins } from './collection';
import { version } from './package.json';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false,
  hooks: {
    'build:manifestGenerated': async ({ config }, manifest) => {
      if (config.mode !== 'local-audit') return;
      const { background } = manifest;
      if (!background || !('service_worker' in background) || !background.service_worker) throw new Error('Не найден фоновый обработчик локальной сборки.');
      // Use a new worker URL so Chromium cannot reuse its previously registered script.
      await rename(join(config.outDir, background.service_worker), join(config.outDir, localAuditWorker));
      background.service_worker = localAuditWorker;
    },
  },
  manifest: ({ mode }) => ({
    name: 'Куплено',
    version: mode === 'local-audit' ? `${version}.${localAuditRevision}` : version,
    ...(mode === 'local-audit' ? { version_name: `${version}.${localAuditRevision} local audit` } : {}),
    description: 'Локальный журнал покупок, возвратов и чеков Ozon, Wildberries и Яндекс Маркета.',
    minimum_chrome_version: '116',
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    permissions: ['scripting', 'storage', 'unlimitedStorage', 'offscreen', ...(mode === 'local-audit' ? ['downloads' as const] : [])],
    optional_permissions: ['cookies'],
    optional_host_permissions: Object.values(storeOrigins).flat(),
    action: { default_title: 'Открыть Куплено' },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" }
  })
});
