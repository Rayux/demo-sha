import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../content/imported.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const key = 'bilibili:BV1test:p1';
const storagePrefix = 'kageImportedTrackV2:';
const track = (extra = {}) => ({ key, name: 'lesson.mp4', enabled: true, offset: 0, revision: 1, updatedAt: Date.now(),
  cues: [{ start: 1, end: 2, text: 'こんにちは', id: 0 }, { start: 3, end: 4, text: 'こんにちは', id: 1 }], ...extra });

function harness({ documents = [], sharedStorage, send, get, now = Date.now, href = 'https://www.bilibili.com/video/BV1test/?p=1' } = {}) {
  const elements = [], events = [], requests = [], timers = new Map();
  let nextTimer = 0;
  class Element {
    constructor(tag) { this.tag = tag; this.textContent = ''; this.children = []; this.handlers = {}; this.dataset = {}; this.hidden = false; this.value = ''; this.disabled = false; this.classList = { toggle() {} }; elements.push(this); }
    setAttribute() {}
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    click() { return this.handlers.click?.(); }
    focus() {}
  }
  const storage = sharedStorage || Object.fromEntries(documents.map(doc => [storagePrefix + doc.key, JSON.parse(JSON.stringify(doc))]));
  const context = vm.createContext({ URL, Date: class extends Date { static now() { return now(); } }, Uint8Array, TextEncoder, btoa, location: { href },
    CustomEvent: class { constructor(type) { this.type = type; } },
    window: { dispatchEvent: event => events.push(event.type) },
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    document: { createElement: tag => new Element(tag), activeElement: null },
    chrome: { storage: { local: {
      get: get || (async () => JSON.parse(JSON.stringify(storage))),
      set: async value => Object.assign(storage, JSON.parse(JSON.stringify(value))),
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key]; }
    } }, runtime: { sendMessage: async message => {
      requests.push(message);
      return send ? send(message) : { success: true, data: { ready: true } };
    } } }
  });
  vm.runInContext(source, context);
  const video = { currentTime: 1.5 };
  context.KageImport.observe(video);
  context.KageImport.mount(new Element('slot'));
  return { context, api: context.KageImport, video, storage, elements, events, requests, timers,
    saved: () => storage[storagePrefix + key],
    documents: () => Object.entries(storage).filter(([name, value]) => name.startsWith(storagePrefix) && !value.deleted).map(([, value]) => value),
    button: text => elements.find(el => el.tag === 'button' && el.textContent === text),
    number: () => elements.find(el => el.tag === 'input' && el.type === 'number'),
    file: () => elements.find(el => el.type === 'file'),
    status: () => elements.find(el => el.className === 'kage-import-status').textContent,
    async choose(size = 600000) {
      const file = new Blob([new Uint8Array(size)], { type: 'video/mp4' });
      file.name = 'download.mp4';
      this.file().files = [file]; this.file().handlers.change();
      for (let i = 0; i < 20; i++) await flush();
    }
  };
}

test('saved imported Japanese drives captions without a native track and preserves repeated cue IDs', async () => {
  const h = harness({ documents: [track()] }); await flush();
  assert.equal(h.api.enabled, true);
  assert.equal(h.api.current(h.video).text, 'こんにちは');
  const firstId = h.api.current(h.video).id;
  const entry = h.api.track(h.video);
  assert.equal(entry[1].language, 'ja');
  assert.equal(h.api.track(h.video), entry, 'stable track references avoid restarting preparation');
  h.video.currentTime = 2;
  assert.equal(h.api.current(h.video).text, '');
  h.video.currentTime = 3;
  assert.notEqual(h.api.current(h.video).id, firstId);
});

test('positive offset delays cues and disabling restores the native source', async () => {
  const h = harness({ documents: [track()] }); await flush();
  const offset = h.number(); offset.value = '2'; await offset.handlers.change();
  assert.equal(h.api.current(h.video).text, '');
  h.video.currentTime = 3;
  assert.equal(h.api.current(h.video).text, 'こんにちは');
  assert.equal(h.saved().offset, 2);
  const checkbox = h.elements.find(el => el.type === 'checkbox');
  checkbox.checked = false; await checkbox.handlers.change();
  assert.equal(h.api.current(h.video), null);
  assert.equal(h.api.hasTrack, true);
  assert.equal(h.saved().enabled, false);
});

test('tracking parameters do not reset subtitles; switching Bilibili part clears immediately', async () => {
  const h = harness({ documents: [track()] }); await flush();
  const entry = h.api.track(h.video);
  h.context.location.href = 'https://www.bilibili.com/video/BV1test/?p=1&spm_id_from=example#reply';
  assert.equal(h.api.track(h.video), entry);
  h.context.location.href = 'https://www.bilibili.com/video/BV1test/?p=2';
  h.api.observe(h.video);
  assert.equal(h.api.current(h.video), null);
  await flush(); assert.equal(h.api.hasTrack, false);
});

test('an old storage load never attaches subtitles to a different video', async () => {
  const loads = [];
  const h = harness({ get: () => new Promise(resolve => loads.push(resolve)) });
  h.context.location.href = 'https://www.bilibili.com/video/BV2other/'; h.api.observe(h.video);
  loads[1]({ kageImportedTracksV1: [track({ key: 'bilibili:BV2other:p1', name: 'second.mp4' })] }); await flush();
  loads[0]({ kageImportedTracksV1: [track()] }); await flush();
  assert.equal(h.api.sourceName, 'second.mp4');
  assert.match(h.api.track(h.video)[0], /BV2other/);
});

test('bangumi episodes persist independently and unsupported pages have no import source', async () => {
  const h = harness({ href: 'https://www.bilibili.com/bangumi/play/ep123?from=search', documents: [track({ key: 'bilibili:ep123' })] });
  await flush(); assert.equal(h.api.hasTrack, true);
  h.context.location.href = 'https://www.netflix.com/watch/123'; h.api.observe(h.video);
  assert.equal(h.api.current(h.video), null);
  assert.equal(h.elements.find(el => el.className === 'kage-import-card kage-source-card').hidden, true);
});

test('uploads use bounded chunks and completion is saved for local-only playback', async () => {
  const h = harness({ send: async message => ({ success: true, data: message.action === 'create' ? { id: 'job-1' }
    : message.action === 'upload' ? { received: message.offset + Buffer.from(message.data, 'base64').length }
      : message.action === 'status' ? { state: 'complete', cues: [{ start: 0, end: 3, text: '日本語です', translation: '這是日語' }], duration: 3 }
        : { ready: true } }) });
  await flush(); await h.choose();
  const uploads = h.requests.filter(message => message.action === 'upload');
  assert.equal(uploads.length, 3);
  assert.ok(uploads.every(message => message.data.length <= 512 * 1024));
  assert.deepEqual(uploads.map(message => message.offset), [0, 262144, 524288]);
  assert.equal(uploads.reduce((total, message) => total + Buffer.from(message.data, 'base64').length, 0), 600000);
  assert.ok(h.requests.every(message => message.type === 'LOCAL_SUBTITLES'));
  assert.equal(h.api.current(h.video).text, '日本語です');
  assert.equal(h.api.chinese(h.video).text, '這是日語');
  assert.equal(h.saved().cues[0].translation, '這是日語');
  assert.equal(h.requests.filter(message => message.action === 'start').length, 1);
  assert.equal(h.saved().job, null);
  assert.match(h.status(), /1 lines ready with Japanese and Traditional Chinese/);
});

test('a status response from the previous episode cannot overwrite the current episode', async () => {
  let finish;
  const h = harness({ documents: [track({ job: { id: 'pending', state: 'transcribing' } }), track({ key: 'bilibili:BV2other:p1', name: 'second.mp4' })],
    send: () => new Promise(resolve => { finish = resolve; }) });
  await flush();
  h.context.location.href = 'https://www.bilibili.com/video/BV2other/'; h.api.observe(h.video); await flush();
  finish({ success: true, data: { state: 'complete', cues: [{ start: 0, end: 99, text: 'wrong episode' }] } }); await flush();
  assert.equal(h.api.sourceName, 'second.mp4');
  assert.equal(h.api.current(h.video).text, 'こんにちは');
});

test('restored jobs reconnect, can cancel, and show an interrupted upload explicitly', async () => {
  const h = harness({ documents: [track({ job: { id: 'pending', state: 'uploading' } })],
    send: async message => ({ success: true, data: { state: message.action === 'cancel' ? 'cancelled' : 'uploading' } }) });
  await flush();
  assert.equal(h.requests[0].action, 'status');
  assert.match(h.status(), /Upload interrupted/);
  await h.button('Stop processing').click();
  assert.equal(h.saved().job, null);
  assert.equal(h.button('Import another video / audio').disabled, false);
});

test('editing the line at playhead saves text and timing without touching other lines', async () => {
  const h = harness({ documents: [track()] }); await flush();
  h.button('Edit line at playhead').click();
  h.elements.find(el => el.tag === 'textarea').value = 'こんばんは';
  const numberInputs = h.elements.filter(el => el.type === 'number');
  numberInputs[1].value = '1.25'; numberInputs[2].value = '2.5';
  await h.button('Save correction').click();
  assert.equal(h.api.current(h.video).text, 'こんばんは');
  assert.equal(h.saved().cues[0].start, 1.25);
  assert.equal(h.saved().cues[1].text, 'こんにちは');
});

test('retention keeps at most fifteen subtitle documents and removing only deletes this part', async () => {
  const documents = [track(), ...Array.from({ length: 16 }, (_, i) => track({ key: `bilibili:BVother${i}:p1`, updatedAt: Date.now() - 1000 + i }))];
  const h = harness({ documents }); await flush();
  const offset = h.number(); offset.value = '1'; await offset.handlers.change();
  assert.equal(h.documents().length, 15);
  assert.equal(h.saved().key, key);
  await h.button('Remove saved subtitles').click();
  assert.equal(h.api.current(h.video), null);
  assert.equal(h.documents().length, 14);
  assert.ok(h.documents().every(item => item.key !== key));
});

test('overlapping imported cues share the normalized text used by translation caching', async () => {
  const h = harness({ documents: [track({ cues: [{ start: 0, end: 2, text: '今日は' }, { start: 1, end: 3, text: '晴れです' }] })] });
  await flush();
  assert.equal(h.api.current(h.video).text, '今日は 晴れです');
});

test('navigation while creating a job cancels the orphan before transferring media', async () => {
  let created;
  const h = harness({ send: message => message.action === 'create' ? new Promise(resolve => { created = resolve; }) : { success: true, data: { ready: true } } });
  await flush(); await h.choose(100);
  h.context.location.href = 'https://www.bilibili.com/video/BV2other/'; h.api.observe(h.video);
  created({ success: true, data: { id: 'orphan' } }); await flush(); await flush();
  assert.equal(h.requests.find(message => message.action === 'cancel')?.id, 'orphan');
  assert.equal(h.requests.some(message => message.action === 'upload'), false);
  assert.equal(h.api.hasTrack, false);
});

test('navigation during an upload stops further chunks and persists its cancelled state', async () => {
  let transferred;
  const h = harness({ send: message => message.action === 'upload' ? new Promise(resolve => { transferred = resolve; })
    : { success: true, data: message.action === 'create' ? { id: 'partial' } : { ready: true } } });
  await flush(); await h.choose();
  h.context.location.href = 'https://www.bilibili.com/video/BV2other/'; h.api.observe(h.video);
  transferred({ success: true, data: { received: 262144 } });
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(h.requests.filter(message => message.action === 'upload').length, 1);
  assert.equal(h.requests.find(message => message.action === 'cancel')?.id, 'partial');
  assert.equal(h.saved().job.state, 'cancelled');
  assert.equal(h.api.hasTrack, false);
});

test('failed upload cancels partial media and leaves the importer ready to retry', async () => {
  const h = harness({ send: async message => message.action === 'upload' ? { success: false, error: 'Upload failed' }
    : { success: true, data: message.action === 'create' ? { id: 'failed' } : { ready: true } } });
  await flush(); await h.choose(100);
  assert.equal(h.requests.find(message => message.action === 'cancel')?.id, 'failed');
  assert.equal(h.saved().job.state, 'error');
  assert.equal(h.button('Import video / audio').disabled, false);
  assert.match(h.status(), /Upload failed/);
});

test('no-speech completion becomes a saved retriable failure', async () => {
  const h = harness({ documents: [track({ cues: [], job: { id: 'silent', state: 'transcribing' } })],
    send: async () => ({ success: true, data: { state: 'complete', cues: [] } }) });
  await flush(); await flush();
  assert.equal(h.saved().job.state, 'error');
  assert.match(h.status(), /No Japanese speech/);
  assert.equal(h.button('Import video / audio').disabled, false);
});

test('an unavailable helper has a visible recovery path that frees the import control', async () => {
  const h = harness({ documents: [track({ cues: [], job: { id: 'missing', state: 'queued' } })],
    send: async () => ({ success: false, error: 'Local helper is unavailable' }) });
  await flush();
  assert.match(h.status(), /Start the local helper/);
  assert.equal(h.button('Discard pending import').hidden, false);
  await h.button('Discard pending import').click();
  assert.equal(h.saved().job, null);
  assert.equal(h.button('Import video / audio').disabled, false);
  assert.match(h.status(), /could not confirm cancellation/);
});

test('simultaneous tabs save different documents without losing either update', async () => {
  const otherKey = 'bilibili:BV2other:p1';
  const sharedStorage = { [storagePrefix + key]: track(), [storagePrefix + otherKey]: track({ key: otherKey }) };
  const first = harness({ sharedStorage });
  const second = harness({ sharedStorage, href: 'https://www.bilibili.com/video/BV2other/' });
  await flush();
  first.number().value = '1'; second.number().value = '2';
  await Promise.all([first.number().handlers.change(), second.number().handlers.change()]);
  assert.equal(sharedStorage[storagePrefix + key].offset, 1);
  assert.equal(sharedStorage[storagePrefix + otherKey].offset, 2);
});

test('legacy documents load, migrate on edit, and stay deleted after a reload', async () => {
  const sharedStorage = { kageImportedTracksV1: [track()] };
  const first = harness({ sharedStorage }); await flush();
  assert.equal(first.api.hasTrack, true);
  first.number().value = '0.5'; await first.number().handlers.change();
  assert.equal(first.saved().offset, 0.5);
  await first.button('Remove saved subtitles').click();
  const reopened = harness({ sharedStorage }); await flush();
  assert.equal(reopened.api.hasTrack, false);
});

test('Chinese source joins overlapping cues only when every active cue has a translation', async () => {
  const cues = [{ start: 0, end: 2, text: '今日は', translation: '今天' }, { start: 1, end: 3, text: '晴れです', translation: '天氣晴朗' }];
  const h = harness({ documents: [track({ cues })] }); await flush();
  assert.equal(h.api.chinese(h.video).available, true);
  assert.equal(h.api.chinese(h.video).text, '今天 天氣晴朗');
  h.video.currentTime = 4;
  assert.equal(h.api.chinese(h.video).available, true, 'a completed track suppresses other subtitle sources during gaps');
  assert.equal(h.api.chinese(h.video).text, '');
  h.number().value = '2'; await h.number().handlers.change();
  h.video.currentTime = 2.5;
  assert.equal(h.api.chinese(h.video).text, '今天');
  assert.equal(h.saved().cues[1].translation, '天氣晴朗');
  const checkbox = h.elements.find(el => el.type === 'checkbox');
  checkbox.checked = false; await checkbox.handlers.change();
  assert.equal(h.api.chinese(h.video).available, false);

  const partial = harness({ documents: [track({ cues: [cues[0], { ...cues[1], translation: undefined }] })] }); await flush();
  assert.equal(partial.api.chinese(partial.video).available, false, 'do not silently omit an overlapping speaker');
  partial.video.currentTime = 0.5;
  assert.equal(partial.api.chinese(partial.video).text, '今天');
  partial.video.currentTime = 4;
  assert.equal(partial.api.chinese(partial.video).available, false);
});

test('translation progress saves partial cues and reconnects after a tab refresh without restarting the job', async () => {
  const cues = [{ start: 1, end: 2, text: '今日は', translation: '今天' }, { start: 3, end: 4, text: '晴れです' }];
  const sharedStorage = { [storagePrefix + key]: track({ cues: [], job: { id: 'translate', name: 'new.mp4', state: 'transcribing' } }) };
  const first = harness({ sharedStorage, send: async () => ({ success: true, data: { state: 'translating', cues, translationCompleted: 1, translationTotal: 2 } }) });
  await flush(); await flush();
  assert.match(first.status(), /Translating Traditional Chinese locally · 1 \/ 2 lines/);
  assert.equal(first.saved().job.state, 'translating');
  assert.equal(first.saved().cues[0].translation, '今天');
  assert.equal(first.api.preparingChinese, true);
  assert.equal(first.button('Import another video / audio').disabled, true);
  assert.equal(first.button('Edit line at playhead').disabled, true);
  assert.equal(first.elements.find(el => el.tag === 'progress').value, 0.5);
  assert.equal(first.timers.size, 1);
  const reopened = harness({ sharedStorage, send: async () => ({ success: true, data: { state: 'complete', cues: [cues[0], { ...cues[1], translation: '天氣晴朗' }] } }) });
  await flush(); await flush();
  assert.equal(reopened.requests[0].action, 'status');
  assert.equal(reopened.requests.some(message => message.action === 'start'), false);
  assert.equal(reopened.api.preparingChinese, false);
  assert.equal(reopened.saved().job, null);
  assert.equal(reopened.saved().cues[1].translation, '天氣晴朗');
  assert.match(reopened.status(), /Japanese and Traditional Chinese/);
});

test('translation failure preserves Japanese and partial Chinese and retry does not upload again', async () => {
  let attempts = 0;
  const cues = [{ start: 1, end: 2, text: '今日は', translation: '今天' }, { start: 3, end: 4, text: '晴れです' }];
  const h = harness({ documents: [track({ cues: [], job: { id: 'retry', state: 'translating' } })], send: async message => {
    if (message.action === 'start') { attempts++; return { success: true, data: { state: 'translating' } }; }
    return { success: true, data: attempts
      ? { state: 'complete', cues: [cues[0], { ...cues[1], translation: '天氣晴朗' }] }
      : { state: 'translation_error', message: 'Ollama is unavailable.', cues, translationCompleted: 1, translationTotal: 2 } };
  } });
  await flush(); await flush();
  assert.equal(h.api.current(h.video).text, '今日は');
  assert.equal(h.api.chinese(h.video).text, '今天');
  assert.equal(h.api.preparingChinese, false);
  assert.equal(h.saved().job.state, 'translation_error');
  assert.equal(h.button('Import another video / audio').disabled, false);
  assert.equal(h.button('Retry Chinese translations').hidden, false);
  assert.match(h.status(), /Japanese subtitles saved.*Ollama is unavailable/);
  await h.button('Retry Chinese translations').click();
  assert.equal(h.saved().job, null);
  assert.equal(h.saved().cues[1].translation, '天氣晴朗');
  assert.equal(h.requests.filter(message => message.action === 'start').length, 1);
  assert.equal(h.requests.some(message => ['upload', 'create'].includes(message.action)), false);
});

test('restored translation errors retain a clear retry action and failed retries preserve subtitles', async () => {
  const h = harness({ documents: [track({ job: { id: 'retry', state: 'translation_error', message: 'Ollama stopped.' } })],
    send: async () => ({ success: false, error: 'Local helper is unavailable' }) });
  await flush();
  assert.equal(h.requests.length, 0);
  assert.match(h.status(), /Ollama stopped.*Retry Chinese translations/);
  assert.equal(h.button('Retry Chinese translations').hidden, false);
  await h.button('Retry Chinese translations').click();
  assert.equal(h.saved().job.state, 'translation_error');
  assert.equal(h.api.current(h.video).text, 'こんにちは');
  assert.equal(h.button('Retry Chinese translations').hidden, false);
  assert.match(h.status(), /Local helper is unavailable/);
});

test('editing Japanese invalidates only its Chinese while timing-only edits preserve translations', async () => {
  const h = harness({ documents: [track({ cues: [{ start: 1, end: 2, text: 'こんにちは', translation: '你好' }, { start: 3, end: 4, text: 'またね', translation: '再見' }] })] }); await flush();
  h.button('Edit line at playhead').click();
  const numberInputs = h.elements.filter(el => el.type === 'number');
  numberInputs[1].value = '1.25'; numberInputs[2].value = '2.5';
  await h.button('Save correction').click();
  assert.equal(h.api.chinese(h.video).text, '你好');
  h.button('Edit line at playhead').click();
  h.elements.find(el => el.tag === 'textarea').value = 'こんばんは';
  await h.button('Save correction').click();
  assert.equal(h.api.chinese(h.video).available, false);
  assert.equal(h.saved().cues[0].translation, undefined);
  assert.equal(h.saved().cues[1].translation, '再見');
});

test('oversized Chinese text is rejected before saving an imported track', async () => {
  const h = harness({ documents: [track({ cues: [], job: { id: 'large', state: 'translating' } })],
    send: async () => ({ success: true, data: { state: 'complete', cues: [{ start: 0, end: 3, text: '日本語です', translation: '文'.repeat(8001) }] } }) });
  await flush(); await flush();
  assert.equal(h.saved().job.state, 'error');
  assert.equal(h.saved().cues.length, 0);
  assert.match(h.status(), /too large to save/);
});

test('translation state changes notify the overlay even when subtitle cues are unchanged', async () => {
  let resolveStatus, rejectStart;
  const saved = track({ job: { id: 'state-transition', state: 'translating' } });
  const h = harness({ documents: [saved], send: message => message.action === 'status'
    ? new Promise(resolve => { resolveStatus = resolve; })
    : new Promise(resolve => { rejectStart = resolve; }) });
  await flush();
  const beforeFailure = h.events.length;
  resolveStatus({ success: true, data: { state: 'translation_error', cues: saved.cues, message: 'Ollama stopped.' } });
  await flush(); await flush();
  assert.equal(h.api.preparingChinese, false);
  assert.equal(h.events.length, beforeFailure + 1, 'enable foreground fallback after Chinese preparation fails');
  const retry = h.button('Retry Chinese translations').click();
  assert.equal(h.api.preparingChinese, true);
  assert.equal(h.events.length, beforeFailure + 2, 'cancel duplicate work when Chinese preparation resumes');
  rejectStart({ success: false, error: 'Local helper is unavailable' });
  await retry;
  assert.equal(h.api.preparingChinese, false);
  assert.equal(h.events.length, beforeFailure + 3, 'restore fallback after a failed restart');
});

test('disabling imported subtitles during translation stays disabled after the next progress update', async () => {
  const cues = [{ start: 1, end: 2, text: 'こんにちは', translation: '你好' }, { start: 3, end: 4, text: 'またね' }];
  const h = harness({ documents: [track({ cues, job: { id: 'progress', state: 'translating', cuesSaved: true } })],
    send: async () => ({ success: true, data: { state: 'translating', cues, translationCompleted: 1, translationTotal: 2 } }) });
  await flush(); await flush();
  const checkbox = h.elements.find(el => el.type === 'checkbox');
  checkbox.checked = false; await checkbox.handlers.change();
  const nextPoll = [...h.timers.values()][0]; nextPoll(); await flush(); await flush();
  assert.equal(h.api.enabled, false);
  assert.equal(h.saved().enabled, false);
  assert.equal(h.api.chinese(h.video).available, false);
});

test('correcting Japanese after a translation failure detaches the stale helper transcript', async () => {
  const h = harness({ documents: [track({ job: { id: 'stale', state: 'translation_error' }, cues: [
    { start: 1, end: 2, text: 'こんにちは', translation: '你好' }, { start: 3, end: 4, text: 'またね', translation: '再見' }
  ] })] }); await flush();
  h.button('Edit line at playhead').click();
  h.elements.find(el => el.tag === 'textarea').value = 'こんばんは';
  await h.button('Save correction').click();
  assert.equal(h.saved().job, null);
  assert.equal(h.saved().cues[0].text, 'こんばんは');
  assert.equal(h.saved().cues[0].translation, undefined);
  assert.equal(h.saved().cues[1].translation, '再見');
  assert.equal(h.button('Retry Chinese translations').hidden, true);
  assert.match(h.status(), /edited text will use your local model/);
  await h.button('Retry Chinese translations').click();
  assert.equal(h.requests.some(message => message.action === 'start'), false);
});

test('timing corrections detach a failed helper job while preserving valid Chinese', async () => {
  const h = harness({ documents: [track({ job: { id: 'stale', state: 'translation_error' }, cues: [
    { start: 1, end: 2, text: 'こんにちは', translation: '你好' }
  ] })] }); await flush();
  h.button('Edit line at playhead').click();
  h.elements.filter(el => el.type === 'number')[2].value = '2.5';
  await h.button('Save correction').click();
  assert.equal(h.saved().job, null);
  assert.equal(h.saved().cues[0].end, 2.5);
  assert.equal(h.saved().cues[0].translation, '你好');
});

test('a saved editor cannot change a cue while an import is active', async () => {
  let releaseHealth;
  const h = harness({ documents: [track()], send: message => message.action === 'health'
    ? new Promise(resolve => { releaseHealth = resolve; })
    : { success: false, error: 'Stop before upload' } }); await flush();
  h.button('Edit line at playhead').click();
  h.elements.find(el => el.tag === 'textarea').value = '変更';
  await h.choose(1);
  await h.button('Save correction').click();
  assert.equal(h.api.current(h.video).text, 'こんにちは');
  releaseHealth({ success: false, error: 'Stop before upload' });
  await flush();
});

test('one-click Bilibili download skips file upload, persists its job, and saves both subtitle languages', async () => {
  let state = 'downloading';
  const h = harness({ send: async message => ({ success: true, data:
    message.action === 'health' ? { ready: true } : message.action === 'download' ? { id: 'download-job' }
    : message.action === 'status' ? { state, progress: 0.5, cues: state === 'complete' ? [{ start: 1, end: 2, text: 'はい', translation: '是' }] : undefined }
    : { state: 'queued' } }) });
  await flush();
  await h.button('Download audio & prepare subtitles').click();
  assert.deepEqual(h.requests.map(item => item.action), ['health', 'download', 'start', 'status']);
  assert.equal(h.saved().job.id, 'download-job');
  assert.match(h.status(), /Connecting to Bilibili audio/);
  assert.equal(h.file().disabled, true);
  assert.equal(h.button('Download audio & prepare subtitles').disabled, true);
  state = 'complete';
  await h.button('Reconnect').click(); await flush();
  assert.equal(h.saved().job, null);
  assert.equal(h.api.chinese(h.video).text, '是');
});

test('reopening a page reconnects a download and cancellation restores import controls', async () => {
  const h = harness({ documents: [track({ job: { id: 'downloading-job', state: 'downloading' } })],
    send: async message => ({ success: true, data: { state: message.action === 'cancel' ? 'cancelled' : 'downloading', progress: 0.2 } }) });
  await flush();
  assert.equal(h.requests[0].action, 'status');
  assert.match(h.status(), /Connecting to Bilibili audio/);
  await h.button('Stop processing').click();
  assert.equal(h.saved().job, null);
  assert.equal(h.button('Download audio & prepare subtitles').disabled, false);
});

test('download creation that finishes after navigation cancels the orphaned job', async () => {
  let finish;
  const h = harness({ send: message => message.action === 'download' ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve({ success: true, data: { ready: true } }) });
  await flush();
  const pending = h.button('Download audio & prepare subtitles').click();
  await flush();
  h.context.location.href = 'https://www.bilibili.com/video/BVother/'; h.api.observe(h.video);
  finish({ success: true, data: { id: 'orphan-job' } });
  await pending;
  assert.equal(h.requests.some(item => item.action === 'start'), false);
  assert.ok(h.requests.some(item => item.action === 'cancel' && item.id === 'orphan-job'));
});

test('progressive subtitles are usable before completion and ready Chinese prevents duplicate inference', async () => {
  const h = harness({ documents: [track({ cues: [], job: { id: 'progressive', state: 'preparing' } })],
    send: async () => ({success:true,data:{state:'preparing',transcriptionComplete:false,processedThrough:60,duration:120,
      cues:[{start:1,end:2,text:'はい',translation:'是'}],translationCompleted:1,translationTotal:1}}) });
  await flush(); await flush();
  assert.equal(h.api.current(h.video).text, 'はい');
  assert.equal(h.api.chinese(h.video).text, '是');
  assert.equal(h.api.preparingChinese, true);
  assert.match(h.status(), /Japanese through 1:00/);
  assert.equal(h.button('Download audio & prepare subtitles').disabled, true);
});

test('silent first sections keep polling and stream errors retain the prepared part', async () => {
  let state = 'preparing';
  const h = harness({ documents: [track({ cues:[],job:{id:'progressive',state:'preparing'} })],
    send:async()=>({success:true,data:{state,transcriptionComplete:false,processedThrough:60,
      message: state==='error' ? 'Audio download stopped.' : '',
      cues:state==='error' ? [{start:1,end:2,text:'はい',translation:'是'}] : []}}) });
  await flush(); await flush();
  assert.equal(h.saved().job.state, 'preparing');
  assert.ok(h.timers.size > 0);
  state='error';
  await h.button('Reconnect').click(); await flush();
  assert.equal(h.api.current(h.video).text, 'はい');
  assert.match(h.status(), /Download or import again/);
  assert.equal(h.button('Download audio & prepare subtitles').disabled, false);
});

test('queue-full errors open the video queue and do not suggest reinstalling the helper', async () => {
  const h = harness({ send: async message => message.action === 'create'
    ? { success: false, error: 'The video queue has four active jobs. Open Video queue to stop a job.' }
    : { success: true, data: message.action === 'list' ? { limit: 4, jobs: [{ id: 'other', name: 'Other video', state: 'queued', queuePosition: 1 }] } : { ready: true } } });
  await flush(); await h.choose(10);
  assert.match(h.status(), /four active jobs/);
  assert.doesNotMatch(h.status(), /npm|Setup:|Start:/);
  assert.equal(h.elements.find(el => el.className === 'kage-import-queue').open, true);
  assert.ok(h.button('Stop'));
  assert.ok(h.requests.some(message => message.action === 'list'));
});

test('global queue can stop another video and refresh without touching the current saved track', async () => {
  let stopped = false;
  const h = harness({ documents: [track()], send: async message => {
    if (message.action === 'cancel') { assert.equal(message.id, 'other-video'); stopped = true; return { success: true, data: { state: 'cancelled' } }; }
    return { success: true, data: { limit: 4, jobs: stopped ? [] : [{ id: 'other-video', name: 'Another video', state: 'preparing', progress: .4 }] } };
  } });
  await flush();
  const queue = h.elements.find(el => el.className === 'kage-import-queue');
  queue.open = true; queue.handlers.toggle(); await flush();
  await h.button('Stop').click();
  assert.equal(stopped, true);
  assert.equal(h.saved().name, 'lesson.mp4');
  assert.equal(h.saved().cues.length, 2);
  assert.match(h.elements.find(el => el.className === 'kage-import-hint' && el.textContent.startsWith('No active')).textContent, /helper is running/);
});

test('Stop keeps the latest partial subtitles returned by the helper', async () => {
  const cues = [{ start: 0, end: 2, text: '保存済み', translation: '已保存' }];
  const h = harness({ documents: [track({ job: { id: 'active', state: 'preparing' } })], send: async message => ({ success: true,
    data: message.action === 'cancel' ? { state: 'cancelled', cues } : { state: 'preparing', cues: [], progress: .1 } }) });
  await flush(); await h.button('Stop processing').click();
  assert.equal(h.saved().job, null);
  assert.equal(h.saved().cues[0].text, '保存済み');
  assert.equal(h.saved().cues[0].translation, '已保存');
});

test('reopening a closed tab restores both languages and timing edits do not extend expiry', async () => {
  const expiry = Date.now() + 86400000;
  const first = harness({ documents: [track({ expiresAt: expiry, cues: [{ start: 1, end: 2, text: 'こんにちは', translation: '你好' }] })] });
  await flush();
  const offset = first.number(); offset.value = '0.1'; await offset.handlers.change();
  const reopened = harness({ sharedStorage: first.storage }); await flush();
  assert.equal(reopened.api.current(reopened.video).text, 'こんにちは');
  assert.equal(reopened.api.chinese(reopened.video).text, '你好');
  assert.equal(reopened.saved().expiresAt, expiry);
  assert.equal(reopened.saved().offset, 0.1);
  assert.equal(reopened.requests.length, 0, 'saved playback needs no running helper');
});

test('expired subtitles cannot load from either current or legacy storage', async () => {
  for (const legacy of [false, true]) {
    const old = track({ updatedAt: Date.now() - 3 * 86400000 - 1 });
    const storage = { kageImportedTracksV1: [old], ...(!legacy ? { [storagePrefix + key]: old } : {}) };
    const h = harness({ sharedStorage: storage }); await flush(); await flush();
    assert.equal(h.api.hasTrack, false);
    assert.match(h.status(), /expired after 3 days/);
    const reopened = harness({ sharedStorage: storage }); await flush();
    assert.equal(reopened.api.hasTrack, false, 'legacy data cannot resurrect expired subtitles');
  }
});

test('a tab left open stops displaying subtitles at their deadline', async () => {
  let now = Date.now();
  const h = harness({ now: () => now, documents: [track({ expiresAt: now + 100 })] }); await flush();
  assert.equal(h.api.hasTrack, true);
  now += 100;
  assert.equal(h.api.current(h.video), null);
  await flush();
  assert.equal(h.saved(), undefined);
});

test('reconnecting a completed job keeps the helper deadline instead of starting another three days', async () => {
  const expiry = Date.now() + 86400000;
  const h = harness({ documents: [track({ job: { id: 'pending', state: 'transcribing' } })],
    send: async () => ({ success: true, data: { state: 'complete', expiresAt: expiry, cues: track().cues } }) });
  await flush(); await flush();
  assert.equal(h.saved().job, null);
  assert.equal(h.saved().expiresAt, expiry);
});

test('the queue is expanded by default, orders running videos first, and labels the current waiting video', async () => {
  const h = harness({ documents: [track({ job: { id: 'mine', state: 'queued' } })], send: async message => ({ success: true, data:
    message.action === 'status' ? { state: 'queued', queuePosition: 2, progress: 0 }
      : { limit: 4, concurrency: 2, jobs: [
        { id: 'mine', name: 'My video', state: 'queued', queuePosition: 2 },
        { id: 'first', name: 'First video', state: 'queued', queuePosition: 1 },
        { id: 'running', name: 'Running video', state: 'transcribing', progress: .25, sourceUrl: 'https://www.bilibili.com/video/BVrunning' },
      ] } }) });
  await flush();
  assert.match(h.status(), /Queued · position 2.*Waiting/);
  assert.equal(h.elements.find(el => el.tag === 'progress').hidden, true);
  const queue = h.elements.find(el => el.className === 'kage-import-queue');
  assert.equal(queue.open, true);
  queue.handlers.toggle(); await flush();
  const rows = h.elements.find(el => el.className === 'kage-queue-jobs').children;
  assert.deepEqual(rows.map(row => row.children[0].textContent), ['Running video', 'First video', 'My video · This video']);
  assert.equal(rows[0].children[1].textContent, 'Transcribing Japanese · 25%');
  assert.equal(rows[1].children[1].textContent, 'Queued · position 1');
  assert.equal(rows[0].children.find(el => el.tag === 'a').href, 'https://www.bilibili.com/video/BVrunning');
  assert.match(queue.children[1].textContent, /1 processing · 2 waiting · up to 2 videos process at once/);
});

test('processing timings survive completion and reopening the video without exposing old job controls', async () => {
  const timings = { processingMs: 90000, recognitionMs: 65000, translationMs: 80000, translationQueueMs: 10000,
    translationRequests: 3, translationRetries: 0, batchSize: 8 };
  const h = harness({ documents: [track({ job: { id: 'timed-job', state: 'transcribing' } })],
    send: async () => ({ success: true, data: { state: 'complete', timings, cues: track().cues } }) });
  await flush(); await flush();
  assert.equal(h.saved().timings.processingMs, 90000);
  assert.equal(h.saved().job, null);
  const reopened = harness({ sharedStorage: h.storage }); await flush();
  const details = reopened.elements.find(el => el.className === 'kage-import-timings');
  assert.equal(details.hidden, false);
  assert.match(details.children[1].textContent, /Japanese recognition: 1m 5s/);
  assert.match(details.children[2].textContent, /3 translation requests · 0 retries · up to 8 lines/);
  assert.match(details.children[3].textContent, /Stages overlap/);
  assert.equal(reopened.requests.length, 0);
});
