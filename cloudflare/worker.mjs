import media from '../.cloudflare/media.json' with { type: 'json' };
import { AI_ROUTES, aiStatus, handleAI } from './ai.mjs';
import { json, HttpError, readJSON } from './http.mjs';
import { hasFirestore, getDocument, setDocument, progressFieldPath } from './firestore.mjs';
import { serveMedia } from './media.mjs';

function baseName(filename) {
  if (typeof filename !== 'string' || !filename || filename.length > 1024) throw new HttpError(400, 'Filename required.');
  const name = filename.split('/').pop().replace(/\.[^.]+$/, '');
  if (!name || name === '.' || name === '..') throw new HttpError(400, 'Invalid filename.');
  return name;
}

async function staticJSON(request, env, path) {
  const response = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
  return response.ok ? response.json() : null;
}

async function override(request, env, id) {
  const local = await staticJSON(request, env, `/transcripts/overrides/${encodeURIComponent(id)}.json`);
  if (local?.protectedImport && local.clips?.length) return local;
  return hasFirestore(env) ? getDocument(env, 'transcriptOverrides', id) : null;
}

async function transcript(request, env, url) {
  if (request.method === 'GET') {
    const id = baseName(url.searchParams.get('file'));
    let data;
    try {
      data = await override(request, env, id);
      if (!data && hasFirestore(env)) data = await getDocument(env, 'transcripts', id);
    } catch { /* Prepared static copies remain usable when Firestore is unavailable. */ }
    data ||= await staticJSON(request, env, `/transcripts/${encodeURIComponent(id)}.json`);
    return json({ exists: Boolean(data), data: data || null });
  }
  const { filename, clips } = await readJSON(request, 10 * 1024 * 1024);
  const id = baseName(filename);
  if (!Array.isArray(clips)) throw new HttpError(400, 'Invalid transcript payload.');
  // Autosaves must never overwrite a prepared lesson.
  if (await override(request, env, id)) return json({ success: true, protected: true });
  if (!hasFirestore(env)) throw new HttpError(503, 'Transcript storage is not configured.');
  await setDocument(env, 'transcripts', id, { source: filename, updatedAt: new Date().toISOString(), clipCount: clips.length, clips });
  return json({ success: true });
}

async function progress(request, env, url) {
  if (request.method === 'GET') {
    const id = baseName(url.searchParams.get('file'));
    if (!hasFirestore(env)) return json({ available: false, masteredKeys: [] });
    try {
      const data = await getDocument(env, 'progress', id);
      return json({ available: true, masteredKeys: Object.keys(data?.mastered || {}).filter(k => data.mastered[k] === true) });
    } catch { return json({ available: false, masteredKeys: [] }); }
  }
  const { filename, masteredKeys } = await readJSON(request, 256 * 1024);
  const id = baseName(filename);
  if (!Array.isArray(masteredKeys)) throw new HttpError(400, 'Invalid progress payload.');
  if (!hasFirestore(env)) return json({ saved: false, available: false });
  const keys = [...new Set(masteredKeys.filter(k => typeof k === 'string' && k.length > 0 && k.length <= 80))];
  // Mask individual fields, preserving mastery saved concurrently on another device.
  await setDocument(env, 'progress', id, { source: filename, updatedAt: new Date().toISOString(), mastered: Object.fromEntries(keys.map(k => [k, true])) },
    ['source', 'updatedAt', ...keys.map(progressFieldPath)]);
  return json({ saved: true, available: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        // Preserve same-origin access; block browser cross-site mutations.
        const origin = request.headers.get('origin');
        if (request.method === 'POST' && origin && origin !== url.origin) return json({ error: 'Forbidden' }, 403);
        if (request.method === 'GET' && url.pathname === '/api/status') return json(aiStatus(env));
        if (request.method === 'GET' && url.pathname === '/api/library') return json({ files: media.files });
        if (request.method === 'POST' && AI_ROUTES.has(url.pathname)) return handleAI(request, env);
        if (['GET', 'POST'].includes(request.method)) {
          if (url.pathname === '/api/transcript') return await transcript(request, env, url);
          if (url.pathname === '/api/progress') return await progress(request, env, url);
        }
        return json({ error: 'Not found' }, 404);
      }
      if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
      if (url.pathname.startsWith('/audio/')) {
        const file = media.chunked[decodeURIComponent(url.pathname.slice('/audio/'.length))];
        if (file) return await serveMedia(request, env, file);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error instanceof HttpError ? error.message : 'The request could not be completed.' }, error.status || 500);
    }
  }
};
