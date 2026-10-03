import { defineConfig } from 'wxt';
import { storeOrigins } from './collection';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false,
  manifest: {
    name: 'Куплено — новая версия',
    version_name: '0.21.0 preview',
    description: 'Покупки и возвраты в одном месте. Локальная проверка новой версии.',
    minimum_chrome_version: '116',
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    permissions: ['scripting', 'storage', 'unlimitedStorage', 'offscreen'],
    optional_permissions: ['cookies'],
    optional_host_permissions: Object.values(storeOrigins).flat(),
    action: { default_title: 'Открыть Куплено' },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" }
  }
});
