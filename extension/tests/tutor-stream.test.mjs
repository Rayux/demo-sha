import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const flush = () => new Promise(resolve => setImmediate(resolve));
function event() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) };
}
function harness(fetch, saved = {}, now = Date.now) {
  const onConnect = event(), onMessage = event();
  const state = { gemmaRestoredV1: true, groqApiKey: 'fixture', ...saved };
  const context = vm.createContext({ URL, AbortController, AbortSignal, TextDecoder, Date: class extends Date { static now() { return now(); } }, fetch, chrome: {
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

test('streams split UTF-8/SSE events before completion using dedicated Groq routing', async () => {
  let controller, request;
  const h = harness(async (url, options) => {
    request = { url, ...options };
    return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }, { groqFallback: true, groqApiKey: 'fixture' });
  const port = h.connect(); port.onMessage.emit(ask); await flush();
  assert.equal(JSON.parse(request.body).stream, true);
  assert.equal(JSON.parse(request.body).model, 'openai/gpt-oss-120b');
  assert.equal(request.headers.Authorization, 'Bearer fixture');
  assert.ok(request.url.startsWith('https://api.groq.com/'));
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
  assert.ok(calls.every(call => call.url.startsWith('https://api.groq.com/')));
});

test('selected local-helper Groq route preserves tutor streaming without a browser Groq request', async () => {
  const h = harness(() => assert.fail('Browser Groq fetch must not run'), { groqConnection: 'helper' });
  let sent;
  h.context.KageGroqTransport = { fetch: async (payload, key, signal) => {
    sent = { payload, key, signal };
    return new Response(sse('解釋') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  } };
  const port = h.connect(); port.onMessage.emit(ask); await flush(); await flush();
  assert.equal(sent.payload.model, 'openai/gpt-oss-120b'); assert.equal(sent.key, 'fixture');
  assert.equal(port.received.at(-1).type, 'done'); assert.equal(port.received.at(-1).answer, '解釋');
  assert.equal(JSON.stringify(port.received).includes('fixture'), false);
});

const answerResponse = () => Response.json({ choices: [{ message: { content: '回答' } }] });
async function answer(h) {
  const port = h.connect(); port.onMessage.emit(ask); await flush(); await flush(); return port.received.at(-1);
}

test('automatic Groq routing uses the browser, remembers a working helper after 403, then rechecks the browser', async () => {
  let now = 1000, blocked = false;
  const calls = [];
  const h = harness(async () => { calls.push('browser'); return blocked ? new Response('', { status: 403 }) : answerResponse(); },
    { groqViaHelper: true }, () => now);
  h.context.KageGroqTransport = { fetch: async () => { calls.push('helper'); return answerResponse(); } };
  assert.equal((await answer(h)).type, 'done');
  blocked = true;
  assert.equal((await answer(h)).type, 'done');
  assert.equal((await answer(h)).type, 'done');
  assert.deepEqual(calls, ['browser', 'browser', 'helper', 'helper']);
  blocked = false; now += 120001;
  assert.equal((await answer(h)).type, 'done');
  assert.equal((await answer(h)).type, 'done');
  assert.deepEqual(calls.slice(-2), ['browser', 'browser']);
});

test('automatic Groq routing recovers through the browser when a remembered helper goes offline', async () => {
  let blocked = true, helperOnline = true;
  const calls = [];
  const h = harness(async () => { calls.push('browser'); return blocked ? new Response('', { status: 403 }) : answerResponse(); });
  h.context.KageGroqTransport = { fetch: async () => {
    calls.push('helper'); if (!helperOnline) throw new Error('Local helper unavailable'); return answerResponse();
  } };
  assert.equal((await answer(h)).type, 'done');
  blocked = false; helperOnline = false;
  assert.equal((await answer(h)).type, 'done');
  assert.equal((await answer(h)).type, 'done');
  assert.deepEqual(calls, ['browser', 'helper', 'helper', 'browser', 'browser']);
});

test('automatic Groq routing tries the helper on browser network failure', async () => {
  let helpers = 0;
  const h = harness(async () => { throw new TypeError('Failed to fetch'); });
  h.context.KageGroqTransport = { fetch: async () => { helpers++; return answerResponse(); } };
  assert.equal((await answer(h)).type, 'done'); assert.equal(helpers, 1);
});

test('automatic Groq routing does not retry account, rate limit, or provider server errors', async () => {
  for (const status of [401, 429, 500]) {
    let helpers = 0;
    const h = harness(async () => new Response('', { status }));
    h.context.KageGroqTransport = { fetch: async () => { helpers++; return answerResponse(); } };
    assert.equal((await answer(h)).type, 'error'); assert.equal(helpers, 0);
  }
});

test('automatic Groq routing does not loop when both routes are refused', async () => {
  const calls = [];
  const h = harness(async () => { calls.push('browser'); return new Response('', { status: 403 }); });
  h.context.KageGroqTransport = { fetch: async () => { calls.push('helper'); return Response.json({ error: 'Groq refused the request.' }, { status: 403 }); } };
  assert.equal((await answer(h)).type, 'error'); assert.deepEqual(calls, ['browser', 'helper']);
});

test('an explicit browser override disables automatic Groq fallback', async () => {
  const h = harness(async () => new Response('', { status: 403 }), { groqConnection: 'browser' });
  h.context.KageGroqTransport = { fetch: () => assert.fail('Explicit browser route must be respected') };
  assert.equal((await answer(h)).type, 'error');
});

test('stopping a browser request never starts the automatic Groq helper', async () => {
  let helpers = 0;
  const h = harness((url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))));
  h.context.KageGroqTransport = { fetch: async () => { helpers++; return answerResponse(); } };
  const port = h.connect(); port.onMessage.emit(ask); await flush(); port.onDisconnect.emit(); await flush();
  assert.equal(helpers, 0); assert.equal(port.received.length, 0);
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
function panelHarness({ saved = {}, getPosition, timers } = {}) {
  const nodes = new Map(), ports = [], writes = [];
  let root;
  const window = { innerWidth: 1000, innerHeight: 600, handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } };
  const documentHandlers = {};
  function node(tag = 'div') {
    return { tagName: tag.toUpperCase(), dataset: {}, children: [], value: '', hidden: true, handlers: {}, style: {},
      get textContent() { return this.children.map(child => child.textContent).join(''); },
      set textContent(value) { this.children = value ? [{ textContent: value }] : []; },
      classList: { toggle() {}, add() {}, remove() {} },
      getBoundingClientRect() { return { left: parseFloat(root?.style.left) || window.innerWidth - 120, top: parseFloat(root?.style.top) || 20, width: 100, height: 42 }; },
      setPointerCapture(id) { this.captured = id; }, hasPointerCapture(id) { return this.captured === id; }, releasePointerCapture() { this.captured = null; },
      setAttribute() {}, removeAttribute() {}, focus() {}, remove() {},
      appendChild(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; },
      addEventListener(name, fn) { this.handlers[name] = fn; },
      querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); },
      querySelectorAll() { return []; }
    };
  }
  const context = vm.createContext({ ...(timers || {}), window, document: { createTextNode: text => ({ textContent: text }), createElement(tag) { const el = node(tag); root ||= el; return el; }, body: node(), addEventListener(name, fn) { documentHandlers[name] = fn; } }, chrome: {
    runtime: { connect() { const port = { onMessage: event(), onDisconnect: event(), disconnected: false,
      postMessage(message) { this.message = message; }, disconnect() { this.disconnected = true; this.onDisconnect.emit(); } }; ports.push(port); return port; } },
    storage: { local: { get: async keys => keys === 'kageStudyPositionV1' && getPosition ? getPosition() : saved, set: async values => { Object.assign(saved, values); writes.push(values); } }, onChanged: event() }
  } });
  vm.runInContext(readFileSync(new URL('../content/tutor.js', import.meta.url), 'utf8'), context);
  context.KageTutor.mount();
  const click = selector => nodes.get(selector).handlers.click();
  const update = text => context.KageTutor.update(text, { sentence_translation: text }, 'Imported', true);
  const submit = text => { nodes.get('#kageChatInput').value = text; nodes.get('form').handlers.submit({ preventDefault() {} }); };
  return { nodes, ports, click, update, submit, context, tutor: context.KageTutor, root, window, documentHandlers, writes, saved,
    emit(name, fields = {}) {
      const event = { button: 0, isPrimary: true, pointerId: 1, clientX: 920, clientY: 40, detail: 1, preventDefault() {}, stopPropagation() {}, ...fields };
      nodes.get(fields.selector || '.kage-launcher').handlers[name](event);
    }
  };
}

test('panel auto-explains on open, pins its sentence through playback and switches explicitly', () => {
  const h = panelHarness(); h.update('最初'); h.click('.kage-launcher');
  assert.equal(h.ports.length, 1);
  assert.equal(h.ports[0].message.sentence, '最初');
  assert.equal(h.ports[0].message.provider, 'groq');
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

test('Study error badge opens subtitle controls without starting tutor inference', () => {
  const h = panelHarness(); h.update('字幕');
  assert.equal(h.nodes.get('.kage-launcher-badge').hidden, true);
  h.tutor.subtitleError('Translation failed. Retry Chinese translations.');
  assert.equal(h.nodes.get('.kage-launcher-badge').hidden, false);
  assert.match(h.nodes.get('.kage-launcher').title, /Translation failed/);
  h.click('.kage-launcher');
  h.update('次の字幕');
  assert.equal(h.ports.length, 0);
  h.tutor.subtitleError('');
  assert.equal(h.nodes.get('.kage-launcher-badge').hidden, true);
});

test('Study launcher drag preserves the grab point, saves once and does not open the panel', async () => {
  const h = panelHarness(); await flush(); h.update('字幕');
  h.emit('pointerdown');
  h.emit('pointermove', { clientX: 720, clientY: 240 });
  assert.equal(h.root.style.left, '680px');
  assert.equal(h.root.style.top, '220px');
  assert.equal(h.writes.length, 0);
  h.emit('pointerup'); h.emit('click');
  assert.equal(h.writes.length, 1);
  assert.equal(h.nodes.get('.kage-chat-panel').hidden, true);
  assert.equal(h.ports.length, 0);
  h.emit('pointerdown'); h.emit('pointerup'); h.emit('click');
  assert.equal(h.nodes.get('.kage-chat-panel').hidden, false);
  assert.equal(h.ports.length, 1);
});

test('Study launcher ignores other pointers and small movements remain clicks', () => {
  const h = panelHarness(); h.update('字幕');
  h.emit('pointerdown', { button: 2 }); h.emit('pointermove', { clientX: 100 });
  assert.equal(h.root.style.left, undefined);
  h.emit('pointerdown'); h.emit('pointermove', { pointerId: 2, clientX: 100 });
  h.emit('pointermove', { clientX: 922, clientY: 41 }); h.emit('pointerup'); h.emit('click');
  assert.equal(h.root.style.left, undefined);
  assert.equal(h.writes.length, 0);
  assert.equal(h.ports.length, 1);
});

test('Study launcher stays inside the viewport, restores on reload and scales through fullscreen', async () => {
  const h = panelHarness(); await flush();
  h.emit('pointerdown'); h.emit('pointermove', { clientX: -100, clientY: 900 }); h.emit('pointerup');
  assert.equal(h.root.style.left, '8px');
  assert.equal(h.root.style.top, '550px');
  const reopened = panelHarness({ saved: h.saved }); await flush();
  assert.equal(reopened.root.style.top, '550px');
  reopened.window.innerWidth = 500; reopened.window.innerHeight = 300;
  reopened.window.handlers.resize();
  assert.equal(reopened.root.style.top, '250px');
  reopened.window.innerHeight = 600;
  reopened.documentHandlers.fullscreenchange();
  assert.equal(reopened.root.style.top, '550px');
});

test('cancelled or lost pointer capture ends movement and keyboard activation still works', () => {
  for (const ending of ['pointercancel', 'lostpointercapture']) {
    const h = panelHarness();
    h.emit('pointerdown'); h.emit('pointermove', { clientX: 720 }); h.emit(ending);
    const left = h.root.style.left;
    h.emit('pointermove', { clientX: 200 });
    assert.equal(h.root.style.left, left);
    h.emit('click', { detail: 0 });
    assert.equal(h.nodes.get('.kage-chat-panel').hidden, false);
  }
});

test('a slow saved-position read cannot overwrite a new drag and Alt arrows move the button', async () => {
  let resolve;
  const h = panelHarness({ getPosition: () => new Promise(done => { resolve = done; }) });
  h.emit('pointerdown'); h.emit('pointermove', { clientX: 720 }); h.emit('pointerup');
  resolve({ kageStudyPositionV1: { x: 0, y: 0 } }); await flush();
  assert.equal(h.root.style.left, '680px');
  h.emit('keydown', { key: 'ArrowLeft', altKey: true });
  assert.equal(h.root.style.left, '670px');
  assert.equal(h.writes.length, 2);
});

function descendants(node, tag) {
  return (node.children || []).flatMap(child => [ ...(child.tagName === tag ? [child] : []), ...descendants(child, tag) ]);
}

test('streamed tutor Markdown formats bold, headings, lists and code without interpreting HTML', () => {
  const h = panelHarness(); h.update('字幕'); h.click('.kage-launcher');
  const answer = h.nodes.get('#kageChatBody').children.at(-1).children.at(-1);
  h.ports[0].onMessage.emit({ type: 'delta', answer: '**未完成' });
  assert.equal(answer.textContent, '**未完成');
  h.ports[0].onMessage.emit({ type: 'delta', answer: '### 文法\n**完成** 與 __語氣__\n\n- *柔和*\n- `**literal**`\n\n1. 練習\n2. 重複\n\n<script>alert(1)</script>\n\n```html\n<img src=x onerror=alert(1)>\n```' });
  assert.deepEqual(descendants(answer, 'STRONG').map(node => node.textContent), ['完成', '語氣']);
  assert.equal(descendants(answer, 'H4')[0].textContent, '文法');
  assert.equal(descendants(answer, 'LI').length, 4);
  assert.equal(descendants(answer, 'CODE')[0].textContent, '**literal**');
  assert.equal(descendants(answer, 'SCRIPT').length, 0);
  assert.equal(descendants(answer, 'IMG').length, 0);
  assert.match(answer.textContent, /<script>alert\(1\)<\/script>/);
  h.click('.kage-chat-close');
  assert.equal(descendants(answer, 'STRONG').length, 2);
  assert.match(answer.textContent, /Stopped\.$/);
});

test('completed and failed tutor responses retain formatting; questions remain literal text', () => {
  const h = panelHarness(); h.submit('**literal question**');
  const messages = h.nodes.get('#kageChatBody').children;
  assert.equal(messages[0].children.at(-1).textContent, '**literal question**');
  assert.equal(descendants(messages[0], 'STRONG').length, 0);
  h.ports[0].onMessage.emit({ type: 'delta', answer: '**部分**' });
  h.ports[0].onMessage.emit({ type: 'error', error: 'Connection lost' });
  assert.equal(descendants(messages[1], 'STRONG')[0].textContent, '部分');
  assert.match(messages[1].textContent, /Unable to answer/);
  h.submit('次');
  h.ports[1].onMessage.emit({ type: 'done', answer: '**完成**' });
  assert.equal(descendants(messages.at(-1), 'STRONG')[0].textContent, '完成');
});

test('download shortcut stays closed and disables during preparation; dragging never starts a job', () => {
  const h = panelHarness(); let downloads = 0;
  h.context.KageImport = { download() { downloads++; h.tutor.downloadState(true, true); } };
  h.update('字幕'); h.tutor.downloadState(true, false);
  const button = h.nodes.get('.kage-download-launcher');
  assert.equal(button.hidden, false); assert.equal(button.disabled, false);
  const selector = '.kage-download-launcher';
  h.emit('pointerdown', { selector }); h.emit('pointermove', { selector, clientX: 720 });
  h.emit('pointerup', { selector }); h.emit('click', { selector });
  assert.equal(downloads, 0);
  h.emit('click', { selector, detail: 0 });
  assert.equal(downloads, 1); assert.equal(h.ports.length, 0);
  assert.equal(h.nodes.get('.kage-chat-panel').hidden, true);
  assert.equal(button.disabled, true);
  h.tutor.downloadState(true, false); assert.equal(button.disabled, false);
  h.click('.kage-launcher');
  assert.equal(h.ports.length, 1);
  h.tutor.downloadState(false, false); assert.equal(button.hidden, true);
});

 test('tutor without a Groq key reports setup without contacting Gemma', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; }, { groqApiKey: '' });
  const result = await h.send(ask);
  assert.equal(calls, 0);
  assert.equal(result.success, false);
  assert.match(result.error, /Groq API key/);
});


test('large completed answers reveal gradually and interruption clears pending animation', () => {
  const pending = new Map(); let id = 0;
  const h = panelHarness({ timers: {
    setTimeout(fn, delay) { assert.equal(delay, 65); pending.set(++id, fn); return id; },
    clearTimeout(timer) { pending.delete(timer); }
  } });
  h.submit('質問');
  const answer = h.nodes.get('#kageChatBody').children.at(-1).children.at(-1);
  h.ports[0].onMessage.emit({ type: 'done', answer: '一二三四五六' });
  assert.equal(answer.textContent, '一二');
  assert.equal(h.ports[0].disconnected, false);
  const tick = () => { const [timer, fn] = pending.entries().next().value; pending.delete(timer); fn(); };
  tick(); assert.equal(answer.textContent, '一二三四');
  tick(); assert.equal(answer.textContent, '一二三四五六');
  assert.equal(h.ports[0].disconnected, true);
  h.submit('次');
  h.ports[1].onMessage.emit({ type: 'delta', answer: '甲乙丙丁戊己' });
  assert.equal(pending.size, 1);
  h.submit('新しい質問');
  assert.equal(pending.size, 0);
});
