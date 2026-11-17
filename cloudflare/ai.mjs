import { json, HttpError, readBody, readJSON } from './http.mjs';
import { tutorPrompts, evaluationPrompts, comparisonPrompts } from './prompts.mjs';
import { recordAzureUsage, recordAzureRefusal, azureUsage, wavSeconds } from './usage.mjs';
import { assessPronunciation, pronunciationConfigured, measureAttempt, applyMeasuredScores, MAX_ASSESSMENT_BYTES } from './scoring.mjs';

export const AI_ROUTES = new Set(['/api/assess-pronunciation', '/api/transcribe', '/api/explain', '/api/chat', '/api/compare-transcript', '/api/evaluate-speech']);

export function aiStatus(env) {
  const hasGroq = Boolean(env.GROQ_API_KEY?.trim());
  const groqChatModel = env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b';
  return { aiConfigured: hasGroq, hasGroq, hasOpenAI: false, hasGemini: false,
    primaryModel: groqChatModel, groqWhisper: env.GROQ_MODEL || 'whisper-large-v3-turbo',
    groqChatModel, activeProvider: 'groq', pronunciationAssessment: pronunciationConfigured(env) };
}

function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end !== -1 ? text.slice(start, end + 1) : text.trim();
}

async function groq(env, endpoint, body, isJSON = false) {
  const response = await fetch(`https://api.groq.com/openai/v1/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY.trim()}`, ...(isJSON ? { 'Content-Type': 'application/json' } : {}) },
    body: isJSON ? JSON.stringify(body) : body,
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) {
    // Do not reflect upstream responses that might contain request or account details.
    throw new HttpError(response.status === 429 ? 429 : 502,
      response.status === 429 ? 'Groq is busy or its free quota has been reached. Try again later.' : `Groq request failed (${response.status}).`);
  }
  return response.json();
}

export const usageStatus = (env) => azureUsage(env, pronunciationConfigured(env));

async function readUpload(request, limit) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('multipart/form-data')) throw new HttpError(400, 'Expected an audio file upload.');
  const bytes = await readBody(request, limit);
  const upload = await new Request('https://upload.invalid', { method: 'POST', headers: { 'Content-Type': type }, body: bytes }).formData();
  const file = upload.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') throw new HttpError(400, 'No audio clip was included.');
  return { upload, file };
}

// Azure hears the recording itself, so this route does not need Groq.
async function handleAssessment(request, env, ctx) {
  // Counting must not delay the score: let it finish after the response when the runtime allows.
  const later = (work) => ctx?.waitUntil ? ctx.waitUntil(work) : work;
  if (!pronunciationConfigured(env)) return json({ error: 'Pronunciation assessment is not configured.' }, 503);
  try {
    const { upload, file } = await readUpload(request, MAX_ASSESSMENT_BYTES + 64 * 1024);
    const audio = await file.arrayBuffer();
    const assessment = await assessPronunciation(env, audio, upload.get('reference'));
    await later(recordAzureUsage(env, wavSeconds(audio.byteLength)));
    return json({ assessment, provider: 'azure' });
  } catch (error) {
    if (error.status === 429) await later(recordAzureRefusal(env));
    return json({ error: error instanceof HttpError ? error.message : 'The pronunciation assessment could not be completed.' }, error.status || 502);
  }
}

export async function handleAI(request, env, ctx) {
  if (new URL(request.url).pathname === '/api/assess-pronunciation') return handleAssessment(request, env, ctx);
  if (!env.GROQ_API_KEY?.trim()) return json({ error: 'AI is not configured. Configure the server’s Groq API key.' }, 503);
  try {
    const route = new URL(request.url).pathname;
    if (route === '/api/transcribe') {
      const { file } = await readUpload(request, 8 * 1024 * 1024);
      const model = env.GROQ_MODEL || 'whisper-large-v3-turbo';
      const form = new FormData();
      form.append('file', file, file.name || 'clip.wav');
      form.append('model', model);
      form.append('language', 'ja');
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      const data = await groq(env, 'audio/transcriptions', form);
      return json({ text: (data.text || '').trim(), words: data.words || [], segments: data.segments || [],
        modelUsed: `Groq Whisper (${model})`, provider: 'groq', fallbackTriggered: false });
    }
    const body = await readJSON(request);
    let prompts;
    let measured;
    if (route === '/api/compare-transcript') {
      if (!body.storedJapanese || !body.freshJapanese) throw new HttpError(400, 'Both stored and fresh Japanese are required.');
      prompts = comparisonPrompts(body);
    } else if (route === '/api/evaluate-speech') {
      measured = measureAttempt(body);
      // The measured scores need no language model, so the page asks for them first and shows them at once.
      if (body.scoresOnly) return json({ evaluation: applyMeasuredScores({}, measured), provider: 'measured' });
      prompts = evaluationPrompts(body, measured);
    } else {
      prompts = tutorPrompts(body, route === '/api/explain');
    }
    const model = env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b';
    const data = await groq(env, 'chat/completions', {
      model, temperature: 0.2,
      messages: [{ role: 'system', content: prompts.system }, { role: 'user', content: prompts.input }],
      ...(route !== '/api/chat' ? { response_format: { type: 'json_object' } } : {}),
      // The coach only words what was measured; deep reasoning just makes the learner wait.
      ...(route === '/api/evaluate-speech' ? { reasoning_effort: 'low' } : {})
    }, true);
    const content = data.choices?.[0]?.message?.content || '';
    const meta = { modelUsed: `Groq (${model})`, provider: 'groq' };
    if (route === '/api/chat') return json({ answer: content, ...meta });
    let parsed;
    try { parsed = JSON.parse(extractJSON(content)); }
    catch {
      if (route === '/api/explain') return json({ analysis: { rubyText: '', translation: '', literal: '', raw: content }, ...meta });
      throw new HttpError(502, 'Groq returned an unreadable response. Try again.');
    }
    const field = route === '/api/explain' ? 'analysis' : route === '/api/compare-transcript' ? 'comparison' : 'evaluation';
    return json({ [field]: measured ? applyMeasuredScores(parsed, measured) : parsed, ...meta });
  } catch (error) {
    return json({ error: error instanceof HttpError ? error.message : 'The AI request could not be completed. Try again.' }, error.status || 502);
  }
}
