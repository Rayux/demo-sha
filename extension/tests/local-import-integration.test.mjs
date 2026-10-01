import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const sender = { id: 'kage-test', url: 'https://www.bilibili.com/video/BV1234567890', tab: { id: 1 } };
function bridge(fetch, settings = {}) {
  const context = vm.createContext({ URL, AbortSignal, Uint8Array, atob, fetch, chrome: { runtime: { id: 'kage-test' }, storage: { local: { get: async () => settings } } } });
  vm.runInContext(read('background/local-subtitles.js'), context);
  return (message, owner = sender) => context.KageLocalSubtitles.request(message, owner);
}
const http = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
test('local bridge confines requests to localhost, transfers bounded bytes, and never exposes its token', async () => {
  const calls = [];
  const request = bridge(async (url, options) => {
    calls.push({ url, options });
    return http(url.endsWith('/health') ? { ok: true, ready: true, token: 'a'.repeat(48) } : { received: 3 });
  });
  assert.equal((await request({ action: 'health' })).token, undefined);
  await request({ action: 'upload', id: 'job-123456789012', offset: 0, data: btoa('abc') });
  assert.deepEqual([...calls[1].options.body], [97, 98, 99]);
  assert.equal(calls[1].options.headers['X-Kage-Token'], 'a'.repeat(48));
  assert.ok(calls.every(call => call.url.startsWith('http://127.0.0.1:8766/')));
  assert.ok(calls.every(call => call.options.redirect === 'error'));
  await assert.rejects(request({ action: 'upload', id: 'job-123456789012', offset: 0, data: 'A'.repeat(700001) }), /chunk/i);
  await assert.rejects(request({ action: 'create', name: 'clip.mp4', size: 4 * 1024 ** 3 + 1 }), /4 GB/);
  await assert.rejects(request({ action: 'status', id: '../health' }), /Invalid/);
  assert.equal(calls.length, 2);
});
test('local bridge refuses messages from unrelated pages before any network request', async () => {
  const request = bridge(() => { throw new Error('Network must not run'); });
  for (const owner of [{ ...sender, url: 'https://bilibili.com.evil.test/' }, { ...sender, id: 'another-extension' }, { url: sender.url }]) {
    await assert.rejects(request({ action: 'health' }, owner), /Bilibili/);
  }
});
test('local bridge refreshes authentication after helper restart without retrying arbitrary failures', async () => {
  let healthCalls = 0, requests = 0;
  const request = bridge(async url => {
    if (url.endsWith('/health')) return http({ token: String(++healthCalls).repeat(48) });
    requests++;
    return requests === 1 ? http({ error: 'Expired token' }, 401) : http({ state: 'complete' });
  });
  assert.equal((await request({ action: 'status', id: 'job-123456789012' })).state, 'complete');
  assert.equal(healthCalls, 2);
  assert.equal(requests, 2);
});
test('starting an import requests automatic Chinese using only the configured local model', async () => {
  for (const settings of [{ apiEndpoint: 'http://localhost:11434/v1/chat/completions', apiModel: 'gemma2' }, { apiEndpoint: 'https://cloud.example/v1/chat/completions', apiModel: 'cloud-model' }]) {
    let payload;
    const request = bridge(async (url, options) => {
      if (url.endsWith('/health')) return http({ token: 'a'.repeat(48), capabilities: { translation: true } });
      payload = JSON.parse(options.body);
      return http({ state: 'queued' });
    }, settings);
    await request({ action: 'start', id: 'job-123456789012' });
    assert.equal(payload.translation.model, 'gemma2');
    assert.ok(['http://localhost:11434/v1/chat/completions', 'http://127.0.0.1:11434/v1/chat/completions'].includes(payload.translation.endpoint));
  }
});
test('starting an import against an old helper requires an update instead of silently omitting Chinese', async () => {
  const request = bridge(async url => {
    assert.ok(url.endsWith('/health'));
    return http({ token: 'a'.repeat(48) });
  });
  await assert.rejects(request({ action: 'start', id: 'job-123456789012' }), /Restart the local helper/);
});

function worker(fetch, state = { groqFallback: true, groqApiKey: 'test' }) {
  let listener;
  const event = { addListener() {} };
  const context = vm.createContext({ URL, AbortSignal, AbortController, fetch, chrome: {
    action: { onClicked: event }, tabs: { onRemoved: event, sendMessage: async () => {} },
    storage: { local: { get: async () => state, set: async value => Object.assign(state, value) }, onChanged: event },
    runtime: { onInstalled: event, onMessage: { addListener: fn => { listener = fn; } } }
  } });
  vm.runInContext(read('background/service_worker.js'), context);
  return message => new Promise(resolve => { if (!listener(message, sender, resolve)) resolve(); });
}
test('imported foreground, batch, tutor and rolling requests stay local even with Groq backup enabled', async () => {
  for (const message of [
    { type: 'PROCESS_SUBTITLE', text: '日本語' },
    { type: 'PREPARE_SUBTITLES', texts: ['日本語', '字幕'] },
    { type: 'ASK_AI', sentence: '日本語', question: '解釋' },
    { type: 'PRELOAD_TRACK', texts: ['日本語', '字幕'] }
  ]) {
    const calls = [];
    const send = worker(async (url, options) => { assert.equal(options.redirect, 'error'); calls.push(url); throw new Error('Local model unavailable'); });
    const result = await send({ ...message, context: 'import:1', localOnly: true });
    await flush();
    if (message.type !== 'PRELOAD_TRACK') assert.equal(result.success, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'http://127.0.0.1:11434/v1/chat/completions');
  }
});
test('local-only requests do not reuse or join results prepared with cloud fallback', async () => {
  const calls = [];
  const send = worker(async url => {
    calls.push(url);
    if (url.startsWith('http:')) throw new Error('Local unavailable');
    return http({ choices: [{ message: { content: '{"sentence_translation":"雲端"}' } }] });
  });
  assert.equal((await send({ type: 'PROCESS_SUBTITLE', text: '日本語', context: 'native:1' })).success, true);
  assert.equal((await send({ type: 'PROCESS_SUBTITLE', text: '日本語', context: 'import:1', localOnly: true })).success, false);
  assert.equal(calls.filter(url => url.startsWith('https://api.groq.com')).length, 1);
});

function contentHarness({ prepared = false, preparing = false } = {}) {
  let shown = null, native = '', importedEnabled = true;
  const messages = [], requests = [], handlers = {};
  const target = { appendChild(element) { element.parentNode = this; element.isConnected = true; } };
  const video = { currentTime: .5, readyState: 4, seeking: false, textTracks: [], parentElement: target,
    getBoundingClientRect: () => ({ width: 100 }), closest: () => target, addEventListener() {} };
  const cues = [{ start: 0, end: 1, text: '最初の字幕', id: 'a' }, { start: 2, end: 3, text: '次の字幕', id: 'b' }];
  cues.language = 'ja';
  const context = vm.createContext({ AbortController,
    location: { href: sender.url, hostname: 'www.bilibili.com', origin: 'https://www.bilibili.com' },
    window: { addEventListener: (name, fn) => { handlers[name] = fn; }, postMessage() {} },
    document: { body: { classList: { add() {}, remove() {}, toggle() {} } },
      querySelectorAll: selector => selector === 'video' ? [video] : native ? [{ textContent: native }] : [],
      createElement: () => ({ remove() { this.isConnected = false; shown = null; } }) },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage(message) {
      messages.push(plain(message));
      if (message.type === 'PROCESS_SUBTITLE') return new Promise(resolve => requests.push({ message, resolve }));
      return Promise.resolve({ success: true });
    } }, storage: { onChanged: { addListener() {} } } },
    KageImport: { observe() {}, preparingChinese: preparing, track: () => importedEnabled ? ['imported:one', cues] : null,
      chinese() { const cue = cues.find(c => c.start <= video.currentTime && video.currentTime < c.end); return { available: prepared, text: cue ? `已儲存 ${cue.text}` : '' }; },
      current() { if (!importedEnabled) return null; const cue = cues.find(c => c.start <= video.currentTime && video.currentTime < c.end); return cue || { text: '', id: '' }; } },
    render: value => { shown = plain(value); }
  });
  vm.runInContext(read('content/subtitles.js'), context);
  vm.runInContext(read('content/content.js').split('// --- Sparkle AI UI ---')[0], context);
  vm.runInContext('renderParsedData = render; setEnabled(true)', context);
  return { context, video, messages, requests, shown: () => shown, sync: () => vm.runInContext('sync()', context),
    toggle() { importedEnabled = !importedEnabled; handlers['kage-import-change'](); }, setNative: text => { native = text; } };
}
test('imported Japanese drives overlay without native captions and prepares local translations through gaps', () => {
  const h = contentHarness();
  assert.equal(h.shown().chunks[0].japanese, '最初の字幕');
  assert.equal(h.requests[0].message.localOnly, true);
  assert.deepEqual(h.messages.find(m => m.type === 'PRELOAD_TRACK' && m.texts.length).texts, ['次の字幕']);
  h.video.currentTime = 1; h.setNative('Native text must not fill an imported gap'); h.sync();
  assert.equal(h.shown(), null);
  h.video.currentTime = 2; h.sync();
  assert.equal(h.shown().chunks[0].japanese, '次の字幕');
});
test('imported seek and source changes discard stale translations and restore native behavior', async () => {
  const h = contentHarness();
  h.video.seeking = true; h.sync();
  assert.equal(h.shown(), null);
  h.video.seeking = false; h.video.currentTime = 2.5; h.sync();
  h.requests[0].resolve({ success: true, data: { chunks: [{ japanese: '最初の字幕' }], sentence_translation: '過期' } });
  await flush();
  assert.equal(h.shown().chunks[0].japanese, '次の字幕');
  h.setNative('原生字幕'); h.toggle();
  assert.equal(h.shown().chunks[0].japanese, '原生字幕');
  assert.equal(h.requests.at(-1).message.localOnly, undefined);
});
test('prepared imported Chinese follows cue times with no extra model requests', () => {
  const h = contentHarness({ prepared: true });
  assert.equal(h.shown().sentence_translation, '已儲存 最初の字幕');
  assert.equal(h.requests.length, 0);
  assert.equal(h.messages.some(message => message.type === 'PRELOAD_TRACK' && message.texts.length), false);
  h.video.currentTime = 1.5; h.sync();
  assert.equal(h.shown(), null);
  h.video.currentTime = 2.5; h.sync();
  assert.equal(h.shown().sentence_translation, '已儲存 次の字幕');
});
test('helper Chinese preparation shows progress without launching duplicate foreground or rolling inference', () => {
  const h = contentHarness({ preparing: true });
  assert.equal(h.shown().chunks[0].japanese, '最初の字幕');
  assert.match(h.shown().translation_status, /準備繁體中文/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.messages.some(message => message.type === 'PRELOAD_TRACK' && message.texts.length), false);
});

test('Bilibili downloads use only the sending page identity, preserve its part, and omit tracking or cookies', async () => {
  const calls = [];
  const request = bridge(async (url, options) => {
    calls.push({ url, options });
    return http(url.endsWith('/health') ? { token: 'a'.repeat(48), capabilities: { bilibiliDownload: true } } : { id: 'job-123456789012' });
  });
  await request({ action: 'download', url: 'https://evil.test/file', cookies: 'secret' },
    { ...sender, url: 'https://www.bilibili.com/video/BVtest?p=3&spm_id_from=tracking' });
  assert.deepEqual(JSON.parse(calls[1].options.body), { sourceUrl: 'https://www.bilibili.com/video/BVtest?p=3' });
  assert.equal(calls[1].url, 'http://127.0.0.1:8766/jobs');
  await request({ action: 'download' }, { ...sender, url: 'https://www.bilibili.com/bangumi/play/ep12?from=test' });
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { sourceUrl: 'https://www.bilibili.com/bangumi/play/ep12' });
  await assert.rejects(request({ action: 'download' }, { ...sender, url: 'https://www.bilibili.com/' }), /specific Bilibili/);
});

test('an older helper gives update instructions instead of trying a download', async () => {
  const request = bridge(async url => {
    assert.ok(url.endsWith('/health'));
    return http({ token: 'a'.repeat(48), capabilities: { translation: true } });
  });
  await assert.rejects(request({ action: 'download' }), /Update and restart/);
});
