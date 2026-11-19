import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dialogueIntervals, intervalSeconds, audioFilename, headerFilename } from './condensed.mjs';
import { createSubtitleService } from './server.mjs';

const worker = fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url));
const ffmpeg = [process.execPath, fileURLToPath(new URL('./fixtures/ffmpeg.mjs', import.meta.url))];
const page = 'https://www.youtube.com/watch?v=abcdefghijk';
const query = `?url=${encodeURIComponent(page)}`;

test('lines are padded, clamped to the video, and joined when their padding overlaps', () => {
  const cues = [{ start: 1, end: 2 }, { start: 4, end: 5 }, { start: 20, end: 21 }, { start: 58, end: 59.8 }];
  assert.deepEqual(dialogueIntervals(cues, 60, { padding: 1.5 }), [[0, 6.5], [18.5, 22.5], [56.5, 60]]);
  assert.deepEqual(dialogueIntervals(cues, 60, { padding: 0 }), [[1, 2], [4, 5], [20, 21], [58, 59.8]]);
  assert.equal(intervalSeconds([[0, 6.5], [18.5, 22.5]]), 10.5);
});

test('unordered, invalid and out-of-range lines never produce a bad span', () => {
  const cues = [{ start: 30, end: 31 }, { start: 5, end: 5 }, { start: 'x', end: 3 }, null, { start: 70, end: 71 }, { start: 10, end: 11 }];
  assert.deepEqual(dialogueIntervals(cues, 60, { padding: 1 }), [[9, 12], [29, 32]]);
  assert.deepEqual(dialogueIntervals(cues, 0), []);
  assert.deepEqual(dialogueIntervals(cues, 60, { padding: 999 })[0], [0, 41]); // Padding is capped at 10 seconds.
});

test('opening and ending songs can be left out', () => {
  const cues = [{ start: 30, end: 40 }, { start: 89, end: 95 }, { start: 100, end: 110 }, { start: 1200, end: 1205 }, { start: 1350, end: 1360 }];
  assert.deepEqual(dialogueIntervals(cues, 1440, { padding: 1, skipSongs: true }), [[99, 111], [1199, 1206]]);
  assert.equal(dialogueIntervals(cues, 1440, { padding: 1 }).length, 5);
});

test('download names are safe in any folder and keep Japanese titles', () => {
  assert.equal(audioFilename('  葬送のフリーレン 第1話: "旅立ち" / EP01?  '), '葬送のフリーレン 第1話 旅立ち EP01 (condensed).mp3');
  assert.equal(audioFilename('../../etc/passwd'), 'etc passwd (condensed).mp3');
  assert.equal(audioFilename(''), 'Kage audio (condensed).mp3');
  assert.ok(audioFilename('x'.repeat(500)).length <= 140);
  assert.equal(headerFilename("It's 第1話 (condensed).mp3"), 'It%27s%20%E7%AC%AC1%E8%A9%B1%20%28condensed%29.mp3');
});

async function start(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kage-condensed-test-'));
  const service = await createSubtitleService({ dataDir, python: process.execPath, worker, modelDir: dataDir, ffmpeg });
  const { port } = await service.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const { token, capabilities } = await (await fetch(`${base}/health`)).json();
  const call = (route, { method = 'GET', json, bytes, auth = true } = {}) => fetch(`${base}${route}`, { method,
    headers: { ...(auth ? { 'X-Kage-Token': token } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: json !== undefined ? JSON.stringify(json) : bytes });
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, call, capabilities };
}
async function prepare(client, mode = 'multi') {
  const { id } = await (await client.call('/jobs', { method: 'POST', json: { name: 'Episode 1.mp4', size: mode.length, pageUrl: page } })).json();
  await client.call(`/jobs/${id}/audio?offset=0`, { method: 'PUT', bytes: mode });
  await client.call(`/jobs/${id}/start`, { method: 'POST', json: {} });
  for (let count = 0; count < 200; count++) {
    const job = await (await client.call(`/jobs/${id}`)).json();
    if (['complete', 'error', 'cancelled'].includes(job.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Fixture job timed out.');
}
async function settled(client) {
  for (let count = 0; count < 200; count++) {
    const status = await (await client.call(`/audio${query}`)).json();
    if (status.export?.state !== 'working') return status;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Condensed audio timed out.');
}

test('condensed audio is cut from the kept soundtrack and downloads only with the helper token', async t => {
  const client = await start(t);
  assert.equal(client.capabilities.condensedAudio, true);
  assert.deepEqual(await (await client.call(`/audio${query}`)).json(),
    { available: false, reason: 'unprepared', defaults: { padding: 1.5, maxPadding: 10 }, export: null });
  const job = await prepare(client);
  assert.equal(job.state, 'complete');
  const kept = path.join(client.dataDir, 'jobs', job.id, 'kept-audio.mp3');

  // The fixture worker keeps no audio, as with videos prepared before this feature.
  assert.equal((await (await client.call(`/audio${query}`)).json()).reason, 'no_audio');
  const refused = await client.call(`/audio/condensed${query}`, { method: 'POST', json: {} });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /Prepare it again/);

  await fs.writeFile(kept, 'soundtrack');
  const ready = await (await client.call(`/audio${query}`)).json();
  assert.equal(ready.available, true);
  assert.equal(ready.lines, 5);
  assert.equal((await client.call(`/audio/file${query}`)).status, 404);
  for (const padding of [-1, 11, 'x']) {
    assert.equal((await client.call(`/audio/condensed${query}`, { method: 'POST', json: { padding } })).status, 400);
  }
  const started = await client.call(`/audio/condensed${query}`, { method: 'POST', json: { padding: 0, title: '第1話: 旅立ち' } });
  assert.equal(started.status, 202);
  const done = await settled(client);
  assert.deepEqual(done.export, { state: 'ready', progress: 1, padding: 0, skipSongs: false,
    filename: '第1話 旅立ち (condensed).mp3', bytes: 13, seconds: done.export.seconds, clips: 5 });
  assert.ok(Math.abs(done.export.seconds - 4.5) < 1e-9);
  const args = JSON.parse(await fs.readFile(path.join(client.dataDir, 'jobs', job.id, 'condensed.mp3.partial.args.json'), 'utf8'));
  assert.equal(args[args.indexOf('-i') + 1], kept);
  assert.equal(args[args.indexOf('-af') + 1],
    "aselect='between(t,0.000,0.900)+between(t,1.000,1.900)+between(t,2.000,2.900)+between(t,3.000,3.900)+between(t,4.000,4.900)',asetpts=N/SR/TB");

  const file = await client.call(`/audio/file${query}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'audio/mpeg');
  assert.match(file.headers.get('content-disposition'), /^attachment; filename="condensed\.mp3"; filename\*=UTF-8''%E7%AC%AC1%E8%A9%B1%20%E6%97%85%E7%AB%8B%E3%81%A1%20%28condensed%29\.mp3$/);
  assert.equal(args[args.indexOf('-metadata') + 1], 'title=第1話 旅立ち (condensed)');
  assert.equal(await file.text(), 'condensed-mp3');
  assert.equal((await client.call(`/audio/file${query}`, { auth: false })).status, 401);
  assert.equal((await client.call(`/audio${query}`, { auth: false })).status, 401);
  assert.equal((await client.call('/audio?url=https://example.com/video')).status, 400);
});

test('an FFmpeg failure is reported and can be retried; cancelled preparations keep no audio', async t => {
  const client = await start(t);
  const job = await prepare(client);
  const kept = path.join(client.dataDir, 'jobs', job.id, 'kept-audio.mp3');
  await fs.writeFile(kept, 'broken');
  await client.call(`/audio/condensed${query}`, { method: 'POST', json: {} });
  const failed = await settled(client);
  assert.equal(failed.export.state, 'error');
  assert.match(failed.export.message, /could not read the audio/);
  await fs.writeFile(kept, 'soundtrack');
  await client.call(`/audio/condensed${query}`, { method: 'POST', json: { skipSongs: true } });
  // Every fixture line lies inside the first 90 seconds.
  assert.equal((await settled(client)).export.state, 'error');
  assert.equal((await client.call(`/audio/condensed${query}`, { method: 'POST', json: { skipSongs: true } })).status, 409);
  await client.call(`/audio/condensed${query}`, { method: 'POST', json: {} });
  assert.equal((await settled(client)).export.state, 'ready');

  // A newer preparation that fails takes its partial soundtrack with it.
  const second = await prepare(client, 'fail');
  assert.equal(second.state, 'error');
  await assert.rejects(fs.stat(path.join(client.dataDir, 'jobs', second.id, 'kept-audio.mp3')), error => error.code === 'ENOENT');
  assert.equal((await (await client.call(`/audio${query}`)).json()).available, false);
});
