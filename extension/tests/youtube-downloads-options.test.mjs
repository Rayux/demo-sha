import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = readFileSync(new URL('../options/youtube-downloads.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ enabled = false, grant = true, failure = false } = {}) {
  const calls = [], handlers = {};
  const button = { disabled: true, textContent: '', addEventListener: (type, fn) => { handlers[type] = fn; } };
  const status = { textContent: '' };
  const permissions = {
    contains: async () => enabled,
    request: value => { calls.push({ action: 'request', value }); if (failure) return Promise.reject(new Error('denied')); enabled = grant; return Promise.resolve(grant); },
    remove: value => { calls.push({ action: 'remove', value }); enabled = false; return Promise.resolve(true); }
  };
  vm.runInNewContext(source, { document: { getElementById: id => id === 'youtubeDownloadsBtn' ? button : status }, chrome: { permissions } });
  return { button, status, calls, click: () => handlers.click() };
}

test('media-server access is optional and requested only by the user’s actual Settings click', async () => {
  const h = harness(); await tick();
  assert.equal(h.calls.length, 0); assert.equal(h.button.disabled, false);
  assert.match(h.button.textContent, /^Enable/);
  h.click();
  assert.equal(h.calls.length, 1, 'permissions.request runs synchronously within the click');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { action: 'request', value: { origins: ['https://*.googlevideo.com/*'] } });
  await tick(); assert.match(h.button.textContent, /^Disable/); assert.match(h.status.textContent, /^Enabled/);
});

test('declined and failed prompts never claim that Chrome downloads are enabled', async () => {
  for (const options of [{ grant: false }, { failure: true }]) {
    const h = harness(options); await tick(); h.click(); await tick();
    assert.match(h.button.textContent, /^Enable/); assert.equal(h.button.disabled, false);
    assert.doesNotMatch(h.status.textContent, /^Enabled/);
  }
});

test('enabled media access can be revoked directly from Settings', async () => {
  const h = harness({ enabled: true }); await tick();
  assert.match(h.button.textContent, /^Disable/);
  h.click(); await tick();
  assert.equal(h.calls[0].action, 'remove'); assert.match(h.button.textContent, /^Enable/);
});
