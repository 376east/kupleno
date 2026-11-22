import { browser } from 'wxt/browser';
import { collectionAttemptDiagnostics, localAuditConfig, readFailureStats, readUnresolvedOrderIds, storeOrigins } from '../collection';
import { handleCollectionCommand, type verifyYandexOrders } from './collection';
import type { Job } from '../collection';
import type { Source } from '../model';
import { knownYandexOrderIds } from '../collection-state';
import { settingsWithDefaults } from '../preferences.mjs';
import { createStore } from '../storage.mjs';

const auditKey = 'kupleno-local-audit-result';
const fullKey = 'kupleno-local-collection-request';
const folder = 'Kupleno-diagnostics';
type FullRun = { run: string; version: string; id: string; report?: object; downloadId?: number };

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
  const version = browser.runtime.getManifest().version;
  const readFull = async () => (await browser.storage.local.get(fullKey))[fullKey] as FullRun | undefined;

  async function finishFull(request: FullRun, outcome: object) {
    const report = request.report ?? { schema: 1, version, run: request.run, source: 'yandex', checkedAt: new Date().toISOString(), ...outcome };
    if (!request.report) await browser.storage.local.set({ [fullKey]: { ...request, report } });
    if (typeof request.downloadId === 'number') {
      const [file] = await browser.downloads.search({ id: request.downloadId });
      if (file?.state === 'in_progress' || (file?.state === 'complete' && file.exists)) return;
    }
    const downloadId = await saveReport(`collection-yandex-${request.run}`, report);
    await browser.storage.local.set({ [fullKey]: { ...request, report, downloadId } });
  }

  function reportFull(request: FullRun, outcome: object) {
    const task = reports.then(async () => {
      const current = await readFull();
      if (current?.id === request.id && current.version === version) await finishFull(current, outcome);
    });
    reports = task.catch(logSaveFailure);
    return task;
  }

  function jobOutcome(job: Job) {
    const { attempts: [attempt] } = collectionAttemptDiagnostics([job]);
    const stats = readFailureStats(job.result?.stats);
    return { ...attempt, ...(stats ? { stats } : {}) };
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[jobsKey]?.newValue) return;
    const previous = changes[jobsKey].oldValue as Partial<Record<Source, Job>> | undefined;
    const jobs = changes[jobsKey].newValue as Partial<Record<Source, Job>>;
    for (const job of Object.values(jobs)) {
      if (job.status === 'running' || (previous?.[job.source]?.id === job.id && previous[job.source]?.status === job.status)) continue;
      reports = reports.then(async () => {
        const outcome = jobOutcome(job);
        const request = job.source === 'yandex' ? await readFull() : undefined;
        if (request?.id === job.id && request.version === version) await finishFull(request, outcome);
        await saveReport(`collection-${job.source}`, {
          schema: 1, version, ...outcome,
        });
      }).catch(logSaveFailure);
    }
  });

  async function runFull(run: string) {
    const previous = await readFull();
    const command = { type: 'KUPLENO_JOB', action: 'status', source: 'yandex' } as const;
    if (previous?.run === run && previous.version === version) {
      if (previous.report) return reportFull(previous, {});
      const result = await handleCollectionCommand({ ...command, id: previous.id });
      if (result.ok && result.job?.status === 'running') return;
      return reportFull(previous, result.ok && result.job ? jobOutcome(result.job) : { status: 'interrupted' });
    }
    const request = { run, version, id: crypto.randomUUID() };
    await browser.storage.local.set({ [fullKey]: request });
    if (!await browser.permissions.contains({ origins: storeOrigins.yandex })) return reportFull(request, { status: 'permission_required' });
    const current = await handleCollectionCommand(command);
    if (current.ok && (current.job?.status === 'running' || current.job?.status === 'completed')) {
      return reportFull(request, { status: 'busy' });
    }
    try {
      const saved = await createStore().read();
      const profile = settingsWithDefaults(saved?.state.settings).dataProfile;
      const knownOrderIds = saved ? knownYandexOrderIds(saved.state, profile) : [];
      const result = await handleCollectionCommand({
        type: 'KUPLENO_JOB', action: 'start', source: 'yandex', profile, knownOrderIds,
      }, request.id);
      if (!result.ok || !result.job) return reportFull(request, { status: 'start_failed' });
      if (result.job.status !== 'running') return reportFull(request, jobOutcome(result.job));
    } catch { return reportFull(request, { status: 'start_failed' }); }
  }

  async function runAudit() {
    const configUrl = new URL(localAuditConfig, browser.runtime.getURL('/app.html'));
    const response = await fetch(configUrl).catch(() => null);
    if (!response?.ok) return;
    const config: unknown = await response.json();
    if (!config || typeof config !== 'object' || !('run' in config)) return;
    const { run } = config;
    if (typeof run !== 'string' || !/^[a-z0-9-]{1,48}$/.test(run)) return;
    if ('collection' in config && config.collection === 'yandex' && !('orderIds' in config)) return runFull(run);
    if (!('orderIds' in config) || 'collection' in config) return;
    const ids = readUnresolvedOrderIds(config.orderIds);
    if (!ids?.length || ids.length > 4) return;
    const previous = (await browser.storage.local.get(auditKey))[auditKey] as { run: string; report: { version?: string }; downloadId?: number } | undefined;
    let report: object;
    if (previous?.run === run && previous.report?.version === version) {
      if (typeof previous.downloadId === 'number') {
        const [file] = await browser.downloads.search({ id: previous.downloadId });
        if (file?.state === 'in_progress' || (file?.state === 'complete' && file.exists)) return;
      }
      report = previous.report;
    } else {
      const result = await verify(ids);
      if (result.status === 'busy') return;
      report = { schema: 1, version, run, checkedAt: new Date().toISOString(), ...result };
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
