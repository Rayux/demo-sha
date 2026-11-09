import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../options/options.js', import.meta.url), 'utf8');
async function harness(saved = {}) {
  const nodes = new Map(), events = {}, writes = [];
  const get = id => { if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, addEventListener: (type, fn) => { events[`${id}:${type}`] = fn; } }); return nodes.get(id); };
  const state = { gemmaRestoredV1: true, apiEndpoint: 'http://127.0.0.1:11434/v1/chat/completions', apiModel: 'user-model', groqApiKey: 'fixture-saved-key', ...saved };
  vm.runInNewContext(source, { URL, document: { getElementById: get, addEventListener: (type, fn) => { events[type] = fn; } },
    setTimeout() {}, chrome: { storage: { local: { get: async () => state, set: async value => { writes.push(value); Object.assign(state, value); } } } } });
  await events.DOMContentLoaded(); return { get, state, writes, save: () => events['saveBtn:click']() };
}
test('Groq connection defaults to automatic and preserves saved local model settings', async () => {
  const h = await harness(); assert.equal(h.get('groqConnection').value, 'auto');
  h.get('groqConnection').value = 'helper'; await h.save();
  assert.equal(h.state.groqConnection, 'helper'); assert.equal(h.state.apiModel, 'user-model'); assert.equal(h.state.groqApiKey, 'fixture-saved-key');
});
test('manual routes are restored and can return to automatic', async () => {
  for (const groqConnection of ['browser', 'helper']) {
    const h = await harness({ groqConnection }); assert.equal(h.get('groqConnection').value, groqConnection);
    h.get('groqConnection').value = 'auto'; await h.save(); assert.equal(h.state.groqConnection, 'auto');
  }
});
test('the previous VPN toggle upgrades to automatic without opening or saving settings', async () => {
  for (const groqViaHelper of [true, false]) {
    const h = await harness({ groqViaHelper });
    assert.equal(h.get('groqConnection').value, 'auto'); assert.equal(h.writes.length, 0);
  }
});
