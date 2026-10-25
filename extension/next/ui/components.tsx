import { useEffect, useRef, type ReactNode } from 'react';
import { SOURCES, sourceOf } from '../domain.mjs';
import type { Source } from '../model';

const operationPlurals = new Intl.PluralRules('ru');
export function operationCount(count: number) {
  const form = operationPlurals.select(count);
  return `${count.toLocaleString('ru-RU')} ${form === 'one' ? 'операция' : form === 'few' ? 'операции' : 'операций'}`;
}

export function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    overview: <><path d="M3 11 12 3l9 8v10h-6v-7H9v7H3Z" /></>,
    purchases: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z" /><path d="M9 8h6M9 12h6" /></>,
    stores: <><path d="m3 9 2-6h14l2 6M3 9h18v4a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0ZM5 16v5h14v-5" /></>,
    control: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>,
    settings: <><path d="M3 6h4m4 0h10M3 12h10m4 0h4M3 18h4m4 0h10" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="9" cy="18" r="2" /></>,
    moon: <path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.purchases}</svg>;
}

export function StoreMark({ source, small = false }: { source: string; small?: boolean }) {
  const key = sourceOf({ source });
  const store = SOURCES[key as Source];
  return <span className={`store-mark ${key} ${small ? 'small' : ''}`} aria-label={store?.name || source}>{store?.mark || '·'}</span>;
}

export function Dialog({ title, children, onClose, error }: { title: string; children: ReactNode; onClose: () => void; error?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    // Keep keyboard-triggered dialogs immediate. CSS also respects reduced motion.
    el.dataset.enter = previous?.matches('button:not(:focus-visible), a:not(:focus-visible)') ? 'true' : 'false';
    el.showModal();
    return () => { el.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-sheet">
    <div className="dialog-head"><h2 id="dialog-title">{title}</h2><button className="secondary" onClick={onClose}>Закрыть</button></div>
    <div className="dialog-body">{error && <div className="callout" role="alert">{error}</div>}{children}</div>
    </div>
  </dialog>;
}

export function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
