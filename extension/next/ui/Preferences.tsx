import { useMemo, useState } from 'react';
import type { State, Purchase } from '../model';
import { effectiveRows, removeProfile, settingsWithDefaults } from '../preferences.mjs';
import { SOURCES } from '../domain.mjs';
import { Dialog } from './components';

type Rule = { id?: string; category?: string; keywords?: string[]; tokens?: string[]; negativeKeywords?: string[]; sources?: string[]; match?: string; enabled?: boolean; priority?: number; profile?: string; [key: string]: unknown };

export function Preferences({ state, save, onSelect }: { state: State; save: (state: State) => Promise<void>; onSelect: (id: string) => void }) {
  const [view, setView] = useState<'profiles' | 'rules' | 'manual' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [editingProfile, setEditingProfile] = useState('');
  const [editingRule, setEditingRule] = useState<number | null>(null);
  const [rule, setRule] = useState<Rule>({ keywords: [], category: '', match: 'any', enabled: true });
  const [keywords, setKeywords] = useState('');
  const [negativeKeywords, setNegativeKeywords] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(20);
  const settings = settingsWithDefaults(state.settings);
  const rules = (settings.customRules || []) as Rule[];
  const overrides = (settings.overrides || {}) as Record<string, Partial<Purchase>>;
  const rows = useMemo(() => effectiveRows(state), [state]);
  const byId = useMemo(() => new Map(rows.map(row => [row.rowId, row])), [rows]);
  async function commit(next: State) {
    setBusy(true); setError('');
    try { await save(next); return true; }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить.'); return false; }
    finally { setBusy(false); }
  }
  function open(next: typeof view) { setView(next); setError(''); setEditingRule(null); setQuery(''); setLimit(20); }
  const altered = Object.entries(overrides).filter(([id]) => (byId.get(id)?.title || id).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const previewRules = [...rules];
  if (editingRule !== null) previewRules[editingRule] = rule;
  const previews = editingRule === null ? [] : effectiveRows({ ...state, settings: { ...settings, customRules: previewRules } }).filter((row, index) => row.category !== rows[index]?.category || row.profile !== rows[index]?.profile);
  return <>
    <section className="panel"><h2>Как устроена ваша история</h2>
      <div className="setting-row"><div><strong>Профили покупок</strong><small>Разделяйте личные, семейные и рабочие расходы.</small></div><button onClick={() => open('profiles')}>Настроить профили</button></div>
      <div className="setting-row"><div><strong>Правила категорий</strong><small>Назначайте категории похожим товарам автоматически.</small></div><button onClick={() => open('rules')}>Свои правила ({rules.length})</button></div>
      <div className="setting-row"><div><strong>Мои изменения</strong><small>Заметки, категории и исключения из расчёта.</small></div><button onClick={() => open('manual')}>Посмотреть изменения ({Object.keys(overrides).length})</button></div>
    </section>
    {view && <Dialog title={view === 'profiles' ? 'Профили покупок' : view === 'rules' ? 'Свои правила' : 'Мои изменения'} error={error} onClose={() => !busy && setView(null)}>
      {view === 'profiles' && <>
        <p className="note-line">Профиль для сбора определяет, куда попадут новые покупки.</p>
        <label>Профиль для сбора<select disabled={busy} value={settings.dataProfile} onChange={e => void commit({ ...state, settings: { ...settings, dataProfile: e.target.value } })}>{settings.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        {settings.profiles.map(profile => <div className="setting-row" key={profile.id}><div><strong>{profile.name}</strong><small>{rows.filter(row => row.profile === profile.id).length} операций</small></div><div className="row-actions"><button disabled={busy} onClick={() => { setEditingProfile(profile.id); setProfileName(profile.name); }}>Переименовать</button><button disabled={busy || settings.profiles.length < 2} onClick={() => { try { void commit(removeProfile(state, profile.id)); } catch (e) { setError(String(e)); } }}>Объединить с другим</button></div></div>)}
        <p className="note-line">При объединении покупки и документы перейдут в первый оставшийся профиль. Предыдущее состояние доступно в истории изменений.</p>
        <form onSubmit={e => { e.preventDefault(); const name = profileName.trim(); if (!name) return; if (settings.profiles.some(p => p.id !== editingProfile && p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { setError('Такой профиль уже есть.'); return; } const profiles = editingProfile ? settings.profiles.map(p => p.id === editingProfile ? { ...p, name } : p) : [...settings.profiles, { id: crypto.randomUUID(), name }]; void commit({ ...state, settings: { ...settings, profiles } }).then(ok => { if (ok) { setProfileName(''); setEditingProfile(''); } }); }}>
          <label>{editingProfile ? 'Новое название' : 'Новый профиль'}<input required maxLength={80} value={profileName} onChange={e => setProfileName(e.target.value)} /></label><div className="form-footer">{editingProfile && <button type="button" onClick={() => { setEditingProfile(''); setProfileName(''); }}>Отмена</button>}<button className="primary" disabled={busy}>{editingProfile ? 'Сохранить название' : 'Добавить профиль'}</button></div>
        </form>
      </>}
      {view === 'rules' && (editingRule === null ? <>
        <p className="note-line">Ручная категория покупки всегда важнее правила. Изменения применяются сразу ко всей истории.</p>
        <button className="primary" onClick={() => { setRule({ id: crypto.randomUUID(), category: '', keywords: [], match: 'any', enabled: true }); setKeywords(''); setNegativeKeywords(''); setEditingRule(rules.length); }}>Добавить правило</button>
        {rules.map((item, index) => <div className="setting-row" key={item.id || index}><div><strong>{item.category || 'Правило профиля'}</strong><small>{(item.keywords || item.tokens || []).join(', ')}{item.enabled === false ? ' · выключено' : ''}</small></div><div className="row-actions"><button disabled={busy} onClick={() => { setRule(structuredClone(item)); setKeywords((item.keywords || item.tokens || []).join(', ')); setNegativeKeywords((item.negativeKeywords || []).join(', ')); setEditingRule(index); }}>Изменить</button><button disabled={busy} onClick={() => void commit({ ...state, settings: { ...settings, customRules: rules.filter((_, i) => i !== index) } })}>Удалить</button></div></div>)}
      </> : <form onSubmit={e => { e.preventDefault(); if (!rule.category?.trim() || !(rule.keywords || []).length) { setError('Укажите слова и категорию.'); return; } const next = [...rules]; next[editingRule] = { ...rule, category: rule.category.trim() }; void commit({ ...state, settings: { ...settings, customRules: next } }).then(ok => { if (ok) setEditingRule(null); }); }}>
        <div className="form-grid"><label className="wide">Слова или фразы через запятую<input required value={keywords} onChange={e => { setKeywords(e.target.value); setRule({ ...rule, keywords: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }); }} /></label>
          <label>Категория<input required maxLength={120} value={rule.category || ''} onChange={e => setRule({ ...rule, category: e.target.value })} /></label>
          <label>Совпадение<select value={rule.match || 'any'} onChange={e => setRule({ ...rule, match: e.target.value })}><option value="any">Любая фраза</option><option value="all">Все фразы</option><option value="exact">Название целиком</option></select></label>
          <label>Магазин<select value={rule.sources?.length === 1 ? rule.sources[0] : ''} onChange={e => setRule({ ...rule, sources: e.target.value ? [e.target.value] : [] })}><option value="">Все магазины</option>{Object.entries(SOURCES).map(([id, source]) => <option key={id} value={id}>{source.name}</option>)}</select></label>
          <label>Приоритет<input type="number" min={-1000} max={1000} value={rule.priority || 0} onChange={e => setRule({ ...rule, priority: Number(e.target.value) })} /></label>
          <label className="wide">Не применять, если есть слова<input value={negativeKeywords} onChange={e => { setNegativeKeywords(e.target.value); setRule({ ...rule, negativeKeywords: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }); }} /></label>
          <label className="checkbox-label"><input type="checkbox" checked={rule.enabled !== false} onChange={e => setRule({ ...rule, enabled: e.target.checked })} />Правило включено</label>
        </div><p className="note-line">Изменится операций: {previews.length}. {previews.slice(0, 3).map(row => row.title).join(' · ')}</p>
        <div className="form-footer"><button type="button" disabled={busy} onClick={() => setEditingRule(null)}>Назад</button><button className="primary" disabled={busy}>Сохранить правило</button></div>
      </form>)}
      {view === 'manual' && <><label>Найти изменение<input type="search" value={query} onChange={e => { setQuery(e.target.value); setLimit(20); }} /></label>
        {altered.slice(0, limit).map(([id, patch]) => <div className="setting-row" key={id}><div><button className="quiet" onClick={() => { setView(null); onSelect(id); }}>{byId.get(id)?.title || 'Покупка пока отсутствует в истории'}</button><small>{[patch.category, patch.note, patch.excluded ? 'Не учитывается' : '', patch.profile ? settings.profiles.find(p => p.id === patch.profile)?.name : ''].filter(Boolean).join(' · ') || 'Изменены настройки покупки'}</small></div><button disabled={busy} onClick={() => { const next = { ...overrides }; delete next[id]; void commit({ ...state, settings: { ...settings, overrides: next } }); }}>Сбросить правку</button></div>)}
        {!altered.length && <p className="note-line">Ручных изменений не найдено.</p>}{altered.length > limit && <button onClick={() => setLimit(limit + 20)}>Показать ещё</button>}
      </>}
    </Dialog>}
  </>;
}
