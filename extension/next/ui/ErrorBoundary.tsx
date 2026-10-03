import { Component, type ReactNode } from 'react';
import { createStore, serializeBackup } from '../storage.mjs';
import { download } from './components';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; message: string }> {
  override state = { failed: false, message: '' };
  static getDerivedStateFromError() { return { failed: true, message: '' }; }
  override render() {
    if (!this.state.failed) return this.props.children;
    return <main className="boot"><h1>Не удалось открыть экран</h1><p>Сохранённая история остаётся в хранилище. Можно скачать её копию и перезагрузить страницу.</p><div className="row-actions"><button className="primary" onClick={() => location.reload()}>Перезагрузить</button><button className="secondary" onClick={async () => {
      try {
        const saved = await createStore().read();
        if (!saved) throw new Error('Сохранённая история не найдена.');
        download('kupleno-recovery.json', serializeBackup(saved.state));
      } catch (e) { this.setState({ message: e instanceof Error ? e.message : 'Не удалось скачать копию.' }); }
    }}>Скачать сохранённую копию</button></div>{this.state.message && <p role="alert">{this.state.message}</p>}</main>;
  }
}
