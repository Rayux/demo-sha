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
          || !/(^|\.)bilibili\.com$/.test(origin.hostname)
          || (sender.id && sender.id !== chrome.runtime.id)) throw new Error('Video import is available from a Bilibili study panel.');
      const action = message.action;
      if (action === 'health') return health();
      if (action === 'list') {
        const status = await health();
        if (!status.capabilities?.jobQueue) throw new Error('The running helper needs this update. Let current processing finish before restarting it; automatic startup remains enabled.');
        return authenticated('/jobs', 'GET');
      }
      if (action === 'download') {
        // Bind the download to the sending tab, never an arbitrary URL in a message.
        const video = origin.pathname.match(/^\/video\/(BV[a-zA-Z0-9]+)\/?$/);
        const episode = origin.pathname.match(/^\/bangumi\/play\/(ep\d+)\/?$/);
        const part = origin.searchParams.get('p') || '1';
        if ((!video && !episode) || (video && !/^[1-9]\d{0,4}$/.test(part))) throw new Error('Open a specific Bilibili video part or episode first.');
        const sourceUrl = episode ? `https://www.bilibili.com/bangumi/play/${episode[1]}`
          : `https://www.bilibili.com/video/${video[1]}?p=${Number(part)}`;
        const status = await health();
        if (!status.capabilities?.bilibiliDownload) throw new Error('Update and restart the local helper with npm run subtitles:setup and npm run subtitles:start to enable Bilibili downloads.');
        return authenticated('/jobs', 'POST', { sourceUrl });
      }
      if (action === 'create') {
        if (typeof message.name !== 'string' || !message.name.trim() || message.name.length > 512
            || !Number.isSafeInteger(message.size) || message.size <= 0 || message.size > 4 * 1024 ** 3) throw new Error('Choose an audio or video file up to 4 GB.');
        return authenticated('/jobs', 'POST', { name: message.name, size: message.size });
      }
      if (typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{12,80}$/.test(message.id)) throw new Error('Invalid local subtitle job.');
      const path = `/jobs/${encodeURIComponent(message.id)}`;
      if (action === 'status') return authenticated(path, 'GET');
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
