import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../background/service_worker.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const response = content => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) });
function translation(body) {
  const text = body.messages[1].content;
  if (text.startsWith('[')) return { translations: JSON.parse(text).map(({ id, text }) => ({ id, sentence_translation: `翻譯 ${text}` })).reverse() };
  return { sentence_translation: `翻譯 ${text}` };
}
function harness(fetch, state = {}) {
  let listener, onChanged;
  const notifications = [];
  const event = { addListener() {} };
  const context = vm.createContext({ URL, AbortSignal, AbortController, fetch, chrome: {
    action: { onClicked: event }, tabs: { onRemoved: event, sendMessage: async (tabId, message) => { notifications.push({ tabId, ...plain(message) }); } },
    storage: { local: { get: async () => state, set: async values => Object.assign(state, values) }, onChanged: { addListener: fn => { onChanged = fn; } } },
    runtime: { onInstalled: event, onMessage: { addListener: fn => { listener = fn; } } }
  } });
  vm.runInContext(source, context);
  return { state, notifications, context,
    send(message, tabId = 1) { return new Promise(resolve => { if (!listener(message, { tab: { id: tabId } }, resolve)) resolve(); }); },
    change(values) { const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])); Object.assign(state, values); onChanged(changes, 'local'); }
  };
}
function controlled(state) {
  const calls = [];
  let active = 0, maxActive = 0;
  const h = harness((url, options) => new Promise((resolve, reject) => {
    const body = JSON.parse(options.body);
    active++; maxActive = Math.max(active, maxActive);
    let done = false;
    const call = { url, body, signal: options.signal, finish(content = translation(body)) {
      if (done) return;
      done = true; active--; resolve(response(content));
    } };
    options.signal.addEventListener('abort', () => { if (!done) { done = true; active--; reject(options.signal.reason); } }, { once: true });
    calls.push(call);
  }), state);
  return { ...h, calls, maxActive: () => maxActive };
}
const prepare = (texts, context = 'page:1') => ({ type: 'PREPARE_SUBTITLES', texts, context });
const current = (text, context = 'page:1') => ({ type: 'PROCESS_SUBTITLE', text, context });

test('four prepared lines use one inference, retain ID alignment, push to the tab, and survive restart', async () => {
  const calls = [];
  const fetch = async (url, options) => { calls.push(url); return response(translation(JSON.parse(options.body))); };
  const h = harness(fetch);
  const result = await h.send(prepare(['字幕0', '字幕1', '字幕2', '字幕3']));
  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(result.results.map(r => r.data.sentence_translation)), ['翻譯 字幕0', '翻譯 字幕1', '翻譯 字幕2', '翻譯 字幕3']);
  assert.equal(h.notifications[0].context, 'page:1');
  assert.equal(h.notifications[0].results.length, 4);
  await h.send(current('字幕2'));
  const restarted = harness(fetch, h.state);
  await restarted.send(current('字幕3'));
  assert.equal(calls.length, 1);
});

test('rolling lookahead translates eight lines in two batches and publishes cached hits too', async () => {
  let calls = 0;
  const h = harness(async (_, options) => { calls++; return response(translation(JSON.parse(options.body))); });
  const texts = Array.from({ length: 8 }, (_, n) => `字幕${n}`);
  await h.send({ type: 'PRELOAD_TRACK', texts, context: 'page:1' }); await flush();
  assert.equal(calls, 2);
  assert.equal(h.notifications.flatMap(n => n.results).length, 8);
  await h.send({ type: 'PRELOAD_TRACK', texts, context: 'page:1' }); await flush();
  assert.equal(calls, 2);
  assert.equal(h.notifications.length, 4);
});

test('a foreground line already in the active batch shares it without aborting or duplicate inference', async () => {
  const h = controlled();
  const preparation = h.send(prepare(['字幕0', '字幕1'])); await flush();
  const foreground = h.send(current('字幕1')); await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, false);
  h.calls[0].finish();
  assert.equal((await preparation).success, true);
  assert.equal((await foreground).data.sentence_translation, '翻譯 字幕1');
});

test('unrelated foreground cancels a speculative batch, runs immediately, then preparation resumes locally', async () => {
  const h = controlled({ groqFallback: true, groqApiKey: 'test' });
  const preparation = h.send(prepare(['未来0', '未来1'])); await flush();
  const foreground = h.send(current('現在')); await flush();
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.calls[1].body.messages[1].content, '現在');
  h.calls[1].finish(); await flush();
  assert.equal((await foreground).success, true);
  assert.equal(h.calls.length, 3);
  h.calls[2].finish();
  assert.equal((await preparation).success, true);
  assert.ok(h.calls.every(c => c.url.startsWith('http://127.0.0.1:11434/')));
  assert.equal(h.maxActive(), 1);
});

test('obsolete foreground inference is aborted before the next caption starts', async () => {
  const h = controlled({ groqFallback: true, groqApiKey: 'test' });
  const old = h.send(current('古い')); await flush();
  const now = h.send(current('新しい')); await flush();
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal((await old).success, false);
  assert.equal(h.calls[1].body.messages[1].content, '新しい');
  h.calls[1].finish();
  assert.equal((await now).success, true);
  assert.equal(h.maxActive(), 1);
});

test('clearing a caption cancels its inference without a retry or cloud fallback', async () => {
  const h = controlled({ groqFallback: true, groqApiKey: 'test' });
  const request = h.send(current('字幕')); await flush();
  await h.send({ type: 'CLEAR_SUBTITLE', context: 'page:1' }); await flush();
  assert.equal((await request).success, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, true);
});

test('partial or duplicate batch IDs only retry missing lines and never misalign a translation', async () => {
  const bodies = [];
  const h = harness(async (_, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    return response(bodies.length === 1 ? { translations: [
      { id: 0, sentence_translation: '零' }, { id: 1, sentence_translation: 'wrong' }, { id: 1, sentence_translation: 'duplicate' }
    ] } : translation(body));
  });
  const result = await h.send(prepare(['字幕0', '字幕1', '字幕2']));
  assert.equal(result.success, true);
  assert.deepEqual(plain(result.results.map(r => r.data.sentence_translation)), ['零', '翻譯 字幕1', '翻譯 字幕2']);
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies.slice(1).map(b => b.messages[1].content), ['字幕1', '字幕2']);
  await h.send(prepare(['字幕3', '字幕4']));
  assert.deepEqual(bodies.slice(3).map(b => b.messages[1].content), ['字幕3', '字幕4']);
});

test('transport failures are not retried as model-format failures', async () => {
  for (const message of [current('字幕'), prepare(['字幕0', '字幕1'])]) {
    let calls = 0;
    const h = harness(async () => { calls++; throw new Error('offline'); });
    assert.equal((await h.send(message)).success, false);
    assert.equal(calls, 1);
  }
});

test('disabled extension cancels manual preparation without its retry loop starting more requests', async () => {
  const h = controlled();
  const work = h.send(prepare(['字幕0', '字幕1'])); await flush();
  h.change({ enabled: false }); await flush();
  assert.equal((await work).success, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.notifications.length, 0);
});

test('provider changes cancel old work and only cache results from the new settings', async () => {
  const h = controlled({ gemmaRestoredV1: true, apiModel: 'first' });
  const old = h.send(prepare(['字幕0', '字幕1'])); await flush();
  h.change({ apiModel: 'second' }); await flush();
  assert.equal((await old).success, false);
  const fresh = h.send(current('字幕0', 'page:2')); await flush();
  assert.equal(h.calls[1].body.model, 'second');
  h.calls[1].finish();
  assert.equal((await fresh).success, true);
  assert.equal(h.state.subtitleCacheV2.length, 1);
  assert.match(h.state.subtitleCacheV2[0][0], /second/);
});

test('seek or navigation cancels old preparation and cannot send stale ready notifications', async () => {
  const h = controlled();
  const old = h.send(prepare(['字幕0', '字幕1'], 'page:1')); await flush();
  await h.send({ type: 'PRELOAD_TRACK', texts: [], context: 'page:2' }); await flush();
  assert.equal((await old).success, false);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.notifications.length, 0);
});

test('clearing rolling work prevents its cancelled batch from requeueing', async () => {
  const h = controlled();
  await h.send({ type: 'PRELOAD_TRACK', texts: ['字幕0', '字幕1'], context: 'page:1' }); await flush();
  await h.send({ type: 'CLEAR_PREFETCH' }); await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.notifications.length, 0);
});

test('a shared foreground request remains alive while another tab still needs it', async () => {
  const h = controlled();
  const first = h.send(current('字幕', 'tab1'), 1); await flush();
  const second = h.send(current('字幕', 'tab2'), 2); await flush();
  await h.send({ type: 'CLEAR_SUBTITLE', context: 'tab1' }, 1); await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, false);
  h.calls[0].finish();
  assert.equal((await first).success, true);
  assert.equal((await second).success, true);
});

test('a cached foreground line does not cancel useful unrelated preloading', async () => {
  const h = controlled();
  const saved = h.send(current('保存')); await flush(); h.calls[0].finish(); await saved;
  const preparation = h.send(prepare(['未来0', '未来1'])); await flush();
  assert.equal((await h.send(current('保存'))).success, true);
  assert.equal(h.calls[1].signal.aborted, false);
  h.calls[1].finish(); await preparation;
});
