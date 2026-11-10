import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../background/dev-reload.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness({ updateUrl, session = {} } = {}) {
  const files = {
    'manifest.json': JSON.stringify({ background: { service_worker: 'background/service_worker.js' }, options_ui: { page: 'options/options.html' },
      content_scripts: [{ js: ['vendor/big.js', 'content/tutor.js'], css: ['content/content.css'] }] }),
    'background/service_worker.js': "importScripts('helper.js', 'dev-reload.js');",
    'background/helper.js': 'helper', 'background/dev-reload.js': 'reload',
    'options/options.html': '<script src="options.js"></script>', 'options/options.js': 'options',
    'content/tutor.js': 'tutor v1', 'content/content.css': 'css', 'vendor/big.js': 'vendor',
  };
  const state = { files, session, reads: [], reloads: 0, messages: [], alarm: null, schedule: null };
  vm.runInNewContext(source, {
    TextEncoder, crypto: globalThis.crypto,
    fetch: async url => {
      const path = url.replace('chrome-extension://kage/', '');
      state.reads.push(path);
      return { ok: path in files, text: async () => files[path] };
    },
    chrome: {
      runtime: { getManifest: () => (updateUrl ? { update_url: updateUrl } : {}), getURL: path => `chrome-extension://kage/${path}`, reload: () => { state.reloads++; } },
      storage: { session: { get: async key => ({ [key]: session[key] }), set: async values => Object.assign(session, values) } },
      tabs: { query: async () => [{ id: 1 }, { id: 2 }], sendMessage: async (id, message) => { state.messages.push([id, message.type]); if (id === 2) throw new Error('No receiver'); } },
      alarms: { create: (name, options) => { state.schedule = { name, ...options }; }, onAlarm: { addListener: fn => { state.alarm = fn; } } },
    },
  });
  return state;
}

test('an unpacked install reloads itself and asks open pages to refresh when a loaded file changes on disk', async () => {
  const h = harness();
  await settle();
  assert.equal(h.reloads, 0, 'the first check only records what was loaded');
  assert.deepEqual({ ...h.schedule }, { name: 'kage-dev-reload', periodInMinutes: 0.5 });
  for (const path of ['background/helper.js', 'options/options.js', 'content/tutor.js', 'content/content.css']) assert.ok(h.reads.includes(path), path);
  assert.ok(!h.reads.includes('vendor/big.js'));

  h.alarm({ name: 'kage-dev-reload' });
  await settle();
  assert.equal(h.reloads, 0, 'unchanged files do not reload');

  h.files['content/tutor.js'] = 'tutor v2';
  h.alarm({ name: 'another-alarm' });
  await settle();
  assert.equal(h.reloads, 0);
  h.alarm({ name: 'kage-dev-reload' });
  await settle();
  assert.equal(h.reloads, 1);
  assert.deepEqual(h.messages, [[1, 'KAGE_EXTENSION_UPDATED'], [2, 'KAGE_EXTENSION_UPDATED']]);

  // If session storage survived the reload, the same files must not reload again.
  h.alarm({ name: 'kage-dev-reload' });
  await settle();
  assert.equal(h.reloads, 1);
});

test('a file that cannot be read is retried later instead of reloading', async () => {
  const h = harness();
  await settle();
  delete h.files['content/tutor.js'];
  h.alarm({ name: 'kage-dev-reload' });
  await settle();
  assert.equal(h.reloads, 0);
  h.files['content/tutor.js'] = 'tutor v1';
  h.alarm({ name: 'kage-dev-reload' });
  await settle();
  assert.equal(h.reloads, 0);
});

test('store installs never check or reload', async () => {
  const h = harness({ updateUrl: 'https://clients2.google.com/service/update2/crx' });
  await settle();
  assert.equal(h.schedule, null);
  assert.equal(h.reads.length, 0);
});
