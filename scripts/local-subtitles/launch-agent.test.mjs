import test from 'node:test';
import assert from 'node:assert/strict';
import { activateAgent } from './launch-agent.mjs';

const settings = { domain: 'gui/501', label: 'com.kage.local-subtitles', plist: '/tmp/helper.plist' };

test('an unchanged loaded service restarts without unregistering it', async () => {
  const calls = [];
  await activateAgent({ ...settings, isLoaded: true, unchanged: true, launch: (...args) => calls.push(args) });
  assert.deepEqual(calls, [['kickstart', '-k', 'gui/501/com.kage.local-subtitles']]);
});

test('changed service retries temporary bootstrap failure after one removal', async () => {
  const calls = [], waits = [];
  let attempts = 0;
  await activateAgent({ ...settings, isLoaded: true, unchanged: false,
    wait: async ms => waits.push(ms), launch: (...args) => {
      calls.push(args);
      if (args[0] === 'bootstrap' && ++attempts < 3) throw Object.assign(new Error('Input/output error'), { status: 5 });
    } });
  assert.deepEqual(calls.map(args => args[0]), ['bootout', 'bootstrap', 'bootstrap', 'bootstrap']);
  assert.deepEqual(waits, [250, 500]);
});

test('an existing plist with no registered service gets bootstrapped', async () => {
  const calls = [];
  await activateAgent({ ...settings, isLoaded: false, unchanged: true, launch: (...args) => calls.push(args) });
  assert.deepEqual(calls, [['bootstrap', 'gui/501', '/tmp/helper.plist']]);
});

test('persistent bootstrap failure stops after five attempts and preserves the error', async () => {
  const error = Object.assign(new Error('Input/output error'), { status: 5 });
  let attempts = 0;
  const waits = [];
  await assert.rejects(activateAgent({ ...settings, isLoaded: false,
    wait: async ms => waits.push(ms), launch: () => { attempts++; throw error; } }), thrown => thrown === error);
  assert.equal(attempts, 5);
  assert.deepEqual(waits, [250, 500, 1000, 2000]);
});

test('permission errors and failed restarts are surfaced without removing the service', async () => {
  for (const isLoaded of [false, true]) {
    const calls = [];
    const error = Object.assign(new Error('Operation not permitted'), { status: 1 });
    await assert.rejects(activateAgent({ ...settings, isLoaded, unchanged: true,
      wait: () => assert.fail('Permanent errors must not retry'),
      launch: (...args) => { calls.push(args[0]); throw error; } }), thrown => thrown === error);
    assert.deepEqual(calls, [isLoaded ? 'kickstart' : 'bootstrap']);
  }
});
