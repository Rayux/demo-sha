// Run before the site's requests. Sniff only a short prefix of ambiguous responses;
// do not decode or buffer media segments while looking for subtitle tracks.
(() => {
  if (window.__kageInterceptor) return;
  window.__kageInterceptor = true;
  const recent = new Map();
  const manifests = new Map();
  const downloads = new Map();
  const trackLanguages = new Map();
  let activePage = location.href;
  const isNetflix = /(^|\.)netflix\.com$/.test(location.hostname || '');
  const videoId = () => location.pathname?.match(/^\/watch\/(\d+)(?:\/|$)/)?.[1];
  const postStatus = status => window.postMessage({ type: 'KAGE_NETFLIX_STATUS', page: location.href, status }, location.origin);
  function syncPage() {
    if (activePage === location.href) return;
    activePage = location.href;
    downloads.clear();
    trackLanguages.clear();
  }
  function inspectManifest(value) {
    if (!isNetflix || !globalThis.KageNetflix) return;
    syncPage();
    // Netflix can parse a playback manifest on Browse before changing the URL.
    // Save only compact, validated metadata; download subtitles for the active title only.
    const grouped = new Map();
    for (const track of KageNetflix.discover(value)) {
      if (!grouped.has(track.videoId)) grouped.set(track.videoId, []);
      const tracks = grouped.get(track.videoId);
      if (tracks.length < 16) tracks.push(track);
    }
    if (!grouped.size) return;
    for (const [id, tracks] of grouped) {
      manifests.delete(id);
      manifests.set(id, tracks);
      if (manifests.size > 4) manifests.delete(manifests.keys().next().value);
    }
    const tracks = manifests.get(videoId());
    if (tracks) loadTracks(tracks);
  }
  function loadTracks(tracks) {
    syncPage();
    // Fetch only one track per wanted language, leaving the player's selected language alone.
    const selected = ['ja', 'zh-Hant'].map(lang => tracks.find(t => t.videoId === videoId() && t.language === lang)).filter(Boolean);
    if (!selected.some(t => t.language === 'zh-Hant')) postStatus('No Traditional Chinese text track found; using the local model.');
    for (const track of selected) {
      const page = location.href;
      const key = `${track.videoId}:${track.id}`;
      trackLanguages.set(track.url, track.language);
      if (trackLanguages.size > 16) trackLanguages.delete(trackLanguages.keys().next().value);
      const previous = downloads.get(key);
      if (previous?.url === track.url && (previous.pending || recent.get(track.url)?.page === page)) continue;
      const download = { url: track.url, pending: true };
      downloads.set(key, download);
      if (track.language === 'zh-Hant') postStatus('Loading Netflix Traditional Chinese subtitles…');
      originalFetch(track.url).then(response => {
        if (!response.ok) throw new Error('Subtitle download failed');
        return readSubtitle(response);
      }).then(text => {
        if (!text) throw new Error('No supported text subtitles');
        if (downloads.get(key) !== download) return;
        download.pending = false;
        publish(track.url, text, page, track.language);
      }).catch(() => {
        if (downloads.get(key) !== download) return;
        downloads.delete(key);
        if (page === location.href && track.language === 'zh-Hant') postStatus('Netflix Chinese track could not be loaded; using the local model.');
      });
      if (downloads.size > 16) downloads.delete(downloads.keys().next().value);
    }
  }
  const LIMIT = 2_000_000;
  function eligible(url, type = '') {
    try {
      const u = new URL(url, location.href);
      return (/\.(netflix\.com|nflxvideo\.net|nflxext\.com)$/.test(u.hostname) && /xml|vtt|ttml|octet-stream/.test(type)) ||
        (/\.(bilibili\.com|hdslb\.com)$/.test(u.hostname) && /subtitle|\.json(?:\?|$)/.test(u.pathname)) ||
        (u.hostname.endsWith('.youtube.com') && u.pathname === '/api/timedtext');
    } catch { return false; }
  }
  function looksLikeSubtitles(prefix) {
    return /^\s*(?:<\?xml\b|<(?:\w+:)?tt\b|WEBVTT\b|\{)/.test(prefix.replace(/^\uFEFF/, ''));
  }
  function publish(url, text, page, language = trackLanguages.get(url)) {
    if (page !== location.href || text.length > LIMIT || !looksLikeSubtitles(text)) return;
    recent.set(url, { type: 'KAGE_RAW_SUBTITLES', url, text, page, language });
    if (recent.size > 8) recent.delete(recent.keys().next().value);
    window.postMessage(recent.get(url), location.origin);
  }
  async function readSubtitle(response) {
    if (Number(response.headers.get('content-length')) > LIMIT || !response.body) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return text + decoder.decode();
        size += value.byteLength;
        if (size > LIMIT) return null;
        text += decoder.decode(value, { stream: true });
        // Wait for a short prefix to account for chunk boundaries, then reject binary.
        if (text.length >= 64 && !looksLikeSubtitles(text)) return null;
      }
    } finally {
      // A cloned fetch stream can wait on its sibling; do not await cancellation.
      reader.cancel().catch(() => {});
    }
  }
  window.addEventListener('message', event => {
    if (event.source === window && event.origin === location.origin && event.data?.type === 'KAGE_TRACKS_READY') {
      syncPage();
      for (const data of recent.values()) if (data.page === location.href) window.postMessage(data, location.origin);
      const tracks = manifests.get(videoId());
      if (tracks) loadTracks(tracks);
    }
  });
  const originalFetch = window.fetch;
  const originalParse = JSON.parse;
  if (isNetflix) {
    JSON.parse = function(...args) {
      const value = originalParse.apply(this, args);
      if (typeof args[0] === 'string' && /"(?:timedtexttracks|textTracks)"/.test(args[0])) {
        try { inspectManifest(value); } catch { /* Never interfere with player parsing. */ }
      }
      return value;
    };
    const originalJSON = Response.prototype.json;
    Response.prototype.json = async function(...args) {
      const value = await originalJSON.apply(this, args);
      try { inspectManifest(value); } catch { /* Native response behavior stays intact. */ }
      return value;
    };
  }
  window.fetch = async function(...args) {
    syncPage();
    const page = location.href;
    const response = await originalFetch.apply(this, args);
    const url = response.url || String(args[0]?.url || args[0]);
    if (eligible(url, response.headers.get('content-type') || '')) {
      readSubtitle(response.clone()).then(text => { if (text) publish(url, text, page); }).catch(() => {});
    }
    return response;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._kageUrl = String(url);
    return originalOpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    syncPage();
    const page = location.href;
    this.addEventListener('load', async () => {
      try {
        const url = this.responseURL || this._kageUrl;
        const contentType = this.getResponseHeader('content-type') || '';
        // responseType=json bypasses both JSON.parse and Response.json hooks.
        // Inspect only already-decoded JSON; never read binary media as a manifest.
        if (isNetflix && globalThis.KageNetflix?.safeURL(new URL(url, location.href).href)) {
          if (this.responseType === 'json') inspectManifest(this.response);
          else if ((!this.responseType || this.responseType === 'text') && /json/i.test(contentType)) {
            const json = this.responseText;
            if (typeof json === 'string' && json.length <= LIMIT && /"(?:timedtexttracks|textTracks)"/.test(json)) {
              try { inspectManifest(originalParse(json)); } catch { /* Non-JSON responses are left alone. */ }
            }
          }
        }
        if (!eligible(url, contentType)) return;
        let text;
        if (this.responseType === 'arraybuffer') {
          if (!this.response || this.response.byteLength > LIMIT) return;
          const decoder = new TextDecoder();
          if (!looksLikeSubtitles(decoder.decode(this.response.slice(0, 128)))) return;
          text = decoder.decode(this.response);
        } else if (this.responseType === 'blob') {
          if (!this.response || this.response.size > LIMIT) return;
          if (!looksLikeSubtitles(await this.response.slice(0, 128).text())) return;
          text = await this.response.text();
        } else if (this.responseType === 'document') {
          text = new XMLSerializer().serializeToString(this.responseXML);
        } else {
          text = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
        }
        if (text) publish(url, text, page);
      } catch { /* Unsupported responses retain native DOM synchronization. */ }
    }, { once: true });
    return originalSend.apply(this, args);
  };
})();
