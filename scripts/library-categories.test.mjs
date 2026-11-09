import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const libraryFunctions = app.slice(app.indexOf('function getLibraryCategory('), app.indexOf('\nasync function loadLibrary('));
const files = [
  { name: 'Assassination Classroom - S01E02 - Episode 2.mp3', url: '/a2' },
  { name: 'The Promised Neverland - S01E10 - Episode 10.mp3', url: '/n10' },
  { name: 'The Promised Neverland - S01E02 - Episode 2.mp3', url: '/n2' },
  { name: 'Cautious Hero - The Hero Is Overpowered but Overly Cautious - S01E01 - Episode 1.mp3', url: '/c1' },
  { name: 'My recording.mp3', url: '/other' },
];
function harness(preference = 'The Promised Neverland') {
  const state = { library: [], libraryCategory: null, defaultLibraryCategory: preference };
  const ui = { library: {}, libraryCategory: {}, defaultLibraryCategory: {} };
  const context = vm.createContext({ state, ui, $: () => ({}), document: { querySelectorAll: () => [] }, escapeHtml: text => text });
  vm.runInContext(libraryFunctions, context);
  context.renderLibrary(files);
  return { context, state, ui };
}

test('default collection shows only Neverland in natural episode order', () => {
  const { context, state, ui } = harness();
  assert.equal(state.libraryCategory, 'The Promised Neverland');
  assert.deepEqual(Array.from(context.getVisibleLibrary(), file => file.url), ['/n2', '/n10']);
  assert.match(ui.library.innerHTML, /Neverland/);
  assert.doesNotMatch(ui.library.innerHTML, /Assassination Classroom/);
  assert.match(ui.libraryCategory.innerHTML, /Cautious Hero - The Hero Is Overpowered but Overly Cautious/);
});

test('saved defaults, all audio, and uncategorized files are selectable', () => {
  const { context, state } = harness('Assassination Classroom');
  assert.equal(context.getVisibleLibrary().length, 1);
  state.libraryCategory = 'all';
  assert.equal(context.getVisibleLibrary().length, 5);
  state.libraryCategory = 'Other audio';
  assert.equal(context.getVisibleLibrary()[0].url, '/other');
  context.renderLibrary(files);
  assert.equal(state.libraryCategory, 'Other audio');
});

test('missing default falls back without losing preference and empty libraries remain usable', () => {
  const { context, state, ui } = harness('Missing series');
  assert.equal(state.libraryCategory, 'Assassination Classroom');
  assert.equal(state.defaultLibraryCategory, 'Missing series');
  assert.match(ui.defaultLibraryCategory.innerHTML, /Missing series \(unavailable\)/);
  context.renderLibrary([]);
  assert.equal(state.libraryCategory, 'all');
  assert.match(ui.library.innerHTML, /No compatible audio/);
});
