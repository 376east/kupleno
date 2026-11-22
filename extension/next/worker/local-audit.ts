import { browser } from 'wxt/browser';
import { collectionAttemptDiagnostics, readFailureStats, readUnresolvedOrderIds } from '../collection';
import type { verifyYandexOrders } from './collection';
import type { Job } from '../collection';
import type { Source } from '../model';

const auditKey = 'kupleno-local-audit-result';
const folder = 'Kupleno-diagnostics';

async function saveReport(name: string, report: object) {
  const json = JSON.stringify(report, null, 2) + '\n';
  return browser.downloads.download({
    url: 'data:application/json;charset=utf-8,' + encodeURIComponent(json),
    filename: `${folder}/${name}.json`,
    conflictAction: 'overwrite',
    saveAs: false,
  });
}

export function registerLocalAudit(jobsKey: string, verify: typeof verifyYandexOrders) {
  let audit: Promise<void> | undefined;
  let reports = Promise.resolve();
  const logSaveFailure = () => console.error('Куплено: не удалось записать локальный отчёт.');

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[jobsKey]?.newValue) return;
    const previous = changes[jobsKey].oldValue as Partial<Record<Source, Job>> | undefined;
    const jobs = changes[jobsKey].newValue as Partial<Record<Source, Job>>;
    for (const job of Object.values(jobs)) {
      if (job.status === 'running' || (previous?.[job.source]?.id === job.id && previous[job.source]?.status === job.status)) continue;
      const { attempts: [attempt] } = collectionAttemptDiagnostics([job]);
      if (!attempt) continue;
      const stats = readFailureStats(job.result?.stats);
      reports = reports.then(async () => {
        await saveReport(`collection-${attempt.source}`, {
          schema: 1, version: browser.runtime.getManifest().version, ...attempt,
          ...(stats ? { stats } : {}),
        });
      }).catch(logSaveFailure);
    }
  });

  async function runAudit() {
    const configUrl = new URL('local-audit.json', browser.runtime.getURL('/app.html'));
    const response = await fetch(configUrl).catch(() => null);
    if (!response?.ok) return;
    const config: unknown = await response.json();
    if (!config || typeof config !== 'object' || !('run' in config) || !('orderIds' in config)) return;
    const { run } = config;
    const ids = readUnresolvedOrderIds(config.orderIds);
    if (typeof run !== 'string' || !/^[a-z0-9-]{1,48}$/.test(run) || !ids?.length || ids.length > 4) return;
    const previous = (await browser.storage.local.get(auditKey))[auditKey] as { run: string; report: object; downloadId?: number } | undefined;
    let report: object;
    if (previous?.run === run) {
      if (typeof previous.downloadId === 'number') {
        const [file] = await browser.downloads.search({ id: previous.downloadId });
        if (file?.state === 'in_progress' || (file?.state === 'complete' && file.exists)) return;
      }
      report = previous.report;
    } else {
      const result = await verify(ids);
      if (result.status === 'busy') return;
      report = { schema: 1, version: browser.runtime.getManifest().version, run, checkedAt: new Date().toISOString(), ...result };
      await browser.storage.local.set({ [auditKey]: { run, report } });
    }
    const downloadId = await saveReport(`yandex-orders-${run}`, report);
    await browser.storage.local.set({ [auditKey]: { run, report, downloadId } });
  }

  const start = () => {
    audit ??= runAudit().catch(logSaveFailure).finally(() => { audit = undefined; });
  };
  browser.runtime.onStartup.addListener(start);
  browser.runtime.onInstalled.addListener(start);
  start();
}
