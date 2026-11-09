import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSubtitleService } from './server.mjs';

const API_KEY = 'gsk_fixture_key_for_relay_testing_only';
const MODEL = 'openai/gpt-oss-120b';
const spec = changes => ({ apiKey: API_KEY, model: MODEL, messages: [{ role: 'user', content: 'Explain this Japanese sentence.' }],
  stream: false, max_completion_tokens: 512, temperature: 0.1, ...changes });
async function start(t, handler, extra = {}) {
  const received = [], requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ headers: req.headers, payload: JSON.parse(Buffer.concat(chunks)) });
    handler(req, res);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kage-groq-relay-'));
  const service = await createSubtitleService({ dataDir, modelDir: dataDir, python: process.execPath,
    worker: fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)),
    groqRequest(url, options, callback) {
      requests.push({ url, options });
      return http.request(`http://127.0.0.1:${upstream.address().port}/fixed`, { ...options, agent: false }, callback);
    }, ...extra });
  const address = await service.listen(0), base = `http://127.0.0.1:${address.port}`;
  const health = await (await fetch(base + '/health')).json();
  const call = (payload = spec(), headers = {}, signal) => fetch(base + '/groq/chat/completions', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Kage-Token': health.token, ...headers }, body: JSON.stringify(payload), signal });
  t.after(async () => { await service.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { received, requests, dataDir, health, call, service };
}

test('fixed authenticated Groq route forwards the key only upstream and never saves it', async t => {
  const c = await start(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '回答' } }] })); });
  assert.equal(c.health.capabilities.groqRelay, true);
  const response = await c.call(); assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, '回答');
  assert.equal(c.requests[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.deepEqual(c.requests[0].options.agent.options.proxyEnv, {});
  assert.equal(c.received[0].headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(c.received[0].payload.model, MODEL);
  assert.equal('apiKey' in c.received[0].payload, false);
  assert.deepEqual(await fs.readdir(path.join(c.dataDir, 'jobs')), []);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('relay authentication, website origin and payload validation stop requests before Groq', async t => {
  const c = await start(t, () => assert.fail('No upstream request allowed'));
  assert.equal((await c.call(spec(), { 'X-Kage-Token': 'wrong' })).status, 401);
  assert.equal((await c.call(spec(), { Origin: 'https://www.youtube.com' })).status, 403);
  for (const payload of [spec({ url: 'http://127.0.0.1/private' }), spec({ model: 'arbitrary' }), spec({ apiKey: API_KEY + '\r\nx-test: leak' }),
    spec({ messages: [{ role: 'tool', content: 'invalid' }] }), spec({ max_completion_tokens: 100000 }), spec({ stream: 'true' }),
    spec({ messages: [{ role: 'user', content: 'x'.repeat(32001) }] })]) assert.equal((await c.call(payload)).status, 400);
  assert.equal((await c.call(spec({ messages: [{ role: 'user', content: 'x'.repeat(128 * 1024) }] }))).status, 413);
  assert.equal(c.requests.length, 0);
});

test('real streamed SSE bytes preserve split UTF-8 and are available before upstream finishes', async t => {
  let finish;
  const c = await start(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"回答"}}]}\n\n');
    res.write(bytes.subarray(0, 43)); res.write(bytes.subarray(43));
    finish = () => res.end('data: [DONE]\n\n');
  });
  const response = await c.call(spec({ stream: true }));
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value, { stream: true });
  assert.ok(text.includes('data:')); finish();
  while (true) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }); }
  assert.match(text, /回答/); assert.match(text, /\[DONE\]/);
});

test('provider errors are classified without forwarding keys, upstream diagnostics or redirects', async t => {
  let status = 403, code;
  const c = await start(t, (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', Location: 'https://evil.invalid/' });
    res.end(JSON.stringify({ error: { code, message: `private diagnostic ${API_KEY}` } }));
  });
  let response = await c.call(); assert.equal(response.status, 403);
  let text = await response.text(); assert.match(text, /direct connection/); assert.ok(!text.includes(API_KEY));
  status = 401; response = await c.call(); assert.match((await response.json()).error, /rejected this API key/);
  status = 403; code = 'model_permission_blocked_project'; response = await c.call(); assert.match((await response.json()).error, /project settings/);
  status = 302; code = undefined; response = await c.call(); assert.equal(response.status, 502);
  text = await response.text(); assert.ok(!text.includes(API_KEY)); assert.equal(c.requests.length, 4);
});

test('request timeout releases the relay slot and returns a safe diagnostic', async t => {
  const c = await start(t, () => {}, { groqTimeoutMs: 60 });
  const response = await c.call(); assert.equal(response.status, 504); assert.match((await response.json()).error, /timed out/);
});

test('disconnecting the browser stops its upstream stream', async t => {
  let closed;
  const stopped = new Promise(resolve => { closed = resolve; });
  const c = await start(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: first\n\n'); res.once('close', closed); });
  const controller = new AbortController();
  const response = await c.call(spec({ stream: true }), {}, controller.signal);
  await response.body.getReader().read(); controller.abort();
  await Promise.race([stopped, new Promise((_, reject) => setTimeout(() => reject(new Error('Upstream was not cancelled')), 1500))]);
});

test('the relay forwards a valid reasoning effort and rejects other values', async () => {
  const { validateGroqRequest } = await import('./groq-relay.mjs');
  const base = { apiKey: 'gsk_' + 'a'.repeat(40), model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: '質問' }],
    stream: true, temperature: 0.1, max_completion_tokens: 512 };
  assert.equal(validateGroqRequest({ ...base, reasoning_effort: 'low' }).reasoning_effort, 'low');
  assert.equal('reasoning_effort' in validateGroqRequest(base), false);
  assert.throws(() => validateGroqRequest({ ...base, reasoning_effort: 'extreme' }), /Invalid Groq tutor request/);
});
