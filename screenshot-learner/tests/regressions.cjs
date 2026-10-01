const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('recognition distinguishes empty results from invalid and truncated responses', () => {
  const source = read('result.js');
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function parseItems'), source.indexOf('async function prepareImage')), context);
  const parse = (content, reason) => context.parseItems({ choices: [{ message: { content }, finish_reason: reason }] });
  assert.equal(parse('{"items":[]}').length, 0);
  assert.equal(parse('```json\n{"items":[{"japanese":"学校"}]}\n```')[0].japanese, '学校');
  for (const content of ['{}', 'null', '{"items":[{}]}', 'Not JSON', '']) assert.throws(() => parse(content));
  assert.throws(() => parse('{"items":[]}', 'length'), /cut off/);
});

test('one capture per window; native panel opens before capture without creating tabs', async () => {
  const listeners = [], pages = [], stored = {}, events = [];
  let captures = 0;
  const tab = { id: 1, windowId: 1, url: "https://example.com", title: "Source" };
  const chrome = {
    commands: { onCommand: { addListener: fn => listeners.push(fn) } },
    action: { onClicked: { addListener() {} } },
    runtime: { onConnect:{addListener(){}}, getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener() {} } },
    scripting: { executeScript: async () => {} },
    sidePanel: { open: async () => events.push("open") },
    windows: { onRemoved: { addListener() {} } },
    tabs: {
      onUpdated:{addListener(){}},onActivated:{addListener(){}},
      query: async () => [tab],
      captureVisibleTab: async () => { captures++; events.push("capture"); return 'data:image/png;base64,test'; },
      create: async page => pages.push(page)
    },
    storage: { session: { set: async values => Object.assign(stored, values) } }
  };
  const context = vm.createContext({ chrome });
  vm.runInContext(read('background.js'), context);
  assert.equal(listeners.length, 1);
  await Promise.all([context.captureAndOpen(tab), context.captureAndOpen(tab)]);
  assert.equal(captures, 1);
  await context.captureAndOpen(tab);
  assert.equal(Object.keys(stored).length, 2);
  assert.equal(stored['study-1'].sourceTabId, 1);
  assert.equal(pages.length, 0);
  assert.equal(events[0], 'open');
  tab.url = 'chrome-extension://test/result.html';
  await context.captureAndOpen(tab);
  assert.equal(captures, 2);
  assert.match(stored['study-1'].error, /Select the page/);
});

test('drag release reads once; clicks, tiny drags, cancellation and busy gestures do not read', () => {
  const source = read('result.js');
  const elements = {}, handlers = {};
  let calls = 0;
  const context = vm.createContext({
    crop: null, busy: false, chatting: false,
    $: id => elements[id] ||= { style: {} },
    analyze: () => calls++
  });
  vm.runInContext(source.slice(source.indexOf('function setupSelection'), source.indexOf('function renderItems')), context);
  context.setupSelection({
    clientWidth: 300, clientHeight: 200,
    getBoundingClientRect: () => ({left: 0, top: 0, width: 300, height: 200}),
    setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {},
    addEventListener: (name, fn) => handlers[name] = fn
  });
  const emit = (type, x, y) => handlers[type]({type, clientX:x, clientY:y, button:0, pointerId:1, preventDefault() {}});
  emit('pointerdown', 20, 20); emit('pointermove', 100, 100); emit('pointerup', 100, 100);
  assert.equal(calls, 1);
  const previous = context.crop;
  emit('pointerdown', 20, 20); emit('pointerup', 20, 20);
  emit('pointerdown', 20, 20); emit('pointerup', 23, 23);
  emit('pointerdown', 20, 20); emit('pointermove', 150, 150); emit('pointercancel', 150, 150);
  assert.equal(context.crop, previous);
  assert.equal(calls, 1);
  context.busy = true;
  emit('pointerdown', 20, 20); emit('pointerup', 100, 100);
  assert.equal(calls, 1);
  context.busy = false;
  emit('pointerdown', 200, 180); emit('pointerup', 30, 30);
  assert.equal(calls, 2);
  assert.equal(context.crop.x, 0.1);
});

test('translation is Traditional Chinese and cannot change Japanese source', () => {
  const converterContext = vm.createContext({});
  vm.runInContext(read('vendor/opencc.js'), converterContext);
  const OpenCC = converterContext.OpenCC;
  const source = read('result.js');
  const context = vm.createContext({toTraditional: OpenCC.Converter({from:'cn',to:'twp'})});
  vm.runInContext(source.slice(source.indexOf('function validateTranslations'), source.indexOf('async function prepareImage')), context);
  const original = [{japanese:'今日は学校に行きます。'}];
  const result = context.validateTranslations(original, [{japanese:original[0].japanese,translation:'今天去学校学习。',furigana:'きょうはがっこうにいきます。'}]);
  assert.equal(result[0].translation, '今天去學校學習。');
  assert.equal(result[0].japanese, original[0].japanese);
  assert.throws(() => context.validateTranslations(original, [{japanese:'今日は學校に行きます。',translation:'今天去學校。'}]));
  assert.throws(() => context.validateTranslations(original, [{japanese:original[0].japanese}]));
  assert.throws(() => context.validateTranslations(original, []));
});


function clipboardHarness() {
  const store = {}, events = [];
  let text = '学校の図書館', contexts = [], creates = 0, handler;
  const chrome = {
    commands:{onCommand:{addListener(){}}},action:{onClicked:{addListener(){}}},
    windows:{WINDOW_ID_CURRENT:-2,getLastFocused:async()=>({id:5}),update:async()=>{},onRemoved:{addListener(){}}},
    sidePanel:{open:async({windowId})=>events.push(`open-${windowId}`)},
    runtime:{getURL:path=>`chrome-extension://test/${path}`,getContexts:async()=>contexts,onMessage:{addListener:fn=>handler=fn},sendMessage:async()=>{events.push('read');return {text}}},
    offscreen:{createDocument:async()=>{creates++;contexts=[{}]}},
    storage:{session:{set:async data=>Object.assign(store,data)}}
  };
  const context = vm.createContext({chrome,crypto:{randomUUID:()=>String(events.length)}});
  vm.runInContext(read('background.js'),context);
  return {context,store,events,setText:value=>text=value,creates:()=>creates};
}

test('global clipboard command works without source tab and reuses offscreen reader', async () => {
  const h=clipboardHarness();
  await h.context.clipboardCommand();
  assert.equal(h.events[0],'open--2');
  assert.equal(h.store['selected-5'].text,'学校の図書館');
  assert.equal(h.store['selected-5'].sourceTitle,'Clipboard');
  h.setText('次の文章');
  await h.context.clipboardCommand();
  assert.equal(h.store['selected-5'].text,'次の文章');
  assert.equal(h.creates(),1);
});

test('empty and oversized clipboard preserve previous study and show recovery message', async () => {
  const h=clipboardHarness();
  await h.context.translateClipboard(5);
  h.setText('  ');
  assert.match((await h.context.translateClipboard(5)).error,/no text/);
  assert.equal(h.store['selected-5'].text,'学校の図書館');
  h.setText('a'.repeat(12001));
  assert.match((await h.context.translateClipboard(5)).error,/shorter/);
});

test('offscreen clipboard reads plain text and clears temporary field', () => {
  let handler, pasteHandler;
  const field={value:'old clipboard',focus(){},addEventListener:(_event,fn)=>pasteHandler=fn,removeEventListener(){}};
  const context=vm.createContext({chrome:{runtime:{onMessage:{addListener:fn=>handler=fn}}},document:{getElementById:()=>field,execCommand:()=>{pasteHandler({preventDefault(){},clipboardData:{getData:format=>format==='text/plain'?'日本語':'<b>日本語</b>'}});return false;}}});
  vm.runInContext(read('clipboard.js'),context);
  let result;
  handler({target:'clipboard-reader',type:'read-clipboard'},{},value=>result=value);
  assert.equal(result.text,'日本語');
  assert.equal(field.value,'');
});
