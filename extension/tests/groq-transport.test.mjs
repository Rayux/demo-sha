import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../background/groq-transport.js', import.meta.url), 'utf8');
const KEY = 'gsk_fixture_key_for_relay_testing_only', TOKEN = 'a'.repeat(64);
const payload = { model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'Explain' }], temperature: 0.1, max_completion_tokens: 512, stream: true };
function harness(handler) {
  const calls = [];
  const context = vm.createContext({ fetch: async (url, options) => { calls.push({ url, options }); return handler(url, options, calls.length); } });
  vm.runInContext(source, context); return { calls, api: context.KageGroqTransport };
}
test('optional helper transport sends the key only to authenticated loopback and preserves streaming', async () => {
  const h = harness(async url => url.endsWith('/health') ? Response.json({ token: TOKEN, capabilities: { groqRelay: true } })
    : new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  assert.equal(h.calls.length, 0);
  const signal = new AbortController().signal, response = await h.api.fetch(payload, KEY, signal);
  assert.match(await response.text(), /DONE/);
  assert.ok(h.calls.every(call => call.url.startsWith('http://127.0.0.1:8766/')));
  const sent = h.calls[1]; assert.equal(sent.options.headers['X-Kage-Token'], TOKEN);
  assert.equal(sent.options.headers.Authorization, undefined);
  assert.equal(JSON.parse(sent.options.body).apiKey, KEY);
  assert.equal(sent.options.redirect, 'error'); assert.equal(sent.options.signal, signal);
});
test('older helpers fail clearly instead of sending a key to an unsupported route', async () => {
  const h = harness(async () => Response.json({ token: TOKEN, capabilities: {} }));
  await assert.rejects(h.api.fetch(payload, KEY), /Update and restart/);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].options.body, undefined);
});
test('only a rotated local token is retried; a Groq key rejection is returned once', async () => {
  let healthCalls = 0, sends = 0;
  const h = harness(async url => {
    if (url.endsWith('/health')) { healthCalls++; return Response.json({ token: TOKEN, capabilities: { groqRelay: true } }); }
    sends++;
    if (sends === 1) return Response.json({ error: 'Local service token is missing or expired. Reconnect and retry.' }, { status: 401 });
    return Response.json({ error: 'Groq rejected this API key.' }, { status: 401 });
  });
  const response = await h.api.fetch(payload, KEY);
  assert.equal(response.status, 401); assert.equal(healthCalls, 2); assert.equal(sends, 2);
});
test('network errors never expose the key and stopping preserves the abort reason', async () => {
  const h = harness(async url => { if (url.endsWith('/health')) return Response.json({ token: TOKEN, capabilities: { groqRelay: true } }); throw new Error(KEY); });
  await assert.rejects(h.api.fetch(payload, KEY), error => !error.message.includes(KEY) && /local Groq connection/.test(error.message));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.api.fetch(payload, KEY, controller.signal), error => error.name === 'AbortError');
});
