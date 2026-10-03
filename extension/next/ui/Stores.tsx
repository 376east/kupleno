import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { SOURCES, mergeCollection, sourceHealth } from '../domain.mjs';
import { storeOrigins, type Command, type Job, type JobResponse } from '../collection';
import { identifyRows, settingsWithDefaults } from '../preferences.mjs';
import type { Purchase, State, Source } from '../model';
import { StoreMark, Dialog } from './components';
import { clearSource } from '../source-data';

async function command(message: Command): Promise<Job | null> {
  const result = await browser.runtime.sendMessage(message) as JobResponse;
  if (!result?.ok) throw new Error(result?.error || 'Фоновый сборщик не ответил. Обновите расширение и повторите.');
  return result.job;
}

export function Stores({ state, rows, save, onSelect }: { state: State; rows: Purchase[]; save: (state: State) => Promise<void>; onSelect: (id: string) => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const [starting, setStarting] = useState(false);
  const [success, setSuccess] = useState('');
  const [errorSource, setErrorSource] = useState<Source | null>(null);
  const [clearing, setClearing] = useState<Source | null>(null);
  const [clearBusy, setClearBusy] = useState(false);
  const applyingId = useRef('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const value = await command({ type: 'KUPLENO_JOB', action: 'status' }); if (!stopped) setJob(value); }
      catch (e) { if (!stopped) setError(e instanceof Error ? e.message : 'Не удалось прочитать ход сбора.'); }
      if (!stopped) timer = setTimeout(() => void poll(), 1500);
    }
    void poll();
    return () => { stopped = true; alive.current = false; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (job?.status !== 'completed' || !job.result || applyingId.current === job.id) return;
    applyingId.current = job.id; setApplying(true);
    const finished = job;
    const result = job.result;
    void (async () => {
      try {
        if (state.metadata.lastAppliedCollection !== finished.id) {
          const merged = mergeCollection(state.rows, result.rows, { source: finished.source, profile: finished.profile, processedReceipts: result.processedReceipts });
          const previous = state.metadata.collection as { sources?: string[]; stats?: Record<string, unknown>; warnings?: string[] } | undefined;
          await save({ ...state, rows: identifyRows(merged), metadata: {
            ...state.metadata, lastAppliedCollection: finished.id, lastRunAt: finished.updatedAt,
            collection: {
              sources: [...new Set([...(previous?.sources || []), finished.source])],
              stats: { ...previous?.stats, [finished.source]: result.stats },
              warnings: [...(previous?.warnings || []).filter(text => !text.startsWith(SOURCES[finished.source].name)), ...result.warnings],
            },
          } });
        }
        await command({ type: 'KUPLENO_JOB', action: 'ack', id: finished.id });
        if (alive.current) { setJob(null); setSuccess(`История обновлена: получено ${result.rows.length} операций.`); setError(''); }
      } catch (e) { if (alive.current) { setErrorSource(finished.source); setError(e instanceof Error ? e.message : 'Не удалось сохранить сбор. Результат остаётся в расширении.'); } }
      finally { if (alive.current) setApplying(false); }
    })();
  }, [job, state, save]);

  async function start(source: Source) {
    setError(''); setSuccess('');
    setStarting(true);
    setErrorSource(source);
    try {
      const granted = await browser.permissions.request({ origins: storeOrigins[source], ...(source === 'wildberries' ? { permissions: ['cookies'] as ['cookies'] } : {}) });
      if (!granted) throw new Error(`Доступ к ${SOURCES[source].name} не предоставлен. Повторите сбор и разрешите доступ в диалоге браузера.`);
      setJob(await command({ type: 'KUPLENO_JOB', action: 'start', source, profile: settingsWithDefaults(state.settings).dataProfile }));
    } catch (e) { setError(e instanceof Error ? e.message : 'Сбор не запущен.'); }
    finally { setStarting(false); }
  }
  async function copyDiagnostics() {
    try {
      const relevant = !error || errorSource === job?.source ? job : null;
      const diagnostic = [browser.runtime.getManifest().version, error && errorSource ? SOURCES[errorSource].name : relevant?.source ? SOURCES[relevant.source].name : 'Куплено', relevant?.updatedAt, relevant?.status, relevant?.message, relevant?.error, relevant?.diagnostic, error].filter(Boolean).join('\n');
      await navigator.clipboard.writeText(diagnostic);
      setSuccess('Сведения об ошибке скопированы');
    } catch { setError('Не удалось скопировать. Выделите текст ошибки ниже.'); }
  }
  const failure = error || (job?.status === 'failed' ? job.error : '');
  return <div className="store-list">
    {clearing && <Dialog title={`Удалить историю ${SOURCES[clearing].name}?`} error={error} onClose={() => !clearBusy && setClearing(null)}><p>Будут удалены покупки этого магазина во всех профилях, связанные ручные правки, ожидания возвратов и гарантии. История остальных магазинов останется.</p><p>Новый сбор не запустится. Предыдущие данные можно восстановить в настройках из истории изменений.</p><button disabled={clearBusy} onClick={() => { setClearBusy(true); setError(''); void command({type: 'KUPLENO_JOB', action: 'status'}).then(async latest => { if (latest?.status === 'running' || latest?.status === 'completed') throw new Error('Сначала остановите сбор или дождитесь сохранения результата.'); await save(clearSource(state, clearing)); }).then(() => { setClearing(null); setSuccess('История магазина удалена'); }).catch(e => setError(e instanceof Error ? e.message : 'Не удалось удалить историю.')).finally(() => setClearBusy(false)); }}>Удалить историю</button></Dialog>}
    {starting && <div className="callout" role="status">Подключаем магазин. Ждём загрузки вкладки…</div>}
    {success && <div className="callout" role="status">{success}</div>}
    {failure && !errorSource && job?.status !== 'failed' && <div className="callout" role="alert">{failure}</div>}
    {Object.entries(SOURCES).map(([source, info]) => {
      const purchases = rows.filter(row => row.source === source);
      const unread = purchases.filter(row => row.parse_quality === 'fallback');
      const active = job?.source === source ? job : null;
      const health = sourceHealth(source, state.metadata);
      return <section className="panel store-panel" key={source}><StoreMark source={source} /><div><h2>{info.name}</h2><p>{purchases.length ? `${purchases.length} операций в истории` : 'История ещё не загружена'}</p></div><div className="row-actions"><button className="primary" disabled={starting || applying || job?.status === 'running' || job?.status === 'completed'} onClick={() => void start(source as Source)}>Обновить покупки</button><a className="action" href={info.url} target="_blank" rel="noreferrer">Чеки в магазине ↗</a><button className="quiet" disabled={!purchases.length || starting || clearBusy || applying || job?.status === 'running' || job?.status === 'completed'} onClick={() => { setError(''); setClearing(source as Source); }}>Удалить историю</button></div>
        {health.warnings.length > 0 && <div className="store-details" role="status">{health.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
        {active?.status === 'running' && <div className="store-progress" role="status"><p>{active.message}</p><progress value={active.progress.total ? active.progress.done : undefined} max={active.progress.total || 1} /><button className="secondary" onClick={() => void command({ type: 'KUPLENO_JOB', action: 'cancel' }).then(setJob).catch(e => setError(String(e)))}>Остановить сбор</button><button className="secondary" onClick={() => void copyDiagnostics()}>Скопировать сведения</button></div>}
        {active?.status === 'completed' && <div className="store-details" role="status">{applying ? 'Сохраняем полученные покупки…' : 'Результат собран и ждёт сохранения.'}</div>}
        {(error ? errorSource === source : active?.status === 'failed') && failure && <div className="callout" role="alert"><strong>Не удалось завершить сбор</strong><p>{failure}</p><div className="row-actions"><button className="secondary" onClick={() => void copyDiagnostics()}>Скопировать сведения</button>{active?.status === 'completed' && !applying && <button onClick={() => { applyingId.current = ''; setJob({ ...active }); }}>Повторить сохранение</button>}</div></div>}
        {unread.length > 0 && <div className="callout"><strong>Нужна проверка {unread.length} чеков</strong><p>Итог известен, но список товаров прочитан не полностью.</p><button onClick={() => onSelect(unread[0]!.rowId)}>Открыть первый чек</button></div>}
      </section>;
    })}
  </div>;
}
