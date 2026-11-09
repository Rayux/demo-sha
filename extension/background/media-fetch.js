// The extension origin can read permitted media responses without the page's
// CORS restrictions. Chrome keeps control of its own existing network route.
(() => {
  const MAX_BYTES = 128 * 1024 * 1024, CHUNK_BYTES = 64 * 1024, MAX_STREAMS = 4, IDLE_MS = 25000;
  const ORIGIN = 'https://*.googlevideo.com/*';
  const sessions = new Map();
  const MIMES = new Set(['audio/mp4', 'audio/webm', 'video/mp4', 'application/octet-stream']);
  const messages = {
    YT_INVALID_REQUEST: 'The browser audio request is invalid. Refresh this video and try again.',
    YT_INVALID_SENDER: 'Browser audio is available only in the requesting YouTube tab.',
    YT_MEDIA_PERMISSION_REQUIRED: 'Allow Kage access to YouTube media when prompted, then try again.',
    YT_INVALID_MEDIA_URL: 'The player supplied an unsupported audio address. Refresh this video and try again.',
    YT_MEDIA_REDIRECT: 'YouTube changed the media address. Refresh this video and try again.',
    YT_BUSY: 'Browser audio is already being fetched in this tab. Stop it before trying again.',
    YT_STREAM_LIMIT: 'Too many browser audio downloads are running. Wait for one to finish.',
    YT_REQUEST_CLOSED: 'This browser audio request has stopped. Start preparation again.',
    YT_CONCURRENT_READ: 'The browser audio stream was read out of order. Start preparation again.',
    YT_NETWORK_ERROR: 'Chrome could not fetch the YouTube audio. Check the VPN connection and try again.',
    YT_TIMEOUT: 'The YouTube audio request timed out. Check the connection and try again.',
    YT_CANCELLED: 'Browser audio preparation stopped.',
    YT_RESPONSE_TYPE: 'YouTube returned an unsupported media response. Refresh this video and try again.',
    YT_RESPONSE_SIZE: 'YouTube returned an invalid or incomplete audio response. Refresh this video and try again.',
    YT_AUDIO_TOO_LARGE: 'Audio exceeds the 128 MiB browser limit. Import a matching local file.'
  };
  class MediaError extends Error {
    constructor(code) { super(`YouTube audio [${code}]: ${messages[code] || messages.YT_NETWORK_ERROR}`); this.code = code; }
  }
  const fail = code => { throw new MediaError(code); };
  function youtube(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)
        && !url.port && !url.username && !url.password ? url : null;
    } catch { return null; }
  }
  function page(value) {
    const url = youtube(value);
    if (!url || url.pathname !== '/watch' || url.hash || [...url.searchParams.keys()].length !== 1
      || !/^[\w-]{11}$/.test(url.searchParams.get('v') || '')) return '';
    return `https://www.youtube.com/watch?v=${url.searchParams.get('v')}`;
  }
  function senderOwner(sender) {
    const url = youtube(sender?.url);
    if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id) || sender.tab.id < 0
      || sender.frameId !== 0 || !url) fail('YT_INVALID_SENDER');
    return { tabId: sender.tab.id, origin: url.origin, documentId: sender.documentId || null };
  }
  function sameOwner(session, owner) {
    return session.owner.tabId === owner.tabId && session.owner.origin === owner.origin
      && session.owner.documentId === owner.documentId;
  }
  function mediaURL(value) {
    try {
      if (typeof value !== 'string' || value.length > 16384) return null;
      const url = new URL(value);
      if (url.protocol !== 'https:' || !/(^|\.)googlevideo\.com$/.test(url.hostname) || url.port
        || url.username || url.password || url.hash || url.pathname !== '/videoplayback'
        || url.searchParams.getAll('id').length !== 1 || url.searchParams.getAll('itag').length !== 1
        || !/^[A-Za-z0-9_.~-]{1,256}$/.test(url.searchParams.get('id') || '')
        || !/^[1-9]\d{0,5}$/.test(url.searchParams.get('itag') || '')) return null;
      return url;
    } catch { return null; }
  }
  function finish(session, reason = 'YT_CANCELLED') {
    if (!session || session.closed) return;
    session.closed = true; session.reason = reason;
    clearTimeout(session.timer);
    session.controller.abort();
    if (session.reader) Promise.resolve(session.reader.cancel()).catch(() => {});
    if (sessions.get(session.owner.tabId) === session) sessions.delete(session.owner.tabId);
    session.pending = null;
  }
  function touch(session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => finish(session, 'YT_TIMEOUT'), IDLE_MS);
  }
  function active(session) { if (session.closed) fail(session.reason || 'YT_REQUEST_CLOSED'); }
  async function permission() {
    try { return Boolean(await chrome.permissions.contains({ origins: [ORIGIN] })); }
    catch { return false; }
  }
  function responseHeaders(response) {
    const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!MIMES.has(mime)) fail('YT_RESPONSE_TYPE');
    const length = response.headers.get('content-length'), range = response.headers.get('content-range');
    let expected = null;
    if (length !== null) {
      if (!/^\d{1,16}$/.test(length) || !Number.isSafeInteger(Number(length))) fail('YT_RESPONSE_SIZE');
      expected = Number(length);
      if (expected > MAX_BYTES) fail('YT_AUDIO_TOO_LARGE');
    }
    if (range !== null) {
      const match = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
      if (!match) fail('YT_RESPONSE_SIZE');
      const [start, end, total] = match.slice(1).map(Number);
      if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || end >= total) fail('YT_RESPONSE_SIZE');
      if (total > MAX_BYTES) fail('YT_AUDIO_TOO_LARGE');
      if (expected !== null && expected !== end - start + 1) fail('YT_RESPONSE_SIZE');
      expected = end - start + 1;
    }
    const headers = { 'content-type': mime };
    if (range !== null) headers['content-range'] = range;
    if (length !== null) headers['content-length'] = length;
    return { headers, expected };
  }
  async function open(message, owner, canonicalPage) {
    const url = mediaURL(message.url);
    if (!url) fail('YT_INVALID_MEDIA_URL');
    if (sessions.has(owner.tabId)) fail('YT_BUSY');
    if (sessions.size >= MAX_STREAMS) fail('YT_STREAM_LIMIT');
    const session = { owner, page: canonicalPage, requestId: message.requestId, fetchId: message.fetchId,
      controller: new AbortController(), reader: null, pending: null, offset: 0, received: 0, sequence: 1, reading: false, closed: false };
    sessions.set(owner.tabId, session); touch(session);
    let response;
    try {
      if (!await permission()) fail('YT_MEDIA_PERMISSION_REQUIRED');
      active(session);
      response = await fetch(url.href, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: session.controller.signal });
      active(session); touch(session);
      const finalURL = mediaURL(response.url);
      if (!finalURL || finalURL.origin !== url.origin || finalURL.pathname !== url.pathname
        || finalURL.searchParams.get('id') !== url.searchParams.get('id')
        || finalURL.searchParams.get('itag') !== url.searchParams.get('itag')) fail('YT_MEDIA_REDIRECT');
      if (!response.ok) {
        if (response.body) Promise.resolve(response.body.cancel()).catch(() => {});
        finish(session);
        return { status: response.status, headers: {}, body: false };
      }
      const parsed = responseHeaders(response);
      if (!response.body) fail('YT_RESPONSE_SIZE');
      session.expected = parsed.expected;
      session.reader = response.body.getReader();
      return { status: response.status, headers: parsed.headers, body: true };
    } catch (error) {
      const reason = session.closed ? session.reason : error instanceof MediaError ? error.code : 'YT_NETWORK_ERROR';
      if (!session.reader && response?.body) Promise.resolve(response.body.cancel()).catch(() => {});
      finish(session, reason);
      fail(reason);
    }
  }
  function lookup(message, owner, canonicalPage) {
    const session = sessions.get(owner.tabId);
    if (!session || !sameOwner(session, owner) || session.page !== canonicalPage || session.requestId !== message.requestId
      || (message.fetchId !== undefined && session.fetchId !== message.fetchId)) fail('YT_REQUEST_CLOSED');
    return session;
  }
  async function read(session) {
    if (!session.reader) fail('YT_REQUEST_CLOSED');
    if (session.reading) fail('YT_CONCURRENT_READ');
    session.reading = true; touch(session);
    try {
      while (!session.pending || session.offset === session.pending.byteLength) {
        session.pending = null; session.offset = 0;
        const result = await session.reader.read();
        active(session); touch(session);
        if (result.done) {
          if (!session.received || (session.expected !== null && session.received !== session.expected)) fail('YT_RESPONSE_SIZE');
          const sequence = session.sequence;
          finish(session);
          return { done: true, data: '', sequence };
        }
        if (!(result.value instanceof Uint8Array)) fail('YT_RESPONSE_SIZE');
        session.received += result.value.byteLength;
        if (session.received > MAX_BYTES) fail('YT_AUDIO_TOO_LARGE');
        if (session.expected !== null && session.received > session.expected) fail('YT_RESPONSE_SIZE');
        session.pending = result.value;
      }
      const bytes = session.pending.subarray(session.offset, session.offset + CHUNK_BYTES);
      session.offset += bytes.byteLength;
      // Runtime messaging uses JSON rather than transferable ArrayBuffers.
      let binary = '';
      for (let offset = 0; offset < bytes.byteLength; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return { done: false, data: btoa(binary), sequence: session.sequence++ };
    } catch (error) {
      const reason = session.closed ? session.reason : error instanceof MediaError ? error.code : 'YT_NETWORK_ERROR';
      finish(session, reason); fail(reason);
    } finally { session.reading = false; }
  }
  async function request(message, sender) {
    try {
      const owner = senderOwner(sender);
      if (!message || message.type !== 'CHROME_AUDIO_FETCH') fail('YT_INVALID_REQUEST');
      if (message.action === 'status') {
        if (message.page !== undefined && !page(message.page)) fail('YT_INVALID_REQUEST');
        return { available: await permission() };
      }
      const canonicalPage = page(message.page);
      const validFetchId = typeof message.fetchId === 'string' && /^[1-9]\d{0,15}$/.test(message.fetchId);
      if (!canonicalPage || typeof message.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(message.requestId)
        || !['open', 'read', 'close', 'cancel'].includes(message.action)
        || (message.action !== 'cancel' && !validFetchId)
        || (message.fetchId !== undefined && !validFetchId)) fail('YT_INVALID_REQUEST');
      if (message.action === 'open') return await open(message, owner, canonicalPage);
      const current = sessions.get(owner.tabId);
      if (!current && ['close', 'cancel'].includes(message.action)) return { closed: true };
      const session = lookup(message, owner, canonicalPage);
      if (message.action === 'read') return await read(session);
      finish(session); return { closed: true };
    } catch (error) { throw error instanceof MediaError ? error : new MediaError('YT_NETWORK_ERROR'); }
  }
  chrome.tabs?.onRemoved?.addListener(tabId => finish(sessions.get(tabId)));
  chrome.permissions?.onRemoved?.addListener(removed => {
    if (removed.origins?.some(origin => origin === ORIGIN || origin === '<all_urls>')) {
      for (const session of [...sessions.values()]) finish(session, 'YT_MEDIA_PERMISSION_REQUIRED');
    }
  });
  globalThis.KageMediaFetch = { request };
})();
