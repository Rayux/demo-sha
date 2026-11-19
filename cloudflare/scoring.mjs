// Scores measured from the audio itself, shared by the local server and Cloudflare.
// Rhythm comes from Whisper's word timings; pronunciation from Azure's assessment.
import { HttpError } from './http.mjs';

const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, value));
const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const MAX_CHARS = 400;

// One entry per spoken character, timed by spreading each word's span evenly.
function timeline(words) {
  const out = [];
  for (const entry of Array.isArray(words) ? words.slice(0, 300) : []) {
    const start = Number(entry?.start);
    const end = Number(entry?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const chars = Array.from(String(entry.word ?? '').normalize('NFKC'))
      .filter((char) => !/[\s\p{P}\p{S}]/u.test(char))
      // Katakana and hiragana are the same sound.
      .map((char) => /[ァ-ヶ]/.test(char) ? String.fromCharCode(char.charCodeAt(0) - 0x60) : char);
    chars.forEach((char, index) => out.push({ char, time: start + ((index + 0.5) / chars.length) * (end - start) }));
    if (out.length >= MAX_CHARS) break;
  }
  return out.slice(0, MAX_CHARS);
}

// Longest common subsequence: the characters both speakers said, in order.
function align(target, learner) {
  const rows = target.length + 1;
  const cols = learner.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = target.length - 1; i >= 0; i -= 1) {
    for (let j = learner.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = target[i].char === learner[j].char
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const pairs = [];
  for (let i = 0, j = 0; i < target.length && j < learner.length;) {
    if (target[i].char === learner[j].char) { pairs.push({ index: i, target: target[i].time, learner: learner[j].time }); i += 1; j += 1; }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

/**
 * Compare the learner's timing with the native clip's. Silence before the first
 * and after the last shared character is ignored. Returns null when too little
 * of the sentence was recognised to judge.
 */
export function measureRhythm(targetWords, learnerWords) {
  const target = timeline(targetWords);
  const learner = timeline(learnerWords);
  const pairs = align(target, learner);
  if (pairs.length < 4 || pairs.length / target.length < 0.5) return null;
  const first = pairs[0];
  const last = pairs[pairs.length - 1];
  const targetSpan = last.target - first.target;
  const learnerSpan = last.learner - first.learner;
  if (targetSpan < 0.3 || learnerSpan <= 0) return null;

  const tempoRatio = learnerSpan / targetSpan;
  // How far each shared character sits from where the native speaker put it,
  // as a fraction of the sentence, once overall speed is factored out.
  const deviation = pairs.reduce((sum, pair) =>
    sum + Math.abs((pair.target - first.target) / targetSpan - (pair.learner - first.learner) / learnerSpan), 0) / pairs.length;
  // Whisper's timings are only good to about a tenth of a second, so small
  // differences score as perfect rather than as noise.
  const shape = clamp(100 - Math.max(0, deviation - 0.015) * 650);
  const tempo = clamp(100 - Math.max(0, Math.abs(Math.log2(tempoRatio)) - 0.14) * 120);

  let extraPause = null;
  for (let i = 0; i < pairs.length - 1; i += 1) {
    const seconds = (pairs[i + 1].learner - pairs[i].learner) - (pairs[i + 1].target - pairs[i].target);
    if (seconds > 0.3 && seconds > (extraPause?.seconds ?? 0)) {
      const end = pairs[i].index + 1;
      extraPause = { after: target.slice(Math.max(0, end - 4), end).map((item) => item.char).join(''), seconds: round(seconds, 1) };
    }
  }
  return {
    score: Math.round(0.6 * shape + 0.4 * tempo),
    tempoRatio: round(tempoRatio),
    timingDeviation: round(deviation, 3),
    coverage: round(pairs.length / target.length),
    extraPause
  };
}

function azureBase(env) {
  const endpoint = env.AZURE_SPEECH_ENDPOINT?.trim().replace(/\/+$/, '');
  if (endpoint) return /^https:\/\/[a-z0-9.-]+$/i.test(endpoint) ? `${endpoint}/stt` : null;
  const region = env.AZURE_SPEECH_REGION?.trim().toLowerCase();
  return region && /^[a-z0-9]+$/.test(region) ? `https://${region}.stt.speech.microsoft.com` : null;
}

export function pronunciationConfigured(env) {
  return Boolean(env.AZURE_SPEECH_KEY?.trim() && azureBase(env));
}

// 30 seconds of 16 kHz mono 16-bit WAV: the service's limit for assessment.
export const MAX_ASSESSMENT_BYTES = 44 + 30 * 16000 * 2;

const score = (value) => Number.isFinite(Number(value)) && value !== null && value !== '' ? clamp(Math.round(Number(value))) : null;

/** Reduce an assessment (Azure's, or one echoed back by the browser) to bounded fields. */
export function cleanAssessment(value) {
  if (!value || typeof value !== 'object') return null;
  const overall = score(value.overall);
  const accuracy = score(value.accuracy);
  if (overall === null && accuracy === null) return null;
  const words = (Array.isArray(value.words) ? value.words : []).slice(0, 120).map((word) => ({
    word: String(word?.word ?? '').slice(0, 40),
    accuracy: score(word?.accuracy),
    error: ['None', 'Omission', 'Insertion', 'Mispronunciation'].includes(word?.error) ? word.error : 'None'
  })).filter((word) => word.word);
  return { overall: overall ?? accuracy, accuracy, fluency: score(value.fluency), completeness: score(value.completeness), words };
}

/** Score a 16 kHz mono WAV recording against the sentence it was meant to be. */
export async function assessPronunciation(env, audio, referenceText) {
  const base = azureBase(env);
  const key = env.AZURE_SPEECH_KEY?.trim();
  if (!key || !base) throw new HttpError(503, 'Pronunciation assessment is not configured.');
  const reference = String(referenceText ?? '').trim().slice(0, 500);
  if (!reference) throw new HttpError(400, 'A target sentence is required.');
  if (audio.byteLength > MAX_ASSESSMENT_BYTES) throw new HttpError(413, 'The recording is longer than 30 seconds.');
  // Prosody scoring is English-only, so it is not requested for Japanese.
  const params = JSON.stringify({ ReferenceText: reference, GradingSystem: 'HundredMark', Granularity: 'Word', Dimension: 'Comprehensive', EnableMiscue: 'True' });
  const response = await fetch(`${base}/speech/recognition/conversation/cognitiveservices/v1?language=ja-JP&format=detailed`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
      Accept: 'application/json',
      'Pronunciation-Assessment': btoa(String.fromCharCode(...new TextEncoder().encode(params)))
    },
    body: audio,
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    // Do not reflect upstream responses that might contain request or account details.
    throw new HttpError(response.status === 429 ? 429 : 502,
      response.status === 429 ? 'Azure Speech is busy or its quota has been reached. Try again later.' : `Azure Speech request failed (${response.status}).`);
  }
  const data = await response.json();
  const best = data?.RecognitionStatus === 'Success' ? data.NBest?.[0] : null;
  if (!best) return null; // Nothing recognisable as Japanese was heard.
  const scores = best.PronunciationAssessment || best;
  return cleanAssessment({
    overall: scores.PronScore, accuracy: scores.AccuracyScore, fluency: scores.FluencyScore, completeness: scores.CompletenessScore,
    words: (best.Words || []).map((word) => ({
      word: word.Word,
      accuracy: (word.PronunciationAssessment || word).AccuracyScore,
      error: (word.PronunciationAssessment || word).ErrorType
    }))
  });
}

/** Everything that was measured for this attempt, from an /api/evaluate-speech body. */
export function measureAttempt(body) {
  return { rhythm: measureRhythm(body?.targetWords, body?.heardWords), pronunciation: cleanAssessment(body?.assessment) };
}

/**
 * The word-by-word row, straight from Azure: colour and note come from its
 * numbers, never from the language model, which only supplies readings.
 */
export function wordCues(words, modelCues) {
  const readings = (Array.isArray(modelCues) ? modelCues : []).slice(0, 200);
  let next = 0;
  return words.filter((word) => word.error !== 'Insertion').map((word) => {
    // The model lists the same words in the same order; tolerate one it skipped.
    const found = readings.findIndex((cue, index) => index >= next && cue?.text === word.word);
    if (found !== -1) next = found + 1;
    const furigana = found === -1 ? '' : String(readings[found].furigana ?? '').slice(0, 40);
    const omitted = word.error === 'Omission';
    const accuracy = omitted ? null : word.accuracy;
    const status = omitted || (accuracy !== null && accuracy < 60) ? 'missed'
      : word.error === 'Mispronunciation' || (accuracy !== null && accuracy < 80) ? 'warning' : 'perfect';
    const note = omitted ? '沒有唸到這個詞' : status === 'missed' ? '差距較大，重聽原音再跟讀' : status === 'warning' ? '接近了，再練一次' : '';
    return { text: word.word, furigana, status, note, score: accuracy };
  });
}

/**
 * Measured numbers replace the language model's guesses; it keeps writing the advice.
 * The cards are pronunciation (were the sounds right), completeness (was every word
 * said) and rhythm. Completeness exists only when Azure heard the recording.
 */
export function applyMeasuredScores(evaluation, measured) {
  const number = (value) => typeof value === 'number' && Number.isFinite(value) ? clamp(Math.round(value)) : null;
  const azure = measured.pronunciation;
  const scores = {
    pronunciation: azure ? azure.accuracy ?? azure.overall : number(evaluation?.scores?.pronunciation),
    completeness: azure ? azure.completeness : null,
    // Without timings there is nothing to judge rhythm by, so it is left unscored.
    rhythm: measured.rhythm ? measured.rhythm.score : null
  };
  const parts = Object.values(scores).filter((value) => value !== null);
  const average = parts.length ? parts.reduce((sum, value) => sum + value, 0) / parts.length : 0;
  scores.overall = parts.length ? Math.round(average) : null;
  const { rhythmFeedback, ...rest } = evaluation || {};
  return {
    ...rest, scores,
    ...(measured.rhythm && rhythmFeedback ? { rhythmFeedback } : {}),
    ...(azure?.words.length ? { visualCues: wordCues(azure.words, evaluation?.visualCues) } : {}),
    recommendation: average >= 70 ? 'move_on' : 'keep_practicing',
    measured: { pronunciation: Boolean(azure), completeness: azure?.completeness != null, rhythm: Boolean(measured.rhythm), words: Boolean(azure?.words.length) }
  };
}
