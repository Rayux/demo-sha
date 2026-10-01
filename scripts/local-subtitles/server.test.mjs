import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createSubtitleService, splitLongCues, validateResult } from './server.mjs';
import { validateTranslationConfig } from './translation.mjs';

const fixture = fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url));
const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
async function start(t, options = {}) {
  const dataDir = options.dataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'kage-subtitles-test-'));
  const service = await createSubtitleService({ dataDir, python: process.execPath, worker: fixture, modelDir: dataDir, ...options });
  const address = await service.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const health = await (await fetch(`${base}/health`)).json();
  const call = async (route, { method = 'GET', json, bytes, headers = {}, auth = true } = {}) => {
    const response = await fetch(`${base}${route}`, { method, headers: {
      ...(auth ? { 'X-Kage-Token': health.token } : {}),
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers,
    }, body: json !== undefined ? JSON.stringify(json) : bytes });
    return { status: response.status, headers: response.headers, value: response.status === 204 ? null : await response.json() };
  };
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await service.close(); } };
  t.after(async () => { await stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { service, dataDir, health, base, call, stop };
}
async function upload(client, text = 'hello') {
  const created = await client.call('/jobs', { method: 'POST', json: { name: '../../chosen-video.mp4', size: Buffer.byteLength(text) } });
  assert.equal(created.status, 201);
  const id = created.value.id;
  const uploaded = await client.call(`/jobs/${id}/audio?offset=0`, { method: 'PUT', bytes: text });
  assert.equal(uploaded.status, 200);
  return id;
}
async function waitJob(client, id, desired = ['complete', 'error', 'translation_error', 'cancelled']) {
  for (let count = 0; count < 200; count++) {
    const result = await client.call(`/jobs/${id}`);
    if (desired.includes(result.value.state)) return result.value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Fixture job timed out.');
}
async function missing(filename) {
  await assert.rejects(fs.stat(filename), error => error.code === 'ENOENT');
}

test('health is loopback-only, rejects website origins/foreign hosts, and protects job reads and mutations', async t => {
  const client = await start(t);
  assert.equal(client.health.ready, true);
  assert.match(client.health.token, /^[a-f0-9]{64}$/);
  const cors = await client.call('/health', { auth: false, headers: { Origin: extensionOrigin } });
  assert.equal(cors.status, 200);
  assert.equal(cors.headers.get('access-control-allow-origin'), extensionOrigin);
  assert.equal((await client.call('/health', { headers: { Origin: 'https://www.bilibili.com' } })).status, 403);
  assert.equal((await client.call('/health', { headers: { Origin: 'null' } })).status, 403);
  // Fetch normalizes Host to its URL; use a raw HTTP request to exercise DNS-rebinding checks.
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${client.base}/health`, { headers: { Host: 'malicious.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await client.call('/jobs', { method: 'POST', json: { name: 'file', size: 4 }, auth: false })).status, 401);
  assert.equal((await client.call(`/jobs/${randomUUID()}`, { auth: false })).status, 401);
  const preflight = await client.call('/jobs', { method: 'OPTIONS', auth: false, headers: { Origin: extensionOrigin } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-Kage-Token/);
});

test('sequential chunks resume by received offset and generate persistent validated captions', async t => {
  const client = await start(t);
  const created = await client.call('/jobs', { method: 'POST', json: { name: '../../outside.mp4', size: 5 } });
  const id = created.value.id;
  assert.equal((await client.call(`/jobs/${id}/start`, { method: 'POST', json: {} })).status, 409);
  assert.equal((await client.call(`/jobs/${id}/audio?offset=0`, { method: 'PUT', bytes: 'he' })).value.received, 2);
  assert.equal((await client.call(`/jobs/${id}/audio?offset=0`, { method: 'PUT', bytes: 'he' })).status, 409);
  assert.equal((await client.call(`/jobs/${id}`)).value.received, 2);
  assert.equal((await client.call(`/jobs/${id}/audio?offset=2`, { method: 'PUT', bytes: 'llo' })).value.received, 5);
  assert.equal((await client.call(`/jobs/${id}/start`, { method: 'POST', json: {} })).status, 202);
  const job = await waitJob(client, id);
  assert.equal(job.state, 'complete');
  assert.equal(job.progress, 1);
  assert.deepEqual(job.cues, [{ id: '0', start: 0.25, end: 1.5, text: 'こんにちは。' }]);
  await missing(path.join(client.dataDir, 'jobs', id, 'input.media'));
  await missing(path.join(client.dataDir, 'jobs', id, 'result.json'));
  const saved = JSON.parse(await fs.readFile(path.join(client.dataDir, 'jobs', id, 'job.json')));
  assert.deepEqual(saved.cues, job.cues);
  assert.equal((await client.call(`/jobs/${id}/start`, { method: 'POST', json: {} })).value.state, 'complete');
});

test('rejects oversized files, oversized chunks and writes beyond the declared file size', async t => {
  const client = await start(t);
  for (const size of [0, -1, 4 * 1024 ** 3 + 1, 1.5]) {
    assert.equal((await client.call('/jobs', { method: 'POST', json: { name: 'video.mp4', size } })).status, 400);
  }
  const id = (await client.call('/jobs', { method: 'POST', json: { name: 'video.mp4', size: 3 * 1024 ** 2 } })).value.id;
  assert.equal((await client.call(`/jobs/${id}/audio?offset=0`, { method: 'PUT', bytes: Buffer.alloc(2 * 1024 ** 2 + 1) })).status, 413);
  assert.equal((await client.call(`/jobs/${id}`)).value.received, 0);
  const small = (await client.call('/jobs', { method: 'POST', json: { name: 'video.mp4', size: 1 } })).value.id;
  assert.equal((await client.call(`/jobs/${small}/audio?offset=0`, { method: 'PUT', bytes: 'too much' })).status, 413);
});

test('two videos run concurrently, a third waits, and cancelling one frees only its slot', async t => {
  const client = await start(t);
  assert.equal(client.health.processing.concurrency, 2);
  assert.equal(client.health.processing.translationConcurrency, 1);
  const ids = await Promise.all([upload(client, 'slow'), upload(client, 'slow'), upload(client)]);
  await Promise.all(ids.slice(0, 2).map(id => client.call(`/jobs/${id}/start`, { method: 'POST', json: {} })));
  await Promise.all(ids.slice(0, 2).map(id => waitJob(client, id, ['transcribing'])));
  await client.call(`/jobs/${ids[2]}/start`, { method: 'POST', json: {} });
  assert.equal((await client.call(`/jobs/${ids[2]}`)).value.state, 'queued');
  assert.equal((await client.call(`/jobs/${ids[2]}`)).value.queuePosition, 1);
  await client.call(`/jobs/${ids[0]}`, { method: 'DELETE' });
  assert.equal((await waitJob(client, ids[2])).state, 'complete');
  assert.equal((await client.call(`/jobs/${ids[1]}`)).value.state, 'transcribing');
  assert.equal((await client.call(`/jobs/${ids[0]}`)).value.state, 'cancelled');
  await missing(path.join(client.dataDir, 'jobs', ids[0], 'input.media'));
  await client.call(`/jobs/${ids[1]}`, { method: 'DELETE' });
});

test('simultaneous create requests cannot exceed the four-job upload limit', async t => {
  const client = await start(t);
  const responses = await Promise.all(Array.from({ length: 8 }, () => client.call('/jobs', {
    method: 'POST', json: { name: 'video.mp4', size: 1 },
  })));
  assert.equal(responses.filter(response => response.status === 201).length, 4);
  assert.equal(responses.filter(response => response.status === 429).length, 4);
});

test('abandoned partial uploads expire and release their local media', async t => {
  const client = await start(t, { uploadIdleMs: 40, sweepIntervalMs: 20 });
  const id = await upload(client);
  const job = await waitJob(client, id);
  assert.equal(job.state, 'cancelled');
  assert.match(job.message, /expired/);
  const media = path.join(client.dataDir, 'jobs', id, 'input.media');
  // The background sweeper marks cancellation before its asynchronous cleanup.
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fs.stat(media); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await missing(media);
});

test('cancels running work, clears media, and lets the next queued job run', async t => {
  const client = await start(t);
  const slow = await upload(client, 'slow');
  await client.call(`/jobs/${slow}/start`, { method: 'POST', json: {} });
  await waitJob(client, slow, ['transcribing']);
  const next = await upload(client);
  await client.call(`/jobs/${next}/start`, { method: 'POST', json: {} });
  assert.equal((await client.call(`/jobs/${slow}`, { method: 'DELETE' })).value.state, 'cancelled');
  assert.equal((await waitJob(client, next)).state, 'complete');
  assert.equal((await client.call(`/jobs/${slow}`)).value.state, 'cancelled');
  await missing(path.join(client.dataDir, 'jobs', slow, 'input.media'));
});

test('decoder failures and invalid timestamps become errors and delete media', async t => {
  const client = await start(t);
  for (const mode of ['fail', 'invalid']) {
    const id = await upload(client, mode);
    await client.call(`/jobs/${id}/start`, { method: 'POST', json: {} });
    const job = await waitJob(client, id);
    assert.equal(job.state, 'error');
    assert.match(job.message, mode === 'fail' ? /decode/ : /timestamp/);
    await missing(path.join(client.dataDir, 'jobs', id, 'input.media'));
  }
});

test('restart retains completed results and invalidates interrupted uploads and old auth tokens', async t => {
  const first = await start(t);
  const id = await upload(first);
  await first.call(`/jobs/${id}/start`, { method: 'POST', json: {} });
  await waitJob(first, id);
  await first.stop();
  const interrupted = randomUUID();
  const interruptedDir = path.join(first.dataDir, 'jobs', interrupted);
  await fs.mkdir(interruptedDir);
  await fs.writeFile(path.join(interruptedDir, 'job.json'), JSON.stringify({ id: interrupted, state: 'uploading', size: 9, received: 3 }));
  await fs.writeFile(path.join(interruptedDir, 'input.media'), 'abc');
  await fs.writeFile(path.join(interruptedDir, 'audio.wav'), 'abc');
  const second = await start(t, { dataDir: first.dataDir });
  assert.notEqual(first.health.token, second.health.token);
  assert.equal((await second.call(`/jobs/${id}`)).value.state, 'complete');
  assert.equal((await second.call(`/jobs/${id}`, { headers: { 'X-Kage-Token': first.health.token } })).status, 401);
  const job = (await second.call(`/jobs/${interrupted}`)).value;
  assert.equal(job.state, 'error');
  assert.match(job.message, /restarted/);
  await missing(path.join(interruptedDir, 'input.media'));
  await missing(path.join(interruptedDir, 'audio.wav'));
});

test('unavailable local runtime returns an actionable health error and never queues work', async t => {
  const client = await start(t, { modelDir: '/tmp/not-ready' });
  assert.equal(client.health.ready, false);
  assert.match(client.health.error, /Install/);
  assert.equal((await client.call('/jobs', { method: 'POST', json: { name: 'video.mp4', size: 1 } })).status, 503);
});

test('result validation accepts silent audio and rejects nonfinite, backwards, and out-of-range cues', () => {
  assert.deepEqual(validateResult({ duration: 2, cues: [] }), { duration: 2, cues: [] });
  for (const cue of [
    { start: NaN, end: 1, text: 'a' }, { start: 0, end: 3, text: 'a' },
    { start: 1, end: 0, text: 'a' }, { start: 0, end: 1, text: '' },
  ]) assert.throws(() => validateResult({ duration: 2, cues: [cue] }));
  assert.throws(() => validateResult({ duration: 2, cues: [{ start: 1, end: 2, text: 'a' }, { start: 0, end: 1, text: 'b' }] }));
});

test('long Japanese cues split into balanced clips of fewer than twelve words', () => {
  const text = 'これは一つ目の長い字幕ですそして二つ目の説明を続けます最後まで聞いてください';
  const cues = splitLongCues([{ start: 10, end: 20, text }]);
  const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
  assert.ok(cues.length > 1);
  assert.equal(cues[0].start, 10);
  assert.equal(cues.at(-1).end, 20);
  assert.equal(cues.map(cue => cue.text).join(''), text);
  for (const cue of cues) {
    assert.ok([...segmenter.segment(cue.text)].filter(part => part.isWordLike).length < 12);
  }
});

const translation = { endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'gemma2' };
function requestedItems(init) {
  const payload = JSON.parse(init.body);
  const content = payload.messages.at(-1).content;
  return JSON.parse(content.slice(content.indexOf('{'))).items;
}
function translatedResponse(items) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: items.map(({ id }) => ({ id, translation: `繁體中文${id}。` })) }) } }] }), { headers: { 'Content-Type': 'application/json' } });
}

test('local translation configuration rejects cloud, credentials, extra settings, and invalid models', () => {
  assert.deepEqual(validateTranslationConfig({}), translation);
  for (const config of [null, [], { endpoint: 'https://api.openai.com/v1/chat/completions' },
    { endpoint: 'http://127.0.0.1.evil.example/chat' }, { endpoint: 'http://user:secret@localhost/chat' },
    { endpoint: 'file:///tmp/model' }, { endpoint: 'http://localhost/chat?api_key=secret' },
    { model: '' }, { model: 'a\nb' }, { apiKey: 'secret' }, { temperature: Infinity }]) {
    assert.throws(() => validateTranslationConfig(config));
  }
});

test('upload automatically prepares all Traditional Chinese lines in batches without altering Japanese timing', async t => {
  const requests = [];
  const client = await start(t, { fetchImpl: async (url, init) => {
    const items = requestedItems(init);
    requests.push(items);
    assert.equal(url, translation.endpoint);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, undefined);
    const payload = JSON.parse(init.body);
    assert.match(payload.messages[0].content, /overlapping speech/);
    assert.match(payload.messages[0].content, /Traditional Chinese/);
    return translatedResponse([...items].reverse());
  } });
  assert.equal(client.health.capabilities.translation, true);
  const id = await upload(client, 'multi');
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  const job = await waitJob(client, id);
  assert.equal(job.state, 'complete');
  assert.equal(job.translationCompleted, 5);
  assert.equal(job.translationTotal, 5);
  assert.equal(job.progress, 1);
  assert.deepEqual(requests.map(items => items.length), [5]);
  assert.deepEqual(job.cues, Array.from({ length: 5 }, (_, index) => ({ id: String(index), start: index, end: index + 0.9, text: `日本語${index}。`, translation: `繁體中文${index}。` })));
  await missing(path.join(client.dataDir, 'jobs', id, 'input.media'));
  const saved = JSON.parse(await fs.readFile(path.join(client.dataDir, 'jobs', id, 'job.json')));
  assert.deepEqual(saved.cues, job.cues);
  assert.deepEqual(saved.translation, translation);
});

test('invalid translation endpoint is rejected before transcription starts', async t => {
  const client = await start(t, { fetchImpl: () => assert.fail('Cloud endpoint must never be requested') });
  const id = await upload(client);
  assert.equal((await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation: { endpoint: 'https://example.com/api' } } })).status, 400);
  assert.equal((await client.call(`/jobs/${id}`)).value.state, 'uploading');
  await missing(path.join(client.dataDir, 'workers.log'));
});

test('missing ids use individual fallback, discard unknown ids and retain successful batch translations', async t => {
  const requests = [];
  const client = await start(t, { fetchImpl: async (_url, init) => {
    const items = requestedItems(init);
    requests.push(items.map(item => item.id));
    if (requests.length === 1) return translatedResponse([items[2], items[0], items[1], { id: '999' }]);
    return translatedResponse(items);
  } });
  const id = await upload(client, 'multi');
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  assert.equal((await waitJob(client, id)).state, 'complete');
  assert.deepEqual(requests, [['0', '1', '2', '3', '4'], ['3'], ['4']]);
});

test('malformed model output gets a format retry and cannot complete with missing Chinese', async t => {
  let requests = 0;
  const client = await start(t, { fetchImpl: async (_url, init) => {
    requests++;
    if (requests === 1) return new Response(JSON.stringify({ choices: [{ message: { content: 'Sorry, not JSON' } }] }));
    assert.match(JSON.parse(init.body).messages.at(-1).content, /previous answer/);
    return translatedResponse(requestedItems(init));
  } });
  const id = await upload(client);
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  const job = await waitJob(client, id);
  assert.equal(job.state, 'complete');
  assert.equal(requests, 2);
});

test('network failure saves Japanese and partial Chinese; retry resumes missing lines without retranscribing', async t => {
  const requests = [];
  let failNext = false;
  const client = await start(t, { translationBatchSize: 4, fetchImpl: async (_url, init) => {
    const items = requestedItems(init);
    requests.push(items.map(item => item.id));
    if (failNext) { failNext = false; throw new TypeError('fetch failed'); }
    if (requests.length === 1) failNext = true;
    return translatedResponse(items);
  } });
  const id = await upload(client, 'multi');
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  const failed = await waitJob(client, id);
  assert.equal(failed.state, 'translation_error');
  assert.equal(failed.cues.length, 5);
  assert.equal(failed.translationCompleted, 4);
  assert.equal(failed.progress, 0.8);
  assert.match(failed.message, /Ollama/);
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  const job = await waitJob(client, id);
  assert.equal(job.state, 'complete');
  assert.deepEqual(requests, [['0', '1', '2', '3'], ['4'], ['4']]);
  assert.equal((await fs.readFile(path.join(client.dataDir, 'workers.log'), 'utf8')).trim().split('\n').length, 2);
});

test('translation occupies one slot while another video can finish and cancellation does not revive it', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let aborted = false;
  const client = await start(t, { fetchImpl: async (_url, init) => {
    entered();
    await new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted = true; reject(init.signal.reason); }, { once: true });
    });
    assert.fail('Cancelled translation must not continue');
  } });
  const id = await upload(client);
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  await started;
  const pending = (await client.call(`/jobs/${id}`)).value;
  assert.equal(pending.state, 'translating');
  assert.equal(pending.cues[0].text, 'こんにちは。');
  const next = await upload(client);
  await client.call(`/jobs/${next}/start`, { method: 'POST', json: {} });
  assert.equal((await waitJob(client, next)).state, 'complete');
  await client.call(`/jobs/${id}`, { method: 'DELETE' });
  assert.equal((await waitJob(client, next)).state, 'complete');
  assert.equal(aborted, true);
  const cancelled = (await client.call(`/jobs/${id}`)).value;
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(cancelled.cues, pending.cues);
  const saved = JSON.parse(await fs.readFile(path.join(client.dataDir, 'jobs', id, 'job.json')));
  assert.equal(saved.state, 'cancelled');
  assert.deepEqual(saved.cues, pending.cues);
});

test('service shutdown and restart preserve interrupted translations for resuming without audio', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const first = await start(t, { translationBatchSize: 4, fetchImpl: async (_url, init) => {
    const items = requestedItems(init);
    if (items[0].id === '0') return translatedResponse(items);
    entered();
    await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  const id = await upload(first, 'multi');
  await first.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  await started;
  await first.stop();
  const second = await start(t, { dataDir: first.dataDir, fetchImpl: async (_url, init) => {
    assert.deepEqual(requestedItems(init).map(item => item.id), ['4']);
    return translatedResponse(requestedItems(init));
  } });
  const interrupted = (await second.call(`/jobs/${id}`)).value;
  assert.equal(interrupted.state, 'translation_error');
  assert.equal(interrupted.translationCompleted, 4);
  await missing(path.join(second.dataDir, 'jobs', id, 'input.media'));
  await second.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  assert.equal((await waitJob(second, id)).state, 'complete');
});

test('silent media completes without an Ollama request and existing Japanese results can add Chinese', async t => {
  let requests = 0;
  const client = await start(t, { fetchImpl: async (_url, init) => { requests++; return translatedResponse(requestedItems(init)); } });
  const silent = await upload(client, 'silent');
  await client.call(`/jobs/${silent}/start`, { method: 'POST', json: { translation } });
  assert.equal((await waitJob(client, silent)).state, 'complete');
  assert.equal(requests, 0);
  const id = await upload(client);
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: {} });
  await waitJob(client, id);
  assert.equal((await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } })).status, 202);
  const job = await waitJob(client, id);
  assert.equal(job.cues[0].translation, '繁體中文0。');
  assert.equal(requests, 1);
});

test('unrecoverable format errors stop after one repair for a single cue and retain Japanese', async t => {
  let requests = 0;
  const client = await start(t, { fetchImpl: async () => {
    requests++;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"translations":[{"id":"wrong","translation":"錯誤"}]}' } }] }));
  } });
  const id = await upload(client);
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  const failed = await waitJob(client, id);
  assert.equal(failed.state, 'translation_error');
  assert.equal(failed.translationCompleted, 0);
  assert.equal(failed.cues[0].text, 'こんにちは。');
  assert.equal(requests, 2);
});

test('translation never follows an HTTP redirect even to another local endpoint', async t => {
  let redirectedRequests = 0;
  const ollama = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/redirected') { redirectedRequests++; res.end('{}'); return; }
    res.writeHead(302, { Location: `http://127.0.0.1:${ollama.address().port}/redirected` });
    res.end();
  });
  await new Promise(resolve => ollama.listen(0, '127.0.0.1', resolve));
  t.after(async () => { ollama.closeIdleConnections(); await new Promise(resolve => ollama.close(resolve)); });
  const client = await start(t);
  const id = await upload(client);
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation: {
    ...translation, endpoint: `http://127.0.0.1:${ollama.address().port}/v1/chat/completions`,
  } } });
  assert.equal((await waitJob(client, id)).state, 'translation_error');
  assert.equal(redirectedRequests, 0);
});

test('restart recovers a crashed translating snapshot without discarding Japanese or partial Chinese', async t => {
  const first = await start(t);
  await first.stop();
  const id = randomUUID();
  const dir = path.join(first.dataDir, 'jobs', id);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify({ id, state: 'translating', translation,
    size: 3, received: 3, duration: 2, translationTotal: 2, translationCompleted: 1, progress: 0.5,
    cues: [{ id: '0', start: 0, end: 0.9, text: 'はい。', translation: '是的。' }, { id: '1', start: 1, end: 1.9, text: 'いいえ。' }],
  }));
  const second = await start(t, { dataDir: first.dataDir, fetchImpl: async (_url, init) => {
    assert.deepEqual(requestedItems(init).map(item => item.id), ['1']);
    return translatedResponse(requestedItems(init));
  } });
  const restored = (await second.call(`/jobs/${id}`)).value;
  assert.equal(restored.state, 'translation_error');
  assert.match(restored.message, /restarted/);
  assert.equal(restored.cues[0].translation, '是的。');
  await second.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  assert.equal((await waitJob(second, id)).state, 'complete');
  await missing(path.join(second.dataDir, 'workers.log'));
});

const downloadFixture = fileURLToPath(new URL('./fixtures/download.mjs', import.meta.url));
async function downloadJob(client, url = 'https://www.bilibili.com/video/BVtest?p=2&spm_id_from=tracking') {
  const created = await client.call('/jobs', { method: 'POST', json: { sourceUrl: url } });
  assert.equal(created.status, 201);
  return created.value.id;
}

test('Bilibili download goes directly through transcription and translation without uploading', async t => {
  const client = await start(t, { downloader: downloadFixture, fetchImpl: async (_url, init) => translatedResponse(requestedItems(init)) });
  assert.equal(client.health.capabilities.bilibiliDownload, true);
  const id = await downloadJob(client);
  assert.equal((await client.call(`/jobs/${id}`)).value.sourceUrl, 'https://www.bilibili.com/video/BVtest?p=2');
  assert.equal((await client.call(`/jobs/${id}/audio?offset=0`, { method: 'PUT', bytes: 'bad' })).status, 409);
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  const job = await waitJob(client, id);
  assert.equal(job.state, 'complete');
  assert.equal(job.cues[0].translation, '繁體中文0。');
  assert.equal(job.size, 5);
  await missing(path.join(client.dataDir, 'jobs', id, 'download'));
  await missing(path.join(client.dataDir, 'jobs', id, 'input.media'));
});

test('Bilibili input accepts a single episode and rejects foreign URLs and malformed parts', async t => {
  const client = await start(t, { downloader: downloadFixture });
  for (const sourceUrl of ['http://127.0.0.1/secret', 'https://bilibili.com.evil.test/video/BVtest',
    'https://user:pass@www.bilibili.com/video/BVtest', 'https://www.bilibili.com:444/video/BVtest',
    'https://www.bilibili.com/video/BVtest?p=-1', 'https://www.bilibili.com/video/BVtest?p=2oops',
    'https://www.bilibili.com/bangumi/play/ss123', 'file:///tmp/video', null]) {
    assert.equal((await client.call('/jobs', { method: 'POST', json: { sourceUrl } })).status, 400, String(sourceUrl));
  }
  const id = await downloadJob(client, 'https://www.bilibili.com/bangumi/play/ep123?from=test');
  assert.equal((await client.call(`/jobs/${id}`)).value.sourceUrl, 'https://www.bilibili.com/bangumi/play/ep123');
  assert.equal((await client.call('/jobs', { method: 'POST', json: { name: 'extra', size: 1 } })).status, 201);
  await client.call(`/jobs/${id}`, { method: 'DELETE' });
  assert.equal((await client.call('/jobs', { method: 'POST', json: { name: 'extra', size: 1 } })).status, 201);
});

test('download cancellation terminates its writer and cleans partial media before accepting another job', async t => {
  const client = await start(t, { downloader: downloadFixture });
  const id = await downloadJob(client, 'https://www.bilibili.com/video/BVslow');
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: {} });
  await waitJob(client, id, ['downloading']);
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fs.stat(path.join(client.dataDir, 'jobs', id, 'download', 'video.mp4.part'))).size > 0) break; }
    catch { /* Wait for the fixture writer to create its file. */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok((await fs.stat(path.join(client.dataDir, 'jobs', id, 'download', 'video.mp4.part'))).size > 0);
  assert.equal((await client.call(`/jobs/${id}`, { method: 'DELETE' })).value.state, 'cancelled');
  await missing(path.join(client.dataDir, 'jobs', id, 'download'));
  await missing(path.join(client.dataDir, 'jobs', id, 'input.media'));
  const next = await downloadJob(client);
  await client.call(`/jobs/${next}/start`, { method: 'POST', json: {} });
  assert.equal((await waitJob(client, next)).state, 'complete');
});

test('download failure never starts transcription and permits a fresh retry', async t => {
  const client = await start(t, { downloader: downloadFixture });
  const id = await downloadJob(client, 'https://www.bilibili.com/video/BVfail');
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: {} });
  const failed = await waitJob(client, id);
  assert.equal(failed.state, 'error');
  assert.match(failed.message, /download failed/);
  await missing(path.join(client.dataDir, 'workers.log'));
  await missing(path.join(client.dataDir, 'jobs', id, 'download'));
  await downloadJob(client);
});

test('a second CLI launch reports the busy port without recovering or deleting active job files', async t => {
  const client = await start(t);
  const id = await upload(client, 'active-upload');
  const jobFile = path.join(client.dataDir, 'jobs', id, 'job.json');
  const original = await fs.readFile(jobFile, 'utf8');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
      env: { ...process.env, KAGE_SUBTITLES_DIR: client.dataDir, KAGE_SUBTITLES_PORT: new URL(client.base).port },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /already in use.*already be running/);
  assert.doesNotMatch(result.output, /node:net|UVException/);
  assert.equal(await fs.readFile(jobFile, 'utf8'), original);
  assert.equal(await fs.readFile(path.join(client.dataDir, 'jobs', id, 'input.media'), 'utf8'), 'active-upload');
  assert.equal((await client.call(`/jobs/${id}`)).value.state, 'uploading');
});

const streamingFixture = fileURLToPath(new URL('./fixtures/streaming-worker.mjs', import.meta.url));
test('audio sections are saved and translated while later sections are still transcribing', async t => {
  let entered, release;
  const translating = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const client = await start(t, { worker: streamingFixture, fetchImpl: async (_url, init) => {
    if (++calls === 1) {
      await fs.writeFile(path.join(client.dataDir, 'translation-started'), 'started');
      entered(); await gate;
    }
    return translatedResponse(requestedItems(init));
  } });
  const id = await downloadJob(client, 'https://www.bilibili.com/video/BVoverlap');
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  await translating;
  const early = (await client.call(`/jobs/${id}`)).value;
  assert.equal(early.state, 'preparing');
  assert.equal(early.processedThrough, 60);
  assert.equal(early.transcriptionComplete, false);
  assert.equal(early.cues[0].text, 'はい。');
  release();
  const job = await waitJob(client, id);
  assert.equal(job.state, 'complete');
  assert.equal(job.transcriptionComplete, true);
  assert.equal(job.cues.length, 2);
  assert.deepEqual(job.cues.map(cue => cue.start), [0.2, 60.2]);
  assert.deepEqual(job.cues.map(cue => cue.translation), ['繁體中文0。', '繁體中文1。']);
});

test('a late stream failure preserves partial subtitles but cannot be retried as a complete transcript', async t => {
  const client = await start(t, { worker: streamingFixture, fetchImpl: async (_url, init) => translatedResponse(requestedItems(init)) });
  const id = await downloadJob(client, 'https://www.bilibili.com/video/BVfail');
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  const job = await waitJob(client, id);
  assert.equal(job.state, 'error');
  assert.equal(job.transcriptionComplete, false);
  assert.equal(job.cues[0].translation, '繁體中文0。');
  assert.equal((await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } })).value.state, 'error');
  await missing(path.join(client.dataDir, 'jobs', id, 'input.media'));
});

test('cancelling progressive processing aborts both inference stages without late subtitle writes', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let aborted = false;
  const client = await start(t, { worker: streamingFixture, fetchImpl: async (_url, init) => {
    entered();
    await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(init.signal.reason); }, { once: true }));
  } });
  const id = await downloadJob(client, 'https://www.bilibili.com/video/BVslow');
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  await started;
  const job = (await client.call(`/jobs/${id}`, { method: 'DELETE' })).value;
  assert.equal(job.state, 'cancelled');
  assert.equal(aborted, true);
  assert.ok(job.cues.length > 0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(client.dataDir,'jobs',id,'job.json'))).cues, job.cues);
});

test('silent initial sections remain active and do not stop preparation of later dialogue', async t => {
  const client = await start(t, { worker: streamingFixture, fetchImpl: async (_url, init) => translatedResponse(requestedItems(init)) });
  const id = await downloadJob(client, 'https://www.bilibili.com/video/BVsilent');
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  const early = await waitJob(client, id, ['preparing']);
  assert.deepEqual(early.cues, []);
  const job = await waitJob(client, id);
  assert.equal(job.state, 'complete');
  assert.equal(job.cues[0].start, 60.2);
});

test('restart retains partial progressive subtitles without treating them as a complete translation-only retry', async t => {
  const first = await start(t);
  await first.stop();
  const id = randomUUID(), dir = path.join(first.dataDir, 'jobs', id);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir,'job.json'),JSON.stringify({id,state:'preparing',translation,
    transcriptionComplete:false,processedThrough:60,duration:120,size:4*1024**3,
    cues:[{id:'0',start:1,end:2,text:'はい。',translation:'是的。'}]}));
  const second = await start(t,{dataDir:first.dataDir});
  const job = (await second.call(`/jobs/${id}`)).value;
  assert.equal(job.state,'error');
  assert.equal(job.cues[0].translation,'是的。');
  assert.equal((await second.call(`/jobs/${id}/start`,{method:'POST',json:{translation}})).value.state,'error');
});

test('serial fallback still publishes sections and defers Chinese until transcription finishes', async t => {
  const client = await start(t,{worker:streamingFixture,parallelStages:false,fetchImpl:async (_url,init)=>{
    const events = await fs.readFile(path.join(client.dataDir,'first-chunk'),'utf8');
    assert.equal(events,'ready');
    return translatedResponse(requestedItems(init));
  }});
  assert.equal(client.health.processing.parallelStages,false);
  const id=await downloadJob(client);
  await client.call(`/jobs/${id}/start`,{method:'POST',json:{translation}});
  const early=await waitJob(client,id,['preparing']);
  assert.equal(early.translationCompleted,undefined);
  assert.equal((await waitJob(client,id)).state,'complete');
});

test('different Bilibili URLs share four queue slots without consuming the upload byte budget', async t => {
  const client = await start(t, { downloader: downloadFixture });
  assert.equal(client.health.capabilities.jobQueue, true);
  assert.equal((await client.call('/jobs', { auth: false })).status, 401);
  const created = await Promise.all(Array.from({ length: 6 }, (_, index) => client.call('/jobs', {
    method: 'POST', json: { sourceUrl: `https://www.bilibili.com/video/BVtest${index}` }
  })));
  assert.equal(created.filter(result => result.status === 201).length, 4);
  assert.equal(created.filter(result => result.status === 429).length, 2);
  const list = (await client.call('/jobs')).value;
  assert.equal(list.jobs.length, 4);
  assert.equal(list.concurrency, 2);
  assert.ok(list.jobs.every(job => job.name && !job.cues && !job.translation));
  const id = list.jobs[0].id;
  await client.call(`/jobs/${id}`, { method: 'DELETE' });
  assert.equal((await client.call('/jobs')).value.jobs.length, 3);
  assert.equal((await client.call('/jobs', { method: 'POST', json: { name: 'local.mp4', size: 1 } })).status, 201);
});

test('queue lists running and waiting videos; stopping a waiting job does not stop the running video', async t => {
  const client = await start(t, { downloader: downloadFixture });
  const running = await downloadJob(client, 'https://www.bilibili.com/video/BVslow');
  await client.call(`/jobs/${running}/start`, { method: 'POST', json: {} });
  await waitJob(client, running, ['downloading']);
  const second = await downloadJob(client, 'https://www.bilibili.com/video/BVslow?p=2');
  await client.call(`/jobs/${second}/start`, { method: 'POST', json: {} });
  await waitJob(client, second, ['downloading']);
  const waiting = await downloadJob(client, 'https://www.bilibili.com/video/BVnext');
  await client.call(`/jobs/${waiting}/start`, { method: 'POST', json: {} });
  const list = (await client.call('/jobs')).value.jobs;
  assert.equal(list.find(job => job.id === waiting).queuePosition, 1);
  assert.equal((await client.call(`/jobs/${waiting}`)).value.queuePosition, 1);
  await client.call(`/jobs/${waiting}`, { method: 'DELETE' });
  assert.equal((await client.call(`/jobs/${running}`)).value.state, 'downloading');
  assert.deepEqual((await client.call('/jobs')).value.jobs.map(job => job.id), [running, second]);
  await client.call(`/jobs/${running}`, { method: 'DELETE' });
});

test('Stop after a completed job does not erase its saved subtitles', async t => {
  const client = await start(t);
  const id = await upload(client);
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: {} });
  const completed = await waitJob(client, id);
  const stopped = (await client.call(`/jobs/${id}`, { method: 'DELETE' })).value;
  assert.equal(stopped.state, 'complete');
  assert.deepEqual(stopped.cues, completed.cues);
});

test('completed transcripts expire three days after completion, including on disk and after a restart', async t => {
  let now = Date.now();
  const client = await start(t, { now: () => now, sweepIntervalMs: 10 });
  const id = await upload(client);
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: {} });
  const completed = await waitJob(client, id);
  assert.equal(completed.expiresAt, now + 3 * 86400000);
  now = completed.expiresAt - 1;
  assert.equal((await client.call(`/jobs/${id}`)).status, 200);
  now++;
  for (let tries = 0; tries < 100; tries++) {
    if ((await client.call(`/jobs/${id}`)).status === 404) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await client.call(`/jobs/${id}`)).status, 404);
  await missing(path.join(client.dataDir, 'jobs', id));
  await client.stop();

  // Simulate an expired legacy result left on disk while the helper was off.
  const directory = path.join(client.dataDir, 'jobs', id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'job.json'), JSON.stringify({ ...completed, expiresAt: undefined,
    updatedAt: new Date(now - 3 * 86400000).toISOString() }));
  const restarted = await start(t, { dataDir: client.dataDir, now: () => now });
  assert.equal((await restarted.call(`/jobs/${id}`)).status, 404);
  await missing(directory);
});

test('two videos share one translation request slot and both retain their own translations', async t => {
  let active = 0, maximum = 0, calls = 0;
  const client = await start(t, { translationBatchSize: 4, fetchImpl: async (_url, init) => {
    active++; maximum = Math.max(maximum, active); calls++;
    await new Promise(resolve => setTimeout(resolve, 30));
    active--;
    return translatedResponse(requestedItems(init));
  } });
  const ids = await Promise.all([upload(client, 'multi'), upload(client, 'multi')]);
  await Promise.all(ids.map(id => client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } })));
  const completed = await Promise.all(ids.map(id => waitJob(client, id)));
  assert.equal(maximum, 1);
  assert.equal(calls, 4);
  assert.ok(completed.every(job => job.state === 'complete' && job.cues.length === 5 && job.cues.every(cue => cue.translation)));
});

test('cancelling a video waiting for Chinese releases its slot without aborting the other translation', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  let requests = 0, aborted = false;
  const client = await start(t, { fetchImpl: async (_url, init) => {
    requests++;
    entered();
    await new Promise((resolve, reject) => {
      release = resolve;
      init.signal.addEventListener('abort', () => { aborted = true; reject(init.signal.reason); }, { once: true });
    });
    return translatedResponse(requestedItems(init));
  } });
  const first = await upload(client);
  await client.call(`/jobs/${first}/start`, { method: 'POST', json: { translation } });
  await started;
  const second = await upload(client);
  await client.call(`/jobs/${second}/start`, { method: 'POST', json: { translation } });
  await waitJob(client, second, ['translating']);
  const third = await upload(client);
  await client.call(`/jobs/${third}/start`, { method: 'POST', json: {} });
  assert.equal((await client.call(`/jobs/${third}`)).value.state, 'queued');
  assert.equal((await client.call(`/jobs/${second}`, { method: 'DELETE' })).value.state, 'cancelled');
  assert.equal((await waitJob(client, third)).state, 'complete');
  assert.equal(requests, 1);
  assert.equal(aborted, false);
  release();
  assert.equal((await waitJob(client, first)).state, 'complete');
  assert.equal((await client.call(`/jobs/${second}`)).value.state, 'cancelled');
});

test('shutdown stops both workers and preserves both records for recovery', async t => {
  const client = await start(t);
  const ids = await Promise.all([upload(client, 'slow'), upload(client, 'slow')]);
  await Promise.all(ids.map(id => client.call(`/jobs/${id}/start`, { method: 'POST', json: {} })));
  await Promise.all(ids.map(id => waitJob(client, id, ['transcribing'])));
  await client.stop();
  for (const id of ids) {
    const saved = JSON.parse(await fs.readFile(path.join(client.dataDir, 'jobs', id, 'job.json'), 'utf8'));
    assert.equal(saved.state, 'cancelled');
    await missing(path.join(client.dataDir, 'jobs', id, 'input.media'));
  }
});

test('stage timings include cumulative worker measurements, separate translation waits, and survive saving', async t => {
  const client = await start(t, { worker: streamingFixture, translationBatchSize: 8,
    fetchImpl: async (_url, init) => translatedResponse(requestedItems(init)) });
  assert.equal(client.health.processing.translationBatchSize, 8);
  const id = await downloadJob(client, 'https://www.bilibili.com/video/BVtimings');
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: { translation } });
  const result = await waitJob(client, id);
  assert.equal(result.state, 'complete');
  assert.equal(result.timings.sourceSetupMs, 5);
  assert.equal(result.timings.audioWaitMs, 19);
  assert.equal(result.timings.recognitionMs, 45, 'cumulative measurements must not be added twice');
  assert.ok(result.timings.processingMs >= result.timings.workerWallMs);
  assert.ok(result.timings.translationMs > 0);
  assert.ok(result.timings.translationQueueMs >= 0);
  assert.ok(result.timings.translationRequests >= 1);
  assert.equal(result.timings.translationRetries, 0);
  await client.stop();
  const saved = JSON.parse(await fs.readFile(path.join(client.dataDir, 'jobs', id, 'job.json'), 'utf8'));
  assert.equal(saved.timings.recognitionMs, 45);
  assert.equal(saved.timings.batchSize, 8);
  assert.ok(saved.timings.processingMs > 0);
});
