#!/usr/bin/env node
// Kage for phones and tablets. A phone cannot run the extension or the subtitle
// helper, so this small server on the Mac does both jobs for it: it fetches the
// episode, hands it to the local helper (127.0.0.1:8766) for subtitles, and
// serves a page that plays the video with those subtitles.
//
// The helper itself stays reachable from this Mac only. Other devices talk to
// this server, and only after entering the pairing code once.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const HELPER = process.env.KAGE_HELPER_URL || 'http://127.0.0.1:8766';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const UPLOAD_CHUNK = 1024 * 1024;
const MAX_MEDIA = 4 * 1024 ** 3;
const TERMINAL = new Set(['complete', 'error', 'translation_error', 'cancelled']);
const TRANSLATION = {
  endpoint: process.env.KAGE_WEB_TRANSLATION_ENDPOINT || 'http://127.0.0.1:11434/v1/chat/completions',
  model: process.env.KAGE_WEB_TRANSLATION_MODEL || 'gemma2'
};

const STATIC = new Map([
  ['/', ['scripts/kage-web/public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['scripts/kage-web/public/app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['scripts/kage-web/public/app.css', 'text/css; charset=utf-8']],
  ['/kage/content/readings.js', ['extension/content/readings.js', 'text/javascript; charset=utf-8']],
  ['/kage/vendor/kuromoji/kuromoji.js', ['extension/vendor/kuromoji/kuromoji.js', 'text/javascript; charset=utf-8']]
]);
const DICT = /^\/kage\/vendor\/kuromoji\/dict\/([a-z_]+\.dat\.gz)$/;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const entities = text => String(text).replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").trim();

// ── anime1.me ───────────────────────────────────────────────────────────────
export function anime1Post(value) {
  const text = String(value ?? '').trim();
  if (/^\d{1,12}$/.test(text)) return text;
  let url;
  try { url = new URL(text); } catch { return ''; }
  if (!['http:', 'https:'].includes(url.protocol) || !/^(?:www\.)?anime1\.me$/i.test(url.hostname) || url.port) return '';
  return url.pathname.match(/^\/(\d{1,12})\/?$/)?.[1] || (url.pathname === '/' && /^\d{1,12}$/.test(url.searchParams.get('p') || '') ? url.searchParams.get('p') : '');
}

export function mediaURL(value) {
  try {
    const url = new URL(String(value).startsWith('//') ? 'https:' + value : value);
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.v\.anime1\.me$/i.test(url.hostname) || url.port || url.username || url.password
      || url.hash || !/^\/[\w./-]+\.mp4$/i.test(url.pathname) || url.pathname.includes('..')) return null;
    return url;
  } catch { return null; }
}

export function parseEpisodePage(html) {
  const title = entities(html.match(/<h2 class="entry-title">([^<]+)<\/h2>/)?.[1] || html.match(/<title>([^<]*?)(?:\s*&#8211;[^<]*)?<\/title>/)?.[1] || '');
  const apireq = html.match(/<video[^>]*\sdata-apireq="([A-Za-z0-9%._~-]{1,4096})"/)?.[1] || '';
  const category = html.match(/href="\/\?cat=(\d{1,12})"/)?.[1] || '';
  return { title, apireq, category };
}

// `titlesOnly` keeps the episodes of a series page and leaves out the sidebar's latest list.
export function parseEpisodeLinks(html, titlesOnly = false) {
  const seen = new Set(), list = [];
  const pattern = titlesOnly ? /<h2 class="entry-title"><a href="https:\/\/anime1\.me\/(\d{1,12})"[^>]*>([^<]{1,300})</g
    : /href="https:\/\/anime1\.me\/(\d{1,12})"[^>]*>([^<]{1,300})</g;
  for (const match of html.matchAll(pattern)) {
    const title = entities(match[2]);
    if (!title || seen.has(match[1])) continue;
    seen.add(match[1]); list.push({ post: match[1], title });
  }
  return list;
}

async function page(url) {
  let response;
  try { response = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) }); }
  catch { fail(502, 'Your Mac could not reach anime1.me. Check its internet connection.'); }
  if (!response.ok) fail(response.status === 404 ? 404 : 502, response.status === 404 ? 'anime1.me has no episode at that address.' : `anime1.me returned HTTP ${response.status}.`);
  return response.text();
}

// anime1.me's own list of every series: [category, title, status, year, season, source].
let catalog = { at: 0, list: [] };
async function seriesCatalog() {
  if (Date.now() - catalog.at < 60 * 60 * 1000 && catalog.list.length) return catalog.list;
  let data;
  try { data = JSON.parse(await page('https://anime1.me/animelist.json')); }
  catch (error) { if (catalog.list.length) return catalog.list; throw error instanceof HttpError ? error : new HttpError(502, 'anime1.me sent a series list Kage could not read.'); }
  const list = (Array.isArray(data) ? data : []).filter(row => Array.isArray(row) && Number.isSafeInteger(row[0]) && row[0] > 0 && typeof row[1] === 'string')
    .map(row => ({ category: String(row[0]), title: entities(row[1]), status: String(row[2] || ''), year: String(row[3] || ''), season: String(row[4] || '') }));
  if (list.length) catalog = { at: Date.now(), list };
  return list;
}
export function searchSeries(list, query, limit = 60) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  return list.filter(item => { const title = item.title.toLowerCase(); return terms.every(term => title.includes(term)); }).slice(0, limit);
}

const episodes = new Map(); // post -> { post, title, category, src, cookie, expires }
async function resolveEpisode(post, fresh = false) {
  const known = episodes.get(post);
  if (known && !fresh && known.expires - Date.now() > 10 * 60 * 1000) return known;
  const info = parseEpisodePage(await page(`https://anime1.me/${post}`));
  if (!info.apireq) fail(422, 'Kage could not find a video on that anime1.me page. Open a single episode, not a series list.');
  let response;
  try {
    response = await fetch('https://v.anime1.me/api', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://anime1.me', Referer: 'https://anime1.me/' },
      body: `d=${info.apireq}` });
  } catch { fail(502, 'Your Mac could not reach the anime1.me video server.'); }
  if (!response.ok) fail(502, `The anime1.me video server returned HTTP ${response.status}.`);
  const data = await response.json().catch(() => null);
  const source = (Array.isArray(data?.s) ? data.s : []).find(item => /video\/mp4/i.test(item?.type) && typeof item?.src === 'string');
  const src = source && mediaURL(source.src);
  if (!src) fail(422, 'This episode uses a kind of video Kage cannot read yet.');
  const cookies = response.headers.getSetCookie().map(line => line.split(';')[0].trim()).filter(pair => /^[\w-]+=[^\s;,]*$/.test(pair));
  const expiry = Number(cookies.find(pair => pair.startsWith('e='))?.slice(2)) * 1000;
  const episode = { post, title: info.title || `anime1.me ${post}`, category: info.category, src: src.href, cookie: cookies.join('; '),
    expires: Number.isFinite(expiry) && expiry > Date.now() ? expiry : Date.now() + 60 * 60 * 1000 };
  episodes.set(post, episode);
  if (episodes.size > 200) episodes.delete(episodes.keys().next().value);
  return episode;
}

async function media(episode, range, signal) {
  let response;
  try {
    response = await fetch(episode.src, { redirect: 'follow', signal,
      headers: { 'User-Agent': UA, Cookie: episode.cookie, Referer: 'https://anime1.me/', ...(range ? { Range: range } : {}) } });
  } catch (error) {
    if (signal?.aborted) throw error;
    fail(502, 'Your Mac could not reach the anime1.me video server.');
  }
  if (!mediaURL(response.url)) { response.body?.cancel().catch(() => {}); fail(502, 'anime1.me redirected the video to an unexpected address.'); }
  return response;
}

// ── The local subtitle helper ───────────────────────────────────────────────
let helperToken = '';
async function helper(pathname, { method = 'GET', json, bytes } = {}) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      if (!helperToken) {
        const health = await (await fetch(HELPER + '/health', { signal: AbortSignal.timeout(10000) })).json();
        if (typeof health.token !== 'string' || health.token.length < 24) throw new Error();
        if (!health.ready) fail(503, 'The subtitle helper on your Mac is not set up yet. Run npm run subtitles:setup on the Mac.');
        helperToken = health.token;
      }
      response = await fetch(HELPER + pathname, { method, redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: { 'X-Kage-Token': helperToken, ...(json !== undefined ? { 'Content-Type': 'application/json' } : bytes ? { 'Content-Type': 'application/octet-stream' } : {}) },
        body: json !== undefined ? JSON.stringify(json) : bytes });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      helperToken = '';
      fail(503, 'The subtitle helper on your Mac is not running. Start it with npm run subtitles:autostart on the Mac.');
    }
    if (response.status === 401 && attempt === 0) { helperToken = ''; continue; } // A restarted helper has a new token.
    const data = await response.json().catch(() => ({}));
    if (!response.ok) fail(response.status, data.error || `The subtitle helper returned HTTP ${response.status}.`);
    return data;
  }
}

const pageURL = post => `https://anime1.me/${post}`;
const recover = async post => (await helper(`/recover?url=${encodeURIComponent(pageURL(post))}`)).job;
const preparing = new Map(); // post -> { controller, received, total }
const failures = new Map(); // post -> message

// Download the episode once for the helper. It transcribes while the file is
// still arriving, so the first lines appear after a few seconds.
async function prepare(episode) {
  const post = episode.post;
  if (preparing.has(post)) return;
  const entry = { controller: new AbortController(), received: 0, total: 0 };
  preparing.set(post, entry);
  failures.delete(post);
  let id = '';
  try {
    let response = await media(episode, null, entry.controller.signal);
    if (response.status === 403) {
      response.body?.cancel().catch(() => {});
      response = await media(await resolveEpisode(post, true), null, entry.controller.signal);
    }
    const total = Number(response.headers.get('content-length'));
    if (!response.ok || !response.body) fail(502, `The anime1.me video server returned HTTP ${response.status}.`);
    if (!Number.isSafeInteger(total) || total < 1) fail(502, 'anime1.me did not report the size of this episode.');
    if (total > MAX_MEDIA) fail(413, 'This episode is larger than 4 GB.');
    entry.total = total;
    id = (await helper('/jobs', { method: 'POST', json: { name: `${episode.title}.mp4`.slice(0, 500), size: total, pageUrl: pageURL(post) } })).id;
    let pending = [], held = 0;
    const flush = async () => {
      if (!held) return;
      const chunk = Buffer.concat(pending, held);
      pending = []; held = 0;
      for (let offset = 0; offset < chunk.length; offset += UPLOAD_CHUNK) {
        const part = chunk.subarray(offset, offset + UPLOAD_CHUNK);
        await helper(`/jobs/${id}/audio?offset=${entry.received}`, { method: 'PUT', bytes: part });
        entry.received += part.length;
      }
    };
    for await (const value of response.body) {
      pending.push(value); held += value.length;
      if (entry.received + held > total) fail(502, 'anime1.me sent more data than it reported.');
      if (held >= UPLOAD_CHUNK) await flush();
    }
    await flush();
    if (entry.received !== total) fail(502, 'The episode download was cut short. Try again.');
    await helper(`/jobs/${id}/start`, { method: 'POST', json: { translation: TRANSLATION } });
  } catch (error) {
    failures.set(post, error instanceof HttpError ? error.message : 'The episode download was interrupted. Try again.');
    if (id) await helper(`/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
  } finally {
    preparing.delete(post);
  }
}

async function open(post, again) {
  const episode = await resolveEpisode(post);
  if (!preparing.has(post)) {
    let job = await recover(post);
    // An upload nobody is feeding any more (this server restarted mid-download).
    const abandoned = job && !TERMINAL.has(job.state) && job.uploadComplete !== true && !job.sourceUrl
      && Date.now() - Date.parse(job.updatedAt || job.createdAt) > 45000;
    if (job && (abandoned || (again && !TERMINAL.has(job.state)))) {
      await helper(`/jobs/${job.id}`, { method: 'DELETE' }).catch(() => {});
      job = null;
    }
    if (job && again && job.state === 'translation_error') {
      await helper(`/jobs/${job.id}/start`, { method: 'POST', json: { translation: TRANSLATION } });
    } else if (!job || ['error', 'cancelled'].includes(job.state) || (again && job.state !== 'complete')) {
      void prepare(episode);
    }
  }
  return { post, title: episode.title, category: episode.category };
}

async function subtitles(post, version) {
  const job = await recover(post);
  const download = preparing.get(post);
  const body = {
    downloading: download ? { received: download.received, total: download.total } : null,
    error: failures.get(post) || '',
    job: job ? { state: job.state, message: job.message || '', progress: job.progress || 0, duration: job.duration || 0,
      processedThrough: job.processedThrough || 0, transcriptionComplete: job.transcriptionComplete === true,
      translationCompleted: job.translationCompleted || 0, translationTotal: job.translationTotal || 0,
      cues: (job.cues || []).map(cue => ({ id: cue.id, start: cue.start, end: cue.end, text: cue.text, translation: cue.translation || '' })) } : null
  };
  // Lines only change every few seconds; an unchanged poll costs a few bytes.
  const hash = createHash('sha1').update(JSON.stringify(body.job?.cues || [])).digest('hex').slice(0, 16);
  if (hash === version && body.job) body.job.cues = undefined;
  return { ...body, version: hash };
}

// ── Pairing ─────────────────────────────────────────────────────────────────
// One short code, typed once per device, exchanged for a long cookie.
async function loadAccess(file) {
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (/^\d{6}$/.test(saved.code) && /^[a-f0-9]{64}$/.test(saved.secret)) return saved;
  } catch { /* First start. */ }
  const access = { code: String(randomInt(0, 1000000)).padStart(6, '0'), secret: randomBytes(32).toString('hex') };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(access), { mode: 0o600 });
  return access;
}
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

function addresses(port) {
  const list = [];
  for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries || []) {
    if (entry.family === 'IPv4' && !entry.internal) list.push({ url: `http://${entry.address}:${port}`,
      kind: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(entry.address) ? 'anywhere' : 'home' });
  }
  return list;
}

export async function createWebServer(options = {}) {
  const access = options.access || await loadAccess(path.join(root, '.local-subtitles', 'web-access.json'));
  let misses = 0, lockedUntil = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const reply = (status, value, headers = {}) => {
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(value));
    };
    try {
      const host = String(req.headers.host || '');
      if (!/^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/.test(host)) fail(400, 'Invalid address.');
      const url = new URL(req.url, `http://${host}`);
      const route = url.pathname;
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) fail(405, 'Method not allowed.');

      if (req.method !== 'POST' && (STATIC.has(route) || DICT.test(route))) {
        const [file, type] = STATIC.get(route) || [`extension/vendor/kuromoji/dict/${route.match(DICT)[1]}`, 'application/octet-stream'];
        const full = path.join(root, file);
        const stat = await fs.stat(full).catch(() => fail(404, 'Not found.'));
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size,
          'Cache-Control': DICT.test(route) ? 'public, max-age=31536000, immutable' : 'no-cache' });
        if (req.method === 'HEAD') return res.end();
        return createReadStream(full).on('error', () => res.destroy()).pipe(res);
      }
      if (!route.startsWith('/api/')) fail(404, 'Not found.');

      // Requests made on the Mac itself need no code; that is where the code is shown.
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
        && /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host) && !req.headers['x-forwarded-for'] && !req.headers.forwarded;
      const cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)kage=([a-f0-9]{64})(?:;|$)/)?.[1] || '';
      const paired = local || same(cookie, access.secret);
      let body = null;
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}` && origin !== `https://${host}`) fail(403, 'Open Kage from its own address.');
        if (!/^application\/json\b/.test(String(req.headers['content-type'] || ''))) fail(415, 'Send JSON.');
        const parts = [];
        let size = 0;
        for await (const part of req) { size += part.length; if (size > 8192) fail(413, 'Request is too large.'); parts.push(part); }
        try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { fail(400, 'Invalid JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Invalid JSON.');
      }

      if (route === '/api/session' && req.method === 'GET') {
        const port = server.address().port;
        return reply(200, { paired, ...(local ? { mac: true, code: access.code, addresses: addresses(port) } : {}) });
      }
      if (route === '/api/pair' && req.method === 'POST') {
        if (Date.now() < lockedUntil) fail(429, 'Too many wrong codes. Wait 10 minutes and try again.');
        if (!same(String(body.code ?? '').replace(/\D/g, ''), access.code)) {
          if (++misses >= 8) { misses = 0; lockedUntil = Date.now() + 10 * 60 * 1000; }
          fail(403, 'That code is not right. Check the code shown on your Mac.');
        }
        misses = 0;
        return reply(200, { paired: true }, { 'Set-Cookie': `kage=${access.secret}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict` });
      }
      if (!paired) fail(401, 'Enter the pairing code shown on your Mac.');

      if (route === '/api/anime1/latest' && req.method === 'GET') {
        return reply(200, { episodes: parseEpisodeLinks(await page('https://anime1.me/')).slice(0, 30) });
      }
      if (route === '/api/anime1/search' && req.method === 'GET') {
        return reply(200, { series: searchSeries(await seriesCatalog(), (url.searchParams.get('q') || '').slice(0, 100)) });
      }
      const series = route.match(/^\/api\/anime1\/series\/(\d{1,12})$/);
      if (series && req.method === 'GET') {
        // Long series are split over several pages, newest first.
        const all = [], seen = new Set();
        for (let number = 1; number <= 8; number++) {
          const html = await page(`https://anime1.me/?cat=${series[1]}${number > 1 ? `&paged=${number}` : ''}`).catch(error => { if (number === 1) throw error; return ''; });
          const fresh = parseEpisodeLinks(html, true).filter(item => !seen.has(item.post));
          if (!fresh.length) break;
          for (const item of fresh) { seen.add(item.post); all.push(item); }
          if (!/class="nav-previous"/.test(html)) break;
        }
        const known = (await seriesCatalog().catch(() => [])).find(item => item.category === series[1]);
        return reply(200, { title: known?.title || '', status: known?.status || '', episodes: all });
      }
      if (route === '/api/open' && req.method === 'POST') {
        const post = anime1Post(body.url);
        if (!post) fail(400, 'Paste the address of one anime1.me episode, for example https://anime1.me/30665.');
        return reply(200, await open(post, body.again === true));
      }
      const episode = route.match(/^\/api\/episode\/(\d{1,12})\/(video|subtitles)$/);
      if (!episode || req.method === 'POST') fail(404, 'Not found.');
      if (episode[2] === 'subtitles') return reply(200, await subtitles(episode[1], url.searchParams.get('v') || ''));

      const range = /^bytes=\d*-\d*$/.test(String(req.headers.range || '')) ? req.headers.range : null;
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      let upstream = await media(await resolveEpisode(episode[1]), range, controller.signal);
      if (upstream.status === 403) { // The signed address expired: ask anime1.me for a new one.
        upstream.body?.cancel().catch(() => {});
        upstream = await media(await resolveEpisode(episode[1], true), range, controller.signal);
      }
      if (![200, 206].includes(upstream.status) || !upstream.body) {
        upstream.body?.cancel().catch(() => {});
        fail(502, `The anime1.me video server returned HTTP ${upstream.status}.`);
      }
      const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
      for (const name of ['content-length', 'content-range']) if (upstream.headers.get(name)) headers[name] = upstream.headers.get(name);
      res.writeHead(upstream.status, headers);
      if (req.method === 'HEAD') { upstream.body.cancel().catch(() => {}); return res.end(); }
      Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (error?.name === 'AbortError') return res.destroy();
      if (!(error instanceof HttpError)) console.error('Kage web error:', error?.message || error);
      reply(error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Kage on your Mac could not complete that request.' });
    }
  });
  server.headersTimeout = 15000;
  return { server, access, addresses: () => addresses(server.address().port) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.KAGE_WEB_PORT || 8780);
  const { server, access, addresses: list } = await createWebServer();
  server.once('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Kage web may already be running.` : `Could not start Kage web: ${error.message}`);
    process.exit(1);
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`Kage for phones and tablets is running.\n\nOn this Mac:      http://127.0.0.1:${port}`);
    for (const entry of list()) console.log(`${entry.kind === 'anywhere' ? 'Away from home: ' : 'On home Wi-Fi:  '}  ${entry.url}`);
    console.log(`\nPairing code:     ${access.code}   (typed once on each device)\nKeep this window open and the Mac awake.`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); process.exit(0); });
}
