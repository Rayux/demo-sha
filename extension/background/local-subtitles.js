// The content script sends bounded file chunks; only this worker contacts localhost.
(() => {
  const BASE = 'http://127.0.0.1:8766';
  let token = '';
  async function fetchJSON(path, options = {}) {
    let response;
    try {
      response = await fetch(BASE + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
    } catch {
      throw new Error('Cannot reach the local helper. If automatic startup is installed, wait a moment and reconnect. Otherwise open Local helper setup to enable it once.');
    }
    let data;
    try { data = await response.json(); } catch { throw new Error('Local subtitle service returned an invalid response.'); }
    if (!response.ok) {
      const error = new Error(data.error || data.message || `Local subtitle request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  async function health() {
    const data = await fetchJSON('/health');
    if (typeof data.token !== 'string' || data.token.length < 24) throw new Error('Unexpected local subtitle service. Check that Kage is running on port 8766.');
    token = data.token;
    const { token: secret, ...publicData } = data;
    return publicData;
  }
  async function authenticated(path, method, body, binary = false) {
    if (!token) await health();
    const send = () => fetchJSON(path, {
      method, headers: { 'X-Kage-Token': token, ...(body !== undefined ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) },
      ...(body !== undefined ? { body: binary ? body : JSON.stringify(body) } : {})
    });
    try { return await send(); }
    catch (error) {
      // A restarted helper rotates its token. A rejected request has no side effects.
      if (error.status !== 401) throw error;
      await health();
      return send();
    }
  }
  globalThis.KageLocalSubtitles = {
    async request(message, sender) {
      let origin;
      try { origin = new URL(sender.url || sender.tab?.url); } catch {}
      if (!sender.tab || !origin || !['https:', 'http:'].includes(origin.protocol)
          || !(/(^|\.)bilibili\.com$/.test(origin.hostname) || /^(?:www\.)?anime1\.me$/.test(origin.hostname)
            || ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(origin.hostname))
          || (sender.frameId !== undefined && sender.frameId !== 0)
          || (sender.id && sender.id !== chrome.runtime.id)) throw new Error('Video import is available from a Bilibili, YouTube, or anime1.me study panel.');
      const action = message.action;
      if (action === 'health') return health();
      const anime1 = /^(?:www\.)?anime1\.me$/.test(origin.hostname);
      if (anime1 && ['create', 'recover'].includes(action)) {
        // Older helpers reject anime1 page identities; say how to fix it instead.
        const status = await health();
        if (!status.capabilities?.anime1Pages) throw new Error('Restart the local helper (npm run subtitles:start) to enable anime1.me subtitles.');
      }
      if (action === 'list') {
        const status = await health();
        if (!status.capabilities?.jobQueue) throw new Error('The running helper needs this update. Let current processing finish before restarting it; automatic startup remains enabled.');
        const queue = await authenticated('/jobs', 'GET');
        return { ...queue, translationPrioritySupported: status.capabilities?.translationPriority === true };
      }
      const pageURL = () => {
        // sender.url can retain the document's initial URL after a History API
        // part switch. Our content script sends location.href at request time.
        let current = origin;
        if (message.pageUrl !== undefined) {
          try { current = new URL(message.pageUrl); } catch { throw new Error('Invalid current video page.'); }
          if (current.origin !== origin.origin || current.username || current.password) throw new Error('Current video must belong to the sending Bilibili or YouTube page.');
        }
        if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(current.hostname)) {
          const id = current.pathname === '/watch' ? current.searchParams.get('v')
            : current.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})\/?$/)?.[1];
          if (current.port || !/^[\w-]{11}$/.test(id || '')) throw new Error('Open a specific YouTube video first.');
          return `https://www.youtube.com/watch?v=${id}`;
        }
        if (/^(?:www\.)?anime1\.me$/.test(current.hostname)) {
          const post = current.pathname.match(/^\/(\d{1,12})\/?$/)?.[1];
          if (current.port || !post) throw new Error('Open a specific anime1.me episode first.');
          return `https://anime1.me/${post}`;
        }
        const video = current.pathname.match(/^\/video\/(BV[a-zA-Z0-9]+)\/?$/);
        const episode = current.pathname.match(/^\/bangumi\/play\/(ep\d+)\/?$/);
        const part = current.searchParams.get('p') || '1';
        if ((!video && !episode) || (video && !/^[1-9]\d{0,4}$/.test(part))) throw new Error('Open a specific Bilibili video part or episode first.');
        return episode ? `https://www.bilibili.com/bangumi/play/${episode[1]}`
          : `https://www.bilibili.com/video/${video[1]}?p=${Number(part)}`;
      };
      if (action === 'recover') {
        const status = await health();
        if (!status.capabilities?.recovery) return { job: null };
        return authenticated(`/recover?url=${encodeURIComponent(pageURL())}`, 'GET');
      }
      if (action === 'download') {
        // Bind the download to the sending tab, never an arbitrary URL in a message.
        const sourceUrl = pageURL();
        if (new URL(sourceUrl).hostname === 'anime1.me') throw new Error('On anime1.me, click play on the video, then choose Prepare browser audio.');
        const status = await health();
        const platform = new URL(sourceUrl).hostname === 'www.youtube.com' ? 'YouTube' : 'Bilibili';
        if (!status.capabilities?.[platform === 'YouTube' ? 'youtubeDownload' : 'bilibiliDownload']) throw new Error(`Update and restart the local helper with npm run subtitles:setup and npm run subtitles:start to enable ${platform} downloads.`);
        return authenticated('/jobs', 'POST', { sourceUrl });
      }
      if (action === 'create') {
        if (typeof message.name !== 'string' || !message.name.trim() || message.name.length > 512
            || !Number.isSafeInteger(message.size) || message.size <= 0 || message.size > 4 * 1024 ** 3) throw new Error('Choose an audio or video file up to 4 GB.');
        return authenticated('/jobs', 'POST', { name: message.name, size: message.size, pageUrl: pageURL() });
      }
      if (typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{12,80}$/.test(message.id)) throw new Error('Invalid local subtitle job.');
      const path = `/jobs/${encodeURIComponent(message.id)}`;
      if (action === 'status') return authenticated(path, 'GET');
      if (action === 'prioritize') {
        const status = await health();
        if (!status.capabilities?.translationPriority) throw new Error('The running helper needs this update to prioritize translations. Let current processing finish before restarting it; automatic startup remains enabled.');
        return authenticated(path + '/prioritize', 'POST', {});
      }
      if (action === 'start') {
        const status = await health();
        if (!status.capabilities?.translation) throw new Error('Restart the local helper with npm run subtitles:start to enable automatic Chinese translation.');
        const settings = await chrome.storage.local.get(['apiEndpoint', 'apiModel']);
        let local = false;
        try {
          const endpoint = new URL(settings.apiEndpoint);
          local = ['http:', 'https:'].includes(endpoint.protocol) && ['localhost', '127.0.0.1'].includes(endpoint.hostname)
            && !endpoint.username && !endpoint.password;
        } catch {}
        const translation = {
          endpoint: local ? settings.apiEndpoint : 'http://127.0.0.1:11434/v1/chat/completions',
          model: local ? settings.apiModel || 'gemma2' : 'gemma2'
        };
        return authenticated(path + '/start', 'POST', { translation });
      }
      if (action === 'cancel') return authenticated(path, 'DELETE');
      if (action === 'upload') {
        if (!Number.isSafeInteger(message.offset) || message.offset < 0 || message.offset > 4 * 1024 ** 3
            || typeof message.data !== 'string' || !message.data.length || message.data.length > 700000
            || !/^[A-Za-z0-9+/]+={0,2}$/.test(message.data)) throw new Error('Invalid upload chunk. Choose the file again.');
        let bytes;
        try { bytes = Uint8Array.from(atob(message.data), character => character.charCodeAt(0)); }
        catch { throw new Error('Invalid upload encoding.'); }
        if (bytes.length > 512 * 1024) throw new Error('Upload chunk is too large.');
        return authenticated(path + `/audio?offset=${message.offset}`, 'PUT', bytes, true);
      }
      throw new Error('Unknown local subtitle action.');
    }
  };
})();
