import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function harness() {
  const handlers = new Map(), classes = new Set(), captured = new Set();
  const parent = { offsetWidth: 1000, offsetHeight: 600, clientLeft: 4, clientTop: 4, scrollLeft: 31, scrollTop: 17,
    getBoundingClientRect: () => ({ left: 130, top: 90, width: 750, height: 450 }) };
  const handle = { closest: selector => selector === '#kageSubDrag' ? handle : null };
  const toggle = { setAttribute() {}, addEventListener() {} };
  const container = {
    offsetParent: parent, offsetWidth: 400, offsetHeight: 120, style: {},
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), toggle() {} },
    querySelector: () => toggle,
    addEventListener(name, fn, options) { const list = handlers.get(name) || []; list.push({ fn, signal: options.signal }); handlers.set(name, list); },
    setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id), releasePointerCapture: id => captured.delete(id),
    getBoundingClientRect() {
      const center = parseFloat(this.style.left) || 420, top = parseFloat(this.style.top) || 260;
      return { left: 130 + (center - 200 + 4 - parent.scrollLeft) * .75,
        top: 90 + (top + 4 - parent.scrollTop) * .75, width: 300, height: 90 };
    }
  };
  const context = vm.createContext({ AbortController, container,
    location: { href: 'https://www.bilibili.com/video/BVtest', hostname: 'www.bilibili.com' },
    window: { scrollX: 0, scrollY: 0, addEventListener() {}, postMessage() {} },
    chrome: { runtime: { onMessage: { addListener() {} } }, storage: { onChanged: { addListener() {} } } },
    KageSubtitles: {},
  });
  vm.runInContext(readFileSync(new URL('../content/content.js', import.meta.url), 'utf8').split('// --- Sparkle AI UI ---')[0], context);
  vm.runInContext("subtitleContainer = container; renderParsedData({ chunks: [{japanese:'今日は'}], sentence_translation:'今天' })", context);
  function emit(name, fields = {}) {
    const event = { target: handle, button: 0, isPrimary: true, pointerId: 1, clientX: 540, clientY: 290, preventDefault() {}, stopPropagation() {}, ...fields };
    for (const { fn, signal } of handlers.get(name) || []) if (!signal.aborted) fn(event);
  }
  return { container, context, parent, classes, captured, emit,
    position: () => JSON.parse(vm.runInContext('JSON.stringify(subtitlePosition)', context)) };
}

test('drag starts without jumping inside a scrolled, bordered, scaled player', () => {
  const h = harness(), before = h.container.getBoundingClientRect();
  h.emit('pointerdown');
  assert.deepEqual(h.container.getBoundingClientRect(), before);
  h.emit('pointermove');
  assert.deepEqual(h.position(), { centerX: 420, top: 260 });
  h.emit('pointermove', { clientX: 600, clientY: 320 });
  assert.deepEqual(h.position(), { centerX: 500, top: 300 });
  assert.equal(h.container.getBoundingClientRect().left - before.left, 60);
  assert.equal(h.container.getBoundingClientRect().top - before.top, 30);
});

test('caption replacement preserves an active drag and pointer release ends it', () => {
  const h = harness();
  h.emit('pointerdown');
  vm.runInContext("renderParsedData({ chunks: [{japanese:'次の字幕'}], sentence_translation:'下一句字幕' })", h.context);
  h.emit('pointermove', { clientX: 600, clientY: 320 });
  assert.deepEqual(h.position(), { centerX: 500, top: 300 });
  assert.ok(h.classes.has('kage-dragging'));
  h.emit('pointerup');
  h.emit('pointermove', { clientX: 900, clientY: 500 });
  assert.deepEqual(h.position(), { centerX: 500, top: 300 });
  assert.equal(h.classes.has('kage-dragging'), false);
  assert.equal(h.captured.size, 0);
});

test('a different pointer cannot move the overlay and cancellation releases the drag', () => {
  const h = harness();
  h.emit('pointerdown');
  h.emit('pointermove', { pointerId: 2, clientX: 900 });
  assert.deepEqual(h.position(), { centerX: 420, top: 260 });
  h.emit('pointercancel');
  h.emit('pointermove', { clientX: 900 });
  assert.deepEqual(h.position(), { centerX: 420, top: 260 });
  assert.equal(h.captured.size, 0);
});

test('dragged subtitle position scales with fullscreen and returns without accumulating drift', () => {
  const h = harness();
  h.emit('pointerdown'); h.emit('pointermove', { clientX: 600, clientY: 320 }); h.emit('pointerup');
  const normal = h.position();
  for (let cycle = 0; cycle < 3; cycle++) {
    Object.assign(h.parent, { offsetWidth: 2000, offsetHeight: 1200, scrollLeft: 0, scrollTop: 0 });
    vm.runInContext('positionSubtitles()', h.context);
    assert.equal(h.position().centerX, (normal.centerX - 31) * 2);
    assert.equal(h.position().top, (normal.top - 17) * 2);
    Object.assign(h.parent, { offsetWidth: 1000, offsetHeight: 600, scrollLeft: 31, scrollTop: 17 });
    vm.runInContext('positionSubtitles()', h.context);
    assert.deepEqual(h.position(), normal);
  }
});

test('a fullscreen drag remains inside the smaller player, including both subtitle rows', () => {
  const h = harness();
  Object.assign(h.parent, { offsetWidth: 1920, offsetHeight: 1080, scrollLeft: 0, scrollTop: 0 });
  vm.runInContext('rememberSubtitlePosition({ centerX: 960, top: 930 }); positionSubtitles()', h.context);
  Object.assign(h.parent, { offsetWidth: 800, offsetHeight: 450 });
  vm.runInContext('positionSubtitles()', h.context);
  assert.equal(h.position().centerX, 400);
  assert.ok(h.position().top + h.container.offsetHeight <= 450 - 8);
  // A taller translation must also stay on screen without losing the saved anchor.
  h.container.offsetHeight = 200;
  vm.runInContext('positionSubtitles()', h.context);
  assert.ok(h.position().top + h.container.offsetHeight <= 450 - 8);
  Object.assign(h.parent, { offsetWidth: 1920, offsetHeight: 1080 });
  h.container.offsetHeight = 120;
  vm.runInContext('positionSubtitles()', h.context);
  assert.equal(h.position().top, 930);
});

test('fullscreen rooted at the document scales a dragged position even without an offset parent', () => {
  const h = harness();
  h.context.document = { documentElement: { clientWidth: 1920, clientHeight: 1080 } };
  h.container.offsetParent = null;
  vm.runInContext('rememberSubtitlePosition({ centerX: 960, top: 900 }); positionSubtitles()', h.context);
  h.container.offsetParent = h.parent;
  Object.assign(h.parent, { offsetWidth: 800, offsetHeight: 450, scrollLeft: 0, scrollTop: 0 });
  vm.runInContext('positionSubtitles()', h.context);
  assert.equal(h.position().centerX, 400);
  assert.ok(h.position().top + h.container.offsetHeight <= 442);
});
