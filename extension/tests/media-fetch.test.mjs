import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../background/media-fetch.js', import.meta.url), 'utf8');
const PAGE = 'https://www.youtube.com/watch?v=KGbMdRhWFz4';
const URL_AUDIO = 'https://rr1---sn-test.googlevideo.com/videoplayback?id=media-id&itag=140&sig=private';
const REQUEST = 'a'.repeat(32);
const code = name => error => error.message.startsWith(`YouTube audio [${name}]:`) && !error.message.includes('private');
const tick = () => new Promise(resolve => setImmediate(resolve));

function response({ url = URL_AUDIO, status = 200, headers = { 'content-type': 'audio/mp4', 'content-length': '3' }, chunks = [new Uint8Array([1, 2, 3])], stream } = {}) {
  const body = stream || new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
  return { url, status, ok: status >= 200 && status < 300, headers: { get: key => headers[key] ?? null }, body };
}

function harness({ permitted = true, fetcher = async () => response() } = {}) {
  const calls = [], permissions = [], timers = new Map(), removed = [], permissionRemoved = [];
  let nextTimer = 0;
  const context = vm.createContext({ URL, Uint8Array, AbortController, btoa, console,
    fetch: (url, init) => { calls.push({ url, init }); return fetcher(url, init); },
    chrome: { runtime: { id: 'kage-extension' }, permissions: { contains: async value => { permissions.push(value); return permitted; },
      onRemoved: { addListener: listener => permissionRemoved.push(listener) } },
      tabs: { onRemoved: { addListener: listener => removed.push(listener) } } },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source, context);
  const sender = { id: 'kage-extension', tab: { id: 12 }, frameId: 0, url: PAGE, documentId: 'document-one' };
  const message = { type: 'CHROME_AUDIO_FETCH', action: 'open', requestId: REQUEST, fetchId: '1', page: PAGE, url: URL_AUDIO };
  return { calls, permissions, timers, sender, message, removed, permissionRemoved,
    request: (fields = {}, owner = sender) => context.KageMediaFetch.request({ ...message, ...fields }, owner),
    status: owner => context.KageMediaFetch.request({ type: 'CHROME_AUDIO_FETCH', action: 'status' }, owner || sender),
    expire() { for (const { fn } of [...timers.values()]) fn(); }
  };
}

test('status reports optional media access without fetching or requiring a request nonce', async () => {
  for (const permitted of [true, false]) {
    const h = harness({ permitted });
    assert.equal((await h.status()).available, permitted);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(h.permissions)), [{ origins: ['https://*.googlevideo.com/*'] }]);
    assert.equal(h.timers.size, 0);
  }
});

test('a denied optional permission never begins a network request', async () => {
  const h = harness({ permitted: false });
  await assert.rejects(h.request(), code('YT_MEDIA_PERMISSION_REQUIRED'));
  assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0);
});

test('open uses Chrome networking without credentials, redirects, proxy controls, or arbitrary headers', async () => {
  const h = harness();
  const result = await h.request();
  assert.equal(result.status, 200); assert.equal(result.body, true);
  assert.equal(result.headers['content-type'], 'audio/mp4');
  assert.equal(result.headers['content-length'], '3');
  assert.equal(new Headers(result.headers).get('content-range'), null);
  const { init } = h.calls[0];
  assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
  assert.deepEqual(Object.keys(init).sort(), ['cache', 'credentials', 'redirect', 'signal']);
  assert.equal(init.signal.aborted, false);
  await h.request({ action: 'close' });
  assert.equal(init.signal.aborted, true); assert.equal(h.timers.size, 0);
});

test('sender checks reject another extension, non-YouTube origins, frames, invalid tabs, and HTTP before permission checks', async () => {
  const h = harness();
  for (const overrides of [{ id: 'different-extension' }, { url: 'https://www.youtube.com.evil.test/watch?v=KGbMdRhWFz4' },
    { url: 'http://www.youtube.com/watch?v=KGbMdRhWFz4' }, { frameId: 1 }, { tab: { id: -1 } }, { url: undefined }]) {
    await assert.rejects(h.request({}, { ...h.sender, ...overrides }), code('YT_INVALID_SENDER'));
  }
  await assert.rejects(h.status({ ...h.sender, frameId: 2 }), code('YT_INVALID_SENDER'));
  assert.equal(h.calls.length, 0); assert.equal(h.permissions.length, 0);
});

test('canonical page validation rejects tracking, duplicate ids, malformed ids, fragments, and unsupported sites', async () => {
  const h = harness();
  for (const page of [`${PAGE}&x=1`, `${PAGE}&v=KGbMdRhWFz4`, `${PAGE}#video`, 'https://www.youtube.com/watch?v=short',
    'https://evil.test/watch?v=KGbMdRhWFz4', 'https://www.youtube.com/shorts/KGbMdRhWFz4']) {
    await assert.rejects(h.request({ page }), code('YT_INVALID_REQUEST'));
  }
  assert.equal(h.calls.length, 0);
});

test('bare and mobile YouTube origins normalize page identity while SPA sender URLs need not have the current video', async () => {
  const h = harness();
  await h.request({}, { ...h.sender, url: 'https://m.youtube.com/watch?v=otherid1234' });
  const owner = { ...h.sender, url: 'https://m.youtube.com/another-spa-path' };
  const read = await h.request({ action: 'read', page: PAGE.replace('www.youtube.com', 'm.youtube.com') }, owner);
  assert.equal(read.data, 'AQID');
  await h.request({ action: 'close' }, owner);
});

test('media URL allowlist rejects deceptive hosts, ports, credentials, paths, missing identities, and duplicate identities', async () => {
  const h = harness();
  for (const url of ['https://googlevideo.com.evil.test/videoplayback?id=media-id&itag=140',
    'https://evilgooglevideo.com/videoplayback?id=media-id&itag=140', 'http://rr1.googlevideo.com/videoplayback?id=media-id&itag=140',
    'https://rr1.googlevideo.com:444/videoplayback?id=media-id&itag=140', 'https://user:private@rr1.googlevideo.com/videoplayback?id=media-id&itag=140',
    URL_AUDIO.replace('/videoplayback', '/other'), URL_AUDIO.replace('id=media-id&', ''), URL_AUDIO.replace('&itag=140', ''),
    `${URL_AUDIO}&id=second`, `${URL_AUDIO}&itag=251`, `${URL_AUDIO}#fragment`]) {
    await assert.rejects(h.request({ url }), code('YT_INVALID_MEDIA_URL'));
  }
  assert.equal(h.calls.length, 0); assert.equal(h.permissions.length, 0);
});

test('changed response origin, path or media identity is rejected even when the destination is another permitted CDN', async () => {
  for (const url of [URL_AUDIO.replace('rr1---sn-test', 'rr2---sn-test'), URL_AUDIO.replace('id=media-id', 'id=another-id'),
    URL_AUDIO.replace('itag=140', 'itag=251'), URL_AUDIO.replace('/videoplayback', '/other'), 'https://evil.test/private']) {
    const h = harness({ fetcher: async () => response({ url }) });
    await assert.rejects(h.request(), code('YT_MEDIA_REDIRECT'));
    assert.equal(h.timers.size, 0);
  }
});

test('HTTP denials expose only status and no response body or headers', async () => {
  const h = harness({ fetcher: async () => response({ status: 403, headers: { 'content-type': 'text/html', 'private-header': 'secret' } }) });
  const result = await h.request();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { status: 403, headers: {}, body: false });
  assert.equal(h.timers.size, 0);
  await assert.rejects(h.request({ action: 'read' }), code('YT_REQUEST_CLOSED'));
});

test('unsupported or absent MIME is rejected before any body bytes are returned', async () => {
  for (const mime of ['text/html', '', 'application/json', 'audio/mpeg']) {
    const h = harness({ fetcher: async () => response({ headers: { 'content-type': mime } }) });
    await assert.rejects(h.request(), code('YT_RESPONSE_TYPE'));
    assert.equal(h.timers.size, 0);
  }
});

test('supported MIME parameters are normalized and only the three required headers are returned', async () => {
  const h = harness({ fetcher: async () => response({ status: 206,
    headers: { 'content-type': 'audio/webm; codecs="opus"', 'content-range': 'bytes 0-2/3', 'content-length': '3', 'set-cookie': 'private' } }) });
  const result = await h.request();
  assert.deepEqual(JSON.parse(JSON.stringify(result.headers)), { 'content-type': 'audio/webm', 'content-range': 'bytes 0-2/3', 'content-length': '3' });
  await h.request({ action: 'close' });
});

test('large native chunks are split into sequential base64 messages of at most 64 KiB decoded bytes', async () => {
  const input = new Uint8Array(150000); for (let i = 0; i < input.length; i++) input[i] = i % 251;
  const h = harness({ fetcher: async () => response({ headers: { 'content-type': 'audio/mp4', 'content-length': String(input.length) }, chunks: [input] }) });
  await h.request();
  const outputs = [];
  for (let sequence = 1; ; sequence++) {
    const part = await h.request({ action: 'read' });
    assert.equal(part.sequence, sequence);
    const decoded = Buffer.from(part.data, 'base64'); assert.ok(decoded.length <= 65536);
    if (part.done) { assert.equal(decoded.length, 0); break; }
    outputs.push(decoded);
  }
  assert.deepEqual(Buffer.concat(outputs), Buffer.from(input));
  assert.equal(h.timers.size, 0);
  assert.equal((await h.request({ action: 'close' })).closed, true);
});

test('empty native chunks do not become empty data messages', async () => {
  const h = harness({ fetcher: async () => response({ chunks: [new Uint8Array(), new Uint8Array([1, 2, 3])] }) });
  await h.request(); assert.equal((await h.request({ action: 'read' })).data, 'AQID');
  assert.equal((await h.request({ action: 'read' })).done, true);
});

test('declared byte totals cannot exceed the download cap and inconsistent range lengths fail', async () => {
  for (const extra of [{ 'content-length': String(128 * 1024 * 1024 + 1) }, { 'content-range': 'bytes 0-2/134217729' }]) {
    const h = harness({ fetcher: async () => response({ headers: { 'content-type': 'audio/mp4', ...extra } }) });
    await assert.rejects(h.request(), code('YT_AUDIO_TOO_LARGE'));
  }
  for (const extra of [{ 'content-length': 'three' }, { 'content-length': '3', 'content-range': 'bytes 0-1/3' },
    { 'content-range': 'bytes 3-2/3' }, { 'content-range': 'bytes 0-3/3' }]) {
    const h = harness({ fetcher: async () => response({ headers: { 'content-type': 'audio/mp4', ...extra } }) });
    await assert.rejects(h.request(), code('YT_RESPONSE_SIZE'));
  }
});

test('the streamed byte count is capped even when no size headers are available', async () => {
  const tooLarge = new Uint8Array(128 * 1024 * 1024 + 1);
  const h = harness({ fetcher: async () => response({ headers: { 'content-type': 'audio/mp4' }, chunks: [tooLarge] }) });
  await h.request();
  await assert.rejects(h.request({ action: 'read' }), code('YT_AUDIO_TOO_LARGE'));
  assert.equal(h.timers.size, 0);
});

test('empty, overlong and short declared bodies cannot complete successfully', async () => {
  for (const chunks of [[], [new Uint8Array([1, 2])], [new Uint8Array([1, 2, 3, 4])]]) {
    const h = harness({ fetcher: async () => response({ chunks }) });
    await h.request();
    if (chunks[0]?.length === 2) await h.request({ action: 'read' });
    await assert.rejects(h.request({ action: 'read' }), code('YT_RESPONSE_SIZE'));
    assert.equal(h.timers.size, 0);
  }
});

test('each active stream is bound to document, tab, origin, video, nonce and fetch id', async () => {
  const h = harness(); await h.request();
  for (const [fields, owner] of [[{}, { ...h.sender, documentId: 'different-document' }], [{}, { ...h.sender, tab: { id: 13 } }],
    [{}, { ...h.sender, url: PAGE.replace('www.youtube.com', 'm.youtube.com') }],
    [{ page: PAGE.replace('KGbMdRhWFz4', 'anotherid12') }, h.sender], [{ requestId: 'b'.repeat(32) }, h.sender], [{ fetchId: '2' }, h.sender]]) {
    await assert.rejects(h.request({ action: 'read', ...fields }, owner), code('YT_REQUEST_CLOSED'));
  }
  assert.equal((await h.request({ action: 'read' })).data, 'AQID');
  await h.request({ action: 'close' });
});

test('one stream per tab and four total prevent duplicate and unbounded background downloads', async () => {
  const h = harness(); await h.request();
  await assert.rejects(h.request({ fetchId: '2' }), code('YT_BUSY'));
  for (const id of [13, 14, 15]) await h.request({}, { ...h.sender, tab: { id } });
  await assert.rejects(h.request({}, { ...h.sender, tab: { id: 16 } }), code('YT_STREAM_LIMIT'));
  assert.equal(h.calls.length, 4);
  for (const id of [12, 13, 14, 15]) await h.request({ action: 'cancel', fetchId: undefined }, { ...h.sender, tab: { id } });
  assert.equal(h.timers.size, 0);
});

test('overall cancel needs no fetch id and aborts an in-flight open', async () => {
  let resolveFetch;
  const h = harness({ fetcher: () => new Promise(resolve => { resolveFetch = resolve; }) });
  const opening = h.request(); await tick();
  assert.equal((await h.request({ action: 'cancel', fetchId: undefined })).closed, true);
  assert.equal(h.calls[0].init.signal.aborted, true);
  resolveFetch(response());
  await assert.rejects(opening, code('YT_CANCELLED'));
  assert.equal(h.timers.size, 0);
});

test('concurrent reads are rejected and cancellation resolves a waiting read as stopped', async () => {
  const stream = new ReadableStream();
  const h = harness({ fetcher: async () => response({ stream }) }); await h.request();
  const reading = h.request({ action: 'read' });
  await assert.rejects(h.request({ action: 'read' }), code('YT_CONCURRENT_READ'));
  await h.request({ action: 'cancel', fetchId: undefined });
  await assert.rejects(reading, code('YT_CANCELLED'));
  assert.equal(h.timers.size, 0);
});

test('idle expiry and tab removal abort and remove the active network stream', async () => {
  for (const expire of [h => h.expire(), h => h.removed[0](12), h => h.permissionRemoved[0]({ origins: ['https://*.googlevideo.com/*'] })]) {
    const h = harness(); await h.request();
    assert.equal([...h.timers.values()][0].ms, 25000);
    expire(h);
    assert.equal(h.calls[0].init.signal.aborted, true); assert.equal(h.timers.size, 0);
    await assert.rejects(h.request({ action: 'read' }), code('YT_REQUEST_CLOSED'));
    await h.request(); await h.request({ action: 'close' });
  }
});

test('idle timeout and revoked access reject a waiting read with their fixed reason', async () => {
  for (const [stop, expected] of [[h => h.expire(), 'YT_TIMEOUT'],
    [h => h.permissionRemoved[0]({ origins: ['https://*.googlevideo.com/*'] }), 'YT_MEDIA_PERMISSION_REQUIRED']]) {
    const h = harness({ fetcher: async () => response({ stream: new ReadableStream() }) });
    await h.request();
    const reading = h.request({ action: 'read' });
    stop(h);
    await assert.rejects(reading, code(expected));
    assert.equal(h.timers.size, 0); assert.equal(h.calls[0].init.signal.aborted, true);
  }
});

test('fetch and reader failures never expose exception text, signed URLs, response bodies or VPN credentials', async () => {
  const h = harness({ fetcher: async () => { throw new Error(`proxy private credential ${URL_AUDIO}`); } });
  await assert.rejects(h.request(), code('YT_NETWORK_ERROR'));
  const stream = new ReadableStream({ start(controller) { controller.error(new Error('private cookies')); } });
  const r = harness({ fetcher: async () => response({ stream }) }); await r.request();
  await assert.rejects(r.request({ action: 'read' }), code('YT_NETWORK_ERROR'));
});

test('malformed action and request identifiers never start network work', async () => {
  const h = harness();
  for (const fields of [{ action: 'anything' }, { requestId: '1234' }, { fetchId: 1 }, { fetchId: '0' }, { fetchId: '-1' }, { type: 'OTHER' }]) {
    await assert.rejects(h.request(fields), code('YT_INVALID_REQUEST'));
  }
  assert.equal(h.calls.length, 0);
});
