import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import worker from './worker.mjs';
import { serveMedia } from './media.mjs';
import { handleAI, aiStatus } from './ai.mjs';
import { measureRhythm, cleanAssessment, wordCues } from './scoring.mjs';
import { encodeValue, decodeValue, setDocument, progressFieldPath } from './firestore.mjs';
import manifest from '../.cloudflare/media.json' with { type: 'json' };

const request = (path, options) => new Request(`https://kage.example${path}`, options);
const post = (path, value) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
function assets(files = {}) {
  return { async fetch(req) {
    const content = files[new URL(req.url).pathname];
    return content === undefined ? new Response('Missing', { status: 404 }) : Response.json(content);
  } };
}

test('status and the library work without any credentials', async () => {
  const status = await (await worker.fetch(request('/api/status'), {})).json();
  assert.equal(status.aiConfigured, false);
  assert.equal(status.groqChatModel, 'openai/gpt-oss-120b');
  const library = await (await worker.fetch(request('/api/library'), {})).json();
  assert.ok(library.files.length > 0);
  assert.deepEqual(library.files, manifest.files);
});

test('prepared lessons take precedence and reject autosave replacement', async () => {
  const original = { protectedImport: true, clips: [{ japanese: '本物' }] };
  const env = { ASSETS: assets({ '/transcripts/overrides/lesson.json': original }) };
  const loaded = await (await worker.fetch(request('/api/transcript?file=lesson.mp3'), env)).json();
  assert.deepEqual(loaded.data, original);
  const saved = await (await worker.fetch(post('/api/transcript', { filename: 'lesson.mp3', clips: [] }), env)).json();
  assert.deepEqual(saved, { success: true, protected: true });
});

test('static transcript fallback works and absent storage never reports a successful save', async () => {
  const env = { ASSETS: assets({ '/transcripts/lesson.json': { clips: [] } }) };
  assert.equal((await (await worker.fetch(request('/api/transcript?file=lesson.mp3'), env)).json()).exists, true);
  assert.equal((await worker.fetch(post('/api/transcript', { filename: 'new.mp3', clips: [] }), env)).status, 503);
  assert.deepEqual(await (await worker.fetch(post('/api/progress', { filename: 'new.mp3', masteredKeys: ['a'] }), env)).json(), { saved: false, available: false });
});

test('invalid requests and cross-origin writes fail without touching the database', async () => {
  assert.equal((await worker.fetch(request('/api/progress'), {})).status, 400);
  assert.equal((await worker.fetch(request('/api/no-such-route'), {})).status, 404);
  assert.equal((await worker.fetch(request('/api/progress', { method: 'POST', headers: { Origin: 'https://other.example' }, body: '{}' }), {})).status, 403);
  assert.equal((await worker.fetch(request('/api/progress', { method: 'POST', body: '{invalid' }), {})).status, 400);
});

function mediaFixture() {
  const calls = [];
  const content = { '/part0': 'abcde', '/part1': 'fghij', '/part2': 'klmno' };
  const env = { ASSETS: { async fetch(req) {
    const path = new URL(req.url).pathname;
    const range = req.headers.get('range');
    calls.push({ path, range });
    const text = content[path];
    if (!range) return new Response(text);
    const [, start, end] = range.match(/bytes=(\d+)-(\d+)/);
    return new Response(text.slice(Number(start), Number(end) + 1), { status: 206 });
  } } };
  const file = { size: 15, type: 'audio/mpeg', hash: 'abc', parts: [0, 1, 2].map(i => ({ path: `/part${i}`, offset: i * 5, size: 5 })) };
  return { calls, env, file };
}

test('full audio streams all parts without altering bytes', async () => {
  const { env, file } = mediaFixture();
  const response = await serveMedia(request('/audio/test.mp3'), env, file);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '15');
  assert.equal(await response.text(), 'abcdefghijklmno');
});

test('seeking across a part boundary fetches only the requested bytes', async () => {
  const { calls, env, file } = mediaFixture();
  const response = await serveMedia(request('/audio/test.mp3', { headers: { Range: 'bytes=3-7' } }), env, file);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 3-7/15');
  assert.equal(await response.text(), 'defgh');
  assert.deepEqual(calls, [{ path: '/part0', range: 'bytes=3-4' }, { path: '/part1', range: 'bytes=0-2' }]);
});

test('suffix, open-ended, unsatisfiable, HEAD, and conditional ranges', async () => {
  for (const [range, expected] of [['bytes=-3', 'mno'], ['bytes=12-', 'mno'], ['bytes=12-99', 'mno']]) {
    const { env, file } = mediaFixture();
    assert.equal(await (await serveMedia(request('/audio/test.mp3', { headers: { Range: range } }), env, file)).text(), expected);
  }
  const { calls, env, file } = mediaFixture();
  for (const range of ['bytes=15-', 'bytes=9-4', 'bytes=-0']) {
    assert.equal((await serveMedia(request('/audio/test.mp3', { headers: { Range: range } }), env, file)).status, 416);
  }
  const head = await serveMedia(request('/audio/test.mp3', { method: 'HEAD' }), env, file);
  assert.equal(head.headers.get('content-length'), '15');
  assert.equal(calls.length, 0);
  assert.equal((await serveMedia(request('/audio/test.mp3', { headers: { 'If-None-Match': '"abc"' } }), env, file)).status, 304);
  const changed = await serveMedia(request('/audio/test.mp3', { headers: { Range: 'bytes=3-7', 'If-Range': '"old"' } }), env, file);
  assert.equal(changed.status, 200);
  assert.equal(await changed.text(), 'abcdefghijklmno');
});

test('seeking works even when the assets backend ignores Range', async () => {
  const { file } = mediaFixture();
  const parts = { '/part0': 'abcde', '/part1': 'fghij', '/part2': 'klmno' };
  const env = { ASSETS: { fetch: async req => new Response(parts[new URL(req.url).pathname]) } };
  const response = await serveMedia(request('/audio/test.mp3', { headers: { Range: 'bytes=3-7' } }), env, file);
  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'defgh');
});

test('built audio parts are byte-for-byte identical to the source tracks', async () => {
  for (const [name, file] of Object.entries(manifest.chunked)) {
    const hash = createHash('sha256');
    let total = 0;
    for (const part of file.parts) {
      assert.equal(part.offset, total);
      const bytes = await readFile(new URL(`../.cloudflare/public${part.path}`, import.meta.url));
      assert.equal(bytes.length, part.size);
      assert.ok(bytes.length <= 25 * 1024 * 1024);
      hash.update(bytes);
      total += bytes.length;
    }
    assert.equal(total, file.size);
    assert.equal(hash.digest('hex'), createHash('sha256').update(await readFile(new URL(`../audio/${encodeURIComponent(name)}`, import.meta.url))).digest('hex'));
  }
});

test('Firestore preserves nested transcript values and escapes progress field paths', () => {
  const value = { clips: [{ start: 1.2, end: 9, japanese: '漢字', analyzed: true, notes: null }], mastered: {} };
  assert.deepEqual(decodeValue(encodeValue(value)), value);
  assert.equal(progressFieldPath('1.25-3.5'), 'mastered.`1.25-3.5`');
  assert.equal(progressFieldPath('a`b\\c'), 'mastered.`a\\`b\\\\c`');
});

test('Firestore authentication signs a valid JWT and progress uses atomic field updates', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = { FIREBASE_PROJECT_ID: 'test-project', FIREBASE_CLIENT_EMAIL: 'test@example.invalid', FIREBASE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  let tokenRequests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      tokenRequests++;
      const jwt = options.body.get('assertion').split('.');
      assert.equal(verify('RSA-SHA256', Buffer.from(`${jwt[0]}.${jwt[1]}`), publicKey, Buffer.from(jwt[2], 'base64url')), true);
      assert.equal(JSON.parse(Buffer.from(jwt[1], 'base64url')).scope, 'https://www.googleapis.com/auth/datastore');
      return Response.json({ access_token: 'test-token', expires_in: 3600 });
    }
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(new URL(url).searchParams.getAll('updateMask.fieldPaths'), ['mastered.`1.2-3.4`']);
    assert.equal(options.method, 'PATCH');
    return Response.json({});
  });
  for (let i = 0; i < 2; i++) await setDocument(env, 'progress', 'lesson', { mastered: { '1.2-3.4': true } }, [progressFieldPath('1.2-3.4')]);
  assert.equal(tokenRequests, 1);
});

test('AI calls use Groq and retain the existing response shapes', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'openai/gpt-oss-120b');
    assert.match(payload.messages[0].content, /Traditional Chinese/);
    return Response.json({ choices: [{ message: { content: '{"translation":"你好"}' } }] });
  });
  const response = await handleAI(post('/api/explain', { sentence: 'こんにちは' }), { GROQ_API_KEY: 'test' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).analysis.translation, '你好');
});

test('transcription sends only the clip to Groq Whisper', async (t) => {
  const form = new FormData();
  form.append('file', new Blob(['audio'], { type: 'audio/wav' }), 'clip.wav');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(options.body.get('model'), 'whisper-large-v3-turbo');
    assert.equal(await options.body.get('file').text(), 'audio');
    return Response.json({ text: ' 日本語 ', words: [], segments: [] });
  });
  const result = await (await handleAI(request('/api/transcribe', { method: 'POST', body: form }), { GROQ_API_KEY: 'test' })).json();
  assert.equal(result.text, '日本語');
  assert.equal(result.provider, 'groq');
});

test('missing AI credentials, quota limits and oversized bodies return useful errors', async (t) => {
  assert.equal((await handleAI(post('/api/chat', {}), {})).status, 503);
  t.mock.method(globalThis, 'fetch', async () => new Response('private upstream detail', { status: 429 }));
  const limited = await handleAI(post('/api/chat', {}), { GROQ_API_KEY: 'test' });
  assert.equal(limited.status, 429);
  assert.doesNotMatch(await limited.text(), /private upstream detail/);
  const large = request('/api/chat', { method: 'POST', headers: { 'Content-Length': '9999999' }, body: '{}' });
  assert.equal((await handleAI(large, { GROQ_API_KEY: 'test' })).status, 413);
});

const spoken = (text, start, step, pauseAfter = -1, pause = 0) => Array.from(text).map((word, index) => {
  const offset = start + index * step + (pauseAfter >= 0 && index > pauseAfter ? pause : 0);
  return { word, start: offset, end: offset + step };
});

test('rhythm is scored from word timings, ignoring leading silence', () => {
  const native = spoken('きょうはいいてんきですね', 0, 0.2);
  const same = measureRhythm(native, spoken('キョウはいいてんきですね', 1.5, 0.2));
  assert.equal(same.score, 100);
  assert.equal(same.tempoRatio, 1);
  assert.equal(same.extraPause, null);

  const hesitant = measureRhythm(native, spoken('きょうはいいてんきですね', 0, 0.2, 3, 0.8));
  assert.ok(hesitant.score < same.score);
  assert.deepEqual(hesitant.extraPause, { after: 'きょうは', seconds: 0.8 });

  const slow = measureRhythm(native, spoken('きょうはいいてんきですね', 0, 0.4));
  assert.equal(slow.tempoRatio, 2);
  assert.ok(slow.score < 80);

  assert.equal(measureRhythm(native, spoken('ぜんぜんちがう', 0, 0.2)), null);
  assert.equal(measureRhythm(native, []), null);
  assert.equal(measureRhythm(undefined, [{ word: 'あ', start: 'x' }]), null);
});

test('pronunciation assessment sends the recording to Azure and keeps only scores', async (t) => {
  const env = { AZURE_SPEECH_KEY: 'azure-key', AZURE_SPEECH_REGION: 'japaneast' };
  assert.equal(aiStatus(env).pronunciationAssessment, true);
  assert.equal(aiStatus({ AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_REGION: 'evil.example/' }).pronunciationAssessment, false);
  const upload = () => {
    const form = new FormData();
    form.append('file', new Blob(['RIFFaudio'], { type: 'audio/wav' }), 'take.wav');
    form.append('reference', '今日はいい天気');
    return request('/api/assess-pronunciation', { method: 'POST', body: form });
  };
  assert.equal((await handleAI(upload(), { GROQ_API_KEY: 'test' })).status, 503);

  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://japaneast.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=ja-JP&format=detailed');
    assert.equal(options.headers['Ocp-Apim-Subscription-Key'], 'azure-key');
    const params = JSON.parse(Buffer.from(options.headers['Pronunciation-Assessment'], 'base64').toString('utf8'));
    assert.equal(params.ReferenceText, '今日はいい天気');
    assert.equal(params.EnableProsodyAssessment, undefined);
    assert.equal(new TextDecoder().decode(options.body), 'RIFFaudio');
    return Response.json({ RecognitionStatus: 'Success', DisplayText: 'private transcript', NBest: [{
      AccuracyScore: 81.4, FluencyScore: 90, CompletenessScore: 100, PronScore: 84.6,
      Words: [{ Word: '今日', AccuracyScore: 95, ErrorType: 'None' }, { Word: '天気', AccuracyScore: 41, ErrorType: 'Mispronunciation' }]
    }] });
  });
  const result = await (await handleAI(upload(), env)).json();
  assert.deepEqual(result.assessment, { overall: 85, accuracy: 81, fluency: 90, completeness: 100, words: [
    { word: '今日', accuracy: 95, error: 'None' }, { word: '天気', accuracy: 41, error: 'Mispronunciation' }] });

  t.mock.method(globalThis, 'fetch', async () => Response.json({ RecognitionStatus: 'NoMatch' }));
  assert.equal((await (await handleAI(upload(), env)).json()).assessment, null);
  t.mock.method(globalThis, 'fetch', async () => new Response('private upstream detail', { status: 401 }));
  const failed = await handleAI(upload(), env);
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /private upstream detail/);
  assert.equal(cleanAssessment({ overall: 'high', words: 'x' }), null);
});

test('measured scores replace the model guesses and are given to it as facts', async (t) => {
  const native = spoken('きょうはいいてんきですね', 0, 0.2);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const [system, user] = JSON.parse(options.body).messages.map((message) => message.content);
    assert.match(system, /taken from the learner's audio/);
    assert.match(system, /Never state or guess why a word sounded wrong/);
    assert.match(user, /Measured pronunciation \(Azure, 0-100\): overall 62/);
    assert.match(user, /天気=Mispronunciation/);
    assert.match(user, /Measured rhythm \(0-100\): 100/);
    return Response.json({ choices: [{ message: { content: '{"scores":{"pronunciation":95,"rhythm":40,"overall":72},"coachingTip":"加油","visualCues":[{"text":"天気","furigana":"てんき","status":"perfect","note":"促音が弱い"}]}' } }] });
  });
  const { evaluation } = await (await handleAI(post('/api/evaluate-speech', {
    target: '今日はいい天気ですね', heard: '今日はいい天気ですね', targetDuration: 2.4, recordedDuration: 3,
    targetWords: native, heardWords: spoken('きょうはいいてんきですね', 0.5, 0.2),
    assessment: { overall: 62, accuracy: 60, completeness: 80, words: [{ word: '天気', accuracy: 41, error: 'Mispronunciation' }] }
  }), { GROQ_API_KEY: 'test' })).json();
  assert.deepEqual(evaluation.scores, { pronunciation: 60, completeness: 80, rhythm: 100, overall: 80 });
  assert.deepEqual(evaluation.measured, { pronunciation: true, completeness: true, rhythm: true, words: true });
  assert.equal(evaluation.recommendation, 'move_on');
  assert.equal(evaluation.coachingTip, '加油');
  // The model said "perfect" and invented a cause; Azure's number decides instead.
  assert.deepEqual(evaluation.visualCues, [{ text: '天気', furigana: 'てんき', status: 'missed', note: '差距較大，重聽原音再跟讀', score: 41 }]);
  assert.deepEqual(wordCues([
    { word: '今日', accuracy: 95, error: 'None' }, { word: 'は', accuracy: 72, error: 'None' }, { word: 'えっと', accuracy: 80, error: 'Insertion' },
    { word: 'いい', accuracy: 0, error: 'Omission' }, { word: '天気', accuracy: 88, error: 'Mispronunciation' }
  ], [{ text: '今日', furigana: 'きょう' }, { text: '天気', furigana: 'てんき' }, 'junk']).map((cue) => [cue.text, cue.furigana, cue.status, cue.score]), [
    ['今日', 'きょう', 'perfect', 95], ['は', '', 'warning', 72], ['いい', '', 'missed', null], ['天気', 'てんき', 'warning', 88]]);

  // The page asks for the measured scores first; that answer must not wait for the language model.
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('scoresOnly must not call any service'); });
  const quick = (await (await handleAI(post('/api/evaluate-speech', { scoresOnly: true, targetWords: native, heardWords: native,
    assessment: { accuracy: 90, completeness: 100, words: [{ word: '天気', accuracy: 90, error: 'None' }] } }), { GROQ_API_KEY: 'test' })).json()).evaluation;
  assert.deepEqual(quick.scores, { pronunciation: 90, completeness: 100, rhythm: 100, overall: 97 });
  assert.deepEqual(quick.visualCues, [{ text: '天気', furigana: '', status: 'perfect', note: '', score: 90 }]);

  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(JSON.parse(options.body).reasoning_effort, 'low');
    assert.doesNotMatch(JSON.parse(options.body).messages[0].content, /taken from the learner's audio|"intonation"|intonationFeedback/);
    return Response.json({ choices: [{ message: { content: '{"scores":{"pronunciation":50,"rhythm":50,"intonation":50},"rhythmFeedback":"guess"}' } }] });
  });
  const plain = (await (await handleAI(post('/api/evaluate-speech', { target: 'はい', heard: 'はい' }), { GROQ_API_KEY: 'test' })).json()).evaluation;
  assert.deepEqual(plain.measured, { pronunciation: false, completeness: false, rhythm: false, words: false });
  assert.deepEqual(plain.scores, { pronunciation: 50, completeness: null, rhythm: null, overall: 50 });
  assert.equal(plain.rhythmFeedback, undefined);
  assert.equal(plain.recommendation, 'keep_practicing');
});

test('Azure usage is counted per month and reported for Settings', async (t) => {
  const azure = { AZURE_SPEECH_KEY: 'azure-key', AZURE_SPEECH_REGION: 'japaneast' };
  const month = new Date().toISOString().slice(0, 7);
  assert.deepEqual(await (await worker.fetch(request('/api/usage'), {})).json(),
    { configured: false, tracked: false, month, secondsUsed: 0, requests: 0, allowanceSeconds: 18000, refusedAt: null });
  const untracked = await (await worker.fetch(request('/api/usage'), { ...azure, AZURE_SPEECH_MONTHLY_HOURS: '2' })).json();
  assert.equal(untracked.configured, true);
  assert.equal(untracked.tracked, false);
  assert.equal(untracked.allowanceSeconds, 7200);

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = { ...azure, FIREBASE_PROJECT_ID: 'usage-project', FIREBASE_CLIENT_EMAIL: 'usage@example.invalid', FIREBASE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const document = `projects/usage-project/databases/(default)/documents/usage/azure-speech-${month}`;
  const writes = [];
  let azureStatus = 200;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    url = String(url);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'test-token', expires_in: 3600 });
    if (url.includes('stt.speech.microsoft.com')) return azureStatus === 200 ? Response.json({ RecognitionStatus: 'NoMatch' }) : new Response('', { status: azureStatus });
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    if (url.endsWith(':commit')) { writes.push(...JSON.parse(options.body).writes); return Response.json({}); }
    if (options.method === 'PATCH') { writes.push({ patch: JSON.parse(options.body), mask: new URL(url).searchParams.getAll('updateMask.fieldPaths') }); return Response.json({}); }
    assert.equal(url, `https://firestore.googleapis.com/v1/${document}`);
    return Response.json({ fields: { seconds: { doubleValue: 754.6 }, requests: { integerValue: '12' }, refusedAt: { stringValue: '2026-11-03T10:00:00.000Z' } } });
  });
  const upload = () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(44 + 32000 * 3)], { type: 'audio/wav' }), 'take.wav');
    form.append('reference', 'はい');
    return request('/api/assess-pronunciation', { method: 'POST', body: form });
  };
  assert.equal((await handleAI(upload(), env)).status, 200);
  assert.deepEqual(writes, [{ update: { name: document, fields: {} }, updateMask: { fieldPaths: [] }, updateTransforms: [
    { fieldPath: 'seconds', increment: { integerValue: '3' } }, { fieldPath: 'requests', increment: { integerValue: '1' } }] }]);

  azureStatus = 429;
  assert.equal((await handleAI(upload(), env)).status, 429);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].mask, ['refusedAt']);

  const usage = await (await worker.fetch(request('/api/usage'), env)).json();
  assert.deepEqual(usage, { configured: true, tracked: true, month, secondsUsed: 755, requests: 12, allowanceSeconds: 18000, refusedAt: '2026-11-03T10:00:00.000Z' });
});
