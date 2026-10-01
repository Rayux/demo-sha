import test from 'node:test';
import assert from 'node:assert/strict';
import { translateCues } from './translation.mjs';
const config = { model: 'gemma2' };
const cues = count => Array.from({ length: count }, (_, i) => ({ id: String(i), text: `日本語${i}`, start: i, end: i + .9 }));
const itemsIn = init => JSON.parse(JSON.parse(init.body).messages.at(-1).content.split('\n').at(-1)).items;
const response = items => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: items.map(({id}) => ({ id, translation: `繁體中文${id}` })) }) } }] }));

test('larger batches translate every cue without changing its text or timestamps', async () => {
  for (const batchSize of [4, 8, 12]) {
    const track = cues(24), original = structuredClone(track), requests = [], metrics = [];
    await translateCues(track, config, { batchSize, onMetrics: metric => metrics.push(metric), fetchImpl: async (_url, init) => {
      const items = itemsIn(init); requests.push(items.length); return response([...items].reverse());
    } });
    assert.deepEqual(requests, Array(24 / batchSize).fill(batchSize));
    assert.deepEqual(track.map(({translation, ...cue}) => cue), original);
    assert.ok(track.every(cue => cue.translation === `繁體中文${cue.id}`));
    assert.equal(metrics.reduce((sum, metric) => sum + metric.requests, 0), requests.length);
    assert.ok(metrics.every(metric => metric.requestMs >= 0 && metric.queueMs >= 0 && metric.retries === 0));
  }
});

test('large batches retain good lines and retry missing or duplicated ids individually', async () => {
  const track = cues(8), requests = [], metrics = [];
  await translateCues(track, config, { batchSize: 8, onMetrics: metric => metrics.push(metric), fetchImpl: async (_url, init) => {
    const items = itemsIn(init); requests.push(items.map(item => item.id));
    return response(requests.length === 1 ? [...items.slice(0, 6), items[0], {id:'unknown'}] : items);
  } });
  assert.deepEqual(requests.map(items => items.length), [8, 1, 1, 1]);
  assert.ok(track.every(cue => cue.translation === `繁體中文${cue.id}`));
  assert.equal(metrics.reduce((sum, metric) => sum + metric.retries, 0), 3);
});

test('long lines bound batch input size even when twelve lines are requested', async () => {
  const track = cues(4).map(cue => ({ ...cue, text: 'あ'.repeat(900) }));
  const sizes = [];
  await translateCues(track, config, { batchSize: 12, fetchImpl: async (_url, init) => {
    const items = itemsIn(init); sizes.push(items.length); return response(items);
  } });
  assert.deepEqual(sizes, [1, 1, 1, 1]);
});

test('time spent waiting for another video is separate from inference time and cancelled waiters make no request', async () => {
  const metrics = [];
  await translateCues(cues(1), config, { onMetrics: metric => metrics.push(metric),
    scheduleRequest: async run => { await new Promise(resolve => setTimeout(resolve, 30)); return run(); },
    fetchImpl: async (_url, init) => response(itemsIn(init)) });
  assert.ok(metrics[0].queueMs >= 20);
  assert.equal(metrics[0].requests, 1);
  const controller = new AbortController();
  await assert.rejects(translateCues(cues(1), config, { signal: controller.signal, onMetrics: metric => metrics.push(metric),
    scheduleRequest: async () => { controller.abort(); controller.signal.throwIfAborted(); },
    fetchImpl: () => assert.fail('Cancelled wait must never reach Ollama') }), { name: 'AbortError' });
  assert.equal(metrics[1].requests, 0);
  assert.equal(metrics[1].requestMs, 0);
});
