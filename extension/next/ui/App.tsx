import { motion, useReducedMotion } from 'motion/react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createStore, parseBackup, serializeBackup, type Recovery } from '../storage.mjs';
import { effectiveRows, editOperations, identifyRows, settingsWithDefaults } from '../preferences.mjs';
import { SOURCES, categoryTotals, filterRows, formatMoney, isRefund, largePurchases, moneyMinor, monthlyTotals, receiptUrl, sourceOf, summarize } from '../domain.mjs';
import type { Envelope, Purchase, Snapshot, State } from '../model';
import type { Filters } from '../domain.mjs';
import { Dialog, Icon, StoreMark, download, operationCount } from './components';
import { LocalReceipt } from './LocalReceipt';
import { Stores } from './Stores';
import { Preferences } from './Preferences';
import { BulkEdit } from './BulkEdit';
import { Control, ReturnForm, DocumentForm } from './Control';
import { addDays, today, upsertClaim, upsertDocument, claims, documents, type Claim, type DocumentRecord } from '../lifecycle';
import { parsePurchasesCsv, exportPurchasesCsv } from '../csv';

const SpendingChart = lazy(() => import('./SpendingChart').then(module => ({ default: module.SpendingChart })));
const store = createStore();
const empty = (): Envelope => ({ state: { rows: [], settings: {}, metadata: {} }, revision: 0, epoch: 0 });
let boot: Promise<Envelope> | undefined;
function initialize() {
  return boot ||= (async () => {
    const current = await store.read();
    if (current) return current;
    const legacy = await store.readLegacy();
    if (!legacy) return empty();
    try {
      return await store.write({ ...legacy.state, metadata: { ...legacy.state.metadata, migratedFrom: 'kupleno-storage-v1', migratedAt: new Date().toISOString() } }, { expectedRevision: 0, expectedEpoch: 0 });
    } catch (error) {
      // Another report tab may have completed the same migration first.
      const concurrent = await store.read();
      if (concurrent) return concurrent;
      throw error;
    }
  })();
}
const pages = [{ id: 'overview', title: 'Обзор' }, { id: 'purchases', title: 'Покупки' }, { id: 'stores', title: 'Магазины' }, { id: 'control', title: 'Контроль' }, { id: 'settings', title: 'Настройки' }];
const currentPage = () => pages.some(page => page.id === location.hash.slice(1).split('/')[0]!) ? location.hash.slice(1).split('/')[0]! : 'overview';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить действие.';
const dateLabel = (value: string) => /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10).split('-').reverse().join('.') : value;
const journalDate = (value: string) => {
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? date : null;
};
const monthLabel = (value: string) => {
  const date = journalDate(`${value.slice(0, 7)}-01`);
  const label = date ? new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date) : 'Дата не указана';
  return label.charAt(0).toLocaleUpperCase('ru-RU') + label.slice(1);
};
const longDate = (value: string) => {
  const date = journalDate(value);
  return date ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date) : dateLabel(value);
};
const periodLabel = (filters: Filters) => filters.from && filters.to ? `${longDate(filters.from)} - ${longDate(filters.to)}` : filters.from ? `С ${longDate(filters.from)}` : filters.to ? `По ${longDate(filters.to)}` : 'Вся история';
const purchaseAmount = (row: Purchase) => {
  if (row.currency && row.currency !== 'RUB') return `${row.amount} ${row.currency}`;
  const amount = moneyMinor(row.amount);
  return amount === null ? 'Сумма требует проверки' : formatMoney(amount);
};

export function App() {
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [page, setPage] = useState(currentPage);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('kupleno-next-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const [filters, setFilters] = useState<Filters>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [bulk, setBulk] = useState<string[] | null>(null);
  const [pendingImport, setPendingImport] = useState<State | null>(null);
  const [importKind, setImportKind] = useState<'backup' | 'csv'>('backup');
  const [history, setHistory] = useState<Snapshot[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const channel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    let active = true;
    initialize().then(value => { if (active) setEnvelope(value); }).catch(async e => {
      if (!active) return;
      setError(errorText(e));
      try { const value = await store.readRecovery(); if (active) setRecovery(value); }
      catch (failed) { if (active) setError(errorText(failed)); }
    });
    const onHash = () => { if (location.hash === '#content') return; setPage(currentPage()); setSelected(null); };
    window.addEventListener('hashchange', onHash);
    const sync = new BroadcastChannel('kupleno-next-state');
    channel.current = sync;
    sync.onmessage = () => {
      // Keep a visible editor intact. Its stale revision is rejected on save.
      setNotice('Данные изменились в другой вкладке. Обновите данные перед следующей правкой.');
    };
    return () => { active = false; window.removeEventListener('hashchange', onHash); sync.close(); };
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('kupleno-next-theme', theme); }, [theme]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 9000); return () => clearTimeout(timer); }, [notice]);
  const state = envelope?.state;
  const version = envelope || recovery;
  const rows = useMemo(() => state ? effectiveRows(state) : [], [state]);
  const settings = useMemo(() => settingsWithDefaults(state?.settings), [state]);
  const visible = useMemo(() => filterRows(rows, filters), [rows, filters]);
  const activePurchase = rows.find(row => row.rowId === selected);

  async function save(next: State) {
    if (!version || writing.current) throw new Error('Дождитесь завершения сохранения.');
    writing.current = true; setBusy(true); setError('');
    try {
      const value = await store.write(next, { expectedRevision: version.revision, expectedEpoch: version.epoch });
      setEnvelope(value); setRecovery(null); channel.current?.postMessage(value.revision); setNotice('Изменения сохранены');
    } finally { writing.current = false; setBusy(false); }
  }
  async function run(action: () => Promise<unknown>) { try { await action(); } catch (e) { setError(errorText(e)); } }
  async function loadFile(file?: File) {
    if (!file) return;
    if (file.size > 64 * 1024 * 1024) throw new Error('Копия больше 64 МБ. Выберите другой файл.');
    if (file.name.toLowerCase().endsWith('.csv')) {
      if (!state) throw new Error('Для восстановления выберите резервную копию JSON.');
      const imported = parsePurchasesCsv(await file.text(), settings.dataProfile);
      const known = new Set(state.rows.map(row => row.rowId));
      setImportKind('csv');
      setPendingImport({ ...state, rows: [...state.rows, ...imported.filter(row => !known.has(row.rowId))], metadata: { ...state.metadata, hasUnverifiedCsv: true } });
      return;
    }
    setImportKind('backup');
    const parsed = parseBackup(await file.text());
    setPendingImport({ ...parsed.state, rows: identifyRows(parsed.state.rows) });
  }
  const refresh = () => run(async () => {
    try { setEnvelope(await store.read() || empty()); setRecovery(null); setSelected(null); setError(''); setNotice('Данные обновлены'); }
    catch (e) { const value = await store.readRecovery(); setRecovery(value); setEnvelope(null); setSelected(null); throw e; }
  });

  return <>
    <a className="skip" href="#content">К содержимому</a>
    <input ref={input} hidden type="file" accept=".json,.csv,application/json,text/csv" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void run(() => loadFile(file)); }} />
    <div className="layout">
      <aside className="sidebar"><a className="brand" href="#overview"><Icon name="purchases" /><span className="wordmark">Куплено</span></a>
        <nav className="nav" aria-label="Основные разделы">{pages.map(item => <a key={item.id} className="nav-link" href={`#${item.id}`} aria-current={page === item.id ? 'page' : undefined}><Icon name={item.id} />{item.title}</a>)}</nav>
        <div className="sidebar-bottom"><div className="sidebar-note">Ваша история покупок.<br />Хранится на этом устройстве.</div></div>
      </aside>
      <main className="main" id="content">
        <header className="topbar"><span className="topbar-note">История на этом устройстве</span><div className="topbar-actions"><button className="icon-button secondary" aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button><button className="secondary" disabled={!version || busy} onClick={() => input.current?.click()}>Загрузить историю</button></div></header>
        {error && <div className="callout" role="alert"><strong>Действие не завершено</strong><p>{error}</p><div className="row-actions"><button onClick={() => void refresh()}>Обновить данные</button><button className="quiet" onClick={() => setError('')}>Скрыть</button></div></div>}
        {!state ? recovery ? <section className="panel stack"><h1>Восстановить историю</h1><p>Сохранённые данные не прошли проверку. Они остаются на устройстве. Сначала скачайте исходную копию, затем выберите исправную резервную копию или прежнее сохранение.</p><div className="row-actions"><button className="secondary" disabled={!recovery.backup} onClick={() => recovery.backup && download('kupleno-original-recovery.json', recovery.backup)}>Скачать исходные данные</button><button className="secondary" disabled={busy} onClick={() => void run(async () => setHistory(await store.history()))}>История изменений</button></div><p className="note-line">Исходная копия может содержать повреждённые настройки. Не отправляйте её посторонним. Восстановление изменит всю историю только после вашего подтверждения.</p></section> : <div className="boot" role="status"><h1>{error ? 'История не открылась' : 'Открываем покупки'}</h1><p>{error ? 'Попробуйте обновить данные. Сохранённая история остаётся на устройстве.' : 'Читаем локальную историю.'}</p></div> : <div className="page">
          {!rows.length && page === 'overview' ? <Welcome onImport={() => input.current?.click()} onLegacy={() => void run(async () => {
            const legacy = await store.readLegacy();
            if (!legacy) throw new Error('В этом расширении нет старой базы. Загрузите резервную копию из установленной версии.');
            setPendingImport({ ...legacy.state, rows: identifyRows(legacy.state.rows) });
          })} /> : <>
            <div className="page-heading"><div><h1>{pages.find(item => item.id === page)?.title}</h1><p>{page === 'overview' ? 'Расходы и возвраты за выбранный период.' : page === 'purchases' ? 'Чеки, категории и заметки к покупкам.' : page === 'stores' ? 'Загрузите или обновите историю покупок.' : page === 'control' ? 'Бюджет, ожидаемые возвраты и документы.' : 'Резервные копии, профили и категории.'}</p></div>{page === 'overview' && <a className="heading-action" href="#stores">Обновить покупки</a>}</div>
            {page === 'overview' && <details className="overview-filters"><summary><span><Icon name="settings" /><strong>Период и фильтры</strong><small>{Object.values(filters).some(Boolean) ? 'Фильтры применены' : 'Вся история · все магазины'}</small></span></summary><FiltersBar filters={filters} setFilters={setFilters} profiles={settings.profiles} /></details>}{page === 'purchases' && <FiltersBar filters={filters} setFilters={setFilters} profiles={settings.profiles} />}
            {(filters.category || filters.rowIds) && <div className="row-actions" style={{ marginBottom: 16 }}><span>{filters.category ? `Категория: ${filters.category}` : `Связанные операции: ${filters.rowIds?.length}`}</span><button className="quiet" onClick={() => setFilters({ ...filters, category: undefined, rowIds: undefined })}>Показать все покупки</button></div>}
            {page === 'overview' && <Overview rows={visible} filters={filters} onSelect={setSelected} onGroup={group => { setFilters({ ...filters, rowIds: group.map(row => row.rowId) }); location.hash = "purchases"; }} onCategory={category => { setFilters({ ...filters, category }); location.hash = "purchases"; }} onMonth={month => { setFilters({ ...filters, from: `${month}-01`, to: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10) }); location.hash = 'purchases'; }} />}
            {page === 'purchases' && <><div className="row-actions journal-tools"><button className="secondary" onClick={() => download(`kupleno-${new Date().toISOString().slice(0, 10)}.csv`, exportPurchasesCsv(visible), 'text/csv;charset=utf-8')}>Скачать таблицу ({visible.length})</button><label className="checkbox-label"><input type="checkbox" checked={filters.includeExcluded === true} onChange={e => setFilters({ ...filters, includeExcluded: e.target.checked })} />Показать исключённые</label><label className="checkbox-label"><input type="checkbox" checked={filters.categoryReview === true} onChange={e => setFilters({ ...filters, categoryReview: e.target.checked })} />Проверить категории</label></div><Purchases rows={visible} onSelect={setSelected} onBulk={setBulk} /></>}
            {page === 'control' && <Control state={state} save={save} onSelect={setSelected} />}
            {page === 'stores' && <Stores state={state} rows={rows} save={save} onSelect={setSelected} />}
            {page === 'settings' && <div className="stack"><section className="panel"><h2>Ваши данные</h2><div className="setting-row"><div><strong>Резервная копия</strong><small>Покупки, заметки, категории и остальные сохранённые настройки.</small></div><button onClick={() => download(`kupleno-backup-${new Date().toISOString().slice(0,10)}.json`, serializeBackup(state))}>Скачать копию</button></div><div className="setting-row"><div><strong>Вернуться к сохранённому состоянию</strong><small>Последние 12 сохранений. Восстановление тоже можно отменить.</small></div><button disabled={busy} onClick={() => void run(async () => setHistory(await store.history()))}>История изменений</button></div><div className="setting-row"><div><strong>Обновить данные из хранилища</strong><small>Если вы работали в другой вкладке.</small></div><button onClick={() => void refresh()}>Обновить</button></div></section><Preferences state={state} save={save} onSelect={setSelected} /></div>}
          </>}
        </div>}
      </main>
    </div>
    {bulk && state && <BulkEdit state={state} ids={bulk} save={save} onClose={() => setBulk(null)} />}
    {activePurchase && state && <PurchaseEditor state={state} onRecordSave={next => run(async () => { await save(next); setSelected(null); })} error={error} key={activePurchase.rowId} row={activePurchase} profiles={settings.profiles} busy={busy} onClose={() => setSelected(null)} onSave={patch => run(async () => { await save(editOperations(state, [activePurchase.rowId], patch)); setSelected(null); })} />}
    {pendingImport && <Dialog error={error} title="Загрузить историю покупок" onClose={() => !busy && setPendingImport(null)}><p>{importKind === 'csv' ? `После добавления таблицы в истории будет ${operationCount(pendingImport.rows.length)}. Операции с уже известными идентификаторами не добавляются повторно.` : `В копии ${operationCount(pendingImport.rows.length)}. Вместе с ними перенесутся сохранённые настройки и ручные изменения.`}</p>{recovery ? <div className="callout">Исправная копия заменит всю текущую историю. Перед подтверждением скачайте исходные данные на экране восстановления.</div> : importKind === 'backup' && !!state?.rows.length && <div className="callout">Текущая история будет заменена. Предыдущее состояние останется в истории изменений.</div>}<div className="form-footer"><button className="secondary" disabled={busy} onClick={() => setPendingImport(null)}>Отмена</button><button className="primary" disabled={busy} onClick={() => void run(async () => { await save(pendingImport); setPendingImport(null); setFilters({}); location.hash = 'overview'; })}>{busy ? 'Сохраняем…' : 'Загрузить историю'}</button></div></Dialog>}
    {history && version && <Dialog error={error} title="История изменений" onClose={() => !busy && setHistory(null)}>{recovery && <p>Выбранное сохранение заменит всю текущую историю. Сначала скачайте исходные данные; повреждённые снимки не будут восстановлены.</p>}{history.length ? history.map(item => <div className="setting-row" key={item.id}><div><strong>{new Date(item.createdAt).toLocaleString('ru-RU')}</strong><small>{operationCount(item.rows)} · сохранение {item.revision}</small></div><button disabled={busy || (!recovery && item.revision === version.revision)} onClick={() => void run(async () => {
      if (writing.current) return;
      writing.current = true; setBusy(true);
      try { setEnvelope(await store.restore(item.id, { expectedRevision: version.revision, expectedEpoch: version.epoch })); setRecovery(null); setError(''); channel.current?.postMessage('restore'); setHistory(null); setNotice('Состояние восстановлено'); } finally { writing.current = false; setBusy(false); }
    })}>Восстановить</button></div>) : <p>Сохранений пока нет.</p>}</Dialog>}
    {notice && <div className="notice" role="status">{notice}</div>}
  </>;
}

function Welcome({ onImport, onLegacy }: { onImport: () => void; onLegacy: () => void }) {
  return <section className="welcome"><div className="welcome-intro"><h1>История покупок</h1><p>Загрузите покупки и возвраты из магазинов, чтобы посмотреть расходы, найти чек или добавить заметку.</p><a className="welcome-cta" href="#stores">Подключить магазины</a></div><div className="store-picker">{Object.entries(SOURCES).map(([source, info]) => <a href="#stores" className="store-choice" key={source}><StoreMark source={source} /><div><strong>{info.name}</strong><small>Покупки и возвраты</small></div></a>)}</div><div className="welcome-footer"><div><h2>Есть сохранённая история?</h2><p>Загрузите резервную копию или таблицу CSV.</p></div><button className="secondary" onClick={onImport}>Загрузить резервную копию</button></div><div className="welcome-help"><span>История хранится на этом устройстве.</span><button className="quiet" onClick={onLegacy}>Проверить старую базу в этом расширении</button></div></section>;
}

function FiltersBar({ filters, setFilters, profiles }: { filters: Filters; setFilters: (filters: Filters) => void; profiles: { id: string; name: string }[] }) {
  return <div className="filter-area"><div className="filterbar"><label className="search-field">Найти покупку<input type="search" placeholder="Название, заказ или заметка" value={filters.query || ''} onChange={e => setFilters({ ...filters, query: e.target.value })} /></label><label>Магазин<select value={filters.source || ''} onChange={e => setFilters({ ...filters, source: e.target.value })}><option value="">Все магазины</option>{Object.entries(SOURCES).map(([key, source]) => <option key={key} value={key}>{source.name}</option>)}</select></label><label>С даты<input type="date" value={filters.from || ''} onChange={e => setFilters({ ...filters, from: e.target.value })} /></label><label>По дату<input type="date" value={filters.to || ''} onChange={e => setFilters({ ...filters, to: e.target.value })} /></label>{profiles.length > 1 && <label>Профиль<select value={filters.profile || 'all'} onChange={e => setFilters({ ...filters, profile: e.target.value })}><option value="all">Все профили</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}</div>{Object.values(filters).some(value => Array.isArray(value) ? value.length > 0 : value && value !== 'all') && <div className="filter-reset"><span>Показаны покупки по выбранным условиям.</span><button className="quiet" onClick={() => setFilters({})}>Сбросить фильтры</button></div>}</div>;
}

function Overview({ rows, filters, onSelect, onMonth, onGroup, onCategory }: { rows: Purchase[]; filters: Filters; onSelect: (id: string) => void; onMonth: (month: string) => void; onGroup: (rows: Purchase[]) => void; onCategory: (category: string) => void }) {
  const reduce = useReducedMotion();
  const [rankList, enableList] = useAutoAnimate<HTMLDivElement>({ duration: 180 });
  useEffect(() => { enableList(!reduce); }, [reduce, enableList]);
  const totals = summarize(rows);
  const months = monthlyTotals(rows).slice(-12);
  const max = Math.max(1, ...months.map(m => Math.abs(m.amount)));
  const signedMonths = months.some(month => month.amount < 0);
  const categories = categoryTotals(rows).slice(0, 7);
  const categoryMax = Math.max(1, ...categories.map(category => Math.abs(category.amount)));
  const top = largePurchases(rows);
  if (!rows.length) return <div className="panel empty"><h2>Покупок за этот период нет</h2><p>Попробуйте другой период или магазин. Условия можно изменить в разделе «Период и фильтры».</p></div>;
  if (totals.currencies.length || totals.invalid) return <div className="callout"><h2>Общий итог пока не рассчитан</h2><p>В истории есть {totals.invalid ? 'суммы, которые требуют проверки' : `другие валюты: ${totals.currencies.join(', ')}`}. Данные сохранены и доступны в разделе «Покупки».</p><a className="action" href="#purchases">Открыть покупки</a></div>;
  return <>
    <section className="expense-report" aria-label="Итог расходов">
      <div className="report-period"><h2>{periodLabel(filters)}</h2><small>{operationCount(totals.count)}</small></div>
      <div className="kpis">
        <div className="panel kpi"><span className="report-label">{totals.net < 0 ? 'Возвраты превысили покупки' : 'Потрачено с учётом возвратов'}</span><motion.strong key={totals.net} className="kpi-value" initial={reduce ? false : { opacity: 0.65, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}>{formatMoney(totals.net)}</motion.strong>{totals.net === 0 && <small>Покупки и возвраты уравновесились</small>}</div>
        <div className="panel kpi"><small>Покупки</small><strong className="kpi-value">{formatMoney(totals.spent)}</strong><small>До вычета возвратов</small></div>
        <div className="panel kpi"><small>Возвраты</small><strong className="kpi-value">{formatMoney(totals.refunded)}</strong><small>Вычтены из расходов</small></div>
      </div>
    </section>
    {totals.unread > 0 && <div className="callout"><strong>Чеков без списка товаров: {totals.unread}</strong><p>Их суммы включены в итог. Такие чеки не показываем как крупные товары.</p><button onClick={() => onSelect(rows.find(r => r.parse_quality === 'fallback')!.rowId)}>Проверить чек</button></div>}
    <Suspense fallback={<p className="note-line" role="status">Открываем график расходов…</p>}><SpendingChart rows={rows} /></Suspense>
    <div className="split overview-ledger"><div className="stack">
      <section className="panel"><div className="panel-heading"><h2>По месяцам</h2><small>Покупки минус возвраты</small></div>
        <div className={`chart ${signedMonths ? 'chart-signed' : ''}`}>{months.map(month => <div className="chart-column" key={month.key}>
          <button aria-label={`${month.key}: ${formatMoney(month.amount)}`} title={`${monthLabel(month.key)}: ${formatMoney(month.amount)}`} className={month.amount < 0 ? 'negative' : month.amount === 0 ? 'zero' : ''} onClick={() => onMonth(month.key)}>
            <span className="month-label">{monthLabel(month.key)}</span><span className="chart-track" aria-hidden="true"><span className="chart-bar" style={{ width: `${Math.abs(month.amount) / max * (signedMonths ? 50 : 100)}%` }} /></span><span className="chart-amount">{formatMoney(month.amount)}{month.amount < 0 ? <small>Возвратов больше</small> : month.amount === 0 ? <small>Нулевой итог</small> : null}</span>
          </button>
        </div>)}</div><p className="note-line chart-help">Откройте месяц, чтобы посмотреть операции.{signedMonths && ' Слева от нуля - превышение возвратов, справа - расходы.'}</p>
      </section>
      <section className="panel"><div className="panel-heading"><h2>По категориям</h2><small>С учётом возвратов</small></div>{categories.map(category => <div className={`category-row ${category.amount < 0 ? 'category-refund' : ''}`} key={category.key}><button className="quiet" onClick={() => onCategory(category.key)}>{category.key}</button><strong>{formatMoney(category.amount)}</strong><div className="category-track" aria-hidden="true"><span style={{ width: `${Math.abs(category.amount) / categoryMax * 100}%` }} /></div>{category.amount < 0 && <small className="category-explanation">Возвратов больше, чем покупок</small>}</div>)}</section>
    </div>
    <section className="panel"><div className="panel-heading"><h2>Крупные покупки</h2><small>Товары с известным составом чека</small></div><div className="rank-list" ref={rankList}>{top.map(group => <button className="rank-row" key={group.key} onClick={() => group.rows.length === 1 ? onSelect(group.rows[0]!.rowId) : onGroup(group.rows)}><StoreMark source={group.rows[0]!.source} small /><span><strong>{group.rows[0]!.title}</strong><small>{group.count > 1 ? operationCount(group.count) : longDate(group.rows[0]!.date)}</small></span><strong className="amount">{formatMoney(group.amount)}</strong></button>)}</div>{!top.length && <p className="empty">Товаров с положительным итогом и прочитанным составом чека нет. Все операции доступны в разделе «Покупки».</p>}</section></div>
  </>;
}

function Purchases({ rows, onSelect, onBulk }: { rows: Purchase[]; onSelect: (id: string) => void; onBulk: (ids: string[]) => void }) {
  const [offset, setOffset] = useState(0);
  const [checked, setChecked] = useState<string[]>([]);
  useEffect(() => setChecked([]), [rows]);
  useEffect(() => setOffset(0), [rows]);
  const sorted = useMemo(() => [...rows].sort((a, b) => b.date.localeCompare(a.date)), [rows]);
  return <section className="panel"><div className="selection-toolbar"><label className="checkbox-label"><input type="checkbox" aria-label="Выбрать страницу" checked={!!rows.length && sorted.slice(offset, offset + 30).every(row => checked.includes(row.rowId))} onChange={e => setChecked(e.target.checked ? [...new Set([...checked, ...sorted.slice(offset, offset + 30).map(row => row.rowId)])] : checked.filter(id => !sorted.slice(offset, offset + 30).some(row => row.rowId === id)))} />Выбрать страницу</label><button className="secondary" disabled={!checked.length} onClick={() => onBulk(checked)}>Изменить выбранные ({checked.length})</button></div><div className="table-wrap"><table className="purchases-table"><thead><tr><th scope="col">Покупка</th><th scope="col" className="optional">Дата</th><th scope="col">Сумма</th></tr></thead><tbody>{sorted.slice(offset, offset + 30).map((row, index, pageRows) => <Fragment key={row.rowId}>{(index === 0 || row.date.slice(0, 7) !== pageRows[index - 1]!.date.slice(0, 7)) && <tr className="journal-month"><td colSpan={3}><h3>{monthLabel(row.date)}</h3></td></tr>}<tr className={isRefund(row) ? 'journal-refund' : undefined}><td><div className="purchase-title"><input type="checkbox" aria-label={`Выбрать: ${row.title}`} checked={checked.includes(row.rowId)} onChange={e => setChecked(e.target.checked ? [...checked, row.rowId] : checked.filter(id => id !== row.rowId))} /><StoreMark source={row.source} /><div><button onClick={() => onSelect(row.rowId)}>{row.parse_quality === 'fallback' ? 'Чек без списка товаров' : row.title}</button><small className="purchase-meta"><span className="mobile-date">{dateLabel(row.date)} · </span>{SOURCES[sourceOf(row) as keyof typeof SOURCES]?.name || row.source} · {row.category || 'Без категории'}{row.note ? ` · ${row.note}` : ''}</small>{receiptUrl(row) && <a className="receipt-shortcut" href={receiptUrl(row)} aria-label={`Открыть чек: ${row.title}`} target="_blank" rel="noreferrer">Чек ↗</a>}</div></div></td><td className="optional">{dateLabel(row.date)}</td><td className={`amount-cell ${isRefund(row) ? 'refund-amount' : ''}`}>{purchaseAmount(row)}{isRefund(row) && <small className="operation-kind">Возврат</small>}</td></tr></Fragment>)}</tbody></table></div>{!rows.length && <div className="empty">Покупки не найдены. Попробуйте изменить фильтры.</div>}<div className="pagination"><small>{rows.length ? `${offset + 1}–${Math.min(offset + 30, rows.length)} из ${rows.length}` : operationCount(0)}</small><button className="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>Назад</button><button className="secondary" disabled={offset + 30 >= rows.length} onClick={() => setOffset(offset + 30)}>Дальше</button></div></section>;
}

function PurchaseEditor({ row, profiles, busy, onClose, onSave, error, state, onRecordSave }: { state: State; onRecordSave: (state: State) => Promise<unknown>; error: string; row: Purchase; profiles: { id: string; name: string }[]; busy: boolean; onClose: () => void; onSave: (patch: Partial<Purchase>) => Promise<unknown> }) {
  const [mode, setMode] = useState('purchase');
  const [recordError, setRecordError] = useState('');
  const [note, setNote] = useState(row.note || '');
  const [category, setCategory] = useState(row.category || '');
  const [profile, setProfile] = useState(row.profile || profiles[0]?.id || 'personal');
  const [excluded, setExcluded] = useState(row.excluded === true);
  const url = receiptUrl(row);
  const expected: Claim = claims(state).find(item => item.rowId === row.rowId) || { id: crypto.randomUUID(), rowId: row.rowId, marketplace_id: row.marketplace_id || null, source: row.source, profile: row.profile || 'personal', title: row.title, expectedAmount: Math.abs(moneyMinor(row.amount) || 0) / 100, requestedAt: today(), purchaseDate: row.date.slice(0,10), dueDate: addDays(today(), 14), status: 'pending', manualMatchRowIds: [] };
  const warranty: DocumentRecord = documents(state).find(item => item.rowId === row.rowId && item.kind === 'warranty') || { id: crypto.randomUUID(), rowId: row.rowId, marketplace_id: row.marketplace_id || null, source: row.source, profile: row.profile || 'personal', title: row.title, kind: 'warranty', issuedAt: row.date.slice(0,10), expiresAt: null, url, addedAt: today() };
  if (mode !== 'purchase') return <Dialog title={mode === 'return' ? 'Ожидать возврат' : 'Гарантия покупки'} error={recordError || error} onClose={() => !busy && onClose()}><button className="quiet" onClick={() => setMode('purchase')}>← К покупке</button>{mode === 'return' ? <ReturnForm claim={expected} rows={effectiveRows(state)} busy={busy} onSave={claim => { try { void onRecordSave(upsertClaim(state, claim)); } catch (e) { setRecordError(e instanceof Error ? e.message : 'Не удалось сохранить.'); } }} /> : <DocumentForm record={warranty} busy={busy} onSave={record => { try { void onRecordSave(upsertDocument(state, record)); } catch (e) { setRecordError(e instanceof Error ? e.message : 'Не удалось сохранить.'); } }} />}</Dialog>;
  return <Dialog error={error} title={row.parse_quality === 'fallback' ? 'Чек без списка товаров' : row.title} onClose={() => !busy && onClose()}><section className="receipt-summary" aria-label="Сведения об операции"><div className="receipt-merchant"><StoreMark source={row.source} /><div><strong>{SOURCES[sourceOf(row) as keyof typeof SOURCES]?.name || row.source}</strong><span>{longDate(row.date)}</span></div><span className="tag">{isRefund(row) ? 'Возврат' : 'Покупка'}</span></div><div className="receipt-total"><span>{isRefund(row) ? 'Сумма возврата' : 'Сумма операции'}</span><strong className={isRefund(row) ? 'refund-amount' : ''}>{purchaseAmount(row)}</strong></div>{row.marketplace_id && <p className="receipt-order">Заказ {row.marketplace_id}</p>}{row.excluded && <p className="note-line">Не учитывается в расходах</p>}{row.parse_quality === 'fallback' && <div className="callout"><p>Сохранили итог чека. Чтобы проверить товары и возможные повторы, откройте оригинал.</p></div>}<div className="row-actions receipt-link">{url ? <a className="action primary" href={url} target="_blank" rel="noreferrer">Открыть оригинал чека ↗</a> : <p>Ссылка на оригинал не сохранилась в этих данных.</p>}</div></section><div className="receipt-actions"><span>По этой покупке</span><div className="row-actions">{!isRefund(row) && (moneyMinor(row.amount) || 0) > 0 && <button className="secondary" onClick={() => setMode('return')}>Ожидать возврат</button>}<button className="secondary" onClick={() => setMode('warranty')}>Добавить гарантию</button></div></div><LocalReceipt /><form className="receipt-edit" onSubmit={e => { e.preventDefault(); void onSave({ note, category, profile, excluded }); }}><h3>Категория и заметка</h3><p className="note-line">Ваши дополнения к покупке. Данные исходного чека сохранятся.</p>{row.categoryNeedsReview === true && typeof row.categorySuggestion === "string" && row.categorySuggestion !== "unknown" && row.categorySuggestion && <p className="note-line">Возможно, это «{row.categorySuggestion}». <button type="button" className="quiet" onClick={() => setCategory(String(row.categorySuggestion))}>Выбрать категорию</button></p>}<div className="form-grid"><label>Категория<input value={category} maxLength={120} onChange={e => setCategory(e.target.value)} /></label><label>Профиль<select value={profile} onChange={e => setProfile(e.target.value)}>{profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="wide">Заметка<textarea value={note} rows={3} maxLength={4000} onChange={e => setNote(e.target.value)} /></label><label className="wide checkbox-label"><input type="checkbox" checked={excluded} onChange={e => setExcluded(e.target.checked)} />Не учитывать в расходах</label></div><div className="form-footer"><button type="button" className="secondary" disabled={busy} onClick={onClose}>Отмена</button><button className="primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button></div></form></Dialog>;
}
