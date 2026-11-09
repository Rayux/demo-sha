import { bilibiliURL } from './bilibili.mjs';

// Canonical page identities only. Stream URLs are resolved by yt-dlp internally.
export function videoURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Open a Bilibili or YouTube video first.'); }
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    const id = url.pathname === '/watch' ? url.searchParams.get('v')
      : url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})\/?$/)?.[1];
    if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password || !/^[\w-]{11}$/.test(id || '')) {
      throw new Error('Open a specific YouTube video first.');
    }
    return `https://www.youtube.com/watch?v=${id}`;
  }
  if (/^(?:www\.)?anime1\.me$/i.test(url.hostname)) {
    const post = url.pathname.match(/^\/(\d{1,12})\/?$/)?.[1];
    if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password || !post) {
      throw new Error('Open a specific anime1.me episode first.');
    }
    return `https://anime1.me/${post}`;
  }
  return bilibiliURL(value);
}

// anime1.me pages identify uploaded browser audio only; the helper never downloads them.
export function downloadableVideoURL(value) {
  const canonical = videoURL(value);
  if (new URL(canonical).hostname === 'anime1.me') throw new Error('anime1.me episodes are prepared with Prepare browser audio.');
  return canonical;
}

export const videoPlatform = value => new URL(value).hostname === 'www.youtube.com' ? 'YouTube' : 'Bilibili';
export function videoName(value) {
  const url = new URL(value);
  return `${videoPlatform(value)} ${url.hostname === 'www.youtube.com' ? url.searchParams.get('v') : url.pathname.split('/').pop() + url.search} (audio)`;
}
