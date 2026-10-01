import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = file => readFileSync(new URL(`../content/${file}`, import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const data = text => ({ chunks: [{ japanese: text }], sentence_translation: `Translated ${text}` });
const plain = value => JSON.parse(JSON.stringify(value));
function contentHarness() {
  let caption = '字幕0';
  let rendered = null;
  let onMessage, onSettings;
  const messages = [], pending = [], posts = [];
  const target = { appendChild(el) { el.parentNode = this; el.isConnected = true; } };
  const video = { currentTime: 0.5, readyState: 4, seeking: false, textTracks: [], parentElement: target,
    getBoundingClientRect: () => ({ width: 100 }), closest: () => target, addEventListener() {} };
  const context = vm.createContext({
    AbortController,
    location: { href: 'https://www.netflix.com/watch/1', hostname: 'www.netflix.com', origin: 'https://www.netflix.com' },
    window: { addEventListener() {}, postMessage: message => posts.push(message) },
    document: {
      body: { classList: { add() {}, remove() {}, toggle() {} } },
      querySelectorAll: selector => selector === 'video' ? [video] : caption ? [{ textContent: caption }] : [],
      createElement: () => ({ remove() { this.isConnected = false; rendered = null; } })
    },
    chrome: {
      runtime: { onMessage: { addListener: fn => { onMessage = fn; } }, sendMessage(message) {
        messages.push(plain(message));
        if (message.type === 'PROCESS_SUBTITLE') return new Promise(resolve => pending.push({ message, resolve }));
        return Promise.resolve({ success: true });
      } },
      storage: { onChanged: { addListener: fn => { onSettings = fn; } } }
    },
    render: value => { rendered = plain(value); }
  });
  vm.runInContext(read('subtitles.js'), context);
  vm.runInContext(read('content.js').split('// --- Sparkle AI UI ---')[0], context);
  vm.runInContext('renderParsedData = render; setEnabled(true)', context);
  const cues = Array.from({ length: 40 }, (_, i) => ({ start: i * 2, end: i * 2 + 1, text: `字幕${i}`, id: i }));
  context.cues = cues;
  vm.runInContext("tracks.set('japanese', cues); sync()", context);
  return {
    context, messages, pending, video, posts,
    get scope() { return vm.runInContext('subtitleContext', context); },
    setCaption(value) { caption = value; },
    sync() { vm.runInContext('sync()', context); },
    notify(scope, results) { onMessage({ type: 'SUBTITLES_READY', context: scope, results }); },
    settings(changes) { onSettings(changes, 'local'); },
    rendered: () => rendered
  };
}

test('rolling results render upcoming subtitles from page memory without another worker request', async () => {
  const h = contentHarness();
  const preload = h.messages.find(m => m.type === 'PRELOAD_TRACK' && m.texts.length);
  assert.equal(preload.texts.length, 24);
  assert.equal(preload.texts[0], '字幕1');
  assert.equal(preload.context, h.scope);
  h.notify(h.scope, [{ text: '字幕1', data: data('字幕1') }]);
  h.video.currentTime = 2.5; h.setCaption('字幕1'); h.sync();
  assert.equal(h.pending.length, 1);
  assert.equal(h.rendered().sentence_translation, 'Translated 字幕1');
  h.pending[0].resolve({ success: false, error: 'obsolete' }); await flush();
  assert.equal(h.rendered().sentence_translation, 'Translated 字幕1');
});

test('a ready notification updates a waiting caption and cannot be overwritten by its old response', async () => {
  const h = contentHarness();
  h.notify(h.scope, [{ text: '字幕0', data: data('字幕0') }]);
  assert.equal(h.rendered().sentence_translation, 'Translated 字幕0');
  h.pending[0].resolve({ success: false, error: 'old request' }); await flush();
  assert.equal(h.rendered().sentence_translation, 'Translated 字幕0');
});

test('changing the captured track restarts an unchanged visible caption in the new context', async () => {
  const h = contentHarness();
  const old = h.scope;
  vm.runInContext("tracks.delete('japanese'); tracks.set('replacement', cues); sync()", h.context);
  assert.notEqual(h.scope, old);
  assert.equal(h.pending.length, 2);
  assert.equal(h.pending[1].message.context, h.scope);
  h.pending[0].resolve({ success: true, data: data('字幕0') }); await flush();
  assert.equal(h.rendered().sentence_translation, undefined);
  h.pending[1].resolve({ success: true, data: data('字幕0') }); await flush();
  assert.equal(h.rendered().sentence_translation, 'Translated 字幕0');
});

test('cue gaps cancel current demand while preserving the confirmed rolling track and context', () => {
  const h = contentHarness();
  const scope = h.scope;
  h.video.currentTime = 1.5; h.setCaption(''); h.sync();
  h.video.currentTime = 3.5; h.sync();
  const preloads = h.messages.filter(m => m.type === 'PRELOAD_TRACK');
  assert.equal(preloads.at(-1).texts[0], '字幕2');
  assert.equal(preloads.at(-1).context, scope);
  assert.equal(preloads.some(m => m.texts.length === 0), false);
  assert.ok(h.messages.some(m => m.type === 'CLEAR_SUBTITLE'));
  assert.equal(h.rendered(), null);
});

test('unmatched nonempty captions stop Japanese rolling preparation even with language metadata', () => {
  const h = contentHarness();
  vm.runInContext("cues.language = 'ja'", h.context);
  const previous = h.scope;
  h.setCaption('A different selected subtitle language'); h.sync();
  assert.notEqual(h.scope, previous);
  assert.deepEqual(h.messages.filter(m => m.type === 'PRELOAD_TRACK').at(-1).texts, []);
  h.notify(previous, [{ text: '字幕1', data: data('字幕1') }]);
  assert.equal(vm.runInContext("translationMemory.has('字幕1')", h.context), false);
  h.setCaption(''); h.video.currentTime = 1.5; h.sync();
  assert.deepEqual(h.messages.filter(m => m.type === 'PRELOAD_TRACK').at(-1).texts, []);
});

for (const action of ['settings', 'seek', 'navigation', 'disabled']) {
  test(`${action} rejects late buffer notifications and foreground results from the old context`, async () => {
    const h = contentHarness();
    const previous = h.scope;
    if (action === 'settings') h.settings({ apiModel: { newValue: 'different-model' } });
    if (action === 'seek') { h.video.seeking = true; h.sync(); }
    if (action === 'navigation') { h.context.location.href = 'https://www.netflix.com/watch/2'; h.setCaption(''); h.sync(); }
    if (action === 'disabled') vm.runInContext('setEnabled(false)', h.context);
    assert.notEqual(h.scope, previous);
    h.notify(previous, [{ text: '字幕1', data: data('字幕1') }]);
    h.pending[0].resolve({ success: true, data: data('字幕0') }); await flush();
    assert.equal(vm.runInContext("translationMemory.has('字幕1') || translationMemory.has('字幕0')", h.context), false);
    if (action === 'navigation') assert.equal(h.posts.filter(m => m.type === 'KAGE_TRACKS_READY').length, 2);
  });
}

function preparationHarness() {
  const buttons = [], requests = [];
  class Element {
    constructor() { this.textContent = ''; this.children = []; this.handlers = {}; }
    setAttribute() {}
    addEventListener(name, fn) { this.handlers[name] = fn; }
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.children.push(node); }
    after() {}
  }
  const context = vm.createContext({ document: { createElement(tag) { const el = new Element(); if (tag === 'button') buttons.push(el); return el; } },
    chrome: { runtime: { sendMessage(message) {
      if (message.type === 'CLEAR_PREFETCH') return Promise.resolve({ success: true });
      return new Promise(resolve => requests.push({ message: plain(message), resolve }));
    } } }
  });
  vm.runInContext(read('subtitles.js'), context);
  vm.runInContext(read('prepare.js'), context);
  context.KagePreparation.setContext('page:1');
  context.KagePreparation.mount({ querySelector: () => new Element() });
  const cues = Array.from({ length: 15 }, (_, i) => ({ start: i * 2, end: i * 2 + 1, text: `字幕${i}`, id: i }));
  const tracks = new Map([['ja', cues]]);
  context.KagePreparation.observe(tracks, { currentTime: 4.5 }, '字幕2');
  return { context, buttons, requests, tracks, cues };
}

test('next ten preparation uses sequential batches of four and retains selection through caption gaps', async () => {
  const h = preparationHarness();
  const work = h.buttons[0].handlers.click();
  assert.deepEqual(h.requests[0].message, { type: 'PREPARE_SUBTITLES', texts: ['字幕3', '字幕4', '字幕5', '字幕6'], context: 'page:1' });
  h.context.KagePreparation.observe(h.tracks, { currentTime: 5.5 }, '');
  assert.equal(h.context.KagePreparation.running, true);
  for (let i = 0; i < 3; i++) {
    assert.equal(h.requests.length, i + 1);
    assert.ok(h.requests[i].message.texts.length <= 4);
    h.requests[i].resolve({ success: true }); await flush();
  }
  await work;
  assert.deepEqual(h.requests.flatMap(r => r.message.texts), Array.from({ length: 10 }, (_, i) => `字幕${i + 3}`));
  assert.equal(h.context.KagePreparation.running, false);
});

test('whole preparation prioritizes upcoming dialogue then covers earlier cues exactly once', async () => {
  const h = preparationHarness();
  const work = h.buttons[1].handlers.click();
  for (let i = 0; i < 4; i++) { h.requests[i].resolve({ success: true }); await flush(); }
  await work;
  assert.deepEqual(h.requests.flatMap(r => r.message.texts), [...Array.from({ length: 12 }, (_, i) => `字幕${i + 3}`), '字幕0', '字幕1', '字幕2']);
});

test('changing context or selected language prevents a manual preparation from submitting another batch', async () => {
  for (const change of ['context', 'language', 'stop']) {
    const h = preparationHarness();
    h.cues.language = 'ja';
    const work = h.buttons[1].handlers.click();
    if (change === 'context') h.context.KagePreparation.setContext('page:2');
    if (change === 'language') h.context.KagePreparation.observe(h.tracks, { currentTime: 4.5 }, 'English subtitle');
    if (change === 'stop') h.buttons[2].handlers.click();
    h.requests[0].resolve({ success: true }); await work;
    assert.equal(h.requests.length, 1);
    assert.equal(h.context.KagePreparation.running, false);
    if (change === 'language') {
      assert.equal(h.buttons[0].disabled, true);
      h.context.KagePreparation.observe(h.tracks, { currentTime: 5.5 }, '');
      assert.equal(h.buttons[0].disabled, true);
    }
  }
});
