import { useState } from 'react';
import type { Purchase, State } from '../model';
import { editOperations, settingsWithDefaults } from '../preferences.mjs';
import { Dialog } from './components';

export function BulkEdit({ state, ids, save, onClose }: { state: State; ids: string[]; save: (state: State) => Promise<void>; onClose: () => void }) {
  const [category, setCategory] = useState('');
  const [profile, setProfile] = useState('');
  const [excluded, setExcluded] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Dialog title={`Изменить покупки: ${ids.length}`} error={error} onClose={() => !busy && onClose()}>
    <p className="note-line">Общие настройки применятся к выбранным покупкам. Исходные чеки сохранятся.</p>
    <form onSubmit={e => { e.preventDefault(); const patch: Partial<Purchase> = {}; if (category.trim()) patch.category = category.trim(); if (profile) patch.profile = profile; if (excluded) patch.excluded = excluded === 'yes'; setBusy(true); void Promise.resolve().then(() => save(editOperations(state, ids, patch))).then(onClose).catch(e => setError(e instanceof Error ? e.message : 'Не удалось сохранить.')).finally(() => setBusy(false)); }}>
      <div className="form-grid"><label>Категория<input placeholder="Оставить как есть" maxLength={120} value={category} onChange={e => setCategory(e.target.value)} /></label><label>Профиль<select value={profile} onChange={e => setProfile(e.target.value)}><option value="">Оставить как есть</option>{settingsWithDefaults(state.settings).profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="wide">Участие в расходах<select value={excluded} onChange={e => setExcluded(e.target.value)}><option value="">Оставить как есть</option><option value="yes">Не учитывать</option><option value="no">Учитывать</option></select></label></div>
      <div className="form-footer"><button type="button" disabled={busy} onClick={onClose}>Отмена</button><button className="primary" disabled={busy || (!category.trim() && !profile && !excluded)}>Применить к выбранным</button></div>
    </form>
  </Dialog>;
}
