import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../content/browser-audio.js', import.meta.url), 'utf8');

function harness(href = 'https://www.bilibili.com/bangumi/play/ep84340?from=related') {
  const listeners = new Set(), posts = [], timers = new Map(), intervals = new Map();
  let nextTimer = 0;
  const location = { href, get origin() { return new URL(this.href).origin; } };
  const window = {
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
    postMessage(data, origin) { posts.push({ data, origin }); }
  };
  const context = vm.createContext({ URL, Uint8Array, ArrayBuffer, File, DOMException, crypto: webcrypto, location, window,
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: fn => { const id = ++nextTimer; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id) });
  vm.runInContext(source, context);
  return { api: context.KageBrowserAudio, posts, location, window, timers, intervals, listeners,
    request: () => posts.find(post => post.data.type === 'KAGE_BROWSER_AUDIO_REQUEST').data,
    reply(type, fields = {}, overrides = {}) {
      const request = this.request();
      const event = { source: window, origin: location.origin, data: { type: `KAGE_BROWSER_AUDIO_${type}`, requestId: request.requestId, page: request.page, ...fields }, ...overrides };
      for (const listener of [...listeners]) listener(event);
    },
    result(fields = {}) { this.reply('RESULT', { bytes: new Uint8Array([1, 2, 3]).buffer, mimeType: 'audio/mp4', name: 'episode.m4a', ...fields }); }
  };
}

test('only explicit download sends a canonical page request, then bounded bytes become a local audio File', async () => {
  const h = harness();
  assert.equal(h.posts.length, 0);
  const progress = [];
  const pending = h.api.download({ onProgress: update => progress.push(update) });
  assert.equal(h.request().page, 'https://www.bilibili.com/bangumi/play/ep84340');
  assert.match(h.request().requestId, /^[a-f0-9]{32}$/);
  assert.equal(h.posts[0].origin, 'https://www.bilibili.com');
  h.reply('PROGRESS', { received: 2, total: 3 });
  assert.equal(progress[0].received, 2);
  h.result();
  const file = await pending;
  assert.ok(file instanceof File);
  assert.equal(file.name, 'episode.m4a'); assert.equal(file.type, 'audio/mp4');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
  assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
});

test('wrong windows, origins, nonces, pages and message types cannot supply privileged import bytes', async () => {
  const h = harness('https://www.bilibili.com/video/BV1test/?p=7&tracking=1');
  let completed = false;
  const pending = h.api.download().then(file => { completed = true; return file; });
  assert.equal(h.request().page, 'https://www.bilibili.com/video/BV1test?p=7');
  h.reply('RESULT', { bytes: new ArrayBuffer(3), mimeType: 'audio/mp4' }, { source: {} });
  h.reply('RESULT', { bytes: new ArrayBuffer(3), mimeType: 'audio/mp4' }, { origin: 'https://evil.example' });
  h.reply('RESULT', { bytes: new ArrayBuffer(3), mimeType: 'audio/mp4', requestId: 'stale-request' });
  h.reply('RESULT', { bytes: new ArrayBuffer(3), mimeType: 'audio/mp4', page: 'https://www.bilibili.com/video/BV1test?p=1' });
  h.reply('UNKNOWN', { bytes: new ArrayBuffer(3), mimeType: 'audio/mp4' });
  await Promise.resolve(); assert.equal(completed, false);
  h.result(); await pending; assert.equal(completed, true);
});

test('tracking changes are harmless but a new part aborts and rejects stale results', async () => {
  const h = harness('https://www.bilibili.com/video/BV1test/?p=1');
  const pending = h.api.download();
  h.location.href += '&spm_id_from=example';
  [...h.intervals.values()][0]();
  assert.equal(h.listeners.size, 1);
  h.location.href = 'https://www.bilibili.com/video/BV1test/?p=2';
  h.result();
  await assert.rejects(pending, error => error.name === 'AbortError' && /leaving this video/.test(error.message));
  assert.equal(h.posts.at(-1).data.type, 'KAGE_BROWSER_AUDIO_CANCEL');
});

test('Stop aborts the page request, cleans listeners and ignores a late audio result', async () => {
  const h = harness(), controller = new AbortController();
  const pending = h.api.download({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  h.result();
  assert.equal(h.posts.at(-1).data.type, 'KAGE_BROWSER_AUDIO_CANCEL');
  assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0);
  const initial = h.posts.length;
  await assert.rejects(h.api.download({ signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(h.posts.length, initial, 'already cancelled requests never reach the page');
});

test('empty, oversized and non-buffer results cannot enter the normal file import path', async () => {
  for (const bytes of [new ArrayBuffer(0), new ArrayBuffer(128 * 1024 * 1024 + 1), [1, 2, 3]]) {
    const h = harness(), pending = h.api.download();
    h.result({ bytes });
    await assert.rejects(pending, /empty, invalid, or oversized/);
    assert.equal(h.posts.at(-1).data.type, 'KAGE_BROWSER_AUDIO_CANCEL');
  }
  const h = harness(), pending = h.api.download();
  h.reply('PROGRESS', { received: 1, total: 128 * 1024 * 1024 + 1 });
  await assert.rejects(pending, /128 MiB/);
});

test('visible source errors, unsupported formats and timeouts reject without returning a File', async () => {
  const errorCase = harness(), failed = errorCase.api.download();
  errorCase.reply('ERROR', { error: 'Start playback briefly, then try again.' });
  await assert.rejects(failed, /Start playback briefly/);
  const formatCase = harness(), invalid = formatCase.api.download();
  formatCase.result({ mimeType: 'text/html' });
  await assert.rejects(invalid, /unsupported audio format/);
  const timeoutCase = harness(), timeout = timeoutCase.api.download();
  [...timeoutCase.timers.values()][0]();
  await assert.rejects(timeout, /timed out/);
  assert.equal(timeoutCase.posts.at(-1).data.type, 'KAGE_BROWSER_AUDIO_CANCEL');
});

test('file names cannot smuggle paths and invalid pages send no bridge request', async () => {
  const h = harness(), pending = h.api.download();
  h.result({ name: '../../bad\u0000.m4a' });
  const file = await pending;
  assert.ok(!/[\x00-\x1f/\\]/.test(file.name));
  const unsupported = harness('https://example.com/bangumi/play/ep84340');
  await assert.rejects(unsupported.api.download(), /Open a Bilibili or YouTube video/);
  assert.equal(unsupported.posts.length, 0);
});

test('season episode resolution validates the bridge response and uses an episode URL for audio', async () => {
  const h = harness('https://www.bilibili.com/bangumi/play/ss425?from=search');
  const pending = h.api.resolveEpisode();
  const request = h.posts.at(-1).data;
  assert.equal(request.type, 'KAGE_BROWSER_EPISODE_REQUEST');
  const episodeUrl = 'https://www.bilibili.com/bangumi/play/ep84340';
  for (const listener of [...h.listeners]) listener({ source: h.window, origin: h.location.origin,
    data: { ...request, type: 'KAGE_BROWSER_EPISODE_RESULT', episodeUrl } });
  assert.equal(await pending, episodeUrl);
  const download = h.api.download();
  assert.equal(h.request().page, episodeUrl);
  h.result(); await download;
  h.location.href = 'https://www.bilibili.com/bangumi/play/ss426';
  assert.equal(h.api.currentPage(), '');
});

test('YouTube browser audio uses the same nonce-bound byte bridge and aborts on a different video', async () => {
  const h = harness('https://www.youtube.com/shorts/KGbMdRhWFz4?feature=share');
  const pending = h.api.download();
  assert.equal(h.request().page, 'https://www.youtube.com/watch?v=KGbMdRhWFz4');
  h.result({ name: 'YouTube-KGbMdRhWFz4.m4a' });
  assert.equal((await pending).name, 'YouTube-KGbMdRhWFz4.m4a');
  const next = h.api.download();
  h.location.href = 'https://www.youtube.com/watch?v=abcdefghijk';
  for (const fn of h.intervals.values()) fn();
  await assert.rejects(next, error => error.name === 'AbortError');
});

test('bounded combined MP4 browser fallback is handed to the helper as a matching local file', async () => {
  const h = harness('https://www.youtube.com/watch?v=KGbMdRhWFz4');
  const pending = h.api.download();
  h.result({ mimeType: 'video/mp4', name: 'YouTube-KGbMdRhWFz4.mp4' });
  const file = await pending;
  assert.equal(file.type, 'video/mp4'); assert.equal(file.name, 'YouTube-KGbMdRhWFz4.mp4');
});
