import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function contentHarness() {
  let native = '最初の字幕';
  let shown = null;
  let status = null;
  const requests = [];
  const classes = new Set();
  const target = { appendChild(el) { el.parentNode = this; el.isConnected = true; } };
  const video = { currentTime: 1, readyState: 4, seeking: false, textTracks: [], parentElement: target,
    getBoundingClientRect: () => ({ width: 100 }), closest: () => target, addEventListener() {} };
  const document = {
    body: { classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, v) => v ? classes.add(c) : classes.delete(c) } },
    querySelectorAll: selector => selector === 'video' ? [video] : native ? [{ textContent: native }] : [],
    createElement: () => ({ remove() { this.isConnected = false; shown = null; } })
  };
  const context = vm.createContext({ document, location: { href: 'https://www.netflix.com/watch/1', hostname: 'www.netflix.com', origin: 'https://www.netflix.com' },
    window: { addEventListener() {}, postMessage() {} }, AbortController,
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: message => message.type === 'PROCESS_SUBTITLE' ? new Promise(resolve => requests.push({ message, resolve })) : Promise.resolve({ success: true }) }, storage: { onChanged: { addListener() {} } } },
    show: data => { shown = data.chunks.map(c => c.japanese).join(''); status = data.translation_status || null; }
  });
  vm.runInContext(read('content/subtitles.js'), context);
  vm.runInContext(read('content/content.js').split('// --- Sparkle AI UI ---')[0], context);
  vm.runInContext('renderParsedData = show; setEnabled(true);', context);
  return { context, requests, video, classes, setText: text => { native = text; }, sync: () => vm.runInContext('sync()', context), shown: () => shown, status: () => status };
}
const result = text => ({ success: true, data: { chunks: [{ japanese: text }], sentence_translation: 'translation' } });
test('native subtitle displays immediately; out-of-order responses never rewind it', async () => {
  const h = contentHarness();
  assert.equal(h.shown(), '最初の字幕');
  h.setText('次の字幕'); h.sync();
  h.requests[1].resolve(result('次の字幕')); await flush();
  h.requests[0].resolve(result('最初の字幕')); await flush();
  assert.equal(h.shown(), '次の字幕');
});
test('subtitle removal and disabling invalidate pending responses', async () => {
  const h = contentHarness();
  h.setText(''); h.sync();
  h.requests[0].resolve(result('最初の字幕')); await flush();
  assert.equal(h.shown(), null);
  assert.equal(h.classes.has('kage-has-subtitle'), false);
  h.setText('再生'); h.sync();
  vm.runInContext('setEnabled(false)', h.context);
  h.requests[1].resolve(result('再生')); await flush();
  assert.equal(h.shown(), null);
});
test('seek and episode navigation invalidate prior requests, including repeated text', async () => {
  const h = contentHarness();
  h.video.seeking = true; h.sync();
  assert.equal(h.shown(), null);
  h.video.seeking = false; h.video.currentTime = 30; h.sync();
  assert.equal(h.shown(), '最初の字幕');
  h.context.location.href = 'https://www.netflix.com/watch/2'; h.setText('別の作品'); h.sync();
  h.requests[0].resolve(result('最初の字幕')); await flush();
  assert.equal(h.shown(), '別の作品');
});
test('AI failures preserve original captions and altered text is rejected', async () => {
  const h = contentHarness();
  h.requests[0].resolve(result('勝手に変更')); await flush();
  assert.equal(h.shown(), '最初の字幕');
  h.setText('次の字幕'); h.sync();
  h.requests[1].resolve({ success: false }); await flush();
  assert.equal(h.shown(), '次の字幕');
});
test('Bilibili cues preserve repeated occurrences and use half-open time intervals', () => {
  const context = vm.createContext({});
  vm.runInContext(read('content/subtitles.js'), context);
  const cues = context.KageSubtitles.parse(JSON.stringify({ body: [{ from: 1, to: 2, content: 'はい' }, { from: 5, to: 6, content: 'はい' }] }));
  assert.equal(cues.length, 2);
  assert.equal(context.KageSubtitles.active(cues, 2).length, 0);
  assert.equal(context.KageSubtitles.active(cues, 5)[0].id, 1);
  assert.equal(context.KageSubtitles.time('10000000t', 10000000), 1);
  assert.equal(context.KageSubtitles.time('01:02:03.500'), 3723.5);
});
function backgroundHarness(state, fetch) {
  let listener;
  const event = { addListener() {} };
  const context = vm.createContext({ URL, AbortSignal, AbortController, fetch, chrome: {
    action: { onClicked: event }, tabs: { onRemoved: event },
    storage: { local: { get: async () => state, set: async values => Object.assign(state, values) }, onChanged: event },
    runtime: { onInstalled: event, onMessage: { addListener: fn => { listener = fn; } } }
  } });
  vm.runInContext(read('background/service_worker.js'), context);
  return message => new Promise(resolve => listener(message, { tab: { id: 1 } }, resolve));
}
test('local failures never contact Groq by default, even with a saved Groq key', async () => {
  const calls = [];
  const send = backgroundHarness({ groqApiKey: 'test', apiEndpoint: 'https://api.groq.com/openai/v1/chat/completions' }, async url => { calls.push(url); throw new Error('offline'); });
  const response = await send({ type: 'PROCESS_SUBTITLE', text: '字幕' });
  assert.equal(response.success, false);
  assert.deepEqual(calls, ['http://127.0.0.1:11434/v1/chat/completions']);
});
test('identical foreground requests share one local inference', async () => {
  let calls = 0;
  const send = backgroundHarness({}, async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(result('字幕').data) } }] }) }; });
  const responses = await Promise.all([send({ type: 'PROCESS_SUBTITLE', text: '字幕' }), send({ type: 'PROCESS_SUBTITLE', text: '字幕' })]);
  assert.equal(calls, 1);
  assert.ok(responses.every(r => r.success));
});
test('Groq fallback only runs after a local failure with explicit opt-in', async () => {
  const calls = [];
  const send = backgroundHarness({ groqFallback: true, groqApiKey: 'test' }, async url => {
    calls.push(url);
    if (calls.length === 1) throw new Error('offline');
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'answer' } }] }) };
  });
  assert.equal((await send({ type: 'ASK_AI', question: 'Explain' })).success, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].startsWith('https://api.groq.com/'));
});

test('translation progress and errors are visible without replacing Japanese', async () => {
  const h = contentHarness();
  assert.match(h.status(), /正在翻譯/);
  h.requests[0].resolve({ success: false, error: 'Local LLM request failed (404).' }); await flush();
  assert.match(h.status(), /404/);
  assert.equal(h.shown(), '最初の字幕');
  h.setText('次の字幕'); h.sync();
  h.requests[1].resolve(result('次の字幕')); await flush();
  assert.equal(h.status(), null);
});

test('local inference is serialized and skips obsolete queued subtitles', async () => {
  const requests = [];
  let active = 0;
  let maxActive = 0;
  const send = backgroundHarness({}, async (url, options) => {
    active++; maxActive = Math.max(maxActive, active);
    const body = JSON.parse(options.body);
    return await new Promise(resolve => requests.push({ body, finish() {
      active--;
      resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ sentence_translation: '翻譯' }) } }] }) });
    } }));
  });
  const first = send({ type: 'PROCESS_SUBTITLE', text: '一番' }); await flush();
  const old = send({ type: 'PROCESS_SUBTITLE', text: '二番' });
  const current = send({ type: 'PROCESS_SUBTITLE', text: '三番' });
  assert.equal(requests.length, 1);
  requests[0].finish(); await flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.messages[1].content, '三番');
  assert.equal((await old).success, false);
  requests[1].finish();
  assert.equal((await first).success, false);
  assert.ok((await current).success);
  assert.equal(maxActive, 1);
  assert.ok(requests[0].body.max_tokens <= 512);
});

test('fast translation accepts translation-only JSON and returns original Japanese', async () => {
  const send = backgroundHarness({}, async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"sentence_translation":"今天天氣很好。"}' } }] }) }));
  const response = await send({ type: 'PROCESS_SUBTITLE', text: '今日はいい天気。' });
  assert.equal(response.data.sentence_translation, '今天天氣很好。');
  assert.equal(response.data.chunks[0].japanese, '今日はいい天気。');
});

test('completed translations survive a worker restart and model changes do not reuse them', async () => {
  const state = {};
  let calls = 0;
  const fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"sentence_translation":"快取翻譯"}' } }] }) };
  };
  const firstWorker = backgroundHarness(state, fetch);
  await firstWorker({ type: 'PROCESS_SUBTITLE', text: '同じ字幕' });
  const restartedWorker = backgroundHarness(state, fetch);
  const replay = await restartedWorker({ type: 'PROCESS_SUBTITLE', text: '同じ字幕' });
  assert.equal(replay.data.sentence_translation, '快取翻譯');
  assert.equal(calls, 1);
  state.apiModel = 'another-model';
  await restartedWorker({ type: 'PROCESS_SUBTITLE', text: '同じ字幕' });
  assert.equal(calls, 2);
});

test('explicit preparation works without an active caption and reuses its cached result', async () => {
  let calls = 0;
  const send = backgroundHarness({}, async () => {
    calls++;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"sentence_translation":"預先翻譯"}' } }] }) };
  });
  assert.ok((await send({ type: 'PREPARE_SUBTITLE', text: '未来の字幕' })).success);
  assert.ok((await send({ type: 'PROCESS_SUBTITLE', text: '未来の字幕' })).success);
  assert.equal(calls, 1);
});

function preparationHarness() {
  const buttons = [];
  const requests = [];
  class Element {
    constructor() { this.textContent = ''; this.children = []; this.disabled = false; this.handlers = {}; }
    setAttribute() {}
    addEventListener(name, handler) { this.handlers[name] = handler; }
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.children.push(node); }
    after() {}
  }
  const context = vm.createContext({ Date, document: { createElement(tag) { const el = new Element(); if (tag === 'button') buttons.push(el); return el; } },
    chrome: { runtime: { sendMessage(message) {
      if (message.type === 'CLEAR_PREFETCH') return Promise.resolve({ success: true });
      return new Promise(resolve => requests.push({ message, resolve }));
    } } }
  });
  vm.runInContext(read('content/subtitles.js'), context);
  vm.runInContext(read('content/prepare.js'), context);
  context.KagePreparation.mount({ querySelector: () => new Element() });
  const cues = Array.from({ length: 15 }, (_, i) => ({ start: i, end: i + 1, text: `字幕${i}`, id: i }));
  const tracks = new Map([['track', cues]]);
  context.KagePreparation.observe(tracks, { currentTime: 2.5 }, '字幕2');
  return { context, buttons, requests, tracks };
}

test('next-ten preparation is bounded, batched, and starts at the current position', async () => {
  const h = preparationHarness();
  const work = h.buttons[0].handlers.click();
  for (let i = 0; i < 3; i++) {
    assert.equal(h.requests.length, i + 1);
    assert.deepEqual(Array.from(h.requests[i].message.texts), Array.from({ length: Math.min(4, 10 - i * 4) }, (_, n) => `字幕${i * 4 + n + 3}`));
    h.requests[i].resolve({ success: true }); await flush();
  }
  await work;
  assert.equal(h.requests.length, 3);
  assert.equal(h.context.KagePreparation.running, false);
});

test('whole-track preparation includes earlier lines; Stop prevents further requests', async () => {
  const h = preparationHarness();
  const work = h.buttons[1].handlers.click();
  assert.equal(h.requests[0].message.texts[0], '字幕3');
  h.buttons[2].handlers.click();
  h.requests[0].resolve({ success: true }); await work;
  assert.equal(h.requests.length, 1);
  assert.equal(h.context.KagePreparation.running, false);
});

test('switching the matched track cancels preparation rather than translating the wrong language', async () => {
  const h = preparationHarness();
  const work = h.buttons[1].handlers.click();
  h.context.KagePreparation.observe(h.tracks, { currentTime: 2.5 }, 'different language');
  h.requests[0].resolve({ success: true }); await work;
  assert.equal(h.requests.length, 1);
  assert.equal(h.buttons[0].disabled, true);
});

test('interceptor captures octet-stream subtitle fetches and binary XHR without publishing media', { timeout: 2000 }, async () => {
  const published = [];
  let onCaptured;
  const captured = new Promise(resolve => { onCaptured = resolve; });
  class XHR {
    open() {}
    send() {}
    addEventListener(name, fn) { this.onLoad = fn; }
    getResponseHeader() { return 'application/octet-stream'; }
  }
  let payload = '<?xml version="1.0"?><tt><body><p begin="1s" end="2s">Test</p></body></tt>';
  const window = { fetch: async () => new Response(payload, { headers: { 'content-type': 'application/octet-stream' } }),
    addEventListener() {}, postMessage: message => { published.push(message); onCaptured(); } };
  const context = vm.createContext({ window, XMLHttpRequest: XHR, URL, TextDecoder,
    location: { href: 'https://www.netflix.com/watch/1', origin: 'https://www.netflix.com' } });
  vm.runInContext(read('content/inject.js'), context);
  await window.fetch('https://cdn.nflxvideo.net/subtitle'); await captured;
  assert.equal(published.length, 1);
  const xhr = new XHR(); xhr.open('GET', 'https://cdn.nflxvideo.net/subtitle');
  xhr.responseType = 'arraybuffer'; xhr.response = new TextEncoder().encode(payload).buffer;
  xhr.send(); await xhr.onLoad();
  assert.equal(published.length, 2);
  payload = new Uint8Array(512);
  await window.fetch('https://cdn.nflxvideo.net/media'); await flush();
  assert.equal(published.length, 2);
});

test('whole-track preparation processes every captured line and completes', async () => {
  const h = preparationHarness();
  const work = h.buttons[1].handlers.click();
  const ordered = [...Array.from({ length: 12 }, (_, i) => `字幕${i + 3}`), '字幕0', '字幕1', '字幕2'];
  for (let i = 0; i < 4; i++) {
    assert.equal(h.requests.length, i + 1);
    assert.deepEqual(Array.from(h.requests[i].message.texts), ordered.slice(i * 4, i * 4 + 4));
    h.requests[i].resolve({ success: true }); await flush();
  }
  await work;
  assert.equal(h.requests.length, 4);
  assert.equal(h.context.KagePreparation.running, false);
  assert.equal(h.buttons[1].disabled, false);
});

test('Netflix metadata selects Traditional Chinese only and ignores other titles, forced tracks, images, and unsafe hosts', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(read('content/netflix-tracks.js'), context);
  const track = (language, extra = {}) => ({ language, id: language, ttDownloadables: { 'webvtt-lssdh-ios8': { downloadUrls: { a: 'https://cdn.nflxvideo.net/sub.vtt' } } }, ...extra });
  const manifest = { result: { movieId: 123, timedtexttracks: [track('ja'), track('zh-Hant'), track('zh-Hans'), track('zh-Hant', { isForcedNarrative: true }), track('zh-Hant', { ttDownloadables: { image: { downloadUrls: { a: 'https://cdn.nflxvideo.net/sub.png' } } } }), track('zh-Hant', { ttDownloadables: { webvtt: { downloadUrls: { a: 'https://evil.example/sub.vtt' } } } })] } };
  const tracks = context.KageNetflix.extract(manifest, 123);
  assert.deepEqual(Array.from(tracks, t => t.language), ['ja', 'zh-Hant']);
  assert.equal(context.KageNetflix.extract(manifest, 456).length, 0);
  assert.equal(context.KageNetflix.traditional('zh-TW'), true);
  assert.equal(context.KageNetflix.traditional('zh-Hans'), false);
});

test('Netflix Chinese follows video timing and skips model inference while retaining dictionary readings', async () => {
  const h = contentHarness();
  const displays = [];
  h.context.collect = data => displays.push(JSON.parse(JSON.stringify(data)));
  vm.runInContext(`
    renderParsedData = collect;
    globalThis.KageReadings = { state: 'ready', chunks: text => [{ japanese: text, furigana: 'じまく' }] };
    const chineseCues = [{ start: 0, end: 3, text: '第一句' }, { start: 3, end: 5, text: '第二句' }];
    chineseCues.language = 'zh-Hant'; tracks.set('chinese-track', chineseCues);
    clearSubtitle();
  `, h.context);
  h.sync();
  const before = h.requests.length;
  assert.equal(displays.at(-1).sentence_translation, '第一句');
  assert.equal(displays.at(-1).chunks[0].furigana, 'じまく');
  h.video.currentTime = 3.1; h.sync();
  assert.equal(displays.at(-1).sentence_translation, '第二句');
  h.video.currentTime = 5; h.sync();
  assert.equal(displays.at(-1).sentence_translation, '');
  assert.equal(h.requests.length, before);
  // A late answer from the pre-native request cannot replace the native source.
  h.requests[0].resolve(result('最初の字幕')); await flush();
  assert.equal(displays.at(-1).sentence_translation, '');
  assert.equal(displays.at(-1).chunks[0].furigana, 'じまく');
});

test('local dictionary readings survive translation success and failure', async () => {
  const h = contentHarness();
  const displays = [];
  h.context.collect = data => displays.push(JSON.parse(JSON.stringify(data)));
  vm.runInContext(`
    renderParsedData = collect;
    globalThis.KageReadings = { state: 'ready', chunks: text => [{ japanese: text, furigana: 'じまく' }] };
    renderedSignature = ''; renderCurrent();
  `, h.context);
  h.requests[0].resolve(result('最初の字幕')); await flush();
  assert.equal(displays.at(-1).chunks[0].furigana, 'じまく');
  h.setText('次の字幕'); h.sync();
  h.requests[1].resolve({ success: false, error: 'offline' }); await flush();
  assert.equal(displays.at(-1).chunks[0].furigana, 'じまく');
});

test('Gemma 2 restoration runs once, then preserves subsequent model choices', async () => {
  const state = { apiModel: 'qwen2.5:3b' };
  const models = [];
  const fetch = async (_, options) => {
    models.push(JSON.parse(options.body).model);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'answer' } }] }) };
  };
  await backgroundHarness(state, fetch)({ type: 'ASK_AI', question: 'test' });
  assert.equal(models[0], 'gemma2');
  state.apiModel = 'custom-local-model';
  await backgroundHarness(state, fetch)({ type: 'ASK_AI', question: 'test' });
  assert.equal(models[1], 'custom-local-model');
});

test('Netflix manifest interception fetches Japanese and Traditional Chinese without changing player selection', async () => {
  const calls = [], posted = [];
  class FixtureResponse extends Response {}
  class XHR { open() {} send() {} }
  const window = { addEventListener() {}, postMessage: value => posted.push(value), fetch: async url => {
    calls.push(url);
    return new FixtureResponse('WEBVTT\n\n00:00.000 --> 00:02.000\n字幕', { headers: { 'content-type': 'text/vtt' } });
  } };
  const context = vm.createContext({ window, URL, TextDecoder, Response: FixtureResponse, XMLHttpRequest: XHR, location: { hostname: 'www.netflix.com', pathname: '/watch/123', href: 'https://www.netflix.com/watch/123', origin: 'https://www.netflix.com' } });
  vm.runInContext(read('content/netflix-tracks.js'), context);
  vm.runInContext(read('content/inject.js'), context);
  const manifest = { result: { movieId: 123, textTracks: ['ja', 'zh-Hant', 'zh-Hans'].map(language => ({ language, id: language, downloadables: { 'webvtt-lssdh-ios8': { urls: [{ url: `https://cdn.nflxvideo.net/${language}.vtt` }] } } })) } };
  context.fixtureJSON = JSON.stringify(manifest);
  vm.runInContext('JSON.parse(fixtureJSON)', context);
  await flush(); await flush();
  assert.deepEqual(calls, ['https://cdn.nflxvideo.net/ja.vtt', 'https://cdn.nflxvideo.net/zh-Hant.vtt']);
  assert.deepEqual(posted.filter(p => p.type === 'KAGE_RAW_SUBTITLES').map(p => p.language).sort(), ['ja', 'zh-Hant']);
  vm.runInContext('JSON.parse(fixtureJSON)', context);
  await flush();
  assert.equal(calls.length, 2);
});

test('revisiting translated dialogue renders from page memory without a worker request', async () => {
  const h = contentHarness();
  h.requests[0].resolve(result('最初の字幕')); await flush();
  h.setText('次の字幕'); h.sync();
  const requests = h.requests.length;
  h.setText('最初の字幕'); h.sync();
  assert.equal(h.shown(), '最初の字幕');
  assert.equal(h.status(), null);
  assert.equal(h.requests.length, requests);
});

test('native Chinese cue transitions render on a frame between timeupdate events', () => {
  const h = contentHarness();
  h.context.requestAnimationFrame = () => {};
  h.video.paused = false;
  vm.runInContext(`
    const chinese = [{start: 0, end: 1.1, text: '第一句'}, {start: 1.1, end: 2, text: '第二句'}];
    chinese.language = 'zh-Hant';
    tracks.set('chinese', chinese);
    renderParsedData = data => { globalThis.frameTranslation = data.sentence_translation; };
    syncChineseFrame();
  `, h.context);
  assert.equal(h.context.frameTranslation, '第一句');
  h.video.currentTime = 1.12;
  vm.runInContext('syncChineseFrame()', h.context);
  assert.equal(h.context.frameTranslation, '第二句');
});

test('preparation accepts a confirmed Japanese track in gaps and ignores Chinese tracks', () => {
  const h = preparationHarness();
  vm.runInContext(`
    const ja = [{ start: 10, end: 12, text: '日本語', id: 0 }];
    ja.language = 'ja';
    const zh = [{ start: 0, end: 12, text: '中文', id: 0 }];
    zh.language = 'zh-Hant';
    KagePreparation.observe(new Map([['ja', ja], ['zh', zh]]), { currentTime: 5 }, '');
  `, h.context);
  assert.equal(h.buttons[0].disabled, false);
  assert.equal(h.buttons[1].disabled, false);
});

test('track matching tolerates Japanese whitespace but never guesses an unknown track', () => {
  const context = vm.createContext({});
  vm.runInContext(read('content/subtitles.js'), context);
  const cues = [{ start: 0, end: 3, text: '今日は いい天気' }];
  const tracks = new Map([['captured', cues]]);
  assert.equal(context.KageSubtitles.matchingTrack(tracks, 1, '今日はいい天気')[0], 'captured');
  assert.equal(context.KageSubtitles.matchingTrack(tracks, 4, ''), null);
});

test('preparation recovers a complete translation from malformed optional JSON', async () => {
  let calls = 0;
  const send = backgroundHarness({}, async () => {
    calls++;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"sentence_translation":"明天見。","chunks":[' } }] }) };
  });
  const response = await send({ type: 'PREPARE_SUBTITLE', text: 'また明日。' });
  assert.equal(response.success, true);
  assert.equal(calls, 1);
});

test('incomplete translation retries once locally and caches the successful result', async () => {
  const urls = [];
  const send = backgroundHarness({}, async url => {
    urls.push(url);
    return { ok: true, json: async () => ({ choices: [{ message: { content: urls.length === 1
      ? '{"sentence_translation":"未完成'
      : '{"sentence_translation":"明天見。"}' } }] }) };
  });
  assert.equal((await send({ type: 'PREPARE_SUBTITLE', text: 'また明日。' })).success, true);
  assert.equal((await send({ type: 'PREPARE_SUBTITLE', text: 'また明日。' })).success, true);
  assert.equal(urls.length, 2);
  assert.ok(urls.every(url => url.startsWith('http://127.0.0.1:11434/')));
});

test('repeated invalid model output stops after one retry without caching it', async () => {
  let calls = 0;
  const send = backgroundHarness({}, async () => {
    calls++;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"sentence_translation":' } }] }) };
  });
  const response = await send({ type: 'PREPARE_SUBTITLE', text: 'また明日。' });
  assert.equal(response.success, false);
  assert.match(response.error, /incomplete translation/);
  assert.equal(calls, 2);
});

test('fullscreen reattaches an unchanged paused caption to the normal player on exit', () => {
  const h = contentHarness();
  const normal = h.video.parentElement;
  const fullscreen = { appendChild(el) { el.parentNode = this; el.isConnected = true; } };
  const parent = () => vm.runInContext('subtitleContainer.parentNode', h.context);
  assert.equal(parent(), normal);
  h.context.document.fullscreenElement = fullscreen;
  h.sync();
  assert.equal(parent(), fullscreen);
  h.context.document.fullscreenElement = null;
  h.sync();
  assert.equal(parent(), normal);
  assert.equal(h.shown(), '最初の字幕');
  assert.equal(h.requests.length, 1, 'layout changes must not request another translation');
});
