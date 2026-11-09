import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { File } from 'node:buffer';
import vm from 'node:vm';
import test from 'node:test';
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const PAGE = 'https://www.youtube.com/watch?v=KGbMdRhWFz4';
const MEDIA = 'https://rr1.googlevideo.com/videoplayback?id=matched-media&itag=140&mime=audio%2Fmp4&sig=private';
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ allowed = true, size = 75000, unknownSize = false, fetcher, pageFetch } = {}) {
  const runtimeMessages = [], pageRequests = [], networkRequests = [], posts = [], listeners = new Set();
  const timers = new Map(), intervals = new Map();
  const bytes = new Uint8Array(size).map((_, index) => index % 251);
  const location = { href: PAGE, hostname: 'www.youtube.com', origin: 'https://www.youtube.com' };
  let timer = 0;
  const clock = { setTimeout: fn => { const id = ++timer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: fn => { const id = ++timer; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id) };
  const owner = { id: 'kage-test', tab: { id: 1 }, frameId: 0, url: PAGE, documentId: 'this-document' };
  const worker = vm.createContext({ URL, Uint8Array, AbortController, btoa, ...clock,
    chrome: { runtime: { id: owner.id }, permissions: { contains: async () => allowed }, tabs: { onRemoved: { addListener() {} } } },
    fetch: async (url, options) => {
      networkRequests.push({ url, options });
      if (fetcher) return fetcher(url, options, bytes);
      const range = new URL(url).searchParams.get('range');
      const [start, end] = range ? range.split('-').map(Number) : [0, bytes.length - 1];
      const response = new Response(bytes.slice(start, end + 1), { status: range ? 206 : 200,
        headers: { 'Content-Type': 'audio/mp4', 'Content-Length': String(end - start + 1), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
      return { url, ok: response.ok, status: response.status, body: response.body, headers: response.headers };
    } });
  vm.runInContext(read('background/media-fetch.js'), worker);
  const runtime = { sendMessage: async message => {
    runtimeMessages.push(message);
    try { return { success: true, data: await worker.KageMediaFetch.request(message, owner) }; }
    catch (error) { return { success: false, error: error.message }; }
  } };
  const window = {
    addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'message') listeners.delete(fn); },
    postMessage(data) { posts.push(data); queueMicrotask(() => { for (const listener of [...listeners]) listener({ source: window, origin: location.origin, data }); }); },
    fetch: async (url, options) => { pageRequests.push({ url, options }); if (pageFetch) return pageFetch(url, options, bytes); throw new TypeError('page CORS error'); }
  };
  const metadata = { videoDetails: { videoId: 'KGbMdRhWFz4', lengthSeconds: '60' }, playabilityStatus: { status: 'OK' },
    streamingData: { adaptiveFormats: [{ itag: 140, mimeType: 'audio/mp4', url: MEDIA, ...(unknownSize ? {} : { contentLength: String(size) }) }] } };
  class XHR { open() {} }
  const main = vm.createContext({ URL, URLSearchParams, Response, ReadableStream, Uint8Array, AbortController, atob, location, window, ...clock,
    document: { getElementById: () => ({ getPlayerResponse: () => metadata }) },
    performance: { getEntriesByType: () => [] }, XMLHttpRequest: XHR });
  vm.runInContext(read('content/youtube-audio-main.js'), main);
  const isolated = vm.createContext({ URL, Uint8Array, ArrayBuffer, File, DOMException, crypto: webcrypto, chrome: { runtime }, location, window, ...clock });
  vm.runInContext(read('content/browser-audio.js'), isolated);
  return { api: isolated.KageBrowserAudio, runtimeMessages, posts, pageRequests, networkRequests, bytes, timers, intervals, location };
}

test('explicit preparation crosses main/content/worker worlds and downloads media through Chrome in bounded messages', async () => {
  const h = harness();
  assert.equal(h.networkRequests.length, 0);
  const file = await h.api.download();
  await tick();
  assert.equal(file.type, 'audio/mp4');
  assert.equal(file.size, h.bytes.length);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), h.bytes);
  assert.equal(h.pageRequests.length, 0, 'extension transport avoids the page CORS path');
  assert.equal(h.networkRequests.length, 1);
  assert.ok(h.networkRequests.every(call => call.options.credentials === 'omit' && call.options.redirect === 'error'));
  assert.ok(h.posts.filter(m => m.type === 'KAGE_CHROME_AUDIO_REPLY').every(m => JSON.stringify(m).length < 91000));
  assert.equal(h.runtimeMessages.some(m => /cookie|proxy/i.test(m.action)), false);
  assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
});

test('Chrome relay can discover an unknown size, close its probe, then download the full matching stream', async () => {
  const h = harness({ size: 3, unknownSize: true });
  const file = await h.api.download(); await tick();
  assert.equal(file.size, 3); assert.equal(h.networkRequests.length, 2);
  assert.equal(new URL(h.networkRequests[0].url).searchParams.get('range'), '0-0');
  assert.equal(new URL(h.networkRequests[1].url).searchParams.get('range'), '0-2');
  assert.equal(h.timers.size, 0);
});

test('without optional permission no extension-origin media request runs and the page failure points to Settings', async () => {
  const h = harness({ allowed: false });
  await assert.rejects(h.api.download(), /YT_PAGE_NETWORK.*Settings/);
  await tick();
  assert.equal(h.networkRequests.length, 0); assert.equal(h.pageRequests.length, 1);
  assert.equal(h.timers.size, 0);
});

test('a media-server refusal has its HTTP code and never exposes an error response body or signed URL', async () => {
  const h = harness({ fetcher: async url => ({ url, status: 403, ok: false, body: new Response('private upstream diagnostics').body }) });
  await assert.rejects(h.api.download(), /YT_HTTP_403/);
  await tick();
  assert.equal(JSON.stringify(h.posts.filter(m => m.type === 'KAGE_BROWSER_AUDIO_ERROR')).includes('private'), false);
  assert.equal(h.timers.size, 0);
});

test('stopping a Chrome download cancels the worker stream and does not publish partial media', async () => {
  let signal;
  const h = harness({ fetcher: async (url, options) => {
    signal = options.signal;
    return { url, status: 200, ok: true, headers: new Headers({ 'Content-Type': 'audio/mp4' }), body: new ReadableStream({
      start(controller) { signal.addEventListener('abort', () => controller.error(new Error('aborted'))); }
    }) };
  } });
  const controller = new AbortController();
  const pending = h.api.download({ signal: controller.signal });
  for (let i = 0; i < 15 && !signal; i++) await tick();
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  await tick(); await tick();
  assert.equal(signal.aborted, true);
  assert.equal(h.posts.some(m => m.type === 'KAGE_BROWSER_AUDIO_RESULT'), false);
  assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
});
