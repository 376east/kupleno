import { useMemo, useState } from 'react';
import { inspectPurchases } from '../intelligence';
import { effectiveRows } from '../preferences.mjs';
import { formatMoney, moneyMinor, SOURCES } from '../domain.mjs';
import type { State, Source } from '../model';

const labels: Record<string, string> = { possible_duplicate: 'Возможный повтор', price_increase: 'Цена выросла', large_new_expense: 'Крупная покупка', refund_without_purchase: 'Возврат без найденной покупки' };
export function Analysis({ state, profile, save, onSelect }: { state: State; profile: string; save: (state: State) => Promise<void>; onSelect: (id: string) => void }) {
  const [mode, setMode] = useState('anomalies');
  const [search, setSearch] = useState('');
  const [showChecked, setShowChecked] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(20);
  const reports = useMemo(() => inspectPurchases(effectiveRows(state), profile), [state, profile]);
  const dismissed = (state.settings.anomalyDismissals || {}) as Record<string, boolean>;
  const decisions = (state.settings.recurringDecisions || {}) as Record<string, string>;
  const matches = (name: string) => name.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  const anomalies = reports.flatMap(report => report.anomalies).filter(item => (showChecked || !dismissed[item.id]) && matches(item.name));
  const recurring = reports.flatMap(report => report.recurring).filter(item => (showChecked || (decisions[item.id] || decisions[item.legacyId]) !== 'ignored') && matches(item.name));
  const prices = reports.flatMap(report => report.prices).filter(item => matches(item.name));
  async function decision(key: 'anomalyDismissals' | 'recurringDecisions', id: string, value?: boolean | string) {
    const map = { ...(state.settings[key] as Record<string, unknown> || {}) };
    if (value === undefined) delete map[id]; else map[id] = value;
    setBusy(true); setError('');
    try { await save({ ...state, settings: { ...state.settings, [key]: map } }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить решение.'); }
    finally { setBusy(false); }
  }
  const count = mode === 'anomalies' ? anomalies.length : mode === 'recurring' ? recurring.length : prices.length;
  return <section className="panel"><h2>Проверка покупок</h2><p className="note-line">Это подсказки для проверки чеков. Похожие названия сами по себе не доказывают дубль.</p>
    <div className="form-grid"><label>Что посмотреть<select value={mode} onChange={e => { setMode(e.target.value); setLimit(20); }}><option value="anomalies">Необычные операции</option><option value="recurring">Регулярные покупки</option><option value="prices">История цен</option></select></label><label>Найти товар<input type="search" value={search} onChange={e => { setSearch(e.target.value); setLimit(20); }} /></label></div>
    {mode !== 'prices' && <label className="checkbox-label"><input type="checkbox" checked={showChecked} onChange={e => setShowChecked(e.target.checked)} />Показать проверенные и скрытые</label>}
    {error && <div className="callout" role="alert">{error}</div>}
    <div className="record-list">
      {mode === 'anomalies' && anomalies.slice(0, limit).map(item => <article className="record" key={item.id}><div className="record-heading"><strong>{item.name}</strong><span className="tag">{dismissed[item.id] ? 'Проверено' : labels[item.type]}</span></div><p>{item.reason}</p><div className="row-actions">{item.rows.map(row => <button className="secondary" key={row.rowId} onClick={() => onSelect(row.rowId)}>{row.date.slice(0,10)} · {formatMoney(moneyMinor(row.amount) || 0)}</button>)}<button className="quiet" disabled={busy} onClick={() => void decision('anomalyDismissals', item.id, dismissed[item.id] ? undefined : true)}>{dismissed[item.id] ? 'Вернуть на проверку' : 'Проверено, всё верно'}</button></div></article>)}
      {mode === 'recurring' && recurring.slice(0, limit).map(item => <article className="record" key={item.id}><div className="record-heading"><strong>{item.name}</strong><span className="tag">{(decisions[item.id] || decisions[item.legacyId]) === 'confirmed' ? 'Подтверждено' : 'Похоже на регулярную покупку'}</span></div><p>{item.occurrenceCount} покупок · примерно раз в {item.intervalDays} дней · в среднем {formatMoney(Math.round(item.averageAmount * 100))}</p><p className="note-line">Оценка за год: {formatMoney(Math.round(item.estimatedAnnualAmount * 100))}, если частота и цена сохранятся.</p><div className="row-actions">{item.rows.slice(-3).map(row => <button className="secondary" key={row.rowId} onClick={() => onSelect(row.rowId)}>{row.date.slice(0,10)}</button>)}<button disabled={busy} onClick={() => void decision('recurringDecisions', item.id, 'confirmed')}>Да, покупаю регулярно</button><button className="quiet" disabled={busy} onClick={() => void decision('recurringDecisions', item.id, 'ignored')}>Скрыть подсказку</button></div></article>)}
      {mode === 'prices' && prices.slice(0, limit).map(item => <article className="record" key={item.id}><div className="record-heading"><strong>{item.name}</strong><span className="tag">{SOURCES[item.rows[0]!.source as Source]?.name || item.rows[0]!.source}</span></div><p className="note-line">Цена за {item.unit === 'g' ? 'грамм' : item.unit === 'ml' ? 'миллилитр' : 'штуку'}. Количество из названия товара может требовать проверки.</p><div className="row-actions">{item.observations.slice(-8).map((point, index) => { const actualIndex = Math.max(0, item.observations.length - 8) + index; return <button className="secondary" key={actualIndex} onClick={() => onSelect(item.rows[actualIndex]!.rowId)}>{point.date.slice(0,10)} · {point.unitPrice.toLocaleString('ru-RU', { maximumFractionDigits: 4 })} ₽</button>; })}</div></article>)}
    </div>{!count && <div className="empty">Подходящих операций нет. Измените поиск или выберите другой вид проверки.</div>}{count > limit && <button onClick={() => setLimit(limit + 20)}>Показать ещё</button>}
  </section>;
}
