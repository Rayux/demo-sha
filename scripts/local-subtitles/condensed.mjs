// Condensed audio: only the stretches of a video where someone is speaking,
// joined into one MP3 for listening practice away from the screen.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

export const DEFAULT_PADDING = 1.5;
export const MAX_PADDING = 10;
// Openings and endings are usually sung; this much of each end can be left out.
export const SONG_SECONDS = 90;
const MAX_CLIPS = 6000;

// The spans of the video to keep: each line with some air around it, with
// overlapping spans joined so nearby lines play as one continuous clip.
export function dialogueIntervals(cues, duration, { padding = DEFAULT_PADDING, skipSongs = false } = {}) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const pad = Math.min(MAX_PADDING, Math.max(0, Number(padding) || 0));
  const spans = [];
  for (const cue of Array.isArray(cues) ? cues : []) {
    const start = Number(cue?.start), end = Number(cue?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start >= duration) continue;
    if (skipSongs && (start <= SONG_SECONDS || end + SONG_SECONDS > duration)) continue;
    spans.push([Math.max(0, start - pad), Math.min(duration, end + pad)]);
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

export const intervalSeconds = intervals => intervals.reduce((sum, [start, end]) => sum + end - start, 0);

// A name the Downloads folder accepts on any system.
export function audioFilename(title) {
  const name = String(title || '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ').replace(/^[.\s]+/, '').slice(0, 120).trim();
  return `${name || 'Kage audio'} (condensed).mp3`;
}

// RFC 5987: quotes, parentheses and asterisks must be escaped too, or browsers drop part of the name.
export const headerFilename = name => encodeURIComponent(name).replace(/['()*!]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

// Cuts `source` down to `intervals` and writes an MP3 to `target`.
// `ffmpeg` is the command as a list, so tests can stand in a script for it.
export function condense({ ffmpeg, source, target, intervals, title, signal, onProgress, onChild }) {
  if (!intervals.length) return Promise.reject(new Error('No spoken lines were found to keep.'));
  if (intervals.length > MAX_CLIPS) return Promise.reject(new Error('This video has too many separate lines to condense. Use a larger padding.'));
  const total = intervalSeconds(intervals);
  const keep = intervals.map(([start, end]) => `between(t,${start.toFixed(3)},${end.toFixed(3)})`).join('+');
  const [command, ...prefix] = ffmpeg;
  const partial = `${target}.partial`;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-protocol_whitelist', 'file', '-i', source, '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-af', `aselect='${keep}',asetpts=N/SR/TB`,
      // Only our own title tag, in the tag version every player reads.
      '-map_metadata', '-1', ...(title ? ['-metadata', `title=${title}`] : []), '-id3v2_version', '3',
      '-c:a', 'libmp3lame', '-b:a', '128k', '-progress', 'pipe:1', '-nostats', '-f', 'mp3', partial],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    onChild?.(child);
    let stderr = '', buffer = '', settled = false;
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-2000); });
    child.stdout.on('data', bytes => {
      buffer = (buffer + bytes.toString('utf8')).slice(-4000);
      const written = [...buffer.matchAll(/^out_time_(?:us|ms)=(\d+)$/gm)].at(-1);
      if (written && total > 0) onProgress?.(Math.min(0.99, Number(written[1]) / 1e6 / total));
    });
    const finish = async (code, failure) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      try {
        if (signal?.aborted) throw new Error('Stopped.');
        if (failure || code !== 0) throw new Error(failure?.code === 'ENOENT' ? 'FFmpeg is missing. Run npm run subtitles:setup.' : stderr.trim().split('\n').at(-1) || 'FFmpeg could not create the audio file.');
        const stat = await fs.stat(partial);
        if (!stat.size) throw new Error('FFmpeg wrote an empty audio file.');
        await fs.rename(partial, target);
        resolve({ bytes: stat.size, seconds: total, clips: intervals.length });
      } catch (error) {
        await fs.rm(partial, { force: true }).catch(() => {});
        reject(error);
      }
    };
    child.once('error', error => void finish(null, error));
    child.once('close', code => void finish(code));
  });
}
