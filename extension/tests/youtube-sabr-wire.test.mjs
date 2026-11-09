import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const vendor = read('vendor/googlevideo/sabr.js');
const PAGE = 'https://www.youtube.com/watch?v=KGbMdRhWFz4';
const VIDEO_ID = 'KGbMdRhWFz4';
const SABR = 'https://rr1.googlevideo.com/videoplayback?id=fixture-media&source=youtube&expire=9999999999&sig=fixture-signature';
const MIME = 'audio/mp4; codecs="mp4a.40.2"';
const SEGMENT_MS = 10000;
const LAST_MODIFIED = '1700000000000000';
const utf8 = new TextEncoder();
const concat = (...chunks) => {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
};

// Independent minimal protobuf encoders keep the fixture on the wire. Only the
// shipped vendor is responsible for decoding headers and assembling segments.
function protobufVarint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do { bytes.push(Number(remaining & 127n) | (remaining > 127n ? 128 : 0)); remaining >>= 7n; } while (remaining);
  return new Uint8Array(bytes);
}
const numberField = (field, value) => concat(protobufVarint(field * 8), protobufVarint(value));
const bytesField = (field, bytes) => concat(protobufVarint(field * 8 + 2), protobufVarint(bytes.length), bytes);
const textField = (field, text) => bytesField(field, utf8.encode(text));
const formatId = () => concat(numberField(1, 140), numberField(2, LAST_MODIFIED));

// UMP uses a length-prefix varint different from protobuf's base-128 encoding.
function umpVarint(value) {
  if (value < 128) return new Uint8Array([value]);
  if (value < 16384) return new Uint8Array([(value & 63) | 128, value >> 6]);
  if (value < 2097152) return new Uint8Array([(value & 31) | 192, (value >> 5) & 255, value >> 13]);
  throw new Error('Fixture UMP part is unexpectedly large');
}
const part = (type, bytes) => concat(umpVarint(type), umpVarint(bytes.length), bytes);
function box(type, payload = new Uint8Array()) {
  const bytes = new Uint8Array(payload.length + 8);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(utf8.encode(type), 4); bytes.set(payload, 8);
  return bytes;
}
const initializationBytes = () => concat(box('ftyp', utf8.encode('isom0000')), box('moov'));
const segmentBytes = number => concat(box('moof'), box('mdat', new Uint8Array(257).fill(number % 251)));

function initializationMetadata(totalSegments) {
  return part(42, concat(textField(1, VIDEO_ID), bytesField(2, formatId()),
    numberField(4, totalSegments), textField(5, MIME),
    numberField(9, totalSegments * SEGMENT_MS), numberField(10, 1000)));
}
function mediaSegment(number, { declaredLength, videoId = VIDEO_ID } = {}) {
  const initialization = number === 0;
  const bytes = initialization ? initializationBytes() : segmentBytes(number);
  const headerId = number + 1;
  const header = concat(numberField(1, headerId), textField(2, videoId), numberField(3, 140),
    numberField(4, LAST_MODIFIED), numberField(6, initialization ? 0 : 24 + (number - 1) * bytes.length),
    numberField(8, initialization ? 1 : 0), numberField(9, number),
    numberField(11, initialization ? 0 : (number - 1) * SEGMENT_MS),
    numberField(12, initialization ? 0 : SEGMENT_MS), bytesField(13, formatId()),
    numberField(14, declaredLength ?? bytes.length));
  return concat(part(20, header), part(21, concat(new Uint8Array([headerId]), bytes)), part(22, new Uint8Array([headerId])));
}

function streamedUmp(bytes) {
  let offset = 0, piece = 0;
  const sizes = [1, 3, 17, 129, 7];
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(bytes.length, offset + sizes[piece++ % sizes.length]);
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    }
  }), { headers: { 'Content-Type': 'application/vnd.yt-ump' } });
}

async function harness({ totalSegments = 3, skipSegment } = {}) {
  const calls = [], listeners = new Map(), timers = new Map(), intervals = new Set();
  const clock = {
    setTimeout(callback, duration, ...args) {
      const timer = setTimeout(() => { timers.delete(timer); callback(...args); }, duration);
      timers.set(timer, duration); return timer;
    },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    setInterval(callback, duration) { const interval = setInterval(callback, duration); intervals.add(interval); return interval; },
    clearInterval(interval) { intervals.delete(interval); clearInterval(interval); }
  };
  const format = { itag: 140, lastModified: LAST_MODIFIED, mimeType: MIME, audioQuality: 'AUDIO_QUALITY_MEDIUM',
    bitrate: 128000, approxDurationMs: String(totalSegments * SEGMENT_MS), audioChannels: 2 };
  const playerResponse = { playabilityStatus: { status: 'OK' },
    videoDetails: { videoId: VIDEO_ID, lengthSeconds: String(totalSegments * SEGMENT_MS / 1000) },
    streamingData: { serverAbrStreamingUrl: SABR, adaptiveFormats: [format] },
    playerConfig: { mediaCommonConfig: { mediaUstreamerRequestConfig: { videoPlaybackUstreamerConfig: 'AQID' } } } };
  const location = { href: PAGE, origin: 'https://www.youtube.com', hostname: 'www.youtube.com' };
  let protocol, capturing = false;
  const window = { ytInitialPlayerResponse: playerResponse,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    fetch: async (input, options) => {
      if (capturing) return streamedUmp(new Uint8Array());
      const request = protocol.VideoPlaybackAbrRequest.decode(new Uint8Array(options.body));
      calls.push({ url: String(input), options, request });
      assert.ok(calls.length <= totalSegments + 2, 'download must finish without repeatedly requesting the same media');
      const number = calls.length === 1 ? 1 : Math.floor(Number(request.clientAbrState.playerTimeMs) / SEGMENT_MS) + 1;
      const next = number === skipSegment ? number + 1 : number;
      return streamedUmp(concat(...(calls.length === 1 ? [initializationMetadata(totalSegments), mediaSegment(0)] : []), mediaSegment(next)));
    } };
  const document = { getElementById: () => ({ getPlayerResponse: () => playerResponse }),
    querySelector: () => ({ duration: totalSegments * SEGMENT_MS / 1000, paused: true }) };
  class XMLHttpRequest { open() {} addEventListener() {} send() {} }
  const context = vm.createContext({ window, location, document, XMLHttpRequest,
    URL, URLSearchParams, Request, Response, Headers, Blob, ReadableStream, ByteLengthQueuingStrategy,
    Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder, AbortController, DOMException,
    atob, btoa, ...clock, performance, console });
  vm.runInContext(vendor, context);
  protocol = context.KageSabrProtocol;
  window.KageSabrProtocol = protocol;
  vm.runInContext(read('content/youtube-sabr-main.js'), context);
  capturing = true;
  await window.fetch(SABR, { method: 'POST', headers: { 'Content-Type': 'application/x-protobuf' },
    body: protocol.VideoPlaybackAbrRequest.encode({ clientAbrState: { playerTimeMs: '369000', enabledTrackTypesBitfield: 0 },
      videoPlaybackUstreamerConfig: new Uint8Array([1, 2, 3]),
      selectedAudioFormatIds: [{ itag: 140, lastModified: LAST_MODIFIED }],
      streamerContext: { clientInfo: { clientName: 1, clientVersion: '2.20261018.01.00' }, poToken: new Uint8Array([4, 5, 6]), sabrContexts: [], unsentSabrContexts: [] },
      selectedVideoFormatIds: [], bufferedRanges: [], initializationFormatIds: [], selectedCaptionFormatIds: [], ssapPlaybackInfos: [], field1000: [] }).finish() });
  await new Promise(resolve => setImmediate(resolve));
  capturing = false;
  return { calls, window, context, timers, intervals,
    cleanup() { for (const timer of timers.keys()) clearTimeout(timer); for (const interval of intervals) clearInterval(interval); } };
}

test('bundled SABR protocol downloads complete audio before playback across advancing audio-only requests', { timeout: 5000 }, async t => {
  const h = await harness();
  t.after(() => h.cleanup());
  const result = await h.window.KageYouTubeSabr.download({ page: PAGE, signal: new AbortController().signal, maxBytes: 128 * 1024 * 1024 });
  assert.deepEqual(new Uint8Array(result.bytes), concat(initializationBytes(), segmentBytes(1), segmentBytes(2), segmentBytes(3)));
  assert.equal(result.mime.split(';')[0], 'audio/mp4');
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls.map(call => call.request.clientAbrState.playerTimeMs), ['0', '10000', '20000']);
  assert.deepEqual(h.calls.map(call => new URL(call.url).searchParams.get('rn')), ['0', '1', '2']);
  for (const { request } of h.calls) {
    assert.equal(request.clientAbrState.enabledTrackTypesBitfield, h.context.KageSabrProtocol.EnabledTrackTypes.AUDIO_ONLY);
    assert.equal(request.selectedVideoFormatIds.length, 0);
    assert.deepEqual(Array.from(request.selectedAudioFormatIds, format => format.itag), [140]);
    assert.deepEqual(request.videoPlaybackUstreamerConfig, new Uint8Array([1, 2, 3]));
  }
  assert.equal(h.calls[0].request.initializationFormatIds.length, 0);
  assert.equal(h.calls[1].request.initializationFormatIds[0].itag, 140);
  assert.equal(h.calls[2].request.bufferedRanges[0].endSegmentIndex, 2);
  assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
});

test('independent completeness ledger survives real protocol eviction after more than 64 segments', { timeout: 5000 }, async t => {
  const h = await harness({ totalSegments: 70 });
  t.after(() => h.cleanup());
  const result = await h.window.KageYouTubeSabr.download({ page: PAGE, signal: new AbortController().signal, maxBytes: 128 * 1024 * 1024 });
  assert.deepEqual(new Uint8Array(result.bytes), concat(initializationBytes(), ...Array.from({ length: 70 }, (_, index) => segmentBytes(index + 1))));
  assert.equal(h.calls.length, 70);
  assert.equal(h.calls.at(-1).request.clientAbrState.playerTimeMs, '690000');
  assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
});

test('missing real UMP segment is rejected even if the vendor sees its declared final segment', { timeout: 5000 }, async t => {
  const h = await harness({ skipSegment: 2 });
  t.after(() => h.cleanup());
  await assert.rejects(h.window.KageYouTubeSabr.download({ page: PAGE, signal: new AbortController().signal, maxBytes: 128 * 1024 * 1024 }), /YT_SABR_(?:INCOMPLETE|SEQUENCE)/);
  assert.equal(h.calls.length, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...h.timers.values()], []); assert.equal(h.intervals.size, 0);
});
