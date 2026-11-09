import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../content/youtube-audio-main.js', import.meta.url), 'utf8');
const PAGE = 'https://www.youtube.com/watch?v=KGbMdRhWFz4';
const MEDIA = 'https://rr1.googlevideo.com/videoplayback?id=current-media&itag=140&mime=audio%2Fmp4&clen=3&sig=private-signature';
const metadata = (extra = {}) => ({ videoDetails: { videoId: 'KGbMdRhWFz4', lengthSeconds: '60' }, playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [
  { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', url: MEDIA, contentLength: '3', bitrate: 120000 }
] }, ...extra });
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
function harness({ response = metadata(), fetch, resources = [], maxBytes, sabr } = {}) {
  const posts = [], calls = [], listeners = [], timers = new Map(), intervals = new Map();
  const location = { href: PAGE, hostname: 'www.youtube.com', origin: 'https://www.youtube.com' };
  let timerID = 0;
  const window = { ytInitialPlayerResponse: response, KageYouTubeSabr: sabr,
    fetch: async (url, options) => { calls.push({ url, options }); return fetch ? fetch(url, options) : new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mp4', 'Content-Range': 'bytes 0-2/3' }, status: 206 }); },
    postMessage: data => posts.push(data), addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); } };
  class XHR { open() {} }
  const context = vm.createContext({ window, location, URL, URLSearchParams, XMLHttpRequest: XHR, Uint8Array, ArrayBuffer, AbortController,
    document: { getElementById: () => ({ getPlayerResponse: () => response }) },
    performance: { getEntriesByType: () => resources.map(name => ({ name })) },
    setTimeout: fn => { const id = ++timerID; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: fn => { const id = ++timerID; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id) });
  vm.runInContext(maxBytes ? source.replace('MAX_BYTES = 128 * 1024 * 1024', `MAX_BYTES = ${maxBytes}`) : source, context);
  const requestId = 'a'.repeat(32);
  const send = (fields = {}, overrides = {}) => { for (const fn of listeners) fn({ source: window, origin: location.origin, data: { type: 'KAGE_BROWSER_AUDIO_REQUEST', requestId, page: PAGE, ...fields }, ...overrides }); };
  return { posts, calls, window, location, timers, intervals, send };
}

test('YouTube browser audio waits for a click, fetches complete bounded ranges and returns only bytes', async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  h.send(); await flush();
  const result = h.posts.find(p => p.type === 'KAGE_BROWSER_AUDIO_RESULT');
  assert.deepEqual([...new Uint8Array(result.bytes)], [1, 2, 3]);
  assert.equal(result.page, PAGE);
  assert.equal(result.mimeType, 'audio/mp4');
  assert.equal(h.calls[0].options.credentials, 'omit');
  assert.equal(h.calls[0].options.redirect, 'error');
  assert.equal(new URL(h.calls[0].url).searchParams.get('range'), '0-2');
  assert.equal(JSON.stringify(h.posts).includes('private-signature'), false);
  assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
});

test('a complete SABR track uses the existing byte importer without file GETs or context export', async () => {
  let received;
  const h = harness({ sabr: { download: async options => {
    received = options;
    options.onProgress({ received: 3, total: null });
    return { bytes: new Uint8Array([4, 5, 6]).buffer, mime: 'audio/mp4' };
  } } });
  h.send({ transport: 'extension' }); await flush();
  assert.equal(received.page, PAGE);
  assert.equal(received.maxBytes, 128 * 1024 * 1024);
  assert.equal(h.calls.length, 0);
  const result = h.posts.find(p => p.type === 'KAGE_BROWSER_AUDIO_RESULT');
  assert.deepEqual([...new Uint8Array(result.bytes)], [4, 5, 6]);
  assert.equal(result.name, 'YouTube-KGbMdRhWFz4.m4a');
  assert.equal(JSON.stringify(h.posts).includes('private-signature'), false);
  assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
});

test('missing SABR context falls back to file download while incomplete SABR never publishes audio', async () => {
  const h = harness({ sabr: { download: async () => { throw new Error('YouTube audio [YT_SABR_NOT_READY]: no current template.'); } } });
  h.send(); await flush();
  assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_RESULT');
  assert.equal(h.calls.length, 1);
  const failed = harness({ sabr: { download: async () => { throw new Error('YouTube audio [YT_SABR_INCOMPLETE]: missing audio segments.'); } } });
  failed.send(); await flush();
  assert.equal(failed.calls.length, 0);
  assert.equal(failed.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_ERROR');
  assert.match(failed.posts.at(-1).error, /YT_SABR_INCOMPLETE/);
});

test('large audio uses contiguous byte ranges without duplicating or omitting bytes', async () => {
  const size = 2 * 1024 * 1024 + 3;
  const response = metadata(); response.streamingData.adaptiveFormats[0].contentLength = String(size);
  const h = harness({ response, fetch: async url => {
    const [start, end] = new URL(url).searchParams.get('range').split('-').map(Number);
    return new Response(new Uint8Array(end - start + 1).fill(start ? 2 : 1), { status: 206, headers: { 'Content-Type': 'audio/mp4', 'Content-Range': `bytes ${start}-${end}/${size}` } });
  } });
  h.send(); await flush();
  assert.equal(h.calls.length, 2);
  const bytes = new Uint8Array(h.posts.find(p => p.type === 'KAGE_BROWSER_AUDIO_RESULT').bytes);
  assert.equal(bytes.length, size); assert.equal(bytes[0], 1); assert.equal(bytes.at(-1), 2);
});

test('ciphered metadata can reuse a native player URL only for this exact media ID and itag', async () => {
  const response = metadata();
  const format = response.streamingData.adaptiveFormats[0];
  delete format.url;
  format.signatureCipher = new URLSearchParams({ url: MEDIA.replace('&sig=private-signature', ''), s: 'encrypted' }).toString();
  const h = harness({ response, resources: [MEDIA.replace('current-media', 'other-media'), MEDIA] });
  h.send(); await flush();
  assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_RESULT');
  assert.equal(h.calls[0].url.includes('id=current-media'), true);
  const other = harness({ response, resources: [MEDIA.replace('current-media', 'other-media')] });
  other.send(); await flush();
  assert.equal(other.calls.length, 0);
  assert.match(other.posts.at(-1).error, /YT_WAIT_FOR_PLAYER/);
});

test('foreign messages, stale videos, protected metadata, unsafe URLs and oversized audio are rejected', async () => {
  const h = harness();
  h.send({}, { source: {} }); h.send({}, { origin: 'https://evil.test' }); h.send({ page: PAGE.replace('KGbMdRhWFz4', 'abcdefghijk') });
  await flush(); assert.equal(h.calls.length, 0); assert.equal(h.posts.length, 0);
  for (const response of [metadata({ videoDetails: { videoId: 'abcdefghijk' } }), metadata({ streamingData: { licenseInfos: [{}] } })]) {
    const h = harness({ response }); h.send(); await flush();
    assert.equal(h.calls.length, 0); assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_ERROR');
  }
  for (const url of ['http://127.0.0.1/videoplayback', MEDIA.replace('rr1.googlevideo.com', 'googlevideo.com.evil.test'), MEDIA.replace('https:', 'file:')]) {
    const response = metadata(); response.streamingData.adaptiveFormats[0].url = url;
    const h = harness({ response }); h.send(); await flush(); assert.equal(h.calls.length, 0);
  }
  const response = metadata(); response.streamingData.adaptiveFormats[0].contentLength = String(128 * 1024 * 1024 + 1);
  const large = harness({ response }); large.send(); await flush(); assert.equal(large.calls.length, 0);
});

test('incomplete, mismatched ranges and failed transfers never produce partial audio', async () => {
  for (const fetch of [async () => { throw new Error(MEDIA); },
    async () => new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'audio/mp4' } }),
    async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mp4', 'Content-Range': 'bytes 3-5/6' } }),
    async () => new Response('not audio', { headers: { 'Content-Type': 'text/html' } })]) {
    const h = harness({ fetch }); h.send(); await flush();
    assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_ERROR');
    assert.equal(JSON.stringify(h.posts).includes('private-signature'), false);
  }
});

test('navigation and cancellation abort in-flight requests without publishing late audio', async () => {
  for (const cancel of [true, false]) {
    let release;
    const h = harness({ fetch: (_url, options) => new Promise((resolve, reject) => {
      release = () => resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mp4' } }));
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')));
    }) });
    h.send(); await flush();
    if (cancel) h.send({ type: 'KAGE_BROWSER_AUDIO_CANCEL' });
    else { h.location.href = PAGE.replace('KGbMdRhWFz4', 'abcdefghijk'); for (const fn of h.intervals.values()) fn(); }
    release(); await flush();
    assert.equal(h.posts.some(p => p.type === 'KAGE_BROWSER_AUDIO_RESULT'), false);
    assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_ERROR');
    assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
  }
});

test('missing format length can use the exact matching native audio request size', async () => {
  const response = metadata(), format = response.streamingData.adaptiveFormats[0];
  delete format.contentLength;
  delete format.url;
  format.signatureCipher = new URLSearchParams({ url: MEDIA.replace('&clen=3', '').replace('&sig=private-signature', ''), s: 'encrypted' }).toString();
  const h = harness({ response, resources: [MEDIA] });
  h.send(); await flush();
  assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_RESULT');
});

test('signed metadata and native audio may omit the redundant MIME query parameter', async () => {
  const response = metadata(), format = response.streamingData.adaptiveFormats[0];
  delete format.url;
  const native = MEDIA.replace('&mime=audio%2Fmp4', '');
  format.signatureCipher = new URLSearchParams({ url: native.replace('&sig=private-signature', ''), s: 'encrypted' }).toString();
  const h = harness({ response, resources: [native] });
  h.send(); await flush();
  assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_RESULT');
});

test('SABR-only player metadata produces an explicit diagnosis instead of telling users to replay', async () => {
  const response = metadata({ streamingData: { serverAbrStreamingUrl: 'https://rr1.googlevideo.com/private-sabr-token', adaptiveFormats: [
    { itag: 140, mimeType: 'audio/mp4', contentLength: '3' }
  ] } });
  const h = harness({ response }); h.send(); await flush();
  assert.match(h.posts.at(-1).error, /YT_STREAMING_ONLY/);
  assert.equal(h.calls.length, 0);
  assert.equal(JSON.stringify(h.posts).includes('private-sabr-token'), false);
  assert.doesNotMatch(h.posts.at(-1).error, /play.*briefly/i);
});

test('360p combined MP4 can supply audio, but audio-only is preferred and higher resolutions are excluded', async () => {
  const response = metadata({ streamingData: { formats: [{ itag: 18, mimeType: 'video/mp4; codecs="avc1,mp4a"', height: 360,
    audioQuality: 'AUDIO_QUALITY_LOW', contentLength: '3', url: MEDIA.replace('itag=140', 'itag=18').replace('audio%2Fmp4', 'video%2Fmp4') }] } });
  const h = harness({ response, fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } }) });
  h.send(); await flush();
  assert.equal(h.posts.at(-1).mimeType, 'video/mp4'); assert.match(h.posts.at(-1).name, /\.mp4$/);
  const both = metadata(); both.streamingData.formats = response.streamingData.formats;
  const preferred = harness({ response: both }); preferred.send(); await flush();
  assert.equal(preferred.posts.at(-1).mimeType, 'audio/mp4');
  response.streamingData.formats[0].height = 720;
  const high = harness({ response }); high.send(); await flush(); assert.equal(high.calls.length, 0);
});

test('size, signature and missing URL diagnoses are distinct and do not echo stream secrets', async () => {
  const size = metadata(); size.streamingData.adaptiveFormats[0].contentLength = String(128 * 1024 * 1024 + 1);
  const range = metadata(); range.streamingData.adaptiveFormats[0].url += '&sparams=range';
  const missing = metadata(); delete missing.streamingData.adaptiveFormats[0].url;
  for (const [response, code] of [[size, 'YT_AUDIO_TOO_LARGE'], [range, 'YT_SIGNED_RANGE'], [missing, 'YT_NO_FILE_URL']]) {
    const h = harness({ response }); h.send(); await flush();
    assert.equal(h.calls.length, 0); assert.ok(h.posts.at(-1).error.includes(code));
    assert.equal(JSON.stringify(h.posts).includes('private-signature'), false);
  }
});

function unknownSizeMetadata() {
  const response = metadata();
  delete response.streamingData.adaptiveFormats[0].contentLength;
  response.streamingData.adaptiveFormats[0].url = MEDIA.replace('&clen=3', '');
  return response;
}
const audioResponse = (bytes, headers = {}, status = 200) => new Response(new Uint8Array(bytes), { status, headers: { 'Content-Type': 'audio/mp4', ...headers } });

test('unknown player size is discovered with a one-byte range probe, then the complete audio is fetched', async () => {
  let probeCancelled = false;
  const h = harness({ response: unknownSizeMetadata(), fetch: async url => {
    if (new URL(url).searchParams.get('range') === '0-0') {
      return new Response(new ReadableStream({ cancel() { probeCancelled = true; } }), { status: 206,
        headers: { 'Content-Type': 'audio/mp4', 'Content-Length': '1', 'Content-Range': 'bytes 0-0/3' } });
    }
    return audioResponse([1, 2, 3], { 'Content-Range': 'bytes 0-2/3' }, 206);
  } });
  h.send(); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(new URL(h.calls[1].url).searchParams.get('range'), '0-2');
  assert.deepEqual([...new Uint8Array(h.posts.at(-1).bytes)], [1, 2, 3]);
  assert.equal(probeCancelled, true);
  assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
});

test('a probe length is never mistaken for the full file size when range headers are hidden', async () => {
  const h = harness({ response: unknownSizeMetadata(), fetch: async url => new URL(url).searchParams.has('range')
    ? audioResponse([99], { 'Content-Length': '1' }, 206)
    : audioResponse([1, 2, 3]) });
  h.send(); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(new URL(h.calls[1].url).searchParams.has('range'), false);
  assert.deepEqual([...new Uint8Array(h.posts.at(-1).bytes)], [1, 2, 3]);
  assert.ok(h.posts.some(p => p.type === 'KAGE_BROWSER_AUDIO_PROGRESS' && p.total === null && p.received === 3));
});

test('a rejected size probe can still use a successful full-file response', async () => {
  const h = harness({ response: unknownSizeMetadata(), fetch: async url => new URL(url).searchParams.has('range')
    ? new Response(null, { status: 403 }) : audioResponse([1, 2, 3], { 'Content-Length': '3' }) });
  h.send(); await flush();
  assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_RESULT');
  assert.equal(h.posts.at(-1).bytes.byteLength, 3);
});

test('an un-ranged response that is partial supplies its total, then is replaced with verified ranges', async () => {
  let calls = 0;
  const h = harness({ response: unknownSizeMetadata(), fetch: async () => {
    calls++;
    if (calls === 1) return audioResponse([99]); // No Content-Range: cannot establish the total.
    if (calls === 2) return audioResponse([99], { 'Content-Range': 'bytes 0-0/3' }, 206);
    return audioResponse([1, 2, 3], { 'Content-Range': 'bytes 0-2/3' }, 206);
  } });
  h.send(); await flush();
  assert.equal(h.calls.length, 3);
  assert.deepEqual([...new Uint8Array(h.posts.at(-1).bytes)], [1, 2, 3]);
});

test('unknown-size downloads reject oversized totals and enforce the cap while receiving a full stream', async () => {
  for (const fetch of [
    async () => audioResponse([1], { 'Content-Range': 'bytes 0-0/8' }, 206),
    async url => new URL(url).searchParams.has('range') ? audioResponse([99]) : audioResponse([1], { 'Content-Length': '8' }),
    async url => new URL(url).searchParams.has('range') ? audioResponse([99]) : audioResponse([1, 2, 3, 4, 5, 6, 7, 8])
  ]) {
    const h = harness({ response: unknownSizeMetadata(), maxBytes: 7, fetch });
    h.send(); await flush();
    assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_ERROR');
    assert.match(h.posts.at(-1).error, /YT_AUDIO_TOO_LARGE/);
    assert.equal(h.posts.some(p => p.type === 'KAGE_BROWSER_AUDIO_RESULT'), false);
    assert.equal(h.timers.size, 0);
  }
});

test('incomplete, malformed, mismatched, or unverified partial responses cannot become full audio', async () => {
  for (const fullResponse of [
    () => audioResponse([1], { 'Content-Length': '3' }),
    () => audioResponse([1, 2, 3], { 'Content-Length': '1' }),
    () => audioResponse([], {}),
    () => audioResponse([1], {}, 206),
    () => audioResponse([1], { 'Content-Range': 'bytes 1-1/3' }, 206),
    () => audioResponse([1], { 'Content-Range': 'bytes 0-0/*' }, 206),
    () => new Response('not audio', { headers: { 'Content-Type': 'text/html' } }),
    () => { throw new Error(MEDIA); }
  ]) {
    let calls = 0;
    const h = harness({ response: unknownSizeMetadata(), fetch: async () => ++calls === 1 ? audioResponse([99]) : fullResponse() });
    h.send(); await flush();
    assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_ERROR');
    assert.equal(h.posts.some(p => p.type === 'KAGE_BROWSER_AUDIO_RESULT'), false);
    assert.equal(JSON.stringify(h.posts).includes('private-signature'), false);
    assert.equal(h.timers.size, 0);
  }
});

test('unknown-size probing and full downloads are cancelled on Stop or video navigation', async () => {
  for (const duringProbe of [true, false]) {
    for (const stop of [true, false]) {
      let signal, calls = 0;
      const h = harness({ response: unknownSizeMetadata(), fetch: async (_url, options) => {
        signal = options.signal;
        if (++calls === 1 && !duringProbe) return audioResponse([99]);
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      } });
      h.send(); await flush();
      if (stop) h.send({ type: 'KAGE_BROWSER_AUDIO_CANCEL' });
      else { h.location.href = PAGE.replace('KGbMdRhWFz4', 'abcdefghijk'); for (const fn of h.intervals.values()) fn(); }
      await flush();
      assert.equal(signal.aborted, true);
      assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_ERROR');
      assert.equal(h.posts.some(p => p.type === 'KAGE_BROWSER_AUDIO_RESULT'), false);
      assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
    }
  }
});

test('unknown-size on-the-fly segments are never imported as a complete audio file', async () => {
  for (const extra of [{ type: 'FORMAT_STREAM_TYPE_OTF' }, { url: MEDIA.replace('&clen=3', '') + '&sq=0' },
    { url: MEDIA.replace('&clen=3', '') + '&source=yt_otf' }, { url: MEDIA.replace('&clen=3', '') + '&otf=1' }]) {
    const response = unknownSizeMetadata(); Object.assign(response.streamingData.adaptiveFormats[0], extra);
    const h = harness({ response }); h.send(); await flush();
    assert.equal(h.calls.length, 0);
    assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_ERROR');
    assert.match(h.posts.at(-1).error, /YT_STREAMING_ONLY/);
  }
});

test('an observed playback URL outranks a lower-bitrate raw metadata format', async () => {
  const response = metadata();
  response.streamingData.adaptiveFormats.unshift({
    itag: 139, mimeType: 'audio/mp4', contentLength: '3', bitrate: 48000,
    url: MEDIA.replace('itag=140', 'itag=139').replace('private-signature', 'raw-low-bitrate')
  });
  const observed = `${MEDIA}&n=player-solved&pot=player-token`;
  const h = harness({ response, resources: [observed] });
  h.send(); await flush();
  assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_RESULT');
  const selected = new URL(h.calls[0].url);
  assert.equal(selected.searchParams.get('itag'), '140');
  assert.equal(selected.searchParams.get('n'), 'player-solved');
  assert.equal(selected.searchParams.get('pot'), 'player-token');
});

test('successful playback observations outrank newer failed playback attempts', async () => {
  const success = `${MEDIA}&n=successful&pot=player-token`;
  const attempted = `${MEDIA}&n=failed&pot=other-token`;
  const h = harness({ fetch: async url => new URL(url).searchParams.get('n') === 'failed'
    ? new Response(null, { status: 403 })
    : audioResponse([1, 2, 3], { 'Content-Range': 'bytes 0-2/3' }, 206) });
  await h.window.fetch(success);
  await h.window.fetch(attempted);
  await flush();
  h.calls.length = 0;
  h.send(); await flush();
  assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_RESULT');
  assert.equal(h.calls.length, 1);
  assert.equal(new URL(h.calls[0].url).searchParams.get('n'), 'successful');
  assert.equal(new URL(h.calls[0].url).searchParams.get('pot'), 'player-token');
});

test('an initial 403 or 410 can select another eligible URL before reading any audio', async () => {
  for (const status of [403, 410]) {
    const observed = MEDIA.replace('private-signature', 'refused-player-url');
    const h = harness({ resources: [observed], fetch: async url => new URL(url).searchParams.get('sig') === 'refused-player-url'
      ? new Response(null, { status })
      : audioResponse([1, 2, 3], { 'Content-Range': 'bytes 0-2/3' }, 206) });
    h.send(); await flush();
    assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_RESULT');
    assert.equal(h.calls.length, 2);
    assert.equal(new URL(h.calls[0].url).searchParams.get('sig'), 'refused-player-url');
    assert.equal(new URL(h.calls[1].url).searchParams.get('sig'), 'private-signature');
    assert.deepEqual([...new Uint8Array(h.posts.at(-1).bytes)], [1, 2, 3]);
  }
});

test('unsigned range variants do not consume alternate candidate attempts', async () => {
  const observed = `${MEDIA.replace('private-signature', 'refused-player-url')}&n=solved&pot=bound-token`;
  const resources = ['0-0', '1-1', '2-2', '0-2'].map(range => `${observed}&range=${range}`);
  const h = harness({ resources, fetch: async url => new URL(url).searchParams.get('sig') === 'refused-player-url'
    ? new Response(null, { status: 403 })
    : audioResponse([1, 2, 3], { 'Content-Range': 'bytes 0-2/3' }, 206) });
  h.send(); await flush();
  assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_RESULT');
  assert.equal(h.calls.length, 2);
  assert.equal(new URL(h.calls[0].url).searchParams.get('n'), 'solved');
  assert.equal(new URL(h.calls[0].url).searchParams.get('pot'), 'bound-token');
  assert.equal(new URL(h.calls[1].url).searchParams.get('sig'), 'private-signature');
});

test('distinct player token and n values remain eligible alternate candidates', async () => {
  for (const parameter of ['pot', 'n']) {
    const resources = [`${MEDIA}&${parameter}=usable`, `${MEDIA}&${parameter}=refused`];
    const h = harness({ resources, fetch: async url => new URL(url).searchParams.get(parameter) === 'refused'
      ? new Response(null, { status: 403 })
      : audioResponse([1, 2, 3], { 'Content-Range': 'bytes 0-2/3' }, 206) });
    h.send(); await flush();
    assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_RESULT');
    assert.equal(h.calls.length, 2);
    assert.equal(new URL(h.calls[0].url).searchParams.get(parameter), 'refused');
    assert.equal(new URL(h.calls[1].url).searchParams.get(parameter), 'usable');
  }
});

test('initial refusals attempt at most three distinct signed URL candidates', async () => {
  const resources = ['one', 'two', 'three', 'four', 'five'].map(signature => MEDIA.replace('private-signature', signature));
  const h = harness({ resources, fetch: async () => new Response(null, { status: 403 }) });
  h.send(); await flush();
  assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_ERROR');
  assert.match(h.posts.at(-1).error, /YT_HTTP_403/);
  assert.equal(h.calls.length, 3);
  assert.equal(new Set(h.calls.map(call => new URL(call.url).searchParams.get('sig'))).size, 3);
  assert.equal(h.posts.some(post => post.type === 'KAGE_BROWSER_AUDIO_RESULT'), false);
  assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
});

test('HTTP 429 stops both known-size downloads and unknown-size probes without another request', async () => {
  for (const unknownSize of [false, true]) {
    const response = unknownSize ? unknownSizeMetadata() : metadata();
    const base = response.streamingData.adaptiveFormats[0].url;
    const resources = ['one', 'two', 'three'].map(signature => base.replace('private-signature', signature));
    const h = harness({ response, resources, fetch: async () => new Response(null, { status: 429 }) });
    h.send(); await flush();
    assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_ERROR');
    assert.match(h.posts.at(-1).error, /YT_HTTP_429/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.posts.some(post => post.type === 'KAGE_BROWSER_AUDIO_RESULT'), false);
    assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
  }
});

test('a refusal after the first audio range never switches formats or publishes partial media', async () => {
  const size = 2 * 1024 * 1024 + 3;
  const response = metadata();
  response.streamingData.adaptiveFormats[0].contentLength = String(size);
  response.streamingData.adaptiveFormats[0].url = MEDIA.replace('clen=3', `clen=${size}`);
  const observed = `${response.streamingData.adaptiveFormats[0].url}&n=player-solved`;
  const h = harness({ response, resources: [observed], fetch: async url => {
    const parsed = new URL(url);
    const [start, end] = parsed.searchParams.get('range').split('-').map(Number);
    if (parsed.searchParams.get('n') === 'player-solved' && start > 0) return new Response(null, { status: 403 });
    return audioResponse(new Uint8Array(end - start + 1), { 'Content-Range': `bytes ${start}-${end}/${size}` }, 206);
  } });
  h.send(); await flush();
  assert.equal(h.posts.at(-1).type, 'KAGE_BROWSER_AUDIO_ERROR');
  assert.match(h.posts.at(-1).error, /YT_HTTP_403/);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => new URL(call.url).searchParams.get('n') === 'player-solved'));
  assert.ok(h.posts.some(post => post.type === 'KAGE_BROWSER_AUDIO_PROGRESS' && post.received === 2 * 1024 * 1024));
  assert.equal(h.posts.some(post => post.type === 'KAGE_BROWSER_AUDIO_RESULT'), false);
  assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
});
