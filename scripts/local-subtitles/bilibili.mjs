import { spawn } from 'node:child_process';

// Accept page identities only, never caller-supplied CDN URLs or downloader options.
export function bilibiliURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Open a Bilibili video or episode first.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !/^(?:www\.)?bilibili\.com$/.test(url.hostname)
      || url.port || url.username || url.password) throw new Error('Use a Bilibili video page.');
  const video = url.pathname.match(/^\/video\/(BV[a-zA-Z0-9]+)\/?$/);
  const episode = url.pathname.match(/^\/bangumi\/play\/(ep\d+)\/?$/);
  if (episode) return `https://www.bilibili.com/bangumi/play/${episode[1]}`;
  const part = url.searchParams.get('p') || '1';
  if (!video || !/^[1-9]\d{0,4}$/.test(part)) throw new Error('Open a specific Bilibili video part or episode.');
  return `https://www.bilibili.com/video/${video[1]}?p=${Number(part)}`;
}

export async function downloadBilibili({ python, worker, url, directory, operation, stopChild, onProgress }) {
  operation.controller.signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawn(python, [worker, '--url', url, '--directory', directory],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    operation.child = child;
    let buffer = '', stderr = '', failure = '', settled = false;
    let progressWrite = Promise.resolve();
    const timer = setTimeout(() => { failure = 'Bilibili download timed out. Retry or import a local file.'; stopChild(child); }, 2 * 3600 * 1000);
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-2000); });
    child.stdout.on('data', bytes => {
      buffer += bytes.toString();
      if (buffer.length > 65536) { failure = 'Invalid download progress.'; stopChild(child); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'progress') progressWrite = progressWrite.then(() => onProgress(event)).catch(() => {});
        } catch { /* Ignore third-party logging. */ }
      }
    });
    async function finish(code, error) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      await progressWrite;
      try {
        operation.controller.signal.throwIfAborted();
        if (error || code !== 0 || failure) throw new Error(failure || stderr.trim() || error?.message || 'Bilibili download failed. Retry or import a local file.');
        resolve();
      } catch (cause) { reject(cause); }
    }
    child.once('error', error => void finish(null, error));
    child.once('close', code => void finish(code));
  });
}
