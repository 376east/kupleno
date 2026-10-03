/** Only called after the worker has validated the receipt endpoint and active job. */
export async function fetchOzonPdf(url: string, request: typeof fetch = fetch) {
  const binary = true;
  try {
    const response = await request(url, { credentials: 'include', signal: AbortSignal.timeout(25000), headers: { accept: 'application/pdf,*/*' } });
    const final = new URL(response.url || url);
    if (final.protocol !== 'https:' || !['ozon.ru', 'www.ozon.ru'].includes(final.hostname)) return { status: 403, text: '', binary, error: 'Ozon перенаправил PDF за пределы магазина.' };
    if (!response.ok) return { status: response.status, text: '', binary, error: '' };
    const max = 20 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > max) throw new RangeError();
    const reader = response.body?.getReader();
    if (!reader) throw new Error('EMPTY_BODY');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > max) throw new RangeError();
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    let encoded = '';
    for (const chunk of chunks) for (let offset = 0; offset < chunk.length; offset += 32768) encoded += String.fromCharCode(...chunk.subarray(offset, offset + 32768));
    return { status: response.status, text: btoa(encoded), binary, error: '' };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    return { status: name === 'RangeError' ? 413 : 502, text: '', binary, error: name === 'RangeError' ? 'PDF Ozon превышает 20 МБ.' : name === 'TimeoutError' ? 'Ozon не отдал PDF за 25 секунд.' : `Ozon: фоновая загрузка PDF не удалась (${name === 'TypeError' ? 'ошибка сети' : 'ошибка ответа'}).` };
  }
}
