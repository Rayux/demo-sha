import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = name => readFileSync(new URL(`../content/${name}`, import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ storage = {}, href = 'https://www.bilibili.com/video/BV1test?p=2&spm=tracking', hash = '' } = {}) {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.textContent = ''; this.hidden = false; }
    setAttribute() {}
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    all() { return [this, ...this.children.flatMap(child => child.all())]; }
  }
  const events = [], timers = [];
  const location = { href: href + hash, hash };
  // A tiny stand-in for the dictionary: は is a particle, the rest are content words.
  const KageReadings = { ready: Promise.resolve(true), chunks: text => [...text].map(char => char === 'は' ? { japanese: char }
    : { japanese: char, word: true, base: char === '食' ? '食べる' : char }) };
  const context = vm.createContext({ URL, URLSearchParams, Date, Math, location, KageReadings,
    document: { title: '  My   show  ', createElement: tag => new Element(tag) },
    CustomEvent: class { constructor(type) { this.type = type; } },
    window: { dispatchEvent: event => events.push(event.type) },
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    chrome: { storage: { local: { get: async keys => Object.fromEntries([].concat(keys).map(key => [key, storage[key]])), set: async values => Object.assign(storage, JSON.parse(JSON.stringify(values))) },
      onChanged: { addListener() {} } } } });
  vm.runInContext(read('words.js'), context);
  vm.runInContext(read('saved.js'), context);
  const slot = new Element('slot');
  return { words: context.KageWords, saved: context.KageSaved, storage, events, location, slot, Element,
    runTimers() { for (const fn of timers.splice(0)) fn(); },
    text: () => slot.all().map(node => node.textContent).filter(Boolean),
    find: text => slot.all().find(node => node.textContent === text) };
}

test('a clicked word is collected for review with its line, and a second click makes it known', async () => {
  const h = harness();
  await flush();
  h.words.mount(h.slot);
  assert.equal(h.words.toggle('食べる', { text: '猫は食', translation: '貓吃', start: 12, end: 14 }), true);
  assert.equal(h.words.learning('食べる'), true);
  assert.equal(h.words.has('食べる'), false);
  assert.equal(h.words.waiting(), 1, 'waiting for the end-of-video review');
  const context = h.storage.kageWordsV2.learning['食べる'];
  assert.deepEqual({ key: context.key, text: context.text, translation: context.translation, start: context.start, end: context.end },
    { key: 'https://www.bilibili.com/video/BV1test?p=2', text: '猫は食', translation: '貓吃', start: 12, end: 14 });
  assert.ok(h.events.includes('kage-words-change'), 'the subtitle redraws');
  h.runTimers();
  assert.ok(h.text().includes('From this video'));
  assert.ok(h.text().includes('1 to learn · 0 known'));

  assert.equal(h.words.toggle('食べる'), false, 'clicking it again means it is known now');
  assert.equal(h.words.has('食べる'), true);
  assert.deepEqual(h.storage.kageWordsV2.known, ['食べる']);
  assert.equal(h.words.waiting(), 0);
});

test('a word passed five times without a click counts as known; a clicked word never does', async () => {
  const h = harness();
  await flush();
  h.words.mount(h.slot);
  h.words.toggle('猫');
  // 猫 は 食: the particle is not a word; 食 is counted once per distinct line.
  for (const line of ['猫は食', '猫は食', '食は猫', '食猫', '猫食']) h.words.sighted(line);
  assert.equal(h.words.has('食べる'), false, 'four distinct lines so far');
  h.words.sighted('は食');
  assert.equal(h.words.has('食べる'), true);
  assert.equal(h.words.has('猫'), false);
  assert.equal(h.words.learning('猫'), true);
  h.runTimers();
  assert.deepEqual(h.storage.kageWordsV2.known, ['食べる']);
  assert.deepEqual({ ...h.words.coverage(['猫は食']) }, { total: 2, known: 1, fresh: 1 });

  // Needing its reading again is one click: the word goes back to being learned.
  assert.equal(h.words.toggle('食べる'), true);
  assert.equal(h.words.has('食べる'), false);
});

test('the review offers Got it and Still learning, and words known in the first version stay known', async () => {
  const key = 'https://www.bilibili.com/video/BV1test?p=2';
  const h = harness({ storage: { kageKnownWordsV1: ['古'], kageWordsV2: { known: [], seen: {}, learning: {
    '猫': { key, text: '猫は食', start: 5, end: 7, added: 2 },
    '犬': { key: 'https://www.bilibili.com/video/BVother', text: '犬', start: 9, end: 11, added: 1 } } } } });
  await flush();
  h.words.mount(h.slot);
  h.saved.mount(h.slot);
  h.runTimers();
  assert.equal(h.words.has('古'), true);
  assert.equal(h.words.waiting(), 1);
  assert.ok(h.text().includes('From this video') && h.text().includes('Still learning'));

  // Replay plays the word's line from this video.
  const video = { currentTime: 0, readyState: 4, play() {}, pause() {} };
  h.saved.observe(video);
  h.find('Replay').handlers.click();
  assert.equal(video.currentTime, 5);
  // The other video's word opens that video at its line.
  h.find('Open video').handlers.click();
  assert.equal(h.location.href, 'https://www.bilibili.com/video/BVother#kage-t=9');
  h.location.href = key;

  h.slot.all().filter(node => node.textContent === 'Still learning' && node.handlers.click)[0].handlers.click();
  assert.equal(h.words.waiting(), 0, 'reviewed, but still being learned');
  assert.equal(h.words.learning('猫'), true);
  h.slot.all().filter(node => node.textContent === 'Got it')[0].handlers.click();
  assert.equal(h.words.learning('猫'), false);
  assert.equal(h.words.has('猫'), true);
});

test('a saved line belongs to its video, ignoring tracking parameters, and saving it twice removes it', async () => {
  const h = harness();
  await flush();
  h.saved.mount(h.slot);
  assert.equal(h.saved.pageKey(), 'https://www.bilibili.com/video/BV1test?p=2');
  assert.equal(h.saved.toggle({ text: 'はい。', translation: '是。', start: 12.5, end: 14 }), true);
  const [line] = h.storage.kageSavedLinesV1;
  assert.deepEqual({ key: line.key, title: line.title, text: line.text, translation: line.translation, start: line.start, end: line.end },
    { key: 'https://www.bilibili.com/video/BV1test?p=2', title: 'My show', text: 'はい。', translation: '是。', start: 12.5, end: 14 });
  assert.equal(h.saved.has('はい。'), true);
  assert.ok(h.text().includes('This video'));
  assert.ok(h.text().includes('0:12'));
  assert.equal(h.saved.toggle({ text: 'はい。', start: 12.5, end: 14 }), false);
  assert.deepEqual(h.storage.kageSavedLinesV1, []);
  // A line without a known end still gets a short clip.
  h.saved.toggle({ text: 'ええ。', start: 30 });
  assert.equal(h.storage.kageSavedLinesV1[0].end, 36);
});

test('saved lines replay from the video in order, stop at the end, and yield when the viewer seeks away', async () => {
  const key = 'https://www.bilibili.com/video/BV1test?p=2';
  const h = harness({ storage: { kageSavedLinesV1: [
    { id: 'b', key, title: 'Show', text: '二', translation: '', start: 40, end: 42, savedAt: 2 },
    { id: 'a', key, title: 'Show', text: '一', translation: '', start: 10, end: 12, savedAt: 1 },
    { id: 'c', key: 'https://www.bilibili.com/video/BVother', title: 'Other show', text: '他', translation: '', start: 5, end: 7, savedAt: 3 }] } });
  await flush();
  h.saved.mount(h.slot);
  const video = { currentTime: 0, readyState: 4, plays: 0, pauses: 0, play() { this.plays++; }, pause() { this.pauses++; } };
  h.saved.observe(video);
  assert.ok(h.text().includes('Other show'), 'lines from other videos are listed under their title');

  h.find('Play all').handlers.click();
  assert.equal(video.currentTime, 10, 'starts at the earliest line');
  video.currentTime = 11; h.saved.observe(video);
  assert.equal(video.currentTime, 11);
  video.currentTime = 12.1; h.saved.observe(video);
  assert.equal(video.currentTime, 40, 'jumps to the next saved line');
  video.currentTime = 42.1; h.saved.observe(video);
  assert.equal(video.pauses, 1, 'pauses after the last line');

  // Playing one line, then seeking far away, hands control back.
  h.slot.all().find(node => node.className === 'kage-saved-open' && node.children[0].textContent === '一').handlers.click();
  assert.equal(video.currentTime, 10);
  video.currentTime = 300; h.saved.observe(video);
  video.currentTime = 12.5; h.saved.observe(video);
  assert.equal(video.pauses, 1, 'no longer following that clip');

  // A line in another video opens that video at the line.
  h.slot.all().find(node => node.className === 'kage-saved-open' && node.children[0].textContent === '他').handlers.click();
  assert.equal(h.location.href, 'https://www.bilibili.com/video/BVother#kage-t=5');
});

test('a video opened from a saved line starts at that line once it can seek', async () => {
  const h = harness({ hash: '#kage-t=95' });
  await flush();
  const video = { currentTime: 0, readyState: 0 };
  h.saved.observe(video);
  assert.equal(video.currentTime, 0, 'waits for the video to load');
  video.readyState = 1; h.saved.observe(video);
  assert.equal(video.currentTime, 95);
  video.currentTime = 200; h.saved.observe(video);
  assert.equal(video.currentTime, 200, 'only once');
});
