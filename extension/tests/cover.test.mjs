import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../content/cover.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(saved, hostname = 'www.bilibili.com') {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.parentNode = null; this.style = {}; this.handlers = {}; this.classes = new Set();
      this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) }; }
    setAttribute() {}
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) { node.parentNode?.children.splice(node.parentNode.children.indexOf(node), 1); node.parentNode = this; this.children.push(node); }
    remove() { if (!this.parentNode) return; this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    getBoundingClientRect() { return { height: 500 }; }
    fire(name, fields = {}) { const event = { button: 0, pointerId: 1, preventDefault() {}, stopPropagation() {}, ...fields }; this.handlers[name]?.(event); return event; }
  }
  const storage = saved ? { [`kageCoverStripV1:${hostname.replace(/^www\./, '')}`]: saved } : {};
  const changed = [];
  const context = vm.createContext({ location: { hostname }, document: { createElement: tag => new Element(tag) },
    chrome: { storage: { local: { get: async key => ({ [key]: storage[key] }), set: async values => Object.assign(storage, JSON.parse(JSON.stringify(values))) },
      onChanged: { addListener: fn => changed.push(fn) } } } });
  vm.runInContext(source, context);
  const player = new Element('div');
  return { api: context.KageCover, player, storage, Element,
    strip: () => player.children.find(node => node.className === 'kage-cover-strip'),
    change: (key, value) => changed.forEach(fn => fn({ [key]: { newValue: value } }, 'local')) };
}

test('the cover is off until switched on, then stays on the player and is remembered for that site', async () => {
  const h = harness();
  await flush();
  h.api.update(h.player);
  assert.equal(h.strip(), undefined);
  assert.equal(h.api.toggle(), true);
  const strip = h.strip();
  assert.deepEqual({ ...strip.style }, { top: '80%', height: '14.000000000000002%' });
  assert.equal(h.storage['kageCoverStripV1:bilibili.com'].on, true);

  // Fullscreen moves it to the new player element; no video removes it.
  const fullscreen = new h.Element('div');
  h.api.update(fullscreen);
  assert.equal(strip.parentNode, fullscreen);
  h.api.update(null);
  assert.equal(strip.parentNode, null);
  h.api.update(h.player);
  assert.equal(strip.parentNode, h.player);
  assert.equal(h.api.toggle(), false);
  assert.equal(strip.parentNode, null);
});

test('a saved cover returns in the same place, and dragging moves and resizes it within the player', async () => {
  const h = harness({ on: true, top: 0.7, height: 0.2 });
  await flush();
  h.api.update(h.player);
  const strip = h.strip(), [, edge, grip] = strip.children;
  assert.deepEqual({ ...strip.style }, { top: '70%', height: '20%' });

  grip.fire('pointerdown', { clientY: 400 });
  grip.fire('pointermove', { clientY: 350 }); // 50 px of a 500 px player = 10%
  assert.equal(strip.style.top, '60%');
  grip.fire('pointermove', { clientY: 900 }); // cannot leave the bottom
  assert.equal(strip.style.top, '80%');
  grip.fire('pointerup');
  assert.deepEqual(h.storage['kageCoverStripV1:bilibili.com'], { on: true, top: 0.8, height: 0.2 });

  // The top edge resizes while the bottom stays put, down to a minimum height.
  edge.fire('pointerdown', { clientY: 400 });
  edge.fire('pointermove', { clientY: 350 });
  assert.equal(Math.round(parseFloat(strip.style.top)), 70);
  assert.equal(Math.round(parseFloat(strip.style.height)), 30);
  edge.fire('pointermove', { clientY: 2000 });
  assert.equal(Math.round(parseFloat(strip.style.height)), 4);
  edge.fire('pointerup');

  // Clicks on the handles never reach the player.
  let stopped = false;
  grip.fire('click', { stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);

  // Keyboard: arrows move, Shift + arrows resize.
  grip.fire('keydown', { key: 'ArrowUp' });
  assert.equal(Math.round(parseFloat(strip.style.top)), 95);
  grip.fire('keydown', { key: 'ArrowUp', shiftKey: true });
  assert.equal(Math.round(parseFloat(strip.style.height)), 5);
});

test('each site keeps its own cover, and a change in another tab applies here', async () => {
  const h = harness(undefined, 'anime1.me');
  await flush();
  h.api.update(h.player);
  h.change('kageCoverStripV1:bilibili.com', { on: true, top: 0.5, height: 0.1 });
  assert.equal(h.strip(), undefined);
  h.change('kageCoverStripV1:anime1.me', { on: true, top: 0.5, height: 0.1 });
  assert.equal(h.strip().style.top, '50%');
  assert.equal(h.api.on, true);
});

test('on-the-cover mode centres the subtitle in the strip, grows it for tall lines, and lets go when the cover is off', async () => {
  const h = harness({ on: true, top: 0.8, height: 0.1 });
  await flush();
  h.api.update(h.player);
  const strip = h.strip();
  assert.equal(strip.children[0].className, 'kage-cover-glass', 'the fading glass is its own layer');
  const subtitle = new h.Element('div');
  subtitle.offsetHeight = 38; // fits: 38 + 12 = 50 px = 10% of the 500 px player

  assert.equal(h.api.hold(subtitle), true);
  assert.ok(subtitle.classes.has('kage-on-strip'));
  assert.equal(Math.round(parseFloat(subtitle.style.top)), 85);
  assert.equal(subtitle.style.transform, 'translate(-50%, -50%)');
  assert.equal(Math.round(parseFloat(strip.style.height)), 10);

  // A two-line subtitle needs 20%: the strip grows upward and its bottom stays at 90%.
  subtitle.offsetHeight = 88;
  h.api.hold(subtitle);
  assert.equal(Math.round(parseFloat(strip.style.top)), 70);
  assert.equal(Math.round(parseFloat(strip.style.height)), 20);
  assert.equal(Math.round(parseFloat(subtitle.style.top)), 80);
  assert.equal(h.storage['kageCoverStripV1:bilibili.com'].height, 0.1, 'the saved height is untouched');

  // No line on screen: the strip returns to the height that was set.
  assert.equal(h.api.hold(null), false);
  assert.equal(Math.round(parseFloat(strip.style.height)), 10);
  assert.equal(subtitle.classes.has('kage-on-strip'), false);
  assert.equal(subtitle.style.top, '');

  // Cover switched off: the subtitle keeps its usual placement.
  h.api.hold(subtitle);
  h.api.toggle();
  assert.equal(h.api.hold(subtitle), false);
  assert.equal(subtitle.classes.has('kage-on-strip'), false);
});
