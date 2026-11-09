import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const bundle = read('vendor/googlevideo/sabr.js');

test('SABR distribution is pinned, self-contained, and ordered before the YouTube adapter', () => {
  const provenance = JSON.parse(read('vendor/googlevideo/provenance.json'));
  assert.equal(createHash('sha256').update(bundle).digest('hex'), provenance.bundleSHA256);
  assert.match(provenance.commit, /^[a-f0-9]{40}$/);
  assert.doesNotMatch(bundle, /\beval\s*\(|\bnew\s+Function\b|\bimport\s*\(/);
  const manifest = JSON.parse(read('manifest.json'));
  const group = manifest.content_scripts.find(group => group.js.includes('content/youtube-sabr-main.js'));
  assert.equal(group.world, 'MAIN');
  assert.equal(group.run_at, 'document_start');
  assert.deepEqual(group.matches, ['*://*.youtube.com/*']);
  assert.deepEqual(group.js, ['vendor/googlevideo/sabr.js', 'content/youtube-sabr-main.js', 'content/youtube-audio-main.js']);
});

test('vendored browser protocol loads without network or dynamic code and round-trips playback context', () => {
  let calls = 0;
  const context = vm.createContext({ Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder,
    atob, btoa, URL, ReadableStream, ByteLengthQueuingStrategy, AbortController,
    setTimeout, clearTimeout, console,
    fetch: () => { calls++; throw new Error('Unexpected network during load'); } },
  { codeGeneration: { strings: false, wasm: false } });
  // Chromium may scope content-script declarations to the injected function.
  // The bundled runtime must still be visible to the following MAIN script.
  vm.runInContext(`(function(){${bundle}\n})();`, context);
  const protocol = context.KageSabrProtocol;
  assert.equal(typeof protocol.SabrStream, 'function');
  assert.equal(typeof protocol.buildSabrFormat, 'function');
  assert.equal(typeof protocol.Logger.getInstance().setLogLevels, 'function');
  const native = { ...protocol.VideoPlaybackAbrRequest.decode(new Uint8Array()),
    videoPlaybackUstreamerConfig: new Uint8Array([1, 2]), streamerContext: {
      clientInfo: { clientName: 1, clientVersion: 'test-browser' }, poToken: new Uint8Array([3, 4]),
      sabrContexts: [], unsentSabrContexts: []
    }, selectedAudioFormatIds: [{ itag: 140, lastModified: '123', xtags: '' }] };
  const decoded = protocol.VideoPlaybackAbrRequest.decode(protocol.VideoPlaybackAbrRequest.encode(native).finish());
  assert.deepEqual([...decoded.videoPlaybackUstreamerConfig], [1, 2]);
  assert.deepEqual([...decoded.streamerContext.poToken], [3, 4]);
  assert.equal(decoded.streamerContext.clientInfo.clientVersion, 'test-browser');
  assert.equal(decoded.selectedAudioFormatIds[0].itag, 140);
  assert.equal(calls, 0);
});
