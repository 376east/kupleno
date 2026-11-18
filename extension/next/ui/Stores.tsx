import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { formatMoney, SOURCES, sourceHealth, sourceOf } from '../domain.mjs';
import { storeOrigins, type Command, type Job, type JobResponse } from '../collection';
import { settingsWithDefaults } from '../preferences.mjs';
import { applyCollectionResult } from '../collection-state';
import type { Purchase, State, Source } from '../model';
import { StoreMark, Dialog, operationCount } from './components';
import { clearSource } from '../source-data';
import { summarizeFiscalPayments } from '../fiscal-payments.mjs';

const sources = Object.keys(storeOrigins) as Source[];

async function command(message: Command): Promise<Extract<JobResponse, { ok: true }>> {
  const result = await browser.runtime.sendMessage(message) as JobResponse;
  if (!result?.ok) throw new Error(result?.error || 'Сбор покупок не отвечает. Перезапустите расширение и повторите.');
  return result;
}

export function Stores({ state, rows, update, onSelect }: { state: State; rows: Purchase[]; update: (transform: (state: State) => State) => Promise<void>; onSelect: (id: string) => void }) {
  const canCollect = typeof browser.runtime?.sendMessage === 'function';
  const [jobs, setJobs] = useState<Job[]>([]);
  const [errors, setErrors] = useState<Partial<Record<Source, string>>>({});
  const [error, setError] = useState('');
  const [applying, setApplying] = useState<string[]>([]);
  const [starting, setStarting] = useState<Source[]>([]);
  const startingRef = useRef(new Set<Source>());
  const [success, setSuccess] = useState<Partial<Record<Source, string>>>({});
  const [clearing, setClearing] = useState<Source | null>(null);
  const [clearBusy, setClearBusy] = useState(false);
  const attempted = useRef(new Set<string>());
  const alive = useRef(true);
  const readJobs = (result: Extract<JobResponse, { ok: true }>) => result.jobs || (result.job ? [result.job] : []);
  useEffect(() => {
    alive.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const value = await command({ type: 'KUPLENO_JOB', action: 'status' }); if (!stopped) setJobs(readJobs(value)); }
      catch (e) { if (!stopped) setError(e instanceof Error ? e.message : 'Не удалось прочитать ход сбора.'); }
      if (!stopped) timer = setTimeout(() => void poll(), 1500);
    }
    if (canCollect) void poll();
    return () => { stopped = true; alive.current = false; clearTimeout(timer); };
  }, [canCollect]);

  useEffect(() => {
    for (const finished of jobs) {
      if (finished.status !== 'completed' || !finished.result || attempted.current.has(finished.id)) continue;
      const completedHealth = sourceHealth(finished.source, { collection: { stats: { [finished.source]: finished.result.stats }, warnings: finished.result.warnings } });
      attempted.current.add(finished.id);
      setApplying(value => [...value, finished.id]);
      void (async () => {
        try {
          // The updater serializes results and reads the latest database state for each transaction.
          await update(current => applyCollectionResult(current, finished));
          await command({ type: 'KUPLENO_JOB', action: 'ack', id: finished.id });
          if (alive.current) {
            setJobs(value => value.filter(job => job.id !== finished.id));
            setSuccess(value => ({ ...value, [finished.source]: completedHealth.state === 'partial' ? 'История обновлена частично.' : 'История обновлена.' }));
            setErrors(value => ({ ...value, [finished.source]: '' }));
          }
        } catch (e) {
          if (alive.current) setErrors(value => ({ ...value, [finished.source]: e instanceof Error ? e.message : 'Не удалось сохранить сбор. Результат остаётся в расширении.' }));
        } finally {
          if (alive.current) setApplying(value => value.filter(id => id !== finished.id));
        }
      })();
    }
  }, [jobs, update]);

  const pending = (source: Source) => jobs.some(job => job.source === source && (job.status === 'running' || job.status === 'completed'));

  async function start(requested: Source[], refreshReceipts = false) {
    if (!canCollect || clearing) return;
    const selected = requested.filter(source => !startingRef.current.has(source) && !pending(source));
    if (!selected.length) return;
    for (const source of selected) startingRef.current.add(source);
    setStarting([...startingRef.current]);
    const cleared = Object.fromEntries(selected.map(source => [source, '']));
    setErrors(value => ({ ...value, ...cleared })); setSuccess(value => ({ ...value, ...cleared }));
    const permissionsFor = (stores: Source[]) => ({
      origins: [...new Set(stores.flatMap(source => storeOrigins[source]))],
      ...(stores.includes('wildberries') ? { permissions: ['cookies'] as ['cookies'] } : {}),
    });
    let granted = false;
    let permissionError = '';
    try {
      granted = await browser.permissions.request(permissionsFor(selected));
    } catch (e) { permissionError = e instanceof Error ? e.message : 'Не удалось запросить доступ.'; }
    const profile = settingsWithDefaults(state.settings).dataProfile;
    await Promise.all(selected.map(async source => {
      try {
        if (!granted && !await browser.permissions.contains(permissionsFor([source]))) {
          throw new Error(permissionError || `Доступ к ${SOURCES[source].name} не предоставлен. Повторите сбор и разрешите доступ в диалоге браузера.`);
        }
        const result = await command({ type: 'KUPLENO_JOB', action: 'start', source, profile, ...(refreshReceipts ? { refreshReceipts: true } : {}) });
        if (alive.current) setJobs(value => [...value.filter(job => job.source !== source), ...readJobs(result).filter(job => job.source === source)]);
      } catch (e) { if (alive.current) setErrors(value => ({ ...value, [source]: e instanceof Error ? e.message : 'Сбор не запущен.' })); }
      finally { startingRef.current.delete(source); if (alive.current) setStarting([...startingRef.current]); }
    }));
  }
  async function copyDiagnostics(source: Source) {
    try {
      const job = jobs.find(job => job.source === source);
      const diagnostic = [browser.runtime.getManifest().version, SOURCES[source].name, job?.updatedAt, job?.status, job?.message, job?.error, job?.diagnostic, job?.failureStats && JSON.stringify(job.failureStats), errors[source]].filter(Boolean).join('\n');
      await navigator.clipboard.writeText(diagnostic); setSuccess(value => ({ ...value, [source]: 'Сведения об ошибке скопированы.' }));
    } catch { setErrors(value => ({ ...value, [source]: 'Не удалось скопировать. Выделите текст ошибки ниже.' })); }
  }
  return <div className="store-list">
    {canCollect && <div className="row-actions"><button className="primary" disabled={!!clearing || sources.every(source => starting.includes(source) || pending(source))} onClick={() => void start(sources)}>Обновить все магазины</button></div>}
    {!canCollect && <section className="callout" role="status"><h2>Предпросмотр истории</h2><p>Сбор покупок доступен в установленном расширении Куплено. Откройте его через меню расширений браузера. Здесь можно посмотреть сохранённую историю и перейти к чекам магазинов.</p></section>}
    {clearing && <Dialog title={`Удалить историю ${SOURCES[clearing].name}?`} error={error} onClose={() => !clearBusy && setClearing(null)}><p>Будут удалены покупки этого магазина во всех профилях, связанные ручные правки, ожидания возвратов и гарантии. История остальных магазинов останется.</p><p>Новый сбор не запустится. Предыдущие данные можно восстановить в настройках из истории изменений.</p><button className="danger" disabled={clearBusy} onClick={() => {
      const source = clearing;
      setClearBusy(true); setError('');
      void command({ type: 'KUPLENO_JOB', action: 'status', source }).then(async latest => {
        if (latest.job?.status === 'running' || latest.job?.status === 'completed') throw new Error('Сначала остановите сбор этого магазина или дождитесь сохранения результата.');
        if (source === 'yandex') await command({ type: 'KUPLENO_JOB', action: 'clearReceiptCache', source });
        await update(current => clearSource(current, source));
      }).then(() => { setClearing(null); setSuccess(value => ({ ...value, [source]: 'История магазина удалена' })); }).catch(e => setError(e instanceof Error ? e.message : 'Не удалось удалить историю.')).finally(() => setClearBusy(false));
    }}>Удалить историю</button></Dialog>}
    {error && !clearing && <div className="callout" role="alert">{error}</div>}
    {Object.entries(SOURCES).map(([sourceName, info]) => {
      const source = sourceName as Source;
      const purchases = rows.filter(row => sourceOf(row) === source);
      const payments = summarizeFiscalPayments(state.fiscalPayments || [], source);
      const unread = purchases.filter(row => row.parse_quality === 'fallback');
      const active = jobs.find(job => job.source === source);
      const blocked = starting.includes(source) || active?.status === 'running' || active?.status === 'completed';
      const saving = !!active && applying.includes(active.id);
      const failure = errors[source] || (active?.status === 'failed' ? active.error : '');
      const health = sourceHealth(source, state.metadata);
      const running = active?.status === 'running';
      const progressText = active?.message.replace(`${info.name}: `, '') || '';
      const status = starting.includes(source) ? 'Подключаем магазин…'
        : running ? progressText.charAt(0).toLocaleUpperCase('ru') + progressText.slice(1)
        : active?.status === 'completed' ? saving ? 'Сохраняем покупки…' : 'Покупки собраны. Ожидают сохранения.'
        : failure ? 'Сбор не завершён.' : success[source] || (health.state === 'partial' ? 'История собрана частично.' : 'Не запущен');
      return <section className="panel store-panel" key={source}><StoreMark source={source} /><div className="store-summary"><h2>{info.name}</h2><p>{purchases.length ? `${operationCount(purchases.length)} в истории` : 'История ещё не загружена'}</p><div className="store-status" role="status">{status}</div><progress className="store-meter" aria-label={`Ход сбора ${info.name}`} aria-hidden={!running} data-active={running || undefined} value={running ? active.progress.total ? active.progress.done : undefined : 0} max={active?.progress.total || 1} /></div><div className="row-actions"><button className="primary" disabled={!canCollect || blocked} onClick={() => void start([source])}>Обновить покупки</button>{source === 'yandex' && canCollect && purchases.length > 0 && !running && <button className="secondary" disabled={blocked} title="Заново скачать чеки из магазина" onClick={() => void start([source], true)}>Перечитать чеки</button>}{running ? <button className="secondary" onClick={() => void command({ type: 'KUPLENO_JOB', action: 'cancel', id: active.id }).then(result => setJobs(value => value.map(job => job.id === active.id ? readJobs(result).find(next => next.id === job.id) || job : job))).catch(e => setErrors(value => ({ ...value, [source]: String(e) })))}>Остановить сбор</button> : <a className="action" href={info.url} target="_blank" rel="noreferrer">Чеки в магазине ↗</a>}{running ? <button className="quiet" onClick={() => void copyDiagnostics(source)}>Скопировать сведения</button> : <button className="quiet" disabled={!canCollect || !purchases.length || clearBusy || blocked} onClick={() => { setError(''); setClearing(source); }}>Удалить историю</button>}</div>
        {!!payments?.count && <div className="store-details">
          <p><strong>{formatMoney(payments.net)}</strong> · оплачено с учётом возвратов</p>
          <p>Проверено чеков: {payments.count.toLocaleString('ru-RU')}. Оплачено {formatMoney(payments.paid)}, возвращено {formatMoney(payments.refunded)}.</p>
          {payments.advance !== 0 && <p>Зачёт ранее оплаченного аванса: {formatMoney(payments.advance)}.</p>}
        </div>}
        {!failure && health.warnings.length > 0 && <div className="store-details" role="status">{health.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
        {failure && <div className="callout" role="alert"><strong>Не удалось завершить сбор</strong><p>{failure}</p><div className="row-actions"><button className="secondary" onClick={() => void copyDiagnostics(source)}>Скопировать сведения</button>{active?.status === 'completed' && !saving && <button onClick={() => { attempted.current.delete(active.id); setJobs([...jobs]); }}>Повторить сохранение</button>}</div></div>}
        {unread.length > 0 && <div className="callout"><strong>Нужна проверка {unread.length} чеков</strong><p>Итог известен, но список товаров прочитан не полностью.</p><button onClick={() => onSelect(unread[0]!.rowId)}>Открыть первый чек</button></div>}
      </section>;
    })}
  </div>;
}
