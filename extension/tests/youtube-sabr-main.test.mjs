import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const source = read('content/youtube-sabr-main.js'), vendor = read('vendor/googlevideo/sabr.js');
const PAGE = 'https://www.youtube.com/watch?v=KGbMdRhWFz4';
const MEDIA = 'https://rr1.googlevideo.com/videoplayback?id=native&sig=private-session';
const VIDEO = 'KGbMdRhWFz4', MODIFIED = '1700000000000000';
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness({ nativeStatus = 200, nativeMime = 'application/vnd.yt-ump', mode = 'complete', fetchDownload } = {}) {
  const calls = [], listeners = new Map(), timeouts = new Map(), intervals = new Map(), instances = [];
  const location = { href: PAGE, hostname: 'www.youtube.com', origin: 'https://www.youtube.com' };
  const player = { playabilityStatus: { status: 'OK' }, videoDetails: { videoId: VIDEO, lengthSeconds: '20' },
    streamingData: { adaptiveFormats: [{ itag: 140, lastModified: MODIFIED, mimeType: 'audio/mp4; codecs="mp4a.40.2"',
      audioQuality: 'AUDIO_QUALITY_MEDIUM', bitrate: 128000, approxDurationMs: '20000' }] } };
  let nextTimer = 0, protocol;
  class XHR {
    constructor() { this.listeners = new Map(); this.withCredentials = false; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    getResponseHeader() { return nativeMime; }
    send(body) { this.sentBody = body; this.status = nativeStatus; this.responseURL = this.url; this.listeners.get('load')?.(); }
  }
  const window = { ytInitialPlayerResponse: player,
    addEventListener(type, callback) { listeners.set(type, callback); },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length > 1 && fetchDownload) return fetchDownload(url, options);
      return new Response(new Uint8Array([1]), { status: nativeStatus, headers: { 'content-type': nativeMime } });
    } };
  class FakeSabr {
    constructor(config) { this.config = config; this.events = new Map(); this.isAborted = false; this.isErrored = false; instances.push(this); }
    on(type, callback) { this.events.set(type, callback); }
    async abort() { this.isAborted = true; try { this.controller?.error(new Error('aborted')); } catch {} }
    start(options) {
      this.options = options;
      const audioStream = new ReadableStream({ start: controller => {
        this.controller = controller;
        queueMicrotask(async () => {
          try {
            const body = protocol.VideoPlaybackAbrRequest.encode({ ...protocol.VideoPlaybackAbrRequest.decode(new Uint8Array()), clientAbrState: { playerTimeMs: '0', enabledTrackTypesBitfield: 1 },
              videoPlaybackUstreamerConfig: new Uint8Array([1, 2, 3]), selectedAudioFormatIds: [{ itag: 140, lastModified: MODIFIED }],
              selectedVideoFormatIds: [], initializationFormatIds: [], bufferedRanges: [],
              streamerContext: { clientInfo: this.config.clientInfo, poToken: new Uint8Array([4, 5, 6]), sabrContexts: [], unsentSabrContexts: [] } }).finish();
            const response = await this.config.fetchFunction(new URL(MEDIA), { method: 'POST', body, signal: new AbortController().signal });
            await response.arrayBuffer();
            if (this.isAborted) return;
            const audio = { type: 'audio', formatId: { itag: 140, lastModified: MODIFIED }, endSegmentNum: 2, endTimeMs: 20000, trackedSegments: new Map() };
            this.events.get('formatInitialization')?.(audio);
            const header = (number, size) => ({ videoId: VIDEO, itag: 0, lmt: '0', xtags: '',
              formatId: { itag: 140, lastModified: MODIFIED, xtags: '' }, segmentLengthBytes: String(size), isInitializationSegment: number === 0 });
            const add = (number, bytes, start, end) => {
              controller.enqueue(new Uint8Array(bytes));
              audio.trackedSegments.set(number, { mediaHeader: header(number, bytes.length), startTimeMs: start, endTimeMs: end });
              if (number) this.events.get('trackStateUpdate')?.({ audio });
            };
            add(0, [1], 0, 0);
            add(1, [2, 3], 0, 10000);
            if (mode === 'identity') audio.formatId.itag = 251;
            if (mode === 'incomplete') { controller.close(); return; }
            add(mode === 'sequence' ? 3 : 2, [4, 5], 10000, 20000);
            if (this.isAborted) return;
            this.events.get('finish')?.(); controller.close();
          } catch (caught) { this.isErrored = true; this.events.get('error')?.(caught); try { controller.error(caught); } catch {} }
        });
      } });
      return { audioStream, selectedFormats: { audioFormat: this.config.formats[0] } };
    }
  }
  const context = vm.createContext({ window, location, document: { getElementById: () => ({ getPlayerResponse: () => player }) }, XMLHttpRequest: XHR,
    URL, URLSearchParams, Uint8Array, ArrayBuffer, DataView, Request, Response, Headers, Blob, ReadableStream, ByteLengthQueuingStrategy,
    AbortController, DOMException, TextEncoder, TextDecoder, atob, btoa, queueMicrotask, performance, console,
    setTimeout(callback) { const id = ++nextTimer; timeouts.set(id, callback); return id; }, clearTimeout(id) { timeouts.delete(id); },
    setInterval(callback) { const id = ++nextTimer; intervals.set(id, callback); return id; }, clearInterval(id) { intervals.delete(id); } });
  vm.runInContext(vendor, context);
  protocol = context.KageSabrProtocol;
  window.KageSabrProtocol = { ...protocol, SabrStream: FakeSabr };
  vm.runInContext(source, context);
  const body = () => protocol.VideoPlaybackAbrRequest.encode({
    ...protocol.VideoPlaybackAbrRequest.decode(new Uint8Array()),
    clientAbrState: { playerTimeMs: '369000', enabledTrackTypesBitfield: 0 }, videoPlaybackUstreamerConfig: new Uint8Array([1, 2, 3]),
    selectedAudioFormatIds: [{ itag: 140, lastModified: MODIFIED }], selectedVideoFormatIds: [],
    streamerContext: { clientInfo: { clientName: 1, clientVersion: 'current' }, poToken: new Uint8Array([4, 5, 6]),
      playbackCookie: new Uint8Array([7, 8]), field4: new Uint8Array([9]), sabrContexts: [], unsentSabrContexts: [] },
    bufferedRanges: [], initializationFormatIds: [], ssapPlaybackInfos: [], field1000: [] }).finish();
  const capture = async options => { await window.fetch(MEDIA, { method: 'POST', body: body(), ...options }); await flush(); };
  const download = fields => window.KageYouTubeSabr.download({ page: PAGE, signal: new AbortController().signal, ...fields });
  return { calls, listeners, timeouts, intervals, instances, location, player, window, XHR, protocol, body, capture, download };
}

test('SABR waits for a successful bounded native session and preserves native request context without exposing it', async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.download(), /YT_SABR_NOT_READY/);
  const nativeBody = h.body(), untouched = nativeBody.slice();
  await h.window.fetch(MEDIA, { method: 'POST', body: nativeBody, credentials: 'include' }); await flush();
  assert.deepEqual(nativeBody, untouched);
  nativeBody.fill(0); // A retained template is an immutable copy.
  const progress = [], result = await h.download({ onProgress: value => progress.push(value) });
  assert.deepEqual(new Uint8Array(result.bytes), new Uint8Array([1, 2, 3, 4, 5]));
  assert.equal(result.mime, 'audio/mp4');
  assert.equal(h.calls[1].options.credentials, 'include');
  assert.deepEqual(Object.keys(h.calls[1].options.headers), []); // No added CORS preflight headers.
  const request = h.protocol.VideoPlaybackAbrRequest.decode(h.calls[1].options.body);
  assert.deepEqual(request.streamerContext.playbackCookie, new Uint8Array([7, 8]));
  assert.deepEqual(request.streamerContext.field4, new Uint8Array([9]));
  assert.equal(request.clientAbrState.playerTimeMs, '0');
  assert.equal(h.instances[0].options.enabledTrackTypes, 1);
  assert.equal(h.instances[0].options.startTimeMs, 0);
  assert.equal(progress.at(-1).received, 5);
  assert.equal(JSON.stringify(result).includes('private-session'), false);
  assert.equal(h.timeouts.size, 0); assert.equal(h.intervals.size, 0);
});

test('native XHR capture keeps original bytes, request headers and credential mode', async () => {
  const h = harness(), xhr = new h.XHR(), body = h.body();
  xhr.open('POST', MEDIA); xhr.setRequestHeader('Content-Type', 'application/x-protobuf'); xhr.withCredentials = true; xhr.send(body);
  await flush();
  assert.equal(xhr.sentBody, body);
  // Account for the observed XHR not going through the mock native fetch.
  h.calls.push({ nativeXHR: true });
  await h.download();
  assert.equal(h.calls[1].options.headers['content-type'], 'application/x-protobuf');
  assert.equal(h.calls[1].options.credentials, 'include');
});

test('the native rendition identity remains authoritative when watch metadata omits its modification ID', async () => {
  const h = harness();
  delete h.player.streamingData.adaptiveFormats[0].lastModified;
  await h.capture();
  const result = await h.download();
  assert.equal(result.bytes.byteLength, 5);
  assert.equal(h.instances[0].config.formats[0].lastModified, MODIFIED);
});

test('failed responses, non-UMP responses, unsafe URLs and oversized native bodies never become download sessions', async () => {
  for (const fields of [{ nativeStatus: 403 }, { nativeMime: 'audio/mp4' }]) {
    const h = harness(fields); await h.capture(); await assert.rejects(h.download(), /YT_SABR_NOT_READY/);
  }
  for (const url of ['https://googlevideo.com.evil.test/videoplayback', 'http://rr1.googlevideo.com/videoplayback']) {
    const h = harness(); await h.window.fetch(url, { method: 'POST', body: h.body() }); await flush();
    await assert.rejects(h.download(), /YT_SABR_NOT_READY/);
  }
  const h = harness(); await h.capture({ body: new Uint8Array(256 * 1024 + 1) }); await assert.rejects(h.download(), /YT_SABR_NOT_READY/);
});

test('native Request bodies are cloned without consuming the player’s original request', async () => {
  const h = harness(), request = new Request(MEDIA, { method: 'POST', body: h.body(), credentials: 'omit' });
  await h.window.fetch(request); await flush();
  assert.equal(request.bodyUsed, false);
  const result = await h.download(); assert.equal(result.bytes.byteLength, 5);
});

test('navigation discards captured sessions and protected or live video metadata is rejected', async () => {
  const h = harness(); await h.capture(); h.listeners.get('yt-navigate-start')();
  await assert.rejects(h.download(), /YT_SABR_NOT_READY/);
  for (const live of [true, false]) {
    const h = harness(); await h.capture();
    if (live) h.player.videoDetails.isLiveContent = true;
    else h.player.streamingData.licenseInfos = [{}];
    await assert.rejects(h.download(), /YT_SABR_UNSUPPORTED/);
    assert.equal(h.calls.length, 1);
  }
});

test('EOF without finish, changed format identity and out-of-order segments never return partial audio', async () => {
  for (const [mode, code] of [['incomplete', 'YT_SABR_INCOMPLETE'], ['identity', 'YT_SABR_IDENTITY'], ['sequence', 'YT_SABR_SEQUENCE']]) {
    const h = harness({ mode }); await h.capture();
    await assert.rejects(h.download(), new RegExp(code));
    assert.equal(h.timeouts.size, 0); assert.equal(h.intervals.size, 0);
  }
});

test('output cap is enforced before returning a completed file', async () => {
  const h = harness(); await h.capture();
  await assert.rejects(h.download({ maxBytes: 4 }), /YT_AUDIO_TOO_LARGE/);
  assert.equal(h.timeouts.size, 0); assert.equal(h.intervals.size, 0);
});

test('cancellation and navigation abort an in-flight page request and sanitize network failures', async () => {
  for (const navigate of [true, false]) {
    let requestSignal;
    const h = harness({ fetchDownload: (_url, options) => new Promise((_resolve, reject) => {
      requestSignal = options.signal; options.signal.addEventListener('abort', () => reject(new Error(MEDIA)), { once: true });
    }) });
    await h.capture(); const controller = new AbortController();
    const pending = h.download({ signal: controller.signal }); await flush();
    if (navigate) { h.location.href = PAGE.replace(VIDEO, 'abcdefghijk'); for (const callback of h.intervals.values()) callback(); }
    else controller.abort();
    await assert.rejects(pending, /YT_SABR_CANCELLED/);
    assert.equal(requestSignal.aborted, true);
    assert.equal(h.timeouts.size, 0); assert.equal(h.intervals.size, 0);
  }
  const h = harness({ fetchDownload: async () => { throw new Error(MEDIA); } }); await h.capture();
  await assert.rejects(h.download(), caught => /YT_SABR_NETWORK/.test(caught.message) && !caught.message.includes('private-session'));
});
