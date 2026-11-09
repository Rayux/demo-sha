// anime1.me serves episodes from *.v.anime1.me behind HttpOnly access cookies,
// and answers credentialed page requests with `Access-Control-Allow-Origin: *`,
// which browsers reject. The page therefore cannot read the file. The extension
// service worker holds host access to *.v.anime1.me, so it fetches the signed
// URL here (cookies attached by the browser).
//
// Episodes are often hundreds of MB, so nothing is buffered whole: the content
// script pulls the body in order, one bounded slice per `read`, and uploads each
// slice to the local helper before asking for the next.
(() => {
  const PORT_NAME = 'kage-anime1-media';
  const MAX_BYTES = 4 * 1024 * 1024 * 1024;
  const MAX_READ = 1024 * 1024;
  const IDLE_MS = 60000;
  const MIMES = new Set(['video/mp4', 'application/octet-stream']);

  function pageURL(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !/^(?:www\.)?anime1\.me$/i.test(url.hostname) || url.port || !/^\/\d+/.test(url.pathname)) return '';
      return url.origin + url.pathname;
    } catch { return ''; }
  }

  function mediaURL(value) {
    try {
      if (typeof value !== 'string' || value.length > 4096) return null;
      const url = new URL(value);
      if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.v\.anime1\.me$/i.test(url.hostname) || url.port
        || url.username || url.password || url.hash || !/^\/[\w./-]+\.mp4$/i.test(url.pathname) || url.pathname.includes('..')) return null;
      return url;
    } catch { return null; }
  }

  function base64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.byteLength; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary);
  }

  function handle(port) {
    const sender = port.sender;
    const senderPage = sender?.id === chrome.runtime.id && Number.isInteger(sender?.tab?.id) && sender.tab.id >= 0
      && (sender.frameId === undefined || sender.frameId === 0) ? pageURL(sender.url || sender.tab.url) : '';
    const controller = new AbortController();
    let started = false, closed = false, idle = null, reader = null, total = null;
    let received = 0, leftover = null, reading = false, ended = false;
    const send = payload => { if (!closed) { try { port.postMessage(payload); } catch { stop(); } } };
    const stop = () => {
      if (closed) return;
      closed = true; clearTimeout(idle); controller.abort();
      if (reader) reader.cancel().catch(() => {});
      leftover = null;
    };
    // The content script closes the port once it has the error, so it is never lost.
    const fail = message => { send({ type: 'error', error: message }); stop(); };
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => fail('Browser audio download stalled. Check the connection and try again.'), IDLE_MS); };
    port.onDisconnect.addListener(stop);

    async function start(message) {
      if (!senderPage) return fail('Browser audio is available only from an anime1.me episode tab.');
      if (pageURL(message.page) !== senderPage) return fail('Browser audio stopped after leaving this episode.');
      const url = mediaURL(message.src);
      if (!url) return fail('The anime1.me player supplied an unsupported video address. Refresh the page and try again.');
      touch();
      try {
        const response = await fetch(url.href, { credentials: 'include', redirect: 'follow', cache: 'no-store', signal: controller.signal });
        if (closed) { response.body?.cancel().catch(() => {}); return; }
        const fail2 = text => { response.body?.cancel().catch(() => {}); fail(text); };
        if (!mediaURL(response.url)) return fail2('anime1.me redirected the video to an unexpected address. Refresh the page and try again.');
        if (!response.ok || !response.body) return fail2(`anime1.me returned HTTP ${response.status}. Click play on the video, wait for it to start, then try again.`);
        const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (mime && !MIMES.has(mime)) return fail2('anime1.me returned an unsupported media response. Refresh the page and try again.');
        const length = response.headers.get('content-length');
        total = length && /^\d{1,16}$/.test(length) ? Number(length) : null;
        if (!total) return fail2('anime1.me did not report the video size. Refresh the page and try again.');
        if (total > MAX_BYTES) return fail2('This episode is larger than 4 GiB. Import a local file instead.');
        reader = response.body.getReader();
        send({ type: 'ready', total, mimeType: 'video/mp4' });
        touch();
      } catch (error) {
        if (!closed) fail(error?.name === 'AbortError' ? 'Browser audio preparation stopped.'
          : 'Could not reach the anime1.me video server. Check the connection and try again.');
      }
    }

    async function read(size) {
      if (!reader || reading || ended) return fail('The browser audio stream was read out of order. Start preparation again.');
      reading = true; touch();
      try {
        const parts = [];
        let have = 0;
        while (have < size) {
          if (leftover) {
            const take = leftover.subarray(0, size - have);
            parts.push(take); have += take.byteLength;
            leftover = take.byteLength < leftover.byteLength ? leftover.subarray(take.byteLength) : null;
            continue;
          }
          const { value, done } = await reader.read();
          if (closed) return;
          touch();
          if (done) { ended = true; break; }
          if (!(value instanceof Uint8Array)) return fail('Browser audio download was invalid. Refresh the page and try again.');
          received += value.byteLength;
          if (received > total) return fail('anime1.me sent more data than it reported. Refresh the page and try again.');
          leftover = value;
        }
        if (ended && received !== total) return fail('Browser audio download was incomplete. Refresh the page and try again.');
        const chunk = new Uint8Array(have);
        let offset = 0;
        for (const part of parts) { chunk.set(part, offset); offset += part.byteLength; }
        send({ type: 'data', data: base64(chunk), done: ended && !leftover });
        if (ended && !leftover) stop();
      } catch (error) {
        if (!closed) fail(error?.name === 'AbortError' ? 'Browser audio preparation stopped.'
          : 'The anime1.me download was interrupted. Check the connection and try again.');
      } finally { reading = false; }
    }

    port.onMessage.addListener(message => {
      if (closed) return;
      if (message?.type === 'start' && !started) { started = true; void start(message); }
      else if (message?.type === 'read' && Number.isSafeInteger(message.size) && message.size > 0 && message.size <= MAX_READ) void read(message.size);
    });
  }

  chrome.runtime.onConnect?.addListener(port => { if (port.name === PORT_NAME) handle(port); });
  globalThis.KageAnime1Fetch = { mediaURL, pageURL };
})();
