import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const functions = app.slice(app.indexOf('function renderFullPlaybackButtons()'), app.indexOf('\nfunction seekBy('));
const cancel = app.slice(app.indexOf('function cancelPracticePlayback()'), app.indexOf('\nfunction renderPlaybackMode('));
function harness() {
  const button = () => ({ textContent: '', setAttribute() {} });
  const state = { library: Array.from({ length: 12 }, (_, i) => ({ name: `episode${i + 1}.mp3`, url: `/audio/${i + 1}` })), clips: [], rate: 1.15, playbackGeneration: 0 };
  state.source = state.library[0];
  const calls = { sources: [], recording: 0, practiceEnds: 0, renders: [] };
  const audio = { paused: true, ended: false, currentTime: 10, pause() { this.paused = true; }, play() { this.paused = false; this.ended = false; return Promise.resolve(); } };
  const context = vm.createContext({ state, ui: { audio, playFull: button(), playLibrary: button() },
    playbackLoopId: 0, cancelAnimationFrame() {}, cancelPendingRecording() {}, toast() {},
    finishClipPlayback() { calls.practiceEnds++; }, renderActiveClip(preserve) { calls.renders.push(preserve); },
    async setSource(track, options) { context.cancelPracticePlayback(); state.source = track; audio.currentTime = 0; audio.ended = false; calls.sources.push(track.name); if (options?.continuousLibrary) context.startFullPlayback(true); }
  });
  vm.runInContext(cancel + functions, context);
  return { context, state, calls, audio };
}

test('Play Full runs through all 12 episodes twice and wraps to episode 1', async () => {
  const { context, state, calls, audio } = harness();
  context.toggleLibraryPlayback();
  for (let i = 0; i < 24; i++) { audio.ended = true; audio.paused = true; context.handleAudioEnded(); }
  await Promise.resolve();
  assert.deepEqual(calls.sources, Array.from({ length: 24 }, (_, i) => `episode${(i + 1) % 12 + 1}.mp3`));
  assert.equal(state.source.name, 'episode1.mp3');
  assert.equal(state.playLibrary, true);
  assert.equal(audio.playbackRate, 1.15);
  assert.equal(calls.practiceEnds, 0);
  assert.equal(context.ui.playLibrary.textContent, 'Pause Full');
});

test('pausing stops the playlist; Play All keeps playback within the current episode', () => {
  const { context, state, calls, audio } = harness();
  context.toggleLibraryPlayback();
  context.toggleLibraryPlayback();
  assert.equal(state.playLibrary, false);
  assert.equal(audio.paused, true);
  context.toggleLibraryPlayback();
  context.toggleFullPlayback();
  assert.equal(state.playLibrary, false);
  assert.equal(state.playFullTrack, true);
  audio.ended = true; context.handleAudioEnded();
  assert.equal(calls.sources.length, 0);
  assert.equal(state.playFullTrack, false);
});

test('starting from an uploaded file begins with episode 1 and recording blocks playback', () => {
  const { context, state, calls } = harness();
  state.source = { name: 'upload.mp3', file: {} };
  state.recorder = { state: 'recording' };
  context.toggleLibraryPlayback();
  assert.equal(calls.sources.length, 0);
  state.recorder = null;
  context.toggleLibraryPlayback();
  assert.deepEqual(calls.sources, ['episode1.mp3']);
});

test('full playback follows transcript clips without restarting or stopping audio', () => {
  const { context, state, calls, audio } = harness();
  state.clips = [{ start: 0, end: 3 }, { start: 8, end: 12 }]; state.active = 0;
  context.toggleLibraryPlayback();
  context.syncFullPlaybackClip();
  assert.equal(state.active, 1);
  assert.deepEqual(calls.renders, [true]);
  assert.equal(audio.currentTime, 10);
  assert.equal(audio.paused, false);
});

test('a stale play rejection cannot cancel a newly selected episode', async () => {
  const { context, state, audio } = harness();
  let reject;
  audio.play = () => new Promise((resolve, fail) => { reject = fail; });
  context.startFullPlayback(true);
  audio.play = () => { audio.paused = false; return Promise.resolve(); };
  context.startFullPlayback(true);
  reject(new Error('previous source aborted'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state.playLibrary, true);
  assert.equal(audio.paused, false);
});
