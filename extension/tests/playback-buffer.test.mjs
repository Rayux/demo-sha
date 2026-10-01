import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('playback without native Chinese receives batched results through the real worker/content message contract', async () => {
  const state = { gemmaRestoredV1: true };
  const calls = [], messages = [];
  let workerMessage, contentMessage, shown, native = '字幕0';
  const event = { addListener() {} };
  const worker = vm.createContext({ URL, AbortSignal, AbortController,
    fetch: async (_, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      const input = body.messages[1].content;
      const result = input.startsWith('[')
        ? { translations: JSON.parse(input).map(({ id, text }) => ({ id, sentence_translation: `中文 ${text}` })) }
        : { sentence_translation: `中文 ${input}` };
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(result) } }] }) };
    },
    chrome: {
      action: { onClicked: event },
      tabs: { onRemoved: event, sendMessage: async (_, message) => { contentMessage(message); } },
      storage: { local: { get: async () => state, set: async values => Object.assign(state, values) }, onChanged: event },
      runtime: { onInstalled: event, onMessage: { addListener: fn => { workerMessage = fn; } } }
    }
  });
  vm.runInContext(read('background/service_worker.js'), worker);
  const target = { appendChild(node) { node.parentNode = this; node.isConnected = true; } };
  const video = { currentTime: .5, readyState: 4, seeking: false, parentElement: target, textTracks: [],
    getBoundingClientRect: () => ({ width: 100 }), closest: () => target, addEventListener() {} };
  const page = vm.createContext({ AbortController,
    location: { href: 'https://www.netflix.com/watch/1', hostname: 'www.netflix.com', origin: 'https://www.netflix.com' },
    window: { addEventListener() {}, postMessage() {} },
    document: {
      body: { classList: { add() {}, remove() {}, toggle() {} } },
      querySelectorAll: selector => selector === 'video' ? [video] : native ? [{ textContent: native }] : [],
      createElement: () => ({ remove() { this.isConnected = false; shown = null; } })
    },
    chrome: {
      runtime: { onMessage: { addListener: fn => { contentMessage = fn; } }, sendMessage: message => new Promise(resolve => {
        messages.push(message);
        queueMicrotask(() => { if (!workerMessage(message, { tab: { id: 1 } }, resolve)) resolve(); });
      }) },
      storage: { onChanged: event }
    },
    show: data => { shown = JSON.parse(JSON.stringify(data)); }
  });
  vm.runInContext(read('content/subtitles.js'), page);
  vm.runInContext(read('content/content.js').split('// --- Sparkle AI UI ---')[0], page);
  vm.runInContext(`
    renderParsedData = show;
    tracks.set('japanese', Array.from({ length: 40 }, (_, n) => ({ start: n * 3, end: n * 3 + 2, text: '字幕' + n })));
    setEnabled(true);
  `, page);
  assert.equal(shown.chunks[0].japanese, '字幕0');
  await flush();
  assert.equal(shown.sentence_translation, '中文 字幕0');
  assert.equal(calls[0].messages[1].content, '字幕0');
  assert.equal(calls.length, 7); // One current line + six batches for 24 upcoming cues.
  const foregrounds = () => messages.filter(m => m.type === 'PROCESS_SUBTITLE').length;
  assert.equal(foregrounds(), 1);
  native = '字幕1'; video.currentTime = 3.5;
  vm.runInContext('sync()', page);
  assert.equal(shown.sentence_translation, '中文 字幕1');
  assert.equal(foregrounds(), 1); // Prepared line is already in the page cache.
  await flush();

  video.seeking = true; vm.runInContext('sync()', page);
  assert.equal(shown, null);
  video.seeking = false; video.currentTime = 90.5; native = '字幕30';
  vm.runInContext('sync()', page); await flush();
  assert.equal(shown.sentence_translation, '中文 字幕30');
  assert.equal(foregrounds(), 2);
});
