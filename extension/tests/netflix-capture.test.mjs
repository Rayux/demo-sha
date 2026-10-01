import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = file => readFileSync(new URL(`../content/${file}`, import.meta.url), 'utf8');
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const subtitle = 'WEBVTT\n\n00:00.000 --> 00:02.000\n字幕';
const track = (id, language = 'ja', overrides = {}) => ({
  id: `${id}-${language}`, language,
  downloadables: { webvtt: { urls: [{ url: `https://cdn.nflxvideo.net/${id}-${language}.vtt` }] } },
  ...overrides
});
const manifest = (id, languages = ['ja', 'zh-Hant']) => ({ result: { movieId: id, textTracks: languages.map(language => track(id, language)) } });

function harness(pathname = '/browse', deferred = false) {
  const posted = [], calls = [], pending = [];
  const location = { hostname: 'www.netflix.com', pathname, href: `https://www.netflix.com${pathname}`, origin: 'https://www.netflix.com' };
  class FixtureResponse extends Response {}
  const response = () => new FixtureResponse(subtitle, { headers: { 'content-type': 'text/vtt' } });
  class XHR {
    open() {}
    send() {}
    addEventListener(type, handler) { if (type === 'load') this.load = handler; }
    getResponseHeader() { return this.contentType || 'application/json'; }
  }
  let onMessage;
  const window = {
    addEventListener(type, handler) { if (type === 'message') onMessage = handler; },
    postMessage(message) { posted.push(message); },
    fetch: async url => {
      calls.push(url);
      return deferred ? new Promise(resolve => pending.push(() => resolve(response()))) : response();
    }
  };
  const context = vm.createContext({ window, location, URL, TextDecoder, Response: FixtureResponse, XMLHttpRequest: XHR });
  vm.runInContext(read('netflix-tracks.js'), context);
  vm.runInContext(read('inject.js'), context);
  return {
    context, calls, pending, posted,
    parse(value) { context.fixtureJSON = JSON.stringify(value); vm.runInContext('JSON.parse(fixtureJSON)', context); },
    navigate(path) { location.pathname = path; location.href = `${location.origin}${path}`; },
    ready() { onMessage({ source: window, origin: location.origin, data: { type: 'KAGE_TRACKS_READY' } }); },
    async xhr(value, responseType, url = 'https://www.netflix.com/manifest', contentType = 'application/json') {
      const xhr = new XHR();
      xhr.open('GET', url);
      xhr.responseType = responseType;
      xhr.response = value;
      xhr.responseText = typeof value === 'string' ? value : '';
      xhr.contentType = contentType;
      xhr.send();
      await xhr.load();
      await flush();
    },
    subtitles: () => posted.filter(message => message.type === 'KAGE_RAW_SUBTITLES')
  };
}

test('Browse manifests are retained without downloads and replayed only for the exact watch title', async () => {
  const h = harness();
  h.parse(manifest(123));
  assert.equal(h.calls.length, 0);
  h.navigate('/watch/1234'); h.ready();
  assert.equal(h.calls.length, 0);
  h.navigate('/watch/123extra'); h.ready();
  assert.equal(h.calls.length, 0);
  h.navigate('/watch/123'); h.ready();
  await flush();
  assert.deepEqual(h.calls, ['https://cdn.nflxvideo.net/123-ja.vtt', 'https://cdn.nflxvideo.net/123-zh-Hant.vtt']);
  assert.deepEqual(h.subtitles().map(message => message.language).sort(), ['ja', 'zh-Hant']);
  h.ready(); h.parse(manifest(123)); await flush();
  assert.equal(h.calls.length, 2);
});

test('already-decoded XHR JSON and bounded textual JSON manifests are captured', async () => {
  const h = harness('/watch/123');
  await h.xhr(manifest(123, ['ja']), 'json');
  await h.xhr(JSON.stringify(manifest(123, ['zh-Hant'])), 'text');
  assert.deepEqual(h.calls, ['https://cdn.nflxvideo.net/123-ja.vtt', 'https://cdn.nflxvideo.net/123-zh-Hant.vtt']);
  assert.equal(h.subtitles().length, 2);
});

test('XHR manifests reject unrelated response hosts and do not decode binary responses as manifests', async () => {
  const h = harness('/watch/123');
  await h.xhr(manifest(123), 'json', 'https://evil.example/manifest');
  await h.xhr(new TextEncoder().encode(JSON.stringify(manifest(123))).buffer, 'arraybuffer', 'https://cdn.nflxvideo.net/media', 'video/mp4');
  await h.xhr(JSON.stringify(manifest(123)), 'text', 'https://www.netflix.com/manifest', 'text/plain');
  assert.equal(h.calls.length, 0);
  assert.equal(h.subtitles().length, 0);
});

test('navigation invalidates download deduplication and late responses cannot replace a new download', async () => {
  const h = harness('/watch/123', true);
  h.parse(manifest(123, ['ja']));
  h.navigate('/watch/456'); h.ready();
  h.navigate('/watch/123'); h.ready();
  assert.equal(h.calls.length, 2);
  h.pending[0](); await flush();
  assert.equal(h.subtitles().length, 0);
  h.pending[1](); await flush();
  assert.equal(h.subtitles().length, 1);
  h.ready(); await flush();
  assert.equal(h.calls.length, 2);
});

test('signed download URL changes can retry an identical track ID', async () => {
  const h = harness('/watch/123');
  h.parse(manifest(123, ['ja'])); await flush();
  const refreshed = manifest(123, ['ja']);
  refreshed.result.textTracks[0].downloadables.webvtt.urls[0].url += '?signature=new';
  h.parse(refreshed); await flush();
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1], /signature=new/);
});

test('only four recent title manifests are retained', async () => {
  const h = harness();
  for (let id = 1; id <= 5; id++) h.parse(manifest(id, ['ja']));
  h.navigate('/watch/1'); h.ready();
  assert.equal(h.calls.length, 0);
  h.navigate('/watch/2'); h.ready(); await flush();
  assert.deepEqual(h.calls, ['https://cdn.nflxvideo.net/2-ja.vtt']);
});

test('discovery retains explicit title IDs, bounded metadata, and existing language and CDN restrictions', () => {
  const h = harness();
  const api = h.context.KageNetflix;
  const value = { result: [
    { movieId: '123', textTracks: [track(123), track(123, 'zh-Hans'), track(123, 'zh-TW'), track(123, 'zh-Hant', { isForcedNarrative: true })] },
    { movieId: '1234', textTracks: [track(1234)] },
    { movieId: '123', nested: { textTracks: [track(123)] } },
    { movieId: { toString: () => '123' }, textTracks: [track(123)] },
    { movieId: 123, textTracks: [track(123, 'zh-Hant', { downloadables: { webvtt: { urls: ['https://nflxvideo.net.evil.example/sub.vtt'] } } })] }
  ] };
  assert.deepEqual(Array.from(api.extract(value, 123), item => item.language), ['ja', 'zh-Hant']);
  assert.deepEqual(Array.from(api.discover(value), item => item.videoId), ['123', '123', '1234']);
  assert.equal(api.extract(value, undefined).length, 0);
  const large = { movieId: 123, textTracks: Array.from({ length: 1000 }, () => track(123)) };
  assert.equal(api.discover(large).length, 64);
  assert.equal(api.safeURL(`https://cdn.nflxvideo.net/${'x'.repeat(8192)}`), null);
});
