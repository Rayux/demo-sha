import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const flush = () => new Promise(resolve => setImmediate(resolve));
function event() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) };
}
function harness(fetch, saved = {}) {
  const onConnect = event(), onMessage = event();
  const state = { gemmaRestoredV1: true, ...saved };
  const context = vm.createContext({ URL, AbortController, AbortSignal, TextDecoder, fetch, chrome: {
    runtime: { onConnect, onMessage, onInstalled: event() },
    tabs: { onRemoved: event(), sendMessage: async () => {} }, action: { onClicked: event() },
    storage: { local: { get: async () => state, set: async values => Object.assign(state, values) }, onChanged: event() }
  } });
  vm.runInContext(readFileSync(new URL('../background/service_worker.js', import.meta.url), 'utf8'), context);
  return {
    context,
    send: message => new Promise(resolve => onMessage.emit(message, { tab: { id: 1 } }, resolve)),
    connect() {
      const port = { name: 'kage-tutor', sender: { tab: { id: 1 } }, onMessage: event(), onDisconnect: event(), received: [], postMessage(value) { this.received.push(value); } };
      onConnect.emit(port); return port;
    }
  };
}
const ask = { type: 'ASK_AI', sentence: '今日はいい天気ですね。', question: 'ですね？', localOnly: true };
const sse = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`;

test('streams split UTF-8/SSE events before completion and preserves local-only routing', async () => {
  let controller, request;
  const h = harness(async (url, options) => {
    request = { url, ...options };
    return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }, { groqFallback: true, groqApiKey: 'fixture' });
  const port = h.connect(); port.onMessage.emit(ask); await flush();
  assert.equal(JSON.parse(request.body).stream, true);
  assert.equal(request.redirect, 'error');
  assert.ok(request.url.startsWith('http://127.0.0.1:11434/'));
  const bytes = new TextEncoder().encode(sse('確認語氣'));
  for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
  await flush();
  assert.equal(port.received.length, 1);
  assert.equal(port.received[0].answer, '確認語氣');
  assert.equal(port.received[0].type, 'delta');
  controller.enqueue(new TextEncoder().encode(sse('。') + 'data: [DONE]\n\n'));
  await flush();
  assert.equal(port.received.at(-1).type, 'done');
  assert.equal(port.received.at(-1).answer, '確認語氣。');
});

test('disconnect interrupts generation, permits a new question and never invokes cloud fallback', async () => {
  const calls = [];
  const h = harness((url, options) => new Promise((resolve, reject) => {
    calls.push({ url, ...options, resolve });
    options.signal.addEventListener('abort', () => reject(options.signal.reason));
  }), { groqFallback: true, groqApiKey: 'fixture' });
  const old = h.connect(); old.onMessage.emit({ ...ask, localOnly: false }); await flush();
  old.onDisconnect.emit();
  const next = h.connect(); next.onMessage.emit(ask); await flush();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls.length, 2);
  assert.equal(old.received.length, 0);
  calls[1].resolve(Response.json({ choices: [{ message: { content: '回答' } }] })); await flush();
  assert.equal(next.received.at(-1).type, 'done');
  assert.ok(calls.every(call => call.url.startsWith('http://127.0.0.1:11434/')));
});

test('partial stream failures retain the answer and do not start a cloud answer', async () => {
  let controller, calls = 0;
  const h = harness(async () => {
    calls++;
    return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }, { groqFallback: true, groqApiKey: 'fixture' });
  const port = h.connect(); port.onMessage.emit({ ...ask, localOnly: false }); await flush();
  controller.enqueue(new TextEncoder().encode(sse('部分回答'))); await flush(); controller.close(); await flush();
  assert.equal(calls, 1);
  assert.equal(port.received[0].answer, '部分回答');
  assert.equal(port.received.at(-1).type, 'error');
});

test('tutor preempts speculative preparation, which resumes after the answer', async () => {
  const calls = [];
  const h = harness((url, options) => new Promise((resolve, reject) => {
    calls.push({ ...options, body: JSON.parse(options.body), resolve });
    options.signal.addEventListener('abort', () => reject(options.signal.reason));
  }));
  const preparation = h.send({ type: 'PREPARE_SUBTITLES', texts: ['字幕1', '字幕2'], context: 'page:1' }); await flush();
  const port = h.connect(); port.onMessage.emit(ask); await flush();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].body.stream, true);
  calls[1].resolve(Response.json({ choices: [{ message: { content: '解釋' } }] })); await flush();
  assert.equal(calls.length, 3);
  calls[2].resolve(Response.json({ choices: [{ message: { content: JSON.stringify({ translations: [{ id: 0, sentence_translation: '一' }, { id: 1, sentence_translation: '二' }] }) } }] }));
  assert.equal((await preparation).success, true);
});

// Minimal DOM fixture exercises the actual panel event handlers and request lifecycle.
function panelHarness() {
  const nodes = new Map(), ports = [];
  function node() {
    return { dataset: {}, children: [], textContent: '', value: '', hidden: true, handlers: {},
      classList: { toggle() {}, add() {} },
      setAttribute() {}, removeAttribute() {}, focus() {}, remove() {},
      appendChild(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; },
      addEventListener(name, fn) { this.handlers[name] = fn; },
      querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); },
      querySelectorAll() { return []; }
    };
  }
  const context = vm.createContext({ document: { createElement: node, body: node(), addEventListener() {} }, chrome: {
    runtime: { connect() { const port = { onMessage: event(), onDisconnect: event(), disconnected: false,
      postMessage(message) { this.message = message; }, disconnect() { this.disconnected = true; this.onDisconnect.emit(); } }; ports.push(port); return port; } },
    storage: { local: { get: async () => ({}) }, onChanged: event() }
  } });
  vm.runInContext(readFileSync(new URL('../content/tutor.js', import.meta.url), 'utf8'), context);
  context.KageTutor.mount();
  const click = selector => nodes.get(selector).handlers.click();
  const update = text => context.KageTutor.update(text, { sentence_translation: text }, 'Imported', true);
  const submit = text => { nodes.get('#kageChatInput').value = text; nodes.get('form').handlers.submit({ preventDefault() {} }); };
  return { nodes, ports, click, update, submit, tutor: context.KageTutor };
}

test('panel auto-explains on open, pins its sentence through playback and switches explicitly', () => {
  const h = panelHarness(); h.update('最初'); h.click('.kage-launcher');
  assert.equal(h.ports.length, 1);
  assert.equal(h.ports[0].message.sentence, '最初');
  assert.equal(h.ports[0].message.localOnly, true);
  h.update('次の字幕'); h.tutor.clearCurrent(); h.update('第三');
  assert.equal(h.ports.length, 1);
  assert.equal(h.nodes.get('.kage-context-jp').textContent, '最初');
  h.click('#kageUseCurrent');
  assert.equal(h.ports[0].disconnected, true);
  assert.equal(h.ports[1].message.sentence, '第三');
});

test('typed questions interrupt automatic explanations; late chunks cannot overwrite new answers', () => {
  const h = panelHarness(); h.update('最初'); h.click('.kage-launcher');
  const old = h.ports[0]; old.onMessage.emit({ type: 'delta', answer: '部分解釋' });
  h.submit('助詞は？');
  assert.equal(old.disconnected, true);
  assert.equal(h.ports[1].message.question, '助詞は？');
  assert.equal(h.ports[1].message.sentence, '最初');
  const messages = h.nodes.get('#kageChatBody').children;
  const answer = messages.at(-1).children.at(-1);
  h.ports[1].onMessage.emit({ type: 'delta', answer: '助詞解釋' });
  old.onMessage.emit({ type: 'done', answer: 'STALE' });
  assert.equal(answer.textContent, '助詞解釋');
  h.ports[1].onMessage.emit({ type: 'done', answer: '助詞解釋完成' });
  assert.equal(answer.textContent, '助詞解釋完成');
  assert.equal(h.ports.length, 2);
});

test('closing stops unfinished work; reopening explains the current line without erasing a draft', () => {
  const h = panelHarness(); h.update('最初'); h.click('.kage-launcher');
  h.nodes.get('#kageChatInput').value = 'draft'; h.click('.kage-chat-close');
  assert.equal(h.ports[0].disconnected, true);
  h.update('次'); h.click('.kage-launcher');
  assert.equal(h.ports[1].message.sentence, '次');
  assert.equal(h.nodes.get('#kageChatInput').value, 'draft');
});
