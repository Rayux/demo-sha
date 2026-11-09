// Intercept the anime1.me Video.js API response to obtain the signed MP4 URL.
// The download itself runs in the extension service worker (see
// background/anime1-fetch.js): the CDN's CORS policy blocks the page from
// reading the file with its access cookies. Cookies never leave the browser.
(() => {
  if (!/(^|\.)anime1\.me$/i.test(location.hostname) || window.__kageAnime1AudioMain) return;
  window.__kageAnime1AudioMain = true;

  const MAX_TIME = 60 * 1000;

  // Best known signed MP4 for the current page, keyed by page href.
  let candidate = null; // { href, src }
  let session = null;

  // ── Intercept the Video.js API call ─────────────────────────────────────────
  // anime1.me fires: $.ajax({ url: '//v.anime1.me/api', data: 'd=<apireq>' })
  // The response is { s: [{ src: '//host.v.anime1.me/cat/ep.mp4', type: 'video/mp4' }] }
  // We shadow fetch and XMLHttpRequest.open to catch the JSON before Video.js uses it.

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = String(args[0]?.url ?? args[0] ?? '');
    const result = originalFetch.apply(this, args);
    if (/\/\/v\.anime1\.me\/api/.test(url)) {
      result.then(async response => {
        try {
          const clone = response.clone();
          const data = await clone.json();
          recordCandidate(data);
        } catch { /* non-JSON or already consumed */ }
      }).catch(() => {});
    }
    return result;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const xhrUrls = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (/\/\/v\.anime1\.me\/api/.test(String(url))) xhrUrls.set(this, true);
    return originalOpen.call(this, method, url, ...rest);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (xhrUrls.get(this)) {
      this.addEventListener('load', () => {
        try { recordCandidate(JSON.parse(this.responseText)); } catch { /* ignore */ }
      }, { once: true });
    }
    return originalSend.apply(this, args);
  };

  function recordCandidate(data) {
    // data.s is an array of source objects; take the first mp4.
    const sources = Array.isArray(data?.s) ? data.s : [];
    const mp4 = sources.find(s => /video\/mp4/i.test(s?.type) && typeof s?.src === 'string');
    if (!mp4) return;
    // Normalise protocol-relative URLs.
    const src = mp4.src.startsWith('//') ? 'https:' + mp4.src : mp4.src;
    try { new URL(src); } catch { return; } // must be valid
    const page = canonicalPage();
    if (page) candidate = { href: page, src };
  }

  // ── Canonical page identity ──────────────────────────────────────────────────
  function canonicalPage() {
    try {
      const url = new URL(location.href);
      if (/(^|\.)anime1\.me$/i.test(url.hostname) && /^\/\d+/.test(url.pathname)) {
        return url.origin + url.pathname;
      }
    } catch { /* */ }
    return '';
  }

  // ── Download on request ──────────────────────────────────────────────────────
  function post(type, request, extra = {}, transfer = []) {
    window.postMessage({ type, requestId: request.requestId, page: request.page, ...extra }, location.origin, transfer);
  }

  function abortSession(request, message) {
    if (session === request) session = null;
    if (!request.finished) {
      request.controller.abort();
      post('KAGE_BROWSER_AUDIO_ERROR', request, { error: message });
    }
  }

  async function acquire(message) {
    const page = canonicalPage();
    if (!page) { window.postMessage({ type: 'KAGE_BROWSER_AUDIO_ERROR', requestId: message.requestId, page: message.page, error: 'Could not identify this anime1.me episode.' }, location.origin); return; }
    if (session) { post('KAGE_BROWSER_AUDIO_ERROR', message, { error: 'Audio preparation is already running in this tab.' }); return; }

    const request = { ...message, controller: new AbortController(), finished: false };
    session = request;

    const navigationTimer = setInterval(() => {
      if (canonicalPage() !== page) abortSession(request, 'Browser audio stopped after leaving this episode.');
    }, 500);
    const globalTimeout = setTimeout(() => abortSession(request, 'Timed out waiting for the anime1.me player. Refresh the page and try again.'), MAX_TIME);

    try {
      // Wait up to 8 s for the API response to arrive (user may not have clicked play yet).
      const src = await waitForCandidate(page, request.controller.signal);
      // The CDN answers credentialed page requests with a wildcard CORS header,
      // so the page cannot read the file. Hand the signed URL to the extension,
      // whose service worker has host access and fetches it with the cookies.
      request.finished = true;
      post('KAGE_ANIME1_MEDIA_URL', request, { src });
    } catch (error) {
      if (!request.finished) abortSession(request, error?.message || 'Browser audio download failed. Refresh the page and try again.');
    } finally {
      clearInterval(navigationTimer);
      clearTimeout(globalTimeout);
      if (session === request) session = null;
    }
  }

  // Poll for the API response (Video.js fires the API when the user first clicks play).
  function waitForCandidate(page, signal) {
    return new Promise((resolve, reject) => {
      // Already available from a previous click?
      if (candidate?.href === page) { resolve(candidate.src); return; }
      let timer;
      const check = () => {
        if (signal.aborted) { clearInterval(timer); reject(new DOMException('Aborted', 'AbortError')); return; }
        if (candidate?.href === page) { clearInterval(timer); resolve(candidate.src); return; }
      };
      timer = setInterval(check, 200);
      // Abort after 8 s with a helpful message.
      setTimeout(() => {
        clearInterval(timer);
        if (!signal.aborted) reject(new Error('Click play on the anime1.me video first, then click Prepare browser audio again.'));
      }, 8000);
    });
  }

  // ── Message bus ─────────────────────────────────────────────────────────────
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window || event.origin !== location.origin || !message
      || typeof message.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(message.requestId)
      || typeof message.page !== 'string') return;

    if (message.type === 'KAGE_BROWSER_AUDIO_CANCEL') {
      if (session?.requestId === message.requestId) abortSession(session, 'Browser audio preparation cancelled.');
      return;
    }
    if (message.type !== 'KAGE_BROWSER_AUDIO_REQUEST' || message.page !== canonicalPage()) return;
    void acquire({ requestId: message.requestId, page: message.page });
  });

  window.addEventListener('pagehide', () => {
    if (session) abortSession(session, 'Tab closed or navigated. Browser audio preparation cancelled.');
  });
})();
