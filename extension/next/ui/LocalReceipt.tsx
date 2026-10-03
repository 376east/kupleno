import { useRef, useState } from 'react';
import { readPdf } from '../collectors/pdf';

// Inspection never changes a purchase or silently replaces its amount.
export function LocalReceipt() {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return <details className="local-receipt"><summary>Есть скачанный PDF-чек?</summary><p className="note-line">Можно прочитать его здесь. Файл остаётся на устройстве; сумма покупки не изменится.</p><input ref={input} type="file" hidden accept="application/pdf,.pdf" onChange={async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setBusy(true); setError(''); setText('');
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Чек больше 20 МБ.');
      const result = await readPdf(new Uint8Array(await file.arrayBuffer()));
      if (!result.trim()) throw new Error('В этом PDF не удалось прочитать текст. Откройте файл в просмотрщике PDF.');
      setText(result);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось прочитать чек.'); } finally { setBusy(false); }
  }} /><button type="button" className="secondary" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Читаем чек…' : 'Выбрать PDF-чек'}</button>{error && <p role="alert">{error}</p>}{text && <pre className="diagnostic-text" aria-label="Текст чека">{text}</pre>}</details>;
}
