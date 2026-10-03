import { useEffect, useRef, type ReactNode } from 'react';
import { SOURCES } from '../domain.mjs';
import type { Source } from '../model';

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
  const store = SOURCES[source as Source];
  return <span className={`store-mark ${source} ${small ? 'small' : ''}`} aria-label={store?.name || source}>{store?.mark || '·'}</span>;
}

export function Dialog({ title, children, onClose, error }: { title: string; children: ReactNode; onClose: () => void; error?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    el.showModal();
    return () => { el.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-head"><h2 id="dialog-title">{title}</h2><button className="secondary" onClick={onClose}>Закрыть</button></div>
    <div className="dialog-body">{error && <div className="callout" role="alert">{error}</div>}{children}</div>
  </dialog>;
}

export function ReceiptArt() {
  return <svg className="welcome-art" viewBox="0 0 280 280" fill="none" aria-hidden="true">
    <circle cx="146" cy="138" r="113" fill="var(--accent-soft)" />
    <path d="m24 79 15 3m-6-12 2 19M236 197l16 8m-5-15-6 22" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
    <g className="receipt-sheet"><g transform="rotate(-10 140 140)">
      <path d="M69 27h142v218l-12-8-12 8-12-8-12 8-12-8-12 8-12-8-12 8-12-8-12 8-10-8-11 8Z" fill="var(--surface)" stroke="var(--ink)" strokeWidth="2" />
      <text x="88" y="65" fill="var(--ink)" fontFamily="Golos,Arial" fontSize="19" fontWeight="700">КУПЛЕНО</text>
      <path d="M88 83h103" stroke="var(--line)" strokeWidth="2" strokeDasharray="4 4" />
      <path d="M88 104h54m22 0h26M88 125h68m8 0h26M88 146h39m37 0h26" stroke="var(--muted)" strokeWidth="5" strokeLinecap="round" />
      <path d="M88 168h103" stroke="var(--line)" strokeWidth="2" strokeDasharray="4 4" />
      <text x="88" y="196" fill="var(--accent)" fontFamily="Golos,Arial" fontSize="19" fontWeight="700">Всё сошлось.</text>
      <path d="M90 208v13m5-13v13m8-13v13m4-13v13m8-13v13m8-13v13m4-13v13m6-13v13m9-13v13m4-13v13m8-13v13m5-13v13m8-13v13m4-13v13m8-13v13" stroke="var(--ink)" strokeWidth="2" />
    </g></g>
    <g className="receipt-stamp" style={{ transformOrigin: '212px 100px' }}><path d="m213 50 12 12 17-1 3 17 13 11-9 15 2 17-17 5-10 14-15-8-17 3-6-16-14-9 7-16-4-17 16-7 8-15Z" fill="var(--pop)" stroke="var(--ink)" strokeWidth="2" /><path d="m197 96 12 12 23-27" stroke="#202027" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" /></g>
  </svg>;
}

export function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
