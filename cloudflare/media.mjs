// Files over the static-asset limit are stored losslessly as several assets.
// Stream only the pieces intersecting the requested range so seeking stays fast.
export async function serveMedia(request, env, file) {
  const headers = new Headers({ 'Content-Type': file.type, 'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600', ETag: `"${file.hash}"` });
  if (request.headers.get('if-none-match') === headers.get('etag')) return new Response(null, { status: 304, headers });
  let start = 0;
  let end = file.size - 1;
  let status = 200;
  const ifRange = request.headers.get('if-range');
  const range = !ifRange || ifRange === headers.get('etag') ? request.headers.get('range') : null;
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (match && (match[1] || match[2])) {
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
    } else { start = Math.max(0, file.size - Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.size) {
      headers.set('Content-Range', `bytes */${file.size}`);
      return new Response(null, { status: 416, headers });
    }
    status = 206;
    headers.set('Content-Range', `bytes ${start}-${end}/${file.size}`);
  }
  headers.set('Content-Length', String(end - start + 1));
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  const parts = file.parts.filter(part => part.offset <= end && part.offset + part.size > start);
  let index = 0;
  let reader;
  let skip = 0;
  let remaining = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (!cancelled) {
          if (!reader) {
            if (index === parts.length) { controller.close(); return; }
            const part = parts[index++];
            const from = Math.max(0, start - part.offset);
            const to = Math.min(part.size - 1, end - part.offset);
            const partial = from !== 0 || to !== part.size - 1;
            const response = await env.ASSETS.fetch(new Request(new URL(part.path, request.url), {
              headers: partial ? { Range: `bytes=${from}-${to}` } : {}
            }));
            if (!response.ok) throw new Error('Audio asset unavailable.');
            if (cancelled) { await response.body?.cancel(); return; }
            // The local assets runtime (and some asset backends) ignores Range.
            // Discard the prefix as a stream rather than buffering the whole file.
            skip = response.status === 206 ? 0 : from;
            remaining = to - from + 1;
            reader = response.body.getReader();
          }
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) {
            if (remaining > 0) throw new Error('Incomplete audio asset.');
            reader.releaseLock(); reader = null; continue;
          }
          if (skip >= value.byteLength) { skip -= value.byteLength; continue; }
          const selected = value.subarray(skip, Math.min(value.byteLength, skip + remaining));
          skip = 0;
          remaining -= selected.byteLength;
          if (remaining === 0) { await reader.cancel(); reader.releaseLock(); reader = null; }
          controller.enqueue(selected);
          return;
        }
      } catch (error) { controller.error(error); }
    },
    async cancel() { cancelled = true; await reader?.cancel(); }
  });
  return new Response(stream, { status, headers });
}
