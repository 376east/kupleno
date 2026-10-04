import { useEffect, useState } from 'react';
import { archiveStatus, budgetReport, claims, closeMonth, documents, getBudget, monthRange, reconcileClaims, reopenMonth, setBudget, today, upsertClaim, upsertDocument, type Claim, type DocumentRecord } from '../lifecycle';
import { formatMoney, moneyDecimal, moneyMinor, receiptUrl } from '../domain.mjs';
import { effectiveRows, settingsWithDefaults } from '../preferences.mjs';
import type { Purchase, State } from '../model';
import { Dialog } from './components';
import { Analysis } from './Analysis';

const statuses: Record<string, string> = { pending: 'Ждём деньги', partial: 'Вернулась часть', overdue: 'Срок прошёл', disputed: 'Нужно проверить', received: 'Деньги вернулись', active: 'Действует', expiring: 'Скоро закончится', expired: 'Срок закончился' };
const tabFromHash = () => ['budget', 'returns', 'documents', 'review'].includes(location.hash.split('/')[1] || '') ? location.hash.split('/')[1]! : 'budget';

export function Control({ state, save, onSelect }: { state: State; save: (state: State) => Promise<void>; onSelect: (id: string) => void }) {
  const [tab, setTab] = useState(tabFromHash);
  const [month, setMonth] = useState(today().slice(0,7));
  const [profile, setProfile] = useState('all');
  const [editing, setEditing] = useState<Claim | DocumentRecord | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { const update = () => { setTab(tabFromHash()); setEditing(null); setError(''); }; window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  const settings = settingsWithDefaults(state.settings), rows = effectiveRows(state);
  async function apply(next: State) { setBusy(true); setError(''); try { await save(next); setEditing(null); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить.'); } finally { setBusy(false); } }
  const returns = reconcileClaims(claims(state), rows).filter(item => profile === 'all' || item.claim.profile === profile);
  const archive = documents(state).filter(item => profile === 'all' || item.profile === profile);
  return <div className="stack"><div className="control-nav"><nav aria-label="Что контролируем">{[['budget','Бюджет'],['returns','Возвраты'],['documents','Гарантии и чеки'],['review','Проверка покупок']].map(([id,title]) => <a className="nav-link" key={id} href={`#control/${id}`} aria-current={tab === id ? 'page' : undefined}>{title}</a>)}</nav><label>Профиль<select value={profile} onChange={e => setProfile(e.target.value)}><option value="all">Все профили</option>{settings.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div>
    {error && <div className="callout" role="alert">{error}</div>}
    {tab === 'review' && <Analysis state={state} profile={profile} save={save} onSelect={onSelect} />}
    {tab === 'budget' && <><label className="month-field">Месяц<input type="month" value={month} onChange={e => { if (e.target.value) setMonth(e.target.value); }} /></label><BudgetEditor key={`${month}:${profile}`} state={state} month={month} profile={profile} save={apply} busy={busy} /></>}
    {tab === 'returns' && <section className="panel"><h2>Ожидаемые возвраты</h2><p className="note-line">Чтобы добавить ожидание, откройте покупку и выберите «Ожидать возврат».</p>{!returns.length && <div className="empty">Нет ожидаемых возвратов.</div>}<div className="record-list">{returns.map(item => <article className="record" key={item.claim.id}><div className="record-heading"><strong>{item.claim.title}</strong><span className={`tag ${item.status === 'received' ? 'good' : 'warning'}`}>{statuses[item.status]}</span></div><p>Ожидается {formatMoney(item.expected)} · вернулось {formatMoney(item.received)} · срок {item.claim.dueDate}</p>{item.problem && <p>{item.problem}</p>}{item.claim.note && <p>{item.claim.note}</p>}<div className="row-actions">{item.claim.rowId && <button className="secondary" onClick={() => onSelect(item.claim.rowId!)}>Покупка</button>}<button className="secondary" onClick={() => setEditing(item.claim)}>Изменить</button><button className="quiet" disabled={busy} onClick={() => void apply({ ...state, settings: { ...state.settings, refundClaims: claims(state).filter(claim => claim.id !== item.claim.id) } })}>Убрать ожидание</button></div></article>)}</div></section>}
    {tab === 'documents' && <section className="panel"><h2>Гарантии и сохранённые чеки</h2><p className="note-line">Документы привязаны к покупкам. Добавить гарантию можно в карточке покупки.</p>{!archive.length && <div className="empty">Сохранённых документов пока нет.</div>}<div className="record-list">{archive.map(item => {
      const status = archiveStatus(item);
      const link = receiptUrl({ receipt_url: item.url } as Purchase);
      return <article className="record" key={item.id}><div className="record-heading"><strong>{item.title}</strong><span className={`tag ${status === 'active' ? 'good' : 'warning'}`}>{statuses[status]}</span></div><p>{item.kind === 'warranty' ? 'Гарантия' : 'Чек'}{item.expiresAt ? ` · до ${item.expiresAt}` : ''}{item.note ? ` · ${item.note}` : ''}</p><div className="row-actions">{link && <a className="action" href={link} target="_blank" rel="noreferrer">Открыть документ ↗</a>}{item.rowId && <button className="secondary" onClick={() => onSelect(item.rowId!)}>Покупка</button>}<button className="secondary" onClick={() => setEditing(item)}>Изменить</button><button className="quiet" disabled={busy} onClick={() => void apply({ ...state, settings: { ...state.settings, warranties: documents(state).filter(record => record.id !== item.id) } })}>Убрать из списка</button></div></article>;
    })}</div></section>}
    {editing && <Dialog title={tab === 'returns' ? 'Ожидание возврата' : 'Документ покупки'} error={error} onClose={() => !busy && setEditing(null)}>{tab === 'returns' ? <ReturnForm claim={editing as Claim} rows={rows} busy={busy} onSave={claim => { try { void apply(upsertClaim(state, claim)); } catch (e) { setError(String(e)); } }} /> : <DocumentForm record={editing as DocumentRecord} busy={busy} onSave={record => { try { void apply(upsertDocument(state, record)); } catch (e) { setError(String(e)); } }} />}</Dialog>}
  </div>;
}

function BudgetEditor({ state, month, profile, save, busy }: { state: State; month: string; profile: string; save: (state: State) => Promise<void>; busy: boolean }) {
  const budget = getBudget(state, month, profile);
  const [total, setTotal] = useState(String(budget.total || ''));
  const [limits, setLimits] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(budget.categories).map(([key,value]) => [key,String(value)])));
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState('');
  let report: ReturnType<typeof budgetReport>;
  try { report = budgetReport(state, month, profile); } catch (e) { return <div className="callout" role="alert">{e instanceof Error ? e.message : 'Не удалось рассчитать бюджет.'}</div>; }
  const categories = [...new Set([...report.categories.map(c => c.key), ...Object.keys(budget.categories)])];
  const closures = state.settings.monthClosures as Record<string, { status?: string; totals?: { netSpend: number } }> | undefined;
  const closure = closures?.[`${profile}\u0001${month}`];
  const savedNet = moneyMinor(closure?.totals?.netSpend);
  async function commit() {
    try {
      const parsed = moneyMinor(total || '0');
      if (parsed === null) throw new Error('Укажите общий бюджет с точностью до копеек.');
      const values: Record<string,number> = {};
      for (const [key,value] of Object.entries(limits)) { const amount = moneyMinor(value || '0'); if (amount === null) throw new Error(`Проверьте лимит категории «${key}».`); values[key] = Number(moneyDecimal(amount)); }
      await save(setBudget(state, month, profile, { ...budget, total: Number(moneyDecimal(parsed)), categories: values })); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить бюджет.'); }
  }
  return <><section className="panel"><div className="panel-heading"><h2>План на месяц</h2><strong>{formatMoney(report.totals.net)} потрачено</strong></div>{error && <p role="alert">{error}</p>}<form onSubmit={e => { e.preventDefault(); void commit(); }}><div className="form-grid"><label>Общий бюджет, ₽<input inputMode="decimal" value={total} placeholder="Например, 30 000" onChange={e => setTotal(e.target.value)} /></label><div><small>{budget.total ? report.remaining >= 0 ? 'Осталось по сохранённому плану' : 'Сверх сохранённого плана' : 'Общий лимит не задан'}</small>{budget.total > 0 && <strong className="kpi-value">{formatMoney(Math.abs(report.remaining))}</strong>}</div></div><details className="budget-categories"><summary>Лимиты по категориям</summary>{categories.map(category => <label className="setting-row" key={category}><span>{category}</span><input aria-label={`Лимит: ${category}`} inputMode="decimal" value={limits[category] || ''} placeholder="Без лимита" onChange={e => setLimits({ ...limits, [category]: e.target.value })} /></label>)}</details><div className="form-footer"><button className="primary" disabled={busy}>Сохранить бюджет</button></div></form></section>
    <section className="panel"><div className="panel-heading"><h2>Итог месяца</h2><span className="tag">{closure?.status === 'closed' ? 'Сохранён' : 'Открыт'}</span></div><p>Сохранённый итог помогает заметить изменения после нового сбора или правок.</p>{closure?.status === 'closed' ? <>{savedNet === null ? <p className="note-line">Сумма сохранённого итога недоступна. Откройте месяц для проверки и сохраните его заново.</p> : <><strong>{formatMoney(savedNet)}</strong>{savedNet !== report.totals.net && <p className="callout">Текущий итог отличается: {formatMoney(report.totals.net)}. Откройте месяц для проверки перед повторным сохранением.</p>}</>}<div className="row-actions"><button className="secondary" disabled={busy} onClick={() => void save(reopenMonth(state, month, profile))}>Открыть месяц для проверки</button></div></> : <>{report.totals.unread > 0 && <label className="checkbox-label"><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} />Подтверждаю итог, включая {report.totals.unread} чеков без состава</label>}<button className="secondary" disabled={busy || (report.totals.unread > 0 && !approved)} onClick={() => { try { void save(closeMonth(state, month, profile, approved)); } catch (e) { setError(String(e)); } }}>Сохранить итог месяца</button></>}</section>
    <div className="row-actions"><button className="secondary" disabled={busy} onClick={() => {
      const range = monthRange(month), next = new Date(`${range.to}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
      void save(setBudget(state, next.toISOString().slice(0,7), profile, budget));
    }}>Скопировать сохранённый бюджет на следующий месяц</button></div></>;
}

export function ReturnForm({ claim, rows, busy, onSave }: { claim: Claim; rows: Purchase[]; busy: boolean; onSave: (value: Claim) => void }) {
  const [draft, setDraft] = useState(claim);
  const refunds = rows.filter(row => (moneyMinor(row.amount) || 0) < 0 && !row.excluded && (!claim.profile || row.profile === claim.profile) && (!claim.source || row.source === claim.source));
  return <form onSubmit={e => { e.preventDefault(); onSave(draft); }}><p>{claim.title}</p><div className="form-grid"><label>Ожидаемая сумма, ₽<input required inputMode="decimal" value={draft.expectedAmount} onChange={e => setDraft({ ...draft, expectedAmount: e.target.value })} /></label><label>Жду до<input required type="date" value={draft.dueDate} onChange={e => setDraft({ ...draft, dueDate: e.target.value })} /></label><label>Дата обращения<input required type="date" value={draft.requestedAt} onChange={e => setDraft({ ...draft, requestedAt: e.target.value })} /></label><label className="wide">Заметка<textarea rows={3} maxLength={4000} value={draft.note || ''} onChange={e => setDraft({ ...draft, note: e.target.value })} /></label></div><details className="budget-categories"><summary>Связать с полученным возвратом</summary><p className="note-line">Выбирайте только операции, которые относятся к этой покупке.</p>{refunds.map(row => <label className="checkbox-label" key={row.rowId}><input type="checkbox" checked={draft.manualMatchRowIds?.includes(row.rowId) || false} onChange={e => setDraft({ ...draft, manualMatchRowIds: e.target.checked ? [...(draft.manualMatchRowIds || []), row.rowId] : draft.manualMatchRowIds?.filter(id => id !== row.rowId) })} />{row.date.slice(0,10)} · {row.title} · {formatMoney(Math.abs(moneyMinor(row.amount) || 0))}</label>)}</details><div className="form-footer"><button className="primary" disabled={busy}>Сохранить ожидание</button></div></form>;
}

export function DocumentForm({ record, busy, onSave }: { record: DocumentRecord; busy: boolean; onSave: (record: DocumentRecord) => void }) {
  const [draft, setDraft] = useState(record);
  return <form onSubmit={e => { e.preventDefault(); onSave(draft); }}><div className="form-grid"><label className="wide">Название<input required value={draft.title} maxLength={500} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label><label>Документ<select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as DocumentRecord['kind'] })}><option value="warranty">Гарантия</option><option value="receipt">Чек</option></select></label><label>Действует до<input type="date" value={draft.expiresAt || ''} onChange={e => setDraft({ ...draft, expiresAt: e.target.value || null })} /></label><label className="wide">Ссылка на документ<input type="url" value={draft.url || ''} onChange={e => setDraft({ ...draft, url: e.target.value })} /></label><label className="wide">Заметка<textarea rows={3} maxLength={4000} value={draft.note || ''} onChange={e => setDraft({ ...draft, note: e.target.value })} /></label></div><div className="form-footer"><button className="primary" disabled={busy}>Сохранить документ</button></div></form>;
}
