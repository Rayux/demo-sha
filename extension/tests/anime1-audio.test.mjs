import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const browserAudio = readFileSync(new URL('../content/browser-audio.js', import.meta.url), 'utf8');
const anime1Fetch = readFileSync(new URL('../background/anime1-fetch.js', import.meta.url), 'utf8');
const PAGE = 'https://anime1.me/30595';
const SRC = 'https://muan.v.anime1.me/1979/6b.mp4';

function fakePort(name) {
  const make = () => { const set = new Set(); return { set, addListener: fn => set.add(fn) }; };
  const a = { name, onMessage: make(), onDisconnect: make(), sent: [], disconnected: false };
  const b = { name, onMessage: make(), onDisconnect: make(), sent: [], disconnected: false };
  a.postMessage = m => { a.sent.push(m); queueMicrotask(() => b.onMessage.set.forEach(fn => fn(structuredClone(m)))); };
  b.postMessage = m => { b.sent.push(m); queueMicrotask(() => a.onMessage.set.forEach(fn => fn(structuredClone(m)))); };
  a.disconnect = () => { if (a.disconnected) return; a.disconnected = b.disconnected = true; b.onDisconnect.set.forEach(fn => fn()); };
  b.disconnect = () => { if (b.disconnected) return; a.disconnected = b.disconnected = true; a.onDisconnect.set.forEach(fn => fn()); };
  return [a, b];
}

function worker(fetchImpl) {
  const connect = new Set();
  const chrome = { runtime: { id: 'kage', onConnect: { addListener: fn => connect.add(fn) } } };
  const ctx = vm.createContext({ chrome, fetch: fetchImpl, URL, Uint8Array, btoa, setTimeout, clearTimeout, AbortController, structuredClone });
  vm.runInContext(anime1Fetch, ctx);
  return { ctx, accept(port, sender) { port.sender = sender; connect.forEach(fn => fn(port)); } };
}

function streamResponse(bytes, { status = 200, type = 'video/mp4', url = SRC, length = String(bytes.byteLength) } = {}) {
  const body = new ReadableStream({ start(c) { for (let i = 0; i < bytes.byteLength; i += 700000) c.enqueue(bytes.subarray(i, i + 700000)); c.close(); } });
  const r = new Response(body, { status, headers: { 'content-type': type, ...(length ? { 'content-length': length } : {}) } });
  Object.defineProperty(r, 'url', { value: url });
  return r;
}

function page(workerSide) {
  const listeners = new Set(), posts = [];
  const location = { href: PAGE, get origin() { return new URL(this.href).origin; } };
  const window = {
    addEventListener(t, fn) { if (t === 'message') listeners.add(fn); },
    removeEventListener(t, fn) { if (t === 'message') listeners.delete(fn); },
    postMessage(data) { posts.push(data); }
  };
  const chrome = { runtime: { connect: ({ name }) => { const [client, server] = fakePort(name); workerSide(server); return client; } } };
  const ctx = vm.createContext({ URL, Uint8Array, ArrayBuffer, File, DOMException, crypto: webcrypto, location, window, chrome, atob,
    setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(browserAudio, ctx);
  const deliver = data => { for (const fn of [...listeners]) fn({ source: window, origin: location.origin, data }); };
  return { api: ctx.KageBrowserAudio, posts, deliver };
}

const SENDER = { id: 'kage', tab: { id: 7, url: PAGE }, frameId: 0, url: PAGE };

async function readAll(source, chunk = 256 * 1024) {
  const out = new Uint8Array(source.size);
  for (let offset = 0; offset < source.size; offset += chunk) {
    out.set(new Uint8Array(await source.slice(offset, offset + chunk).arrayBuffer()), offset);
  }
  return out;
}

function begin(w, sender = SENDER) {
  const p = page(server => w.accept(server, sender));
  const progress = [];
  const pending = p.api.download({ onProgress: u => progress.push(u) });
  const req = p.posts.find(m => m.type === 'KAGE_BROWSER_AUDIO_REQUEST');
  assert.equal(req.page, PAGE);
  p.deliver({ type: 'KAGE_ANIME1_MEDIA_URL', requestId: req.requestId, page: PAGE, src: SRC });
  return { pending, progress };
}

test('anime1 audio streams from the service worker with cookies, in order, without buffering the episode', async () => {
  const bytes = new Uint8Array(3_500_000).map((_, i) => (i * 7) % 251);
  let init;
  const w = worker(async (url, options) => { init = { url, ...options }; return streamResponse(bytes); });
  const { pending, progress } = begin(w);
  const source = await pending;
  assert.equal(init.url, SRC);
  assert.equal(init.credentials, 'include');
  assert.equal(source.size, bytes.byteLength);
  assert.equal(source.name, 'anime1-30595.mp4');
  assert.equal(progress.at(-1).total, bytes.byteLength);
  assert.deepEqual(await readAll(source), bytes);
});

test('episodes over the old 128 MiB cap are accepted (size comes from the header)', async () => {
  const w = worker(async () => streamResponse(new Uint8Array(10), { length: String(400 * 1024 * 1024) }));
  const { pending } = begin(w);
  const source = await pending;
  assert.equal(source.size, 400 * 1024 * 1024);
  source.close();
});

test('out-of-order reads are refused', async () => {
  const w = worker(async () => streamResponse(new Uint8Array(1_000_000)));
  const source = await begin(w).pending;
  await assert.rejects(source.slice(256 * 1024, 512 * 1024).arrayBuffer(), /out of order/);
  source.close();
});

test('CDN errors surface as a readable message', async () => {
  const w = worker(async () => streamResponse(new Uint8Array(0), { status: 403, length: '' }));
  await assert.rejects(begin(w).pending, /HTTP 403/);
});

test('a truncated body fails the upload read instead of producing a short file', async () => {
  const w = worker(async () => streamResponse(new Uint8Array(300_000), { length: '1000000' }));
  const source = await begin(w).pending;
  await assert.rejects(readAll(source), /incomplete/);
});

test('worker refuses non-anime1 media URLs and non-anime1 senders without fetching', async () => {
  let fetched = 0;
  const w = worker(async () => { fetched++; return streamResponse(new Uint8Array(10)); });
  for (const [src, sender] of [
    ['https://evil.example/1979/6b.mp4', SENDER],
    ['https://muan.v.anime1.me.evil.example/a.mp4', SENDER],
    ['http://muan.v.anime1.me/1979/6b.mp4', SENDER],
    ['https://muan.v.anime1.me/api', SENDER],
    [SRC, { ...SENDER, url: 'https://evil.example/30595', tab: { id: 7, url: 'https://evil.example/30595' } }],
  ]) {
    const [client, server] = fakePort('kage-anime1-media');
    const got = new Promise(resolve => client.onMessage.addListener(resolve));
    w.accept(server, sender);
    client.postMessage({ type: 'start', src, page: PAGE });
    const reply = await got;
    assert.equal(reply.type, 'error', src);
  }
  assert.equal(fetched, 0);
  assert.ok(w.ctx.KageAnime1Fetch.mediaURL(SRC));
});

test('cancelling disconnects the port and aborts the worker fetch', async () => {
  let signal;
  const w = worker((url, options) => { signal = options.signal; return new Promise(() => {}); });
  const p = page(server => w.accept(server, SENDER));
  const controller = new AbortController();
  const pending = p.api.download({ signal: controller.signal });
  const req = p.posts.find(m => m.type === 'KAGE_BROWSER_AUDIO_REQUEST');
  p.deliver({ type: 'KAGE_ANIME1_MEDIA_URL', requestId: req.requestId, page: PAGE, src: SRC });
  await new Promise(r => setTimeout(r, 10));
  controller.abort();
  await assert.rejects(pending, e => e.name === 'AbortError');
  assert.equal(signal.aborted, true);
  assert.ok(p.posts.some(m => m.type === 'KAGE_BROWSER_AUDIO_CANCEL'));
});
