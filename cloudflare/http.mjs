export function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readBody(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413, 'The request is too large.');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, 'The request is too large.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function readJSON(request, limit = 512 * 1024) {
  try { return JSON.parse(new TextDecoder().decode(await readBody(request, limit))); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid JSON payload.');
  }
}
