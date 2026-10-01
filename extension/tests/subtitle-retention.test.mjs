import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../background/subtitle-retention.js', import.meta.url), 'utf8');
const prefix = 'kageImportedTrackV2:';
const legacy = 'kageImportedTracksV1';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('startup and alarms clean expired transcripts with no open video tabs, preserving settings and recent tracks', async () => {
  let now = Date.now();
  const storage = {
    apiModel: 'gemma2',
    [prefix + 'old']: { key: 'old', expiresAt: now - 1 },
    [prefix + 'new']: { key: 'new', expiresAt: now + 1000 },
    [legacy]: [{ key: 'old', updatedAt: now }, { key: 'ancient', updatedAt: now - 4 * 86400000 }, { key: 'legacy', updatedAt: now }],
  };
  let alarm, schedule;
  vm.runInNewContext(source, {
    Date: class extends Date { static now() { return now; } }, console,
    chrome: {
      storage: { local: {
        get: async () => structuredClone(storage),
        set: async data => Object.assign(storage, structuredClone(data)),
        remove: async keys => { for (const key of keys) delete storage[key]; },
      } },
      alarms: { create: (name, options) => { schedule = { name, ...options }; }, onAlarm: { addListener: fn => { alarm = fn; } } },
    },
  });
  await flush();
  assert.equal(storage[prefix + 'old'], undefined);
  assert.ok(storage[prefix + 'new']);
  assert.deepEqual(storage[legacy].map(value => value.key), ['legacy']);
  assert.equal(schedule.periodInMinutes, 1);
  now += 1000;
  alarm({ name: schedule.name }); await flush();
  assert.equal(storage[prefix + 'new'], undefined);
  assert.equal(storage.apiModel, 'gemma2');
});
