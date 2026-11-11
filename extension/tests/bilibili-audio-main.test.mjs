import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../content/bilibili-audio-main.js', import.meta.url), 'utf8');
const CDN = 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/84340/audio.m4s?signature=player';
const EP = 'https://www.bilibili.com/bangumi/play/ep84340';
const API = 'https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=84340&fnval=12240';
const requestId = '1234567890abcdef1234567890abcdef';
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const audio = (overrides = {}) => ({ id: 30280, bandwidth: 192000, mimeType: 'audio/mp4', baseUrl: CDN, ...overrides });
const manifest = (overrides = {}) => ({ code: 0, result: { dash: { audio: [audio()] }, ...overrides } });
function metadataResponse(value, { status = 200, url = API, length } = {}) {
  const response = new Response(typeof value === 'string' ? value : JSON.stringify(value), { status,
    headers: { 'Content-Type': 'application/json', ...(length !== undefined ? { 'Content-Length': String(length) } : {}) } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function harness({ frames = [], href = EP, state = { epInfo: { id: 84340, cid: 111 } }, playinfo, ssr, lexicalSSR, response, fallback = { code: -10403 } } = {}) {
  // Invalid passive metadata tests intentionally receive a denied fallback.
  // Record explicit API lookups separately from player/media fetches.
  const events = new Map(), posted = [], calls = [], apiCalls = [], intervals = new Map(), timeouts = new Map();
  let timer = 0;
  const location = { href, hostname: 'www.bilibili.com', origin: 'https://www.bilibili.com' };
  class FixtureResponse {
    constructor(value, url = '') { this.value = value; this.url = url; }
    async json() { return this.value; }
    async text() { if (this.value instanceof Error) throw this.value; return typeof this.value === 'string' ? this.value : JSON.stringify(this.value); }
  }
  class XHR {
    open() {}
    send() {}
    addEventListener(type, handler) { if (type === 'load') this.load = handler; }
  }
  let fixture = manifest();
  let cancelled = 0;
  const window = {
    __INITIAL_STATE__: state, __playinfo__: playinfo, playurlSSRData: ssr,
    addEventListener(type, handler) { events.set(type, handler); },
    postMessage(message, origin, transfer) { posted.push({ message, origin, transfer }); },
    async fetch(url, options = {}) {
      if (options.credentials === 'include' && /\/pgc\/view\/web\/season\?/.test(url)) {
        apiCalls.push({ url, options });
        return metadataResponse({ code: 0, result: { episodes: [{ id: 84340, title: '1', long_title: 'First episode' }, { id: 99999, title: '2' }] } }, { url });
      }
      if (options.credentials === 'include' && /\/pgc\/player\/web\/v2\/playurl\?/.test(url) && /fnval=12240/.test(url)) {
        apiCalls.push({ url, options });
        return typeof fallback === 'function' ? fallback(url, options) : metadataResponse(fallback, { url });
      }
      calls.push({ url, options });
      if (/playurl/.test(url)) return new FixtureResponse(fixture, url);
      if (response) return response(url, options);
      const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
      return { ok: true, url, headers: { get: key => key === 'content-length' ? '4' : 'audio/mp4' },
        body: { getReader: () => ({ async read() { return chunks.length ? { value: chunks.shift(), done: false } : { done: true }; }, async cancel() { cancelled++; } }) } };
    }
  };
  const context = vm.createContext({ document: { querySelectorAll: () => frames.map(src => ({ getAttribute: () => src })) }, window, location, URL, Response: FixtureResponse, XMLHttpRequest: XHR, AbortController, AbortSignal, Uint8Array, TextDecoder,
    setInterval(handler) { const id = ++timer; intervals.set(id, handler); return id; }, clearInterval(id) { intervals.delete(id); },
    setTimeout(handler) { const id = ++timer; timeouts.set(id, handler); return id; }, clearTimeout(id) { timeouts.delete(id); } });
  if (lexicalSSR !== undefined) {
    context.fixtureSSR = lexicalSSR; vm.runInContext('let playurlSSRData = fixtureSSR', context);
  }
  vm.runInContext(source, context);
  const message = (type, overrides = {}, event = {}) => events.get('message')({ source: window, origin: location.origin,
    data: { type, requestId, page: currentCanonical(), ...overrides }, ...event });
  const currentCanonical = () => location.href.includes('/video/') ? `https://www.bilibili.com${new URL(location.href).pathname}?p=${new URL(location.href).searchParams.get('p') || '1'}` : location.href.split('?')[0];
  return { window, context, calls, apiCalls, posted, intervals, timeouts,
    messages: type => posted.map(item => item.message).filter(item => item.type === type),
    results: () => posted.map(item => item.message).filter(item => item.type === 'KAGE_BROWSER_AUDIO_RESULT'),
    errors: () => posted.map(item => item.message).filter(item => item.type === 'KAGE_BROWSER_AUDIO_ERROR'),
    async metadata(value = manifest(), url = 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=84340&cid=111') {
      fixture = value;
      return (await window.fetch(url)).json();
    },
    async metadataText(value = manifest(), url = 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=84340&cid=111') {
      fixture = value;
      return (await window.fetch(url)).text();
    },
    parse(value) { context.fixtureJSON = JSON.stringify(value); return vm.runInContext('JSON.parse(fixtureJSON)', context); },
    xhr(value, responseType = 'json', url = 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=84340&cid=111') {
      const xhr = new XHR(); xhr.open('GET', url); xhr.response = value; xhr.responseText = typeof value === 'string' ? value : '';
      xhr.responseType = responseType; xhr.send(); xhr.load?.(); return xhr;
    },
    request(overrides, event) { message('KAGE_BROWSER_AUDIO_REQUEST', overrides, event); },
    cancel(overrides) { message('KAGE_BROWSER_AUDIO_CANCEL', overrides); },
    navigate(href, state) { location.href = href; if (state) window.__INITIAL_STATE__ = state; for (const handler of intervals.values()) handler(); },
    pagehide() { events.get('pagehide')(); },
    cancelled: () => cancelled
  };
}

test('official playurl audio downloads the whole stream without playback and transfers its buffer', async () => {
  const h = harness();
  const value = manifest();
  assert.equal(await h.metadata(value), value);
  assert.equal(h.calls.length, 1, 'metadata discovery does not fetch media');
  assert.equal(h.apiCalls.length, 0);
  h.request(); await flush();
  assert.equal(h.results().length, 1);
  assert.deepEqual([...new Uint8Array(h.results()[0].bytes)], [1, 2, 3, 4]);
  assert.equal(h.results()[0].page, EP);
  assert.equal(h.results()[0].mimeType, 'audio/mp4');
  assert.match(h.results()[0].name, /ep84340.*\.m4a$/);
  const media = h.calls[1];
  assert.equal(media.url, CDN);
  assert.equal(media.options.credentials, 'omit');
  assert.equal(media.options.redirect, 'error');
  assert.equal(media.options.headers, undefined);
  assert.equal(h.posted.at(-1).transfer[0], h.results()[0].bytes);
  assert.equal(h.messages('KAGE_BROWSER_AUDIO_PROGRESS').at(-1).received, 4);
  assert.equal(h.intervals.size + h.timeouts.size, 0);
  assert.equal(h.apiCalls.length, 0, 'captured audio needs no fallback API request');
});

test('decoded JSON and textual XHR are supported without reading binary media', async () => {
  for (const type of ['json', 'text']) {
    const h = harness();
    const value = manifest();
    h.xhr(type === 'text' ? JSON.stringify(value) : value, type);
    h.request(); await flush();
    assert.equal(h.results().length, 1);
  }
  const h = harness();
  h.xhr(manifest(), 'arraybuffer');
  h.request(); await flush();
  assert.equal(h.calls.length, 0); assert.equal(h.results().length, 0);
});

test('official playurl fetched as text binds anonymous DASH audio to the captured request identity', async () => {
  for (const url of [
    'https://api.bilibili.com/pgc/player/web/playurl?ep_id=84340',
    'https://api.bilibili.com/pgc/player/web/v2/playurl?cid=111',
    'https://api.bilibili.com/pgc/player/web/playurl?ep_id=84340&cid=111'
  ]) {
    const h = harness();
    const value = manifest({ video_info: { dash: { audio: [audio()] } } });
    const text = await h.metadataText(value, url);
    assert.equal(text, JSON.stringify(value), 'the player receives exactly its original response text');
    assert.equal(h.calls.length, 1, 'capture adds no fetch, clone, or media request');
    h.request(); await flush(); assert.equal(h.results().length, 1);
    assert.equal(h.calls[1].url, CDN);
  }
});

test('text capture ignores unrelated, anonymous, conflicting, protected, invalid, and oversized metadata', async () => {
  for (const [value, url] of [
    [manifest(), 'https://evil.test/playurl?ep_id=84340&cid=111'],
    [manifest(), 'https://api.bilibili.com/account?playurl=1&ep_id=84340'],
    [manifest(), 'https://api.bilibili.com/pgc/player/web/playurl'],
    [manifest(), 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=84341&cid=112'],
    [manifest({ cid: 112 }), 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=84340&cid=111'],
    [manifest({ is_drm: true }), 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=84340'],
    [manifest({ dash: { audio: [audio({ drm_info: {} })] } }), 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=84340'],
    ['not JSON', 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=84340'],
    [JSON.stringify(manifest()) + ' '.repeat(2 * 1024 * 1024), 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=84340']
  ]) {
    const h = harness();
    const text = await h.metadataText(value, url);
    assert.equal(text, typeof value === 'string' ? value : JSON.stringify(value));
    h.request(); await flush();
    assert.equal(h.results().length, 0); assert.equal(h.calls.length, 1);
  }
});

test('native text rejection remains unchanged and no candidate is captured', async () => {
  const h = harness();
  const error = new Error('Native response body failed');
  await assert.rejects(h.metadataText(error), cause => cause === error);
  h.request(); await flush(); assert.equal(h.results().length, 0);
});

test('old text responses cannot overwrite audio metadata from the new episode', async () => {
  const h = harness();
  const oldResponse = await h.window.fetch('https://api.bilibili.com/pgc/player/web/playurl?ep_id=84340&cid=111');
  h.navigate('https://www.bilibili.com/bangumi/play/ep84341', { epInfo: { id: 84341, cid: 112 } });
  const newURL = CDN + '&current=1';
  await h.metadataText(manifest({ dash: { audio: [audio({ baseUrl: newURL })] } }),
    'https://api.bilibili.com/pgc/player/web/playurl?ep_id=84341&cid=112');
  assert.equal(await oldResponse.text(), JSON.stringify(manifest()));
  h.request(); await flush();
  assert.equal(h.results().length, 1);
  assert.equal(h.calls.at(-1).url, newURL);
  assert.equal(h.results()[0].page, 'https://www.bilibili.com/bangumi/play/ep84341');
});

test('highest quality AAC audio is preferred over lower bitrate or other audio codecs', async () => {
  const h = harness();
  await h.metadata(manifest({ dash: { audio: [
    audio({ bandwidth: 64000, baseUrl: CDN + '&low=1' }),
    audio({ bandwidth: 256000, mimeType: 'audio/webm', baseUrl: CDN + '&webm=1' }),
    audio({ bandwidth: 192000 })
  ] } }));
  h.request(); await flush(); assert.equal(h.calls[1].url, CDN); assert.equal(h.results()[0].mimeType, 'audio/mp4');
});

test('matching explicit cid in parsed JSON is accepted without replacing the parsed object', async () => {
  const h = harness();
  const result = h.parse(manifest({ cid: 111 }));
  assert.equal(result.result.cid, 111);
  h.request(); await flush(); assert.equal(h.results().length, 1);
});

test('preloaded next episode, mismatched cid, and anonymous parsed manifests are ignored', async () => {
  for (const [value, url] of [
    [manifest(), 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=84341&cid=112'],
    [manifest({ cid: 112 }), 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=84340&cid=111'],
    [manifest(), 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=84340&cid=112'],
    [manifest(), 'https://evil.test/playurl?ep_id=84340&cid=111']
  ]) {
    const h = harness(); await h.metadata(value, url); h.request(); await flush();
    assert.equal(h.results().length, 0); assert.equal(h.calls.length, 1);
  }
  const h = harness(); h.parse(manifest()); h.request(); await flush();
  assert.equal(h.calls.length, 0); assert.match(h.errors()[0].error, /code -10403/);
});

test('BV parts use the selected part cid and ignore preloaded other parts', async () => {
  const state = { videoData: { bvid: 'BVtest', pages: [{ page: 1, cid: 11 }, { page: 2, cid: 22 }] } };
  const h = harness({ href: 'https://www.bilibili.com/video/BVtest?p=2&from=tracking', state });
  await h.metadata(manifest(), 'https://api.bilibili.com/x/player/wbi/playurl?bvid=BVtest&cid=11');
  h.request(); await flush(); assert.equal(h.results().length, 0);
  await h.metadata(manifest(), 'https://api.bilibili.com/x/player/wbi/playurl?bvid=BVtest&cid=22');
  h.request(); await flush(); assert.equal(h.results().length, 1);
  assert.equal(h.results()[0].page, 'https://www.bilibili.com/video/BVtest?p=2');
});

test('current startup globals are usable but old anonymous globals never survive an episode switch', async () => {
  const h = harness({ playinfo: manifest() });
  h.request(); await flush(); assert.equal(h.results().length, 1);
  h.navigate('https://www.bilibili.com/bangumi/play/ep84341', { epInfo: { id: 84341, cid: 112 } });
  h.request(); await flush(); assert.equal(h.results().length, 1); assert.match(h.errors().at(-1).error, /code -10403/);
});

test('a preloaded global with the next episode state cannot borrow a matching cid from epList', async () => {
  const h = harness({ playinfo: manifest(), state: { epInfo: { id: 84341, cid: 112 }, epList: [{ id: 84340, cid: 111 }] } });
  h.request(); await flush(); assert.equal(h.calls.length, 0); assert.equal(h.results().length, 0);
});

test('a stale startup global does not replace audio captured from the matching player response', async () => {
  const h = harness({ playinfo: manifest({ dash: { audio: [audio({ baseUrl: CDN + '&stale=1' })] } }) });
  await h.metadata(); h.request(); await flush();
  assert.equal(h.calls[1].url, CDN);
});

test('unsupported metadata and DRM tracks cannot trigger media downloads', async () => {
  for (const value of [
    { result: { durl: [{ url: CDN }] } },
    manifest({ is_drm: true }), manifest({ drm_tech_type: 2 }),
    manifest({ video_info: { cid: 111, dash: { audio: [audio()], contentProtection: {} } } }),
    manifest({ dash: { audio: [audio({ drm_info: {} })] } }),
    manifest({ dash: { audio: [audio({ mimeType: 'video/mp4' })] } })
  ]) {
    const h = harness(); await h.metadata(value); h.request(); await flush();
    assert.equal(h.results().length, 0); assert.equal(h.calls.length, 1);
  }
});

test('browser audio is limited to HTTPS Bili CDN hosts without credentials or custom ports', async () => {
  for (const url of ['http://upos.bilivideo.com/audio', 'https://127.0.0.1/audio', 'https://localhost/audio',
    'https://bilivideo.com.evil.test/audio', 'https://user:secret@upos.bilivideo.com/audio', 'https://upos.bilivideo.com:8443/audio',
    'https://evil.test/audio', 'file:///tmp/audio']) {
    const h = harness(); await h.metadata(manifest({ dash: { audio: [audio({ baseUrl: url })] } }));
    h.request(); await flush(); assert.equal(h.calls.length, 1); assert.equal(h.results().length, 0);
  }
});

test('untrusted message origins, request ids, and old episode pages are ignored', async () => {
  const h = harness(); await h.metadata();
  h.request({}, { origin: 'https://evil.test' });
  h.request({}, { source: {} });
  h.request({ requestId: 'short' });
  h.request({ page: 'https://www.bilibili.com/bangumi/play/ep84341' });
  await flush(); assert.equal(h.calls.length, 1); assert.equal(h.posted.length, 0);
});

test('declared and streamed audio enforce 128MiB without returning incomplete buffers', async () => {
  for (const streamed of [false, true]) {
    const oversized = new Uint8Array([1]);
    Object.defineProperty(oversized, 'byteLength', { value: 128 * 1024 * 1024 + 1 });
    const h = harness({ response: async url => ({ ok: true, url,
      headers: { get: () => streamed ? null : String(128 * 1024 * 1024 + 1) },
      body: { getReader: () => ({ async read() { return { done: false, value: oversized }; }, async cancel() {} }) } }) });
    await h.metadata(); h.request(); await flush();
    assert.equal(h.results().length, 0); assert.match(h.errors()[0].error, /128 MiB/);
    assert.equal(h.intervals.size + h.timeouts.size, 0);
  }
});

test('incomplete, redirected, and failed audio produce useful errors without URLs or signed tokens', async () => {
  for (const mode of ['incomplete', 'redirect', 'failure']) {
    let sent = false;
    const h = harness({ response: async url => {
      if (mode === 'failure') throw new Error(`Blocked ${url}`);
      return { ok: true, url: mode === 'redirect' ? 'https://evil.test/stolen' : url, headers: { get: () => '5' },
        body: { getReader: () => ({ async read() { if (sent) return { done: true }; sent = true; return { done: false, value: new Uint8Array([1]) }; }, async cancel() {} }) } };
    } });
    await h.metadata(); h.request(); await flush();
    assert.equal(h.results().length, 0); assert.equal(h.errors().length, 1);
    assert.doesNotMatch(h.errors()[0].error, /signature|stolen|https?:/);
  }
});

test('backup audio can recover an unavailable player CDN URL', async () => {
  const backup = 'https://upos-sz-mirrorali.bilivideo.com/upgcxcode/84340/audio.m4s';
  const h = harness({ response: async url => {
    if (url === CDN) throw new Error('Unavailable');
    return { ok: true, url, headers: { get: () => '1' }, body: { getReader: () => {
      let sent = false; return { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: new Uint8Array([1]) }; }, async cancel() {} };
    } } };
  } });
  await h.metadata(manifest({ dash: { audio: [audio({ backupUrl: [backup] })] } })); h.request(); await flush();
  assert.equal(h.results().length, 1); assert.deepEqual(h.calls.slice(1).map(item => item.url), [CDN, backup]);
});

test('matching cancellation and navigation abort in-flight fetches and clear timers', async () => {
  for (const mode of ['cancel', 'navigate', 'pagehide']) {
    let signal;
    const h = harness({ response: (url, options) => new Promise((resolve, reject) => {
      signal = options.signal; signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }) });
    await h.metadata(); h.request(); await flush();
    h.cancel({ requestId: 'differentdifferent' }); assert.equal(signal.aborted, false);
    if (mode === 'cancel') h.cancel();
    if (mode === 'navigate') h.navigate('https://www.bilibili.com/bangumi/play/ep84341');
    if (mode === 'pagehide') h.pagehide();
    await flush(); assert.equal(signal.aborted, true); assert.equal(h.results().length, 0); assert.equal(h.errors().length, 1);
    assert.equal(h.intervals.size + h.timeouts.size, 0);
  }
});

test('late playurl response from the previous episode cannot be bound to the new page', async () => {
  const h = harness();
  const response = await h.window.fetch('https://api.bilibili.com/pgc/player/web/playurl?ep_id=84340&cid=111');
  h.navigate('https://www.bilibili.com/bangumi/play/ep84341', { epInfo: { id: 84341, cid: 112 } });
  await response.json(); h.request(); await flush();
  assert.equal(h.results().length, 0); assert.equal(h.calls.length, 1);
});

test('an explicit click looks up exactly the current episode without initial state or full playback', async () => {
  const h = harness({ state: null, href: EP + '?from=tracking', fallback: { code: 0, data: { result: { video_info: { dash: { audio: [audio()] } } } } } });
  await flush();
  assert.equal(h.calls.length + h.apiCalls.length, 0, 'nothing is fetched before the panel request');
  h.request(); await flush();
  assert.equal(h.results().length, 1);
  assert.equal(h.apiCalls.length, 1); assert.equal(h.apiCalls[0].url, API);
  assert.equal(h.apiCalls[0].options.credentials, 'include');
  assert.equal(h.apiCalls[0].options.redirect, 'error');
  assert.equal(h.apiCalls[0].options.headers, undefined, 'cookies are supplied only by the browser');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, CDN);
  assert.equal(h.calls[0].options.credentials, 'omit');
  assert.deepEqual([...new Uint8Array(h.results()[0].bytes)], [1, 2, 3, 4]);
  assert.equal(h.intervals.size + h.timeouts.size, 0);
});

test('known nested playback wrappers retain request binding for passive capture', async () => {
  for (const value of [
    { code: 0, raw: { data: { video_info: { dash: { audio: [audio()] } } } } },
    { code: 0, data: { result: { video_info: { dash: { audio: [audio()] } } } } },
    { code: 0, raw: { data: { result: { video_info: { dash: { audio: [audio()] } } } } } }
  ]) {
    const h = harness(); await h.metadata(value); h.request(); await flush();
    assert.equal(h.results().length, 1); assert.equal(h.apiCalls.length, 0);
  }
});

test('window and lexical SSR globals reveal audio without any API request', async () => {
  const value = { code: 0, raw: { data: { video_info: { dash: { audio: [audio()] } } } } };
  for (const options of [{ ssr: value }, { lexicalSSR: value }]) {
    const h = harness(options);
    await flush(); assert.equal(h.calls.length + h.apiCalls.length, 0);
    h.request(); await flush();
    assert.equal(h.results().length, 1); assert.equal(h.apiCalls.length, 0);
  }
});

test('unchanged SSR objects are never rebound after navigating away and returning', async () => {
  const value = { ep_id: 84340, raw: { data: { video_info: { dash: { audio: [audio()] } } } } };
  const h = harness({ ssr: value }); h.request(); await flush();
  assert.equal(h.results().length, 1);
  h.navigate('https://www.bilibili.com/bangumi/play/ep84341', { epInfo: { id: 84341, cid: 112 } });
  h.request(); await flush();
  h.navigate(EP, { epInfo: { id: 84340, cid: 111 } });
  h.request(); await flush();
  assert.equal(h.results().length, 1); assert.equal(h.apiCalls.length, 2);
});

test('every outer wrapper identity, status, and protection flag vetoes inner DASH audio', async () => {
  for (const outer of [
    { ep_id: 84341 }, { cid: 112 }, { code: -10403 }, { is_drm: '1' },
    { drm_info: {} }, { is_preview: 1 }, { play_check: { play_detail: 'PLAY_NONE' } },
    { play_video_type: 'none' }, { plugins: [{ name: 'AreaLimitPanel', config: { is_block: true } }] }
  ]) {
    const h = harness();
    await h.metadata({ ...outer, raw: { data: { video_info: { ep_id: 84340, cid: 111, dash: { audio: [audio()] } } } } });
    h.request(); await flush();
    assert.equal(h.results().length, 0); assert.equal(h.calls.length, 1, 'no media request');
    assert.equal(h.apiCalls.length, 1, 'rejected passive metadata needs explicit fallback');
  }
});

test('fallback rejects conflicts, access errors, previews, regions, DRM, and unsupported formats with safe reasons', async () => {
  const cases = [
    [{ code: -10403, message: 'secret signed https://evil.test' }, /code -10403/],
    [{ code: -404, message: 'secret signed https://evil.test' }, /code -404/],
    [{ code: 0, play_check: { play_detail: 'PLAY_PREVIEW' } }, /preview/],
    [{ code: 0, play_check: { play_detail: 'PLAY_NONE' } }, /not playable/],
    [{ code: 0, play_video_type: 'preview' }, /preview/],
    [{ code: 0, play_video_type: 'none' }, /not playable/],
    [{ code: 0, plugins: [{ name: 'AreaLimitPanel', config: { is_block: true } }] }, /regional/],
    [{ code: 0, is_drm: '1' }, /DRM/],
    [{ code: 0, cid: 112 }, /does not match/],
    [{ code: 0, ep_id: 84341 }, /does not match/]
  ];
  for (const [outer, reason] of cases) {
    const fallback = { ...outer, raw: { data: { video_info: { ep_id: 84340, cid: 111, dash: { audio: [audio()] } } } } };
    const h = harness({ fallback }); h.request(); await flush();
    assert.equal(h.results().length, 0); assert.equal(h.calls.length, 0); assert.equal(h.apiCalls.length, 1);
    assert.match(h.errors()[0].error, reason); assert.doesNotMatch(h.errors()[0].error, /secret|signed|https?:/);
    assert.equal(h.intervals.size + h.timeouts.size, 0);
  }
  const h = harness({ fallback: { code: 0, result: { durl: [{ url: CDN }] } } });
  h.request(); await flush(); assert.equal(h.calls.length, 0); assert.match(h.errors()[0].error, /DASH audio/);
});

test('fallback enforces metadata size and wrapper depth bounds before acquiring media', async () => {
  let deeplyNested = { video_info: { dash: { audio: [audio()] } } };
  for (let i = 0; i < 6; i++) deeplyNested = { data: deeplyNested };
  for (const fallback of [
    () => metadataResponse(manifest(), { length: 2 * 1024 * 1024 + 1 }),
    () => metadataResponse(JSON.stringify(manifest()) + ' '.repeat(2 * 1024 * 1024)),
    deeplyNested,
    'not JSON'
  ]) {
    const h = harness({ fallback }); h.request(); await flush();
    assert.equal(h.results().length, 0); assert.equal(h.calls.length, 0); assert.equal(h.errors().length, 1);
    assert.match(h.errors()[0].error, /2 MiB|DASH audio|invalid playback metadata/);
    assert.equal(h.intervals.size + h.timeouts.size, 0);
  }
});

test('fallback HTTP and network failures do not expose signed URLs or raw server messages', async () => {
  for (const [fallback, reason] of [
    [() => metadataResponse({ message: 'secret signed' }, { status: 412 }), /HTTP 412/],
    [() => metadataResponse(manifest(), { url: 'https://evil.test/secret' }), /unexpected playback metadata/],
    [() => { throw new Error('secret signed https://evil.test'); }, /could not fetch.*metadata/]
  ]) {
    const h = harness({ fallback }); h.request(); await flush();
    assert.equal(h.results().length, 0); assert.equal(h.calls.length, 0);
    assert.match(h.errors()[0].error, reason); assert.doesNotMatch(h.errors()[0].error, /secret|signed|https?:/);
  }
});

test('metadata lookup shares cancellation, page navigation, and its 20-second timeout', async () => {
  for (const mode of ['cancel', 'navigate', 'timeout']) {
    let signal;
    const h = harness({ fallback: (url, options) => new Promise((resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }) });
    h.request(); await flush(); assert.equal(h.apiCalls.length, 1);
    if (mode === 'cancel') h.cancel();
    if (mode === 'navigate') h.navigate('https://www.bilibili.com/bangumi/play/ep84341');
    if (mode === 'timeout') [...h.timeouts.values()].at(-1)();
    await flush();
    assert.equal(signal.aborted, true); assert.equal(h.results().length, 0); assert.equal(h.calls.length, 0);
    assert.equal(h.errors().length, 1); assert.equal(h.intervals.size + h.timeouts.size, 0);
  }
});

test('late metadata from a cancelled old episode cannot replace the new episode audio', async () => {
  let releaseOld;
  const h = harness({ state: null, fallback: (url, options) => {
    if (new URL(url).searchParams.get('ep_id') === '84340') return new Promise(resolve => { releaseOld = resolve; });
    return metadataResponse({ code: 0, result: { video_info: { dash: { audio: [audio({ baseUrl: CDN + '&new=1' })] } } } }, { url });
  } });
  h.request(); await flush();
  h.navigate('https://www.bilibili.com/bangumi/play/ep84341');
  h.request(); await flush();
  releaseOld(metadataResponse(manifest())); await flush();
  assert.equal(h.apiCalls.length, 2); assert.equal(h.apiCalls[0].options.signal.aborted, true);
  assert.equal(h.results().length, 1); assert.equal(h.results()[0].page, 'https://www.bilibili.com/bangumi/play/ep84341');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, CDN + '&new=1');
  assert.equal(h.intervals.size + h.timeouts.size, 0);
});

test('fresh passive player audio wins when a concurrent fallback succeeds or fails', async () => {
  for (const fallback of [manifest(), { code: -10403 }]) {
    let release;
    const h = harness({ fallback: () => new Promise(resolve => { release = resolve; }) });
    h.request(); await flush();
    await h.metadata(manifest({ dash: { audio: [audio({ baseUrl: CDN + '&passive=1' })] } }));
    release(metadataResponse(fallback)); await flush();
    assert.equal(h.results().length, 1); assert.equal(h.errors().length, 0);
    assert.equal(h.calls.at(-1).url, CDN + '&passive=1');
  }
});

test('BV pages do not trigger an unsigned Bangumi API lookup', async () => {
  const h = harness({ href: 'https://www.bilibili.com/video/BVtest?p=2', state: null });
  h.request(); await flush();
  assert.equal(h.apiCalls.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.results().length, 0);
});

test('season page resolves the player episode and downloads its audio rather than the season', async () => {
  const href = 'https://www.bilibili.com/bangumi/play/ss425?spm_id_from=333.337.0.0';
  const h = harness({ href, fallback: manifest() });
  h.request({ type: 'KAGE_BROWSER_EPISODE_REQUEST', page: href });
  const resolved = h.messages('KAGE_BROWSER_EPISODE_RESULT')[0];
  assert.equal(resolved.episodeUrl, EP);
  h.request({ page: EP }); await flush();
  assert.equal(h.apiCalls[0].url, API);
  assert.equal(h.results()[0].page, EP);
});


test('season iframe lookup accepts one explicit Bilibili episode and rejects ambiguous or foreign frames', () => {
  const href = 'https://www.bilibili.com/bangumi/play/ss425';
  for (const [frames, expected] of [
    [['https://player.bilibili.com/player.html?ep_id=84340'], EP],
    [['https://www.bilibili.com/bangumi/play/ep84340'], EP],
    [['https://example.com/player?ep_id=84340'], ''],
    [['https://player.bilibili.com/player.html?ep_id=84340', 'https://player.bilibili.com/player.html?ep_id=99999'], '']
  ]) {
    const h = harness({ href, state: {}, frames });
    h.request({ type: 'KAGE_BROWSER_EPISODE_REQUEST', page: href });
    assert.equal(h.messages('KAGE_BROWSER_EPISODE_RESULT')[0].episodeUrl, expected);
  }
});


test('season catalog fallback returns choices and validates selection before resolving an episode', async () => {
  const href = 'https://www.bilibili.com/bangumi/play/ss425';
  const h = harness({ href, state: {} });
  h.request({ type: 'KAGE_BROWSER_EPISODE_REQUEST', page: href, lookup: true }); await flush();
  const response = h.messages('KAGE_BROWSER_EPISODE_RESULT').at(-1);
  assert.equal(response.episodeUrl, '');
  assert.equal(response.episodes.length, 2);
  assert.equal(h.apiCalls[0].url, 'https://api.bilibili.com/pgc/view/web/season?season_id=425');
  h.request({ type: 'KAGE_BROWSER_EPISODE_REQUEST', page: href, lookup: true, episodeId: '11111' }); await flush();
  assert.equal(h.messages('KAGE_BROWSER_EPISODE_RESULT').at(-1).episodeUrl, '');
  h.request({ type: 'KAGE_BROWSER_EPISODE_REQUEST', page: href, lookup: true, episodeId: '84340' }); await flush();
  assert.equal(h.messages('KAGE_BROWSER_EPISODE_RESULT').at(-1).episodeUrl, EP);
  assert.equal(h.apiCalls.length, 1);
});

test('a streaming request hands each downloaded piece over instead of one buffer at the end', async () => {
  const h = harness();
  await h.metadata(manifest());
  h.request({ stream: true }); await flush();
  assert.equal(h.results().length, 0);
  const [stream] = h.messages('KAGE_BROWSER_AUDIO_STREAM');
  assert.equal(stream.mimeType, 'audio/mp4');
  assert.match(stream.name, /ep84340.*\.m4a$/);
  const chunks = h.messages('KAGE_BROWSER_AUDIO_CHUNK');
  assert.deepEqual(chunks.flatMap(chunk => [...new Uint8Array(chunk.bytes)]), [1, 2, 3, 4]);
  assert.equal(h.messages('KAGE_BROWSER_AUDIO_END')[0].received, 4);
  assert.equal(h.errors().length, 0);
  assert.equal(h.intervals.size + h.timeouts.size, 0);
});

test('a video page that just opened waits briefly for the player instead of giving up', async () => {
  const state = { videoData: { bvid: 'BVtest', pages: [{ page: 1, cid: 11 }] } };
  const h = harness({ href: 'https://www.bilibili.com/video/BVtest', state });
  h.context.performance = { now: () => 400 };
  h.request(); await flush();
  assert.equal(h.errors().length, 0, 'still waiting for the player');
  await h.metadata(manifest(), 'https://api.bilibili.com/x/player/wbi/playurl?bvid=BVtest&cid=11');
  const waiting = Math.max(...h.timeouts.keys()); // The newest timer is the short wait.
  const tick = h.timeouts.get(waiting); h.timeouts.delete(waiting); tick();
  await flush(); await flush();
  assert.equal(h.results().length, 1);

  // A page that has been open a while has nothing more to wait for.
  const late = harness({ href: 'https://www.bilibili.com/video/BVtest', state });
  late.context.performance = { now: () => 60000 };
  late.request(); await flush();
  assert.equal(late.errors().length, 1);
});
