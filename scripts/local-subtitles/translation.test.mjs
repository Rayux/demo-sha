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

test('large batches retain good lines and retry missing or duplicated ids together', async () => {
  const track = cues(8), requests = [], metrics = [];
  await translateCues(track, config, { batchSize: 8, onMetrics: metric => metrics.push(metric), fetchImpl: async (_url, init) => {
    const items = itemsIn(init); requests.push(items.map(item => item.id));
    return response(requests.length === 1 ? [...items.slice(0, 6), items[0], {id:'unknown'}] : items);
  } });
  assert.deepEqual(requests.map(items => items.length), [8, 3]);
  assert.ok(track.every(cue => cue.translation === `繁體中文${cue.id}`));
  assert.equal(metrics.reduce((sum, metric) => sum + metric.retries, 0), 1);
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

test('numeric model IDs align exactly and mixed numeric/string duplicates are retried', async () => {
  const track = cues(3), requests = [];
  await translateCues(track, config, { fetchImpl: async (_url, init) => {
    const items = itemsIn(init); requests.push(items.map(item => item.id));
    const result = items.map(item => ({ id: Number(item.id), translation: `中文${item.id}` }));
    if (requests.length === 1) result.push({ id: '1', translation: 'duplicate' });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ translations: result }) } }] });
  } });
  assert.deepEqual(requests, [['0', '1', '2'], ['1']]);
  assert.deepEqual(track.map(cue => cue.translation), ['中文0', '中文1', '中文2']);
});

test('a malformed line does not block later batches and retry requests only the remaining gap', async () => {
  const track = cues(18), requests = [];
  await assert.rejects(translateCues(track, config, { fetchImpl: async (_url, init) => {
    const items = itemsIn(init); requests.push(items.map(item => item.id));
    return response(items.filter(item => item.id !== '2'));
  } }), error => error.code === 'INVALID_SUBTITLE_RESPONSE' && /1 subtitle line/.test(error.message));
  assert.equal(track.filter(cue => cue.translation).length, 17);
  assert.equal(track[17].translation, '繁體中文17');
  assert.ok(requests.length <= 6, 'invalid responses have bounded retries');
  const retried = [];
  await translateCues(track, config, { fetchImpl: async (_url, init) => {
    const items = itemsIn(init); retried.push(...items.map(item => item.id)); return response(items);
  } });
  assert.deepEqual(retried, ['2']);
});

test('schema constrains response fields, IDs and batch length, including individual repairs', async () => {
  let calls = 0;
  await translateCues(cues(2), config, { fetchImpl: async (_url, init) => {
    const items = itemsIn(init);
    const format = JSON.parse(init.body).response_format;
    assert.equal(format.type, 'json_schema');
    assert.equal(format.json_schema.strict, true);
    assert.ok(!JSON.parse(init.body).messages.at(-1).content.includes(JSON.stringify(format.json_schema.schema)));
    const schema = format.json_schema.schema;
    assert.deepEqual(schema.required, ['translations']);
    assert.equal(schema.additionalProperties, false);
    const translations = schema.properties.translations;
    assert.equal(translations.type, 'object');
    assert.deepEqual(translations.required, items.map(item => item.id));
    assert.equal(translations.additionalProperties, false);
    for (const item of items) {
      assert.equal(translations.properties[item.id].type, 'string');
      assert.equal(translations.properties[item.id].minLength, 1);
    }
    return response(++calls === 1 ? items.slice(0, 1) : items);
  } });
  assert.equal(calls, 2);
});

test('temporary failures retry twice outside the shared slot and count actual attempts', async () => {
  for (const failure of [() => { throw new TypeError('fetch failed'); },
    ...[408, 429, 500, 502, 503, 504].map(status => () => new Response('', { status }))]) {
    let calls = 0, inSlot = false;
    const waits = [], diagnostics = [], metrics = [];
    const track = cues(1);
    await translateCues(track, config, {
      scheduleRequest: async run => { inSlot = true; try { return await run(); } finally { inSlot = false; } },
      waitBeforeRetry: async ms => { assert.equal(inSlot, false); waits.push(ms); },
      onDiagnostic: event => diagnostics.push(event), onMetrics: event => metrics.push(event),
      fetchImpl: async (_url, init) => ++calls <= 2 ? failure() : response(itemsIn(init)),
    });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [1000, 3000]);
    assert.deepEqual(diagnostics.map(event => event.retry), [true, true]);
    assert.equal(metrics.reduce((sum, event) => sum + event.retries, 0), 2);
    assert.equal(track[0].translation, '繁體中文0');
  }
});

test('a request timeout is retried with a fresh signal', async () => {
  let calls = 0;
  const diagnostics = [];
  await translateCues(cues(1), config, { requestTimeoutMs: 10, waitBeforeRetry: async () => {},
    onDiagnostic: event => diagnostics.push(event), fetchImpl: async (_url, init) => {
      if (++calls > 1) { assert.equal(init.signal.aborted, false); return response(itemsIn(init)); }
      await new Promise((resolve, reject) => {
        const keepAlive = setTimeout(resolve, 1000);
        init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); }, { once: true });
      });
    } });
  assert.equal(calls, 2);
  assert.equal(diagnostics[0].code, 'TIMEOUT');
});

test('retry exhaustion preserves completed lines and permanent HTTP errors do not retry', async () => {
  for (const status of [503, 400, 401, 404]) {
    const track = cues(2); track[0].translation = '已儲存';
    let calls = 0;
    const diagnostics = [];
    await assert.rejects(translateCues(track, config, { waitBeforeRetry: async () => {},
      onDiagnostic: event => diagnostics.push(event), fetchImpl: async (_url, init) => {
        calls++; assert.deepEqual(itemsIn(init).map(item => item.id), ['1']);
        return new Response('', { status });
      } }), error => error.code === `HTTP_${status}`);
    assert.equal(calls, status === 503 ? 3 : 1);
    assert.equal(diagnostics.at(-1).retry, false);
    assert.equal(track[0].translation, '已儲存');
    assert.equal(track[1].translation, undefined);
  }
});

test('cancellation interrupts backoff and does not start another request', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(translateCues(cues(1), config, { signal: controller.signal,
    onDiagnostic: () => { setTimeout(() => controller.abort(), 10); },
    fetchImpl: async () => { calls++; throw new TypeError('fetch failed'); },
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('diagnostics distinguish bad JSON, missing fields, duplicate IDs, empty lines and truncation', async () => {
  const cases = [
    ['sensitive malformed response', ['malformed_json']],
    ['{}', ['invalid_shape']],
    [JSON.stringify({ translations: [{ id: '0', translation: '' }, { id: 0, translation: 'sensitive text' }, { id: 'bad', translation: 'text' }] }),
      ['empty_translation', 'duplicate_id', 'unknown_id', 'missing_translation']],
  ];
  for (const [content, expected] of cases) {
    const diagnostics = [];
    await assert.rejects(translateCues(cues(1), config, { onDiagnostic: event => diagnostics.push(event),
      fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'length', message: { content } }] }),
    }), error => error.code === 'INVALID_SUBTITLE_RESPONSE');
    assert.deepEqual(diagnostics[0].issues, [...expected, 'token_limit']);
    assert.deepEqual(diagnostics[0].missingIds, ['0']);
    assert.ok(!JSON.stringify(diagnostics).includes('sensitive'));
  }
});

test('compact responses keep cue alignment, reject invalid values and salvage unrelated duplicate keys', async () => {
  for (const duplicated of ['"0"', '"\\u0030"']) {
    const track = cues(4), requested = [];
    await translateCues(track, config, { fetchImpl: async (_url, init) => {
      const items = itemsIn(init); requested.push(items.map(item => item.id));
      const content = requested.length === 1
        ? `{"translations":{"3":"保留標點：{\\"字\\"}, [句子]","0":"不可信",${duplicated}:"也不可信","1":"已完成","2":null,"unknown":"忽略"}}`
        : JSON.stringify({ translations: Object.fromEntries(items.map(item => [item.id, `修正${item.id}`])) });
      return Response.json({ choices: [{ message: { content } }] });
    } });
    assert.deepEqual(requested, [['0', '1', '2', '3'], ['0', '2']]);
    assert.deepEqual(track.map(cue => cue.translation), ['修正0', '已完成', '修正2', '保留標點：{"字"}, [句子]']);
  }
});

test('duplicate root objects cannot overwrite an apparently valid set of translations', async () => {
  const track = cues(1); let calls = 0;
  await translateCues(track, config, { fetchImpl: async (_url, init) => {
    if (++calls === 1) return Response.json({ choices: [{ message: { content: '{"translations":{"0":"錯"},"translations":{"0":"也不可信"}}' } }] });
    return response(itemsIn(init));
  } });
  assert.equal(calls, 2);
  assert.equal(track[0].translation, '繁體中文0');
});

test('nonadjacent gap repairs preserve nearby context and never re-request saved lines', async () => {
  const track = cues(8), requested = [];
  await translateCues(track, config, { fetchImpl: async (_url, init) => {
    const payload = JSON.parse(JSON.parse(init.body).messages.at(-1).content.split('\n').at(-1));
    requested.push(payload.items.map(item => item.id));
    if (requested.length === 1) return response(payload.items.filter(item => item.id !== '0' && item.id !== '7'));
    assert.deepEqual(payload.context, ['日本語1', '日本語2', '日本語5', '日本語6']);
    return response(payload.items);
  } });
  assert.deepEqual(requested, [['0', '1', '2', '3', '4', '5', '6', '7'], ['0', '7']]);
  const repeat = [];
  await translateCues(track, config, { fetchImpl: () => { repeat.push(1); assert.fail('Saved lines must not be requested'); } });
  assert.deepEqual(repeat, []);
});

test('fully malformed batches split with a finite request budget and allow sibling lines to finish', async () => {
  for (const count of [1, 8]) {
    let calls = 0;
    await assert.rejects(translateCues(cues(count), config, { fetchImpl: async () => {
      calls++; return Response.json({ choices: [{ message: { content: '{}' } }] });
    } }), error => error.code === 'INVALID_SUBTITLE_RESPONSE');
    assert.equal(calls, count === 1 ? 2 : 15);
  }
  const track = cues(8), requested = [];
  await assert.rejects(translateCues(track, config, { fetchImpl: async (_url, init) => {
    const items = itemsIn(init); requested.push(items.map(item => item.id));
    return response(items.length === 1 && items[0].id !== '0' ? items : []);
  } }), error => error.code === 'INVALID_SUBTITLE_RESPONSE');
  assert.equal(track[0].translation, undefined);
  assert.ok(track.slice(1).every(cue => cue.translation));
  assert.equal(requested.length, 15);
});

test('cancelling after saved partial progress prevents every gap repair', async () => {
  const controller = new AbortController(), track = cues(8); let calls = 0;
  await assert.rejects(translateCues(track, config, { signal: controller.signal,
    onProgress: async () => controller.abort(),
    fetchImpl: async (_url, init) => { calls++; return response(itemsIn(init).slice(0, 4)); },
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.ok(track.slice(0, 4).every(cue => cue.translation));
  assert.ok(track.slice(4).every(cue => !cue.translation));
});
