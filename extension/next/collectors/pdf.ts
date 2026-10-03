import moduleUrl from '../../vendor/pdf.mjs?url';
import workerUrl from '../../vendor/pdf.worker.mjs?url';

interface TextItem { str: string; transform: number[] }
interface PdfPage { getTextContent(): Promise<{ items: unknown[] }>; cleanup(): void }
interface PdfDocument { numPages: number; getPage(page: number): Promise<PdfPage>; destroy(): Promise<void> }
interface LoadingTask { promise: Promise<PdfDocument>; destroy(): Promise<void> }
interface PdfLibrary { GlobalWorkerOptions: { workerSrc: string }; getDocument(options: Record<string, unknown>): LoadingTask }
let library: Promise<PdfLibrary> | undefined;

function textItem(value: unknown): value is TextItem {
  return !!value && typeof value === 'object' && 'str' in value && typeof value.str === 'string' && 'transform' in value && Array.isArray(value.transform);
}

export function layoutText(items: unknown[]): string {
  const words = items.filter(textItem).map((item, index) => ({ text: item.str.trim(), x: item.transform[4] || 0, y: item.transform[5] || 0, index })).filter(item => item.text);
  words.sort((a, b) => b.y - a.y || a.x - b.x || a.index - b.index);
  const lines: { y: number; words: typeof words }[] = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last && Math.abs(last.y - word.y) <= 2) last.words.push(word);
    else lines.push({ y: word.y, words: [word] });
  }
  return lines.map(line => line.words.sort((a, b) => a.x - b.x || a.index - b.index).map(word => word.text).join(' ')).join('\n');
}

export async function readPdf(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('Чек больше 20 МБ.');
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('Файл не является PDF-чеком.');
  signal?.throwIfAborted();
  library ??= import(/* @vite-ignore */ moduleUrl).then(module => {
    const pdf = module as PdfLibrary;
    pdf.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdf;
  }).catch(error => { library = undefined; throw error; });
  const pdf = await library;
  signal?.throwIfAborted();
  const task = pdf.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
  const abort = () => { void task.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const document = await task.promise;
    if (document.numPages > 50) throw new Error('В чеке больше 50 страниц.');
    const result: string[] = [];
    for (let index = 1; index <= document.numPages; index++) {
      signal?.throwIfAborted();
      const page = await document.getPage(index);
      try { result.push(layoutText((await page.getTextContent()).items)); } finally { page.cleanup(); }
    }
    return result.join('\n');
  } finally {
    signal?.removeEventListener('abort', abort);
    await task.destroy();
  }
}
