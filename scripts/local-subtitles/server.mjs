#!/usr/bin/env node
// Loopback-only, dependency-free transport. Audio and transcripts never leave this Mac.
import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { translateCues, validateTranslationConfig, DEFAULT_BATCH_SIZE } from './translation.mjs';
import { bilibiliURL, downloadBilibili } from './bilibili.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
export const MODEL = 'mlx-community/whisper-large-v3-turbo';
const MAX_UPLOAD = 4 * 1024 ** 3;
const CHUNK_BYTES = 2 * 1024 ** 2;
const MAX_DURATION = 6 * 3600;
const TERMINAL = new Set(['complete', 'error', 'translation_error', 'cancelled']);
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const VIDEO_CONCURRENCY = 2;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new HttpError(status, message); }
async function body(req, limit) {
  const advertised = Number(req.headers['content-length']);
  if (Number.isFinite(advertised) && advertised > limit) fail(413, 'Request body is too large.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
async function jsonBody(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'Use application/json.');
  try { return JSON.parse((await body(req, 4096)).toString('utf8')); }
  catch (error) { if (error instanceof HttpError) throw error; fail(400, 'Invalid JSON.'); }
}
function safeEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateResult(value) {
  if (!value || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > MAX_DURATION) {
    throw new Error('Transcription returned an invalid media duration.');
  }
  if (!Array.isArray(value.cues) || value.cues.length > 50000) throw new Error('Transcription returned invalid subtitles.');
  let previous = -1;
  const validated = value.cues.map((cue, index) => {
    if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 ||
        cue.start < previous || cue.end <= cue.start || cue.end > value.duration + 0.05 ||
        typeof cue.text !== 'string' || !cue.text.trim() || cue.text.length > 4000) {
      throw new Error('Transcription returned an invalid subtitle timestamp or text.');
    }
    previous = cue.start;
    return { start: cue.start, end: cue.end, text: cue.text.trim() };
  });
  const cues = splitLongCues(validated).map((cue, index) => ({ ...cue, id: String(index) }));
  if (cues.length > 50000) throw new Error('Transcription returned too many subtitle clips.');
  return { cues, duration: value.duration };
}

// Keep study clips short without breaking natural phrases too aggressively.
// The user-facing target is fewer than twelve Japanese words per clip.
const MAX_WORDS_PER_CUE = 11;
const japaneseSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;

export function splitLongCues(cues) {
  if (!japaneseSegmenter) return cues;
  const result = [];
  for (const cue of cues) {
    const words = [...japaneseSegmenter.segment(cue.text)].filter(part => part.isWordLike && /\S/.test(part.segment));
    if (words.length <= MAX_WORDS_PER_CUE) { result.push(cue); continue; }
    const parts = Math.ceil(words.length / MAX_WORDS_PER_CUE);
    const wordsPerPart = Math.ceil(words.length / parts);
    const boundaries = [0];
    for (let index = wordsPerPart; index < words.length; index += wordsPerPart) boundaries.push(words[index].index);
    boundaries.push(cue.text.length);
    const duration = cue.end - cue.start;
    for (let index = 0; index < boundaries.length - 1; index++) {
      const startOffset = boundaries[index];
      const endOffset = boundaries[index + 1];
      const text = cue.text.slice(startOffset, endOffset).trim();
      if (!text) continue;
      result.push({
        text,
        start: index === 0 ? cue.start : cue.start + duration * startOffset / cue.text.length,
        end: index === boundaries.length - 2 ? cue.end : cue.start + duration * endOffset / cue.text.length,
      });
    }
  }
  return result;
}

export async function createSubtitleService(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.KAGE_SUBTITLES_DIR || path.join(ROOT, '.local-subtitles'));
  const jobsDir = path.join(dataDir, 'jobs');
  const python = options.python || process.env.KAGE_SUBTITLES_PYTHON || path.join(dataDir, 'venv/bin/python');
  const worker = options.worker || path.join(HERE, 'worker.py');
  const modelDir = options.modelDir || process.env.KAGE_WHISPER_MODEL || path.join(dataDir, 'model');
  const parallelStages = options.parallelStages ?? process.env.KAGE_PIPELINE_PARALLEL !== '0';
  const translationBatchSize = Number(options.translationBatchSize ?? process.env.KAGE_TRANSLATION_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  if (!Number.isInteger(translationBatchSize) || translationBatchSize < 1 || translationBatchSize > 12) throw new Error('Translation batch size must be between 1 and 12.');
  const token = randomBytes(32).toString('hex');
  const now = options.now || Date.now;
  const jobs = new Map();
  const queue = [];
  const uploadLocks = new Set();
  const saves = new Map();
  let reservedJobs = 0;
  let reservedBytes = 0;
  const running = new Map();
  const translationQueue = [];
  let translating = false;
  let closing = false;
  let ready = false;
  let readinessError = '';
  let probePromise;
  await fs.mkdir(jobsDir, { recursive: true, mode: 0o700 });

  const jobDir = id => path.join(jobsDir, id);
  const mediaPath = id => path.join(jobDir(id), 'input.media');
  const resultPath = id => path.join(jobDir(id), 'result.json');
  const queuePosition = job => job.state === 'queued'
    ? queue.filter(id => jobs.get(id)?.state === 'queued').indexOf(job.id) + 1 : 0;
  const deadline = job => Number(job.expiresAt) || (Date.parse(job.updatedAt) || now()) + RETENTION_MS;
  const expired = job => TERMINAL.has(job.state) && deadline(job) <= now();
  const addTime = (job, key, value) => { job.timings ||= {}; job.timings[key] = (job.timings[key] || 0) + Math.max(0, value); };
  function timingSnapshot(job) {
    const timings = { ...job.timings };
    const operation = running.get(job.id);
    if (operation) timings.processingMs = (timings.processingMs || 0) + performance.now() - operation.started;
    if (operation?.workerStarted !== undefined) timings.workerWallMs = (timings.workerWallMs || 0) + performance.now() - operation.workerStarted;
    if (job.state === 'queued' && job.queuedAt) timings.queueMs = (timings.queueMs || 0) + Math.max(0, Date.now() - job.queuedAt);
    return timings;
  }
  async function removeExpired(job) {
    if (!expired(job) || running.has(job.id) || uploadLocks.has(job.id) || saves.has(job.id)) return;
    jobs.delete(job.id);
    try { await fs.rm(jobDir(job.id), { recursive: true, force: true }); }
    catch (error) { jobs.set(job.id, job); throw error; }
  }
  function save(job) {
    // Serialize status writes so progress cannot overwrite a cancellation or later stage.
    const pending = (saves.get(job.id) || Promise.resolve()).catch(() => {}).then(async () => {
      job.updatedAt = new Date().toISOString();
      if (TERMINAL.has(job.state)) job.expiresAt ||= now() + RETENTION_MS;
      else delete job.expiresAt;
      const filename = path.join(jobDir(job.id), 'job.json');
      const tmp = `${filename}.${randomBytes(6).toString('hex')}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(job), { mode: 0o600 });
      await fs.rename(tmp, filename);
    });
    saves.set(job.id, pending);
    return pending.finally(() => { if (saves.get(job.id) === pending) saves.delete(job.id); });
  }
  async function cleanAudio(id) {
    await fs.rm(path.join(jobDir(id), 'download'), { recursive: true, force: true });
    await Promise.all(['input.media', 'audio.wav', 'result.json'].map(name =>
      fs.rm(path.join(jobDir(id), name), { force: true })));
  }
  async function cancel(job, message = 'Cancelled. Uploaded media deleted.') {
    job.state = 'cancelled';
    const operation = running.get(job.id);
    if (operation) { operation.controller.abort(); stopChild(operation.child); }
    job.message = message;
    await save(job);
    // Wait for the writer to exit before removing partial downloads and decoder output.
    if (operation) await operation.done;
    await cleanAudio(job.id);
  }
  function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // The worker and FFmpeg share a process group, so cancellation also stops decoding.
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    const killTimer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, 5000);
    killTimer.unref();
    child.once('close', () => clearTimeout(killTimer));
  }

  for (const entry of await fs.readdir(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    try {
      const job = JSON.parse(await fs.readFile(path.join(jobDir(entry.name), 'job.json'), 'utf8'));
      if (job.id !== entry.name) continue;
      if (expired(job)) { await fs.rm(jobDir(job.id), { recursive: true, force: true }); continue; }
      if (TERMINAL.has(job.state) && !job.expiresAt) {
        job.expiresAt = deadline(job);
        await save(job);
      }
      if (!TERMINAL.has(job.state)) {
        const canResume = job.translation && Array.isArray(job.cues) && job.transcriptionComplete !== false;
        job.state = canResume ? 'translation_error' : 'error';
        job.message = canResume ? 'The local service restarted. Retry Chinese translation to continue from saved Japanese subtitles.' : 'The local service restarted. Import the file again to retry.';
        await save(job);
      }
      await cleanAudio(job.id);
      jobs.set(job.id, job);
    } catch {
      // A process may have exited between directory creation and the first status write.
      await cleanAudio(entry.name);
    }
  }

  const workerEnv = () => ({ ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
    TOKENIZERS_PARALLELISM: 'false', PYTHONUNBUFFERED: '1' });
  async function probe() {
    if (probePromise) return probePromise;
    probePromise = new Promise(resolve => {
      let output = '';
      let settled = false;
      const child = spawn(python, [worker, '--check', '--model', modelDir], { env: workerEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
      const finish = (success, message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ready = success;
        readinessError = success ? '' : (message || output || 'Run scripts/local-subtitles/setup.sh first.').trim().slice(-1000);
        resolve();
      };
      child.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-4000); });
      child.stderr.on('data', bytes => { output = (output + bytes.toString()).slice(-4000); });
      child.once('error', error => finish(false, error.code === 'ENOENT' ? 'Local Whisper is not installed. Run scripts/local-subtitles/setup.sh.' : error.message));
      child.once('close', code => finish(code === 0));
    }).finally(() => { probePromise = null; });
    return probePromise;
  }
  await probe();

  async function transcribe(job, operation, onChunk) {
    const remote = job.sourceUrl && !options.downloader;
    job.state = remote ? 'downloading' : 'transcribing';
    job.message = remote ? 'Connecting to Bilibili audio…' : 'Reading audio locally…';
    job.transcriptionComplete = false;
    job.progress = 0;
    await save(job);
    operation.controller.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(python, [worker, ...(remote ? ['--url', job.sourceUrl] : ['--input', mediaPath(job.id)]), '--output', resultPath(job.id), '--model', modelDir],
        { env: workerEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      operation.child = child;
      let stderr = '';
      let buffer = '';
      let failure = '';
      let progressWrite = Promise.resolve();
      const timer = setTimeout(() => { failure = 'Transcription exceeded the 12-hour limit.'; stopChild(child); }, 12 * 3600 * 1000);
      child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-4000); });
      child.stdout.on('data', bytes => {
        buffer += bytes.toString('utf8');
        if (buffer.length > 1024 * 1024) { failure = 'Invalid transcription progress output.'; stopChild(child); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            progressWrite = progressWrite.then(async () => {
              operation.controller.signal.throwIfAborted();
              if (event.timings && typeof event.timings === 'object') {
                for (const key of ['sourceSetupMs', 'audioWaitMs', 'recognitionMs']) {
                  const value = event.timings[key];
                  if (Number.isFinite(value) && value >= 0 && value <= 12 * 3600 * 1000) {
                    job.timings[key] = Math.max(job.timings[key] || 0, value);
                  }
                }
              }
              if (event.type === 'metadata') {
                if (!Number.isFinite(event.duration) || event.duration <= 0 || event.duration > MAX_DURATION) throw new Error('Invalid audio duration.');
                job.duration = event.duration;
                job.mediaMode = event.mediaMode === 'audio' ? 'audio' : '360p fallback';
                job.state = 'preparing';
                job.message = 'Preparing the first minute of subtitles…';
                await save(job);
              } else if (event.type === 'chunk') {
                const result = validateResult(event);
                if (!Number.isFinite(event.processedThrough) || event.processedThrough <= (job.processedThrough || 0)
                    || event.processedThrough > result.duration + 0.05) throw new Error('Invalid subtitle section progress.');
                const previous = job.cues?.at(-1);
                if (previous && result.cues[0]?.start < previous.end - 0.001) throw new Error('Subtitle sections overlap.');
                job.cues ||= [];
                const offset = job.cues.length;
                if (offset + result.cues.length > 30000) throw new Error('The subtitle track is too large.');
                job.cues.push(...result.cues.map((cue, index) => ({ ...cue, id: String(offset + index) })));
                job.duration = result.duration;
                job.processedThrough = event.processedThrough;
                job.state = 'preparing';
                job.progress = Math.min(0.99, event.processedThrough / result.duration);
                job.translationTotal = job.cues.length;
                job.message = 'New subtitle sections are ready while the rest prepares…';
                await save(job);
                onChunk();
              } else if (event.type === 'timings') {
                await save(job);
              } else if (event.type === 'progress' && job.state !== 'preparing') {
                if (Number.isFinite(event.progress)) job.progress = Math.max(job.progress, Math.min(0.99, event.progress));
                if (typeof event.message === 'string') job.message = event.message.slice(0, 300);
                await save(job);
              }
            }).catch(error => { if (!operation.controller.signal.aborted) failure = error.message; stopChild(child); });
          } catch { /* Ignore non-protocol library logging. */ }
        }
      });
      let settled = false;
      async function finish(code, spawnError) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        await progressWrite;
        try {
          operation.controller.signal.throwIfAborted();
          if (spawnError || code !== 0 || failure) throw new Error(failure || spawnError?.message || stderr.trim() || 'Local transcription failed.');
          const stat = await fs.stat(resultPath(job.id));
          if (stat.size > 32 * 1024 ** 2) throw new Error('Transcription output is too large.');
          const result = validateResult(JSON.parse(await fs.readFile(resultPath(job.id), 'utf8')));
          if (Array.isArray(job.cues)) {
            const japanese = cues => cues.map(({ start, end, text, id }) => ({ start, end, text, id }));
            if (JSON.stringify(japanese(result.cues)) !== JSON.stringify(japanese(job.cues))) throw new Error('Final subtitles do not match the prepared sections.');
            result.cues = job.cues; // Retain Chinese already produced while Whisper ran.
          }
          operation.controller.signal.throwIfAborted();
          job.transcriptionComplete = true;
          job.processedThrough = result.duration;
          resolve(result);
        } catch (error) { reject(error); }
      }
      child.once('error', error => void finish(null, error));
      child.once('close', code => void finish(code));
    });
  }

  function updateTranslationProgress(job) {
    job.translationTotal = job.cues.length;
    job.translationCompleted = job.cues.filter(cue => typeof cue.translation === 'string' && cue.translation.trim()).length;
    job.progress = job.translationTotal ? job.translationCompleted / job.translationTotal : 1;
    job.message = `Translating to Traditional Chinese locally: ${job.translationCompleted} of ${job.translationTotal} lines…`;
  }

  // Share one Ollama request slot between videos, releasing it after each batch.
  // A cancelled waiter must not wait for another video's inference to finish.
  function scheduleTranslation(run, signal) {
    return new Promise((resolve, reject) => {
      const entry = { run, resolve, reject, signal, abort: () => {
        const index = translationQueue.indexOf(entry);
        if (index !== -1) translationQueue.splice(index, 1);
        reject(signal.reason);
      } };
      if (signal?.aborted) { reject(signal.reason); return; }
      signal?.addEventListener('abort', entry.abort, { once: true });
      translationQueue.push(entry);
      drainTranslations();
    });
  }
  function drainTranslations() {
    if (translating || !translationQueue.length) return;
    const entry = translationQueue.shift();
    entry.signal?.removeEventListener('abort', entry.abort);
    translating = true;
    Promise.resolve().then(entry.run).then(entry.resolve, entry.reject).finally(() => {
      translating = false;
      drainTranslations();
    });
  }

  async function pump() {
    if (closing) return;
    while (running.size < VIDEO_CONCURRENCY && queue.length) {
      const job = jobs.get(queue.shift());
      if (job?.state !== 'queued' || running.has(job.id)) continue;
      void runJob(job).catch(error => console.error('Subtitle job error:', error.message));
    }
  }
  async function runJob(job) {
    let finishOperation;
    const operation = { id: job.id, child: null, controller: new AbortController(), started: performance.now(),
      done: new Promise(resolve => { finishOperation = resolve; }) };
    running.set(job.id, operation);
    addTime(job, 'queueMs', job.queuedAt ? Date.now() - job.queuedAt : 0);
    delete job.queuedAt;
    job.timings.batchSize = translationBatchSize;
    const translationOptions = {
      fetchImpl: options.fetchImpl, signal: operation.controller.signal, scheduleRequest: scheduleTranslation, batchSize: translationBatchSize,
      onMetrics: metrics => {
        addTime(job, 'translationMs', metrics.requestMs);
        addTime(job, 'translationQueueMs', metrics.queueMs);
        addTime(job, 'translationRequests', metrics.requests);
        addTime(job, 'translationRetries', metrics.retries);
      },
    };
    let outcome;
    let translationTask = null, translationFailure = null;
    const pendingChinese = () => job.translation && job.cues?.some(cue => !cue.translation?.trim());
    function startTranslation() {
      if (!parallelStages || translationTask || translationFailure || !pendingChinese() || operation.controller.signal.aborted) return;
      // Whisper can run for both videos; Ollama batches share a single slot.
      translationTask = (async () => {
        while (pendingChinese()) {
          await translateCues(job.cues.slice(), job.translation, {
            ...translationOptions,
            onProgress: async () => {
              operation.controller.signal.throwIfAborted();
              job.translationTotal = job.cues.length;
              job.translationCompleted = job.cues.filter(cue => cue.translation?.trim()).length;
              if (job.state === 'translating') updateTranslationProgress(job);
              await save(job);
            },
          });
        }
      })().catch(error => { translationFailure = error; }).finally(() => { translationTask = null; });
    }
    try {
      if (options.downloader && job.sourceUrl && !Array.isArray(job.cues)) {
        job.state = 'downloading';
        job.message = 'Connecting to Bilibili for a 360p download…';
        job.progress = 0;
        await save(job);
        const downloadStarted = performance.now();
        try { await downloadBilibili({ python, worker: options.downloader || path.join(HERE, 'download.py'),
          url: job.sourceUrl, directory: jobDir(job.id), operation, stopChild,
          onProgress: async event => {
            if (job.state !== 'downloading' || operation.controller.signal.aborted) return;
            if (Number.isFinite(event.progress)) job.progress = Math.max(0, Math.min(0.99, event.progress));
            job.message = 'Downloading Bilibili video and audio (up to 360p)…';
            await save(job);
          },
        }); } finally { addTime(job, 'downloadMs', performance.now() - downloadStarted); }
        operation.controller.signal.throwIfAborted();
        const stat = await fs.stat(mediaPath(job.id));
        if (!stat.size || stat.size > MAX_UPLOAD) throw new Error('Downloaded video is empty or exceeds 4 GiB.');
        job.size = stat.size; job.received = stat.size;
      }
      if (!Array.isArray(job.cues)) {
        operation.workerStarted = performance.now();
        try { Object.assign(job, await transcribe(job, operation, startTranslation)); }
        finally {
          addTime(job, 'workerWallMs', performance.now() - operation.workerStarted);
          delete operation.workerStarted;
        }
      }
      operation.controller.signal.throwIfAborted();
      if (job.translation) { job.state = 'translating'; updateTranslationProgress(job); await save(job); }
      // A final chunk can arrive as the previous translation drain finishes.
      if (translationTask) await translationTask;
      if (translationFailure) throw translationFailure;
      if (job.translation) {
        job.state = 'translating';
        updateTranslationProgress(job);
        await save(job);
        await cleanAudio(job.id);
        await translateCues(job.cues, job.translation, {
          ...translationOptions,
          onProgress: async () => {
            operation.controller.signal.throwIfAborted();
            updateTranslationProgress(job);
            await save(job);
          },
        });
      }
      operation.controller.signal.throwIfAborted();
      outcome = { state: 'complete', progress: 1,
        message: !job.cues.length ? 'No Japanese speech was detected.' :
          job.translation ? 'Japanese and Traditional Chinese subtitles are ready.' : 'Japanese subtitles are ready.' };
    } catch (error) {
      // Never let a late translation write revive cancelled or failed processing.
      if (translationTask) {
        operation.controller.abort();
        await translationTask;
      }
      if (job.state !== 'cancelled' && !closing) {
        outcome = { state: job.translation && Array.isArray(job.cues) && job.transcriptionComplete !== false ? 'translation_error' : 'error',
          message: error.message.slice(-1000) };
      }
    } finally {
      try {
        await cleanAudio(job.id);
        // Do not advertise completion/failure or release the media budget before cleanup.
        if (outcome && job.state !== 'cancelled' && !closing) Object.assign(job, outcome);
        addTime(job, 'processingMs', performance.now() - operation.started);
        operation.started = performance.now(); // Snapshot only the final write's remaining time.
        await save(job);
      }
      catch (error) { console.error('Unable to save subtitle status:', error.message); }
      running.delete(job.id);
      finishOperation();
      void pump().catch(error => console.error('Subtitle queue error:', error.message));
    }
  }

  const server = options.server || http.createServer();
  server.on('request', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      const port = server.address()?.port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) fail(403, 'Invalid local service host.');
      const origin = req.headers.origin;
      if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) fail(403, 'Only the browser extension can access this service.');
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kage-Token');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        return reply(204, {});
      }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        return reply(200, { ok: true, ready, model: MODEL, token, capabilities: { translation: true, bilibiliDownload: true, progressiveSubtitles: true, audioOnly: true, jobQueue: true }, processing: { sectionSeconds: 60, parallelStages, concurrency: VIDEO_CONCURRENCY, translationConcurrency: 1, translationBatchSize }, status: ready ? 'ready' : 'setup_required',
          ...(!ready ? { error: readinessError } : {}) });
      }
      if (!safeEqual(req.headers['x-kage-token'], token)) fail(401, 'Local service token is missing or expired. Reconnect and retry.');
      if (url.pathname === '/jobs' && req.method === 'GET') {
        const active = [...jobs.values()].filter(job => !TERMINAL.has(job.state));
        return reply(200, { limit: 4, concurrency: VIDEO_CONCURRENCY, jobs: active.map(job => ({
          id: job.id, name: job.name, state: job.state, progress: job.progress,
          message: job.message, sourceUrl: job.sourceUrl,
          queuePosition: queuePosition(job)
        })) });
      }
      if (url.pathname === '/jobs' && req.method === 'POST') {
        if (!ready) { await probe(); if (!ready) fail(503, readinessError); }
        const spec = await jsonBody(req);
        let sourceUrl;
        if (spec && Object.hasOwn(spec, 'sourceUrl')) {
          try { sourceUrl = bilibiliURL(spec.sourceUrl); } catch (error) { fail(400, error.message); }
          // URL jobs stream audio only when scheduled; queued URLs use no upload budget.
          spec.size = MAX_UPLOAD;
          spec.name = `Bilibili ${new URL(sourceUrl).pathname.split('/').pop()}${new URL(sourceUrl).search} (audio)`;
        }
        if (!spec || typeof spec.name !== 'string' || !spec.name.trim() || spec.name.length > 512 ||
            !Number.isSafeInteger(spec.size) || spec.size < 1 || spec.size > MAX_UPLOAD) fail(400, 'Choose a video or audio file between 1 byte and 4 GiB.');
        const active = [...jobs.values()].filter(job => !TERMINAL.has(job.state));
        const uploadBytes = sourceUrl ? 0 : spec.size;
        if (active.length + reservedJobs >= 4) fail(429, 'The video queue has four active jobs. Open Video queue to stop a job, or wait for one to finish.');
        if (active.filter(job => !job.sourceUrl).reduce((sum, job) => sum + job.size, 0) + reservedBytes + uploadBytes > MAX_UPLOAD) {
          fail(429, 'Local uploads have reached the 4 GiB limit. Open Video queue to stop an upload, or wait for it to finish.');
        }
        reservedJobs++;
        reservedBytes += uploadBytes;
        try {
        if (jobs.size >= 200) {
          const oldest = [...jobs.values()].filter(job => TERMINAL.has(job.state)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
          if (oldest) { await fs.rm(jobDir(oldest.id), { recursive: true, force: true }); jobs.delete(oldest.id); }
        }
        const job = { id: randomUUID(), name: spec.name.trim(), size: spec.size, received: 0, state: 'uploading',
          ...(sourceUrl ? { sourceUrl } : {}),
          progress: 0, message: 'Uploading to this Mac…', createdAt: new Date().toISOString() };
        await fs.mkdir(jobDir(job.id), { mode: 0o700 });
        await fs.writeFile(mediaPath(job.id), '', { mode: 0o600, flag: 'wx' });
        await save(job);
        jobs.set(job.id, job);
        return reply(201, { id: job.id });
        } finally { reservedJobs--; reservedBytes -= uploadBytes; }
      }
      const match = url.pathname.match(/^\/jobs\/([a-f0-9-]+)(?:\/(audio|start))?$/);
      if (!match || !UUID.test(match[1])) fail(404, 'Not found.');
      const job = jobs.get(match[1]);
      if (!job) fail(404, 'This job is no longer available. Import the file again.');
      if (expired(job)) {
        await removeExpired(job);
        fail(404, 'Saved subtitles expired after 3 days. Prepare this video again.');
      }
      if (!match[2] && req.method === 'GET') return reply(200, { ...job, timings: timingSnapshot(job), queuePosition: queuePosition(job) });
      if (!match[2] && req.method === 'DELETE') {
        if (TERMINAL.has(job.state)) return reply(200, job);
        if (uploadLocks.has(job.id)) fail(409, 'An upload chunk is being written. Retry cancellation.');
        await cancel(job, 'Processing stopped. Ready subtitles are kept; temporary media deleted.');
        return reply(200, job);
      }
      if (match[2] === 'audio' && req.method === 'PUT') {
        if (job.sourceUrl) fail(409, 'This job downloads its media from Bilibili.');
        if (job.state !== 'uploading') fail(409, 'This job is no longer accepting uploads.');
        if (uploadLocks.has(job.id)) fail(409, 'Another upload chunk is being written.');
        const offsetText = url.searchParams.get('offset');
        const offset = Number(offsetText);
        if (offsetText === null || !/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset) || offset !== job.received) {
          fail(409, `Upload offset mismatch. Expected ${job.received}.`);
        }
        uploadLocks.add(job.id);
        try {
          // Each request is bounded to 2 MiB; the full video is never held in memory.
          const chunk = await body(req, Math.min(CHUNK_BYTES, job.size - job.received));
          if (!chunk.length) fail(400, 'An upload chunk cannot be empty.');
          const handle = await fs.open(mediaPath(job.id), 'r+');
          try {
            let written = 0;
            while (written < chunk.length) {
              const result = await handle.write(chunk, written, chunk.length - written, job.received + written);
              if (!result.bytesWritten) throw new Error('Unable to write uploaded media.');
              written += result.bytesWritten;
            }
          } finally { await handle.close(); }
          job.received += chunk.length;
          await save(job);
          return reply(200, { received: job.received });
        } finally { uploadLocks.delete(job.id); }
      }
      if (match[2] === 'start' && req.method === 'POST') {
        const spec = await jsonBody(req);
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail(400, 'Invalid subtitle job settings.');
        let translation;
        if (Object.hasOwn(spec, 'translation')) {
          try { translation = validateTranslationConfig(spec.translation); }
          catch (error) { fail(400, error.message); }
        }
        const resume = job.state === 'translation_error' && Array.isArray(job.cues) && job.transcriptionComplete !== false;
        const addTranslation = job.state === 'complete' && translation && Array.isArray(job.cues) && job.cues.some(cue => !cue.translation?.trim());
        if (job.state !== 'uploading' && !resume && !addTranslation) return reply(200, job); // Safe retry after a lost response.
        if (job.state === 'uploading' && !job.sourceUrl && (uploadLocks.has(job.id) || job.received !== job.size)) fail(409, 'Upload the complete file before starting.');
        if (translation) job.translation = translation;
        job.state = 'queued';
        job.queuedAt = Date.now();
        job.message = Array.isArray(job.cues) ? 'Waiting for local Chinese translation…' : job.sourceUrl ? 'Waiting to prepare Bilibili audio…' : 'Waiting for local transcription…';
        await save(job);
        queue.push(job.id);
        reply(202, job);
        void pump().catch(error => console.error('Subtitle queue error:', error.message));
        return;
      }
      fail(405, 'Method not allowed.');
    } catch (error) { reply(error.status || 500, { error: error.status ? error.message : 'The local service could not complete the request.' }); }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  // A lost tab can leave an unreferenced partial upload. Reclaim it automatically.
  const sweep = setInterval(() => {
    const expiredBefore = Date.now() - (options.uploadIdleMs ?? 3600 * 1000);
    for (const job of jobs.values()) {
      if (expired(job)) {
        void removeExpired(job).catch(error => console.error('Subtitle cleanup failed:', error.message));
        continue;
      }
      if (job.state === 'uploading' && !uploadLocks.has(job.id) && Date.parse(job.updatedAt) < expiredBefore) {
        void cancel(job, 'Upload expired after being inactive. Import the file again.').catch(error => console.error('Upload cleanup failed:', error.message));
      }
    }
  }, options.sweepIntervalMs ?? 60000);
  sweep.unref();
  return {
    server,
    async listen(port = Number(process.env.KAGE_SUBTITLES_PORT || 8766)) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      return server.address();
    },
    async close() {
      closing = true;
      clearInterval(sweep);
      const operations = [...running.values()];
      for (const operation of operations) { operation.controller.abort(); stopChild(operation.child); }
      for (const job of jobs.values()) if (!TERMINAL.has(job.state)) {
        if (Array.isArray(job.cues)) {
          job.state = job.transcriptionComplete === false ? 'error' : 'translation_error';
          job.message = job.transcriptionComplete === false
            ? 'The service stopped before transcription finished. Ready sections are saved; download or import again for the full video.'
            : 'The service stopped. Retry Chinese translation to continue from saved Japanese subtitles.';
          await save(job);
        } else await cancel(job, 'The service stopped. Import the file again to retry.');
      }
      await Promise.all(operations.map(operation => operation.done));
      server.closeIdleConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Claim the port before recovering jobs or deleting temporary media. A second
  // launch must never treat the running helper's files as interrupted work.
  const server = http.createServer();
  const starting = (_req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'The local subtitle helper is starting. Retry shortly.' }));
  };
  server.on('request', starting);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(process.env.KAGE_SUBTITLES_PORT || 8766), '127.0.0.1', resolve);
    });
  } catch (error) {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${process.env.KAGE_SUBTITLES_PORT || 8766} is already in use. The subtitle helper may already be running. Check npm run subtitles:status. For an automatic-startup update, run npm run subtitles:autostart when processing is idle. For a manual helper, stop its terminal with Ctrl+C before starting again.`
      : `Could not start the subtitle helper: ${error.message}`);
    process.exit(1);
  }
  let service;
  try { service = await createSubtitleService({ server }); }
  catch (error) {
    server.close();
    console.error(`Could not initialize the subtitle helper: ${error.message}`);
    process.exit(1);
  }
  server.removeListener('request', starting);
  const address = server.address();
  console.log(`Local Japanese subtitles: http://127.0.0.1:${address.port}`);
  console.log('The subtitle helper is running. Keep Ollama running for Chinese translation.');
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await service.close();
    process.exit(0);
  });
}
