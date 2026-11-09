// Read the official player's audio metadata and fetch it through this browser's
// connection (including its active proxy). No cookies or localhost tokens cross
// this bridge. Media is fetched only after an explicit panel request.
(() => {
  if (!/(^|\.)bilibili\.com$/i.test(location.hostname) || window.__kageBilibiliAudioMain) return;
  window.__kageBilibiliAudioMain = true;
  const MAX_BYTES = 128 * 1024 * 1024;
  const MAX_METADATA = 2 * 1024 * 1024;
  const MAX_TIME = 10 * 60 * 1000;
  const IDLE_TIME = 30000;
  const originalParse = JSON.parse;
  const originalResponseJSON = Response.prototype.json;
  const originalResponseText = Response.prototype.text;
  const responseContexts = new WeakMap();
  const originalFetch = window.fetch;
  let activePage = canonicalPage(location.href);
  let generation = 0, candidate = null, session = null;
  let metadataIssue = '';
  const globalSnapshots = new Map(readGlobals().map(([name, value]) => [name, { value, generation }]));

  var selectedEpisode;
  var seasonCatalog;
  function seasonEpisode() {
    if (selectedEpisode?.href === location.href) return selectedEpisode.id;
    let state = window.__INITIAL_STATE__;
    try { if (!state && typeof __INITIAL_STATE__ !== 'undefined') state = __INITIAL_STATE__; } catch {}
    const info = state?.epInfo || state?.ep_info;
    const id = info?.id ?? info?.ep_id;
    if (/^\d{1,20}$/.test(String(id || ''))) return String(id);
    // Some players embed the selected episode instead of exposing page state.
    // Read only explicit episode identities on Bilibili-owned frame URLs.
    const ids = new Set();
    for (const frame of Array.from(globalThis.document?.querySelectorAll?.('iframe[src]') || []).slice(0, 100)) {
      try {
        const url = new URL(frame.getAttribute('src'), location.href);
        if (url.protocol !== 'https:' || !/(^|\.)bilibili\.com$/i.test(url.hostname) || url.username || url.password) continue;
        const path = url.pathname.match(/^\/bangumi\/play\/ep(\d{1,20})\/?$/i);
        const episode = path?.[1] || url.searchParams.get('ep_id') || url.searchParams.get('epid');
        if (/^\d{1,20}$/.test(String(episode || ''))) ids.add(String(episode));
      } catch {}
    }
    return ids.size === 1 ? [...ids][0] : '';
  }
  function canonicalPage(value) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || !/^(?:www\.)?bilibili\.com$/i.test(url.hostname)
          || url.port || url.username || url.password) return '';
      if (/^\/bangumi\/play\/ss\d+\/?$/i.test(url.pathname)) {
        const id = seasonEpisode();
        if (id) return `https://www.bilibili.com/bangumi/play/ep${id}`;
        return '';
      }
      const episode = url.pathname.match(/^\/bangumi\/play\/(ep\d+)\/?$/i);
      if (episode) return `https://www.bilibili.com/bangumi/play/${episode[1].toLowerCase()}`;
      const video = url.pathname.match(/^\/video\/(BV[a-zA-Z0-9]+)\/?$/);
      const part = url.searchParams.get('p') || '1';
      return video && /^[1-9]\d{0,4}$/.test(part) ? `https://www.bilibili.com/video/${video[1]}?p=${Number(part)}` : '';
    } catch { return ''; }
  }
  const numericId = value => (typeof value === 'string' || Number.isSafeInteger(value)) && /^\d{1,20}$/.test(String(value)) ? String(value) : '';
  function currentIdentity() {
    const page = canonicalPage(location.href);
    if (!page) return null;
    const url = new URL(page);
    const episode = url.pathname.match(/\/ep(\d+)$/);
    return episode ? { page, episode: episode[1], part: 1 } : { page, bvid: url.pathname.split('/').pop(), part: Number(url.searchParams.get('p')) };
  }
  function expectedCID(identity) {
    const state = window.__INITIAL_STATE__;
    if (!state || typeof state !== 'object') return '';
    if (identity.episode) {
      // epList can contain preloaded episodes. Look up the URL's exact episode.
      const direct = state.epInfo || state.ep_info;
      if (numericId(direct?.id ?? direct?.ep_id) === identity.episode) return numericId(direct.cid);
      const list = state.epList || state.ep_list;
      const entry = Array.isArray(list) && list.slice(0, 2000).find(item => numericId(item?.id ?? item?.ep_id) === identity.episode);
      return numericId(entry?.cid);
    }
    const data = state.videoData || state.videoInfo;
    if (!data || data.bvid !== identity.bvid) return '';
    const pages = data.pages;
    if (Array.isArray(pages)) {
      const entry = pages.slice(0, 2000).find(item => Number(item?.page) === identity.part);
      return numericId(entry?.cid);
    }
    return identity.part === 1 ? numericId(data.cid) : '';
  }
  function safeAudioURL(value) {
    if (typeof value !== 'string' || value.length > 8192) return '';
    try {
      const url = new URL(value.startsWith('//') ? `https:${value}` : value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port
        && /(^|\.)(bilivideo\.com|bilivideo\.cn|bilivideo\.net|hdslb\.com)$/i.test(url.hostname) ? url.href : '';
    } catch { return ''; }
  }
  function metadataURL(value) {
    try {
      const url = new URL(value, location.href);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port
        && /(^|\.)bilibili\.com$/i.test(url.hostname) && /(?:^|\/)playurl(?:\/|$)/i.test(url.pathname) ? url : null;
    } catch { return null; }
  }
  function protectedMedia(node) {
    return !!node && (node.is_drm === true || node.is_drm === 1 || node.is_drm === '1' || node.drm_tech_type > 0
      || !!node.drm_info || !!node.drm || !!node.contentProtection || !!node.content_protection
      || !!node.encryption || !!node.encrypted || !!node.widevine);
  }
  function availabilityIssue(node) {
    if (protectedMedia(node)) return 'Bilibili returned protected audio. Browser audio preparation does not support DRM.';
    if (node?.code !== undefined && /^-?\d{1,8}$/.test(String(node.code)) && Number(node.code) !== 0) {
      const code = Number(node.code);
      return code === -10403 ? 'Bilibili refused full audio for this episode (code -10403). Check login, UfunR, and episode access in this browser.'
        : `Bilibili rejected the playback request (code ${code}). Check episode access and UfunR.`;
    }
    if (node?.is_preview === true || node?.is_preview === 1 || node?.is_preview === '1'
        || node?.play_check?.play_detail === 'PLAY_PREVIEW' || node?.play_video_type === 'preview') {
      return 'Bilibili returned only a preview. Check login and access to the full episode in this browser.';
    }
    if (node?.play_check?.play_detail === 'PLAY_NONE' || node?.play_video_type === 'none') {
      return 'Bilibili reported that this episode is not playable. Check access in this browser.';
    }
    const plugins = node?.plugins;
    if (Array.isArray(plugins) && plugins.slice(0, 16).some(plugin => plugin?.name === 'AreaLimitPanel' && plugin.config?.is_block)) {
      return 'Bilibili reported a regional playback restriction. Check UfunR and confirm the episode plays in this browser.';
    }
    return '';
  }
  function knownWrappers(value) {
    const found = [], queue = [{ node: value, ancestors: [], depth: 0 }], seen = new WeakSet();
    while (queue.length && found.length < 16) {
      const item = queue.shift();
      if (!item.node || typeof item.node !== 'object' || Array.isArray(item.node) || seen.has(item.node)) continue;
      seen.add(item.node); found.push(item);
      if (item.depth >= 4) continue;
      for (const key of ['raw', 'data', 'result', 'video_info', 'videoInfo']) {
        if (queue.length + found.length >= 16) break;
        const child = item.node[key];
        if (child && typeof child === 'object' && !Array.isArray(child)) {
          queue.push({ node: child, ancestors: [...item.ancestors, item.node], depth: item.depth + 1 });
        }
      }
    }
    return found;
  }
  function boundToPage(ancestors, context, identity, global = false) {
    const url = metadataURL(context?.url);
    const cid = expectedCID(identity);
    const requestEpisode = numericId(url?.searchParams.get('ep_id') ?? url?.searchParams.get('epid'));
    const requestCID = numericId(url?.searchParams.get('cid'));
    const requestBvid = url?.searchParams.get('bvid') || '';
    const episodes = [requestEpisode, ...ancestors.flatMap(node => [node.ep_id, node.epid].map(numericId))].filter(Boolean);
    const cids = [requestCID, ...ancestors.map(node => numericId(node.cid))].filter(Boolean);
    const bvids = [requestBvid, ...ancestors.map(node => typeof node.bvid === 'string' ? node.bvid : '')].filter(Boolean);
    // An explicit conflicting identifier always wins over any implicit binding.
    if (new Set(episodes).size > 1 || new Set(cids).size > 1 || new Set(bvids).size > 1) return false;
    if (identity.episode && episodes.some(id => id !== identity.episode)) return false;
    if (identity.bvid && bvids.some(id => id !== identity.bvid)) return false;
    if (cid && cids.some(id => id !== cid)) return false;
    if (identity.bvid) {
      const parts = [url?.searchParams.get('p'), ...ancestors.map(node => node.page)]
        .filter(value => /^\d{1,5}$/.test(String(value))).map(Number);
      if (parts.some(part => part !== identity.part)) return false;
      if (bvids.includes(identity.bvid) && (identity.part === 1 || parts.includes(identity.part))) return true;
    }
    if (identity.episode && episodes.includes(identity.episode)) return true;
    if (cid && cids.includes(cid)) return true;
    // __playinfo__ is bound only to a matching initial state. After navigation,
    // never reuse the previous global object or accept anonymous global metadata.
    if (!global || generation !== 0 || !cid) return false;
    if (!identity.episode) return true;
    const epInfo = window.__INITIAL_STATE__?.epInfo || window.__INITIAL_STATE__?.ep_info;
    return numericId(epInfo?.id ?? epInfo?.ep_id) === identity.episode;
  }
  function syncPage() {
    const page = canonicalPage(location.href);
    if (page === activePage) return;
    activePage = page; generation++; candidate = null; metadataIssue = '';
    if (session) abortSession(session, 'Video changed. Start audio preparation for the current episode.');
  }
  function inspect(value, context, global = false) {
    syncPage();
    const identity = currentIdentity();
    if (!identity || !value || typeof value !== 'object' || context?.page !== identity.page || context?.generation !== generation) return;
    let issue = '';
    for (const { node, ancestors } of knownWrappers(value)) {
      const chain = [...ancestors, node];
      const blocked = chain.map(availabilityIssue).find(Boolean);
      if (blocked) { issue ||= blocked; continue; }
      // The authoritative media object can override cached fields alongside it.
      if (node.video_info || node.videoInfo) continue;
      const dash = node.dash;
      if (!dash || !Array.isArray(dash.audio)) continue;
      const protectedDash = availabilityIssue(dash);
      if (protectedDash) { issue ||= protectedDash; continue; }
      if (!boundToPage([...chain, dash], context, identity, global)) { issue ||= 'Bilibili playback metadata does not match the current episode or video part.'; continue; }
      const tracks = dash.audio.slice(0, 16).filter(track => track && !protectedMedia(track)
        && (!track.mimeType && !track.mime_type || /^audio\/(?:mp4|webm|mpeg)$/i.test(track.mimeType || track.mime_type)));
      // Prefer the highest quality AAC track so recognition retains the
      // player's audio quality while using the existing translation model.
      tracks.sort((a, b) => Number(!/mp4/i.test(a.mimeType || a.mime_type || 'audio/mp4')) - Number(!/mp4/i.test(b.mimeType || b.mime_type || 'audio/mp4'))
        || (Number(b.bandwidth) || 192000) - (Number(a.bandwidth) || 192000));
      for (const track of tracks) {
        if (availabilityIssue(track) || !boundToPage([...chain, dash, track], context, identity, global)) continue;
        const urls = [track.baseUrl, track.base_url, ...(Array.isArray(track.backupUrl || track.backup_url) ? (track.backupUrl || track.backup_url).slice(0, 4) : [])]
          .map(safeAudioURL).filter(Boolean);
        if (!urls.length) continue;
        candidate = { page: identity.page, generation, urls: [...new Set(urls)].slice(0, 4), mimeType: track.mimeType || track.mime_type || 'audio/mp4', acquiredAt: Date.now() };
        metadataIssue = '';
        return;
      }
      if (dash.audio.some(protectedMedia)) issue ||= 'Bilibili returned protected audio. Browser audio preparation does not support DRM.';
    }
    metadataIssue = issue || 'Bilibili playback metadata contains no supported unprotected DASH audio.';
  }
  function readGlobals() {
    let ssr;
    try {
      ssr = window.playurlSSRData;
      // Bangumi can use a top-level lexical declaration instead of window.
      if (!ssr && typeof playurlSSRData !== 'undefined') ssr = playurlSSRData;
    } catch { /* A not-yet-initialized lexical binding is unavailable. */ }
    return [['playinfo', window.__playinfo__], ['ssr', ssr]];
  }
  function readyCandidate() {
    return candidate && candidate.page === activePage && candidate.generation === generation && Date.now() - candidate.acquiredAt <= 30 * 60 * 1000;
  }
  function inspectGlobal() {
    syncPage();
    // A captured, explicitly bound player response is stronger evidence than
    // the startup global, which some players retain while preloading episodes.
    if (readyCandidate()) return;
    candidate = null;
    for (const [name, value] of readGlobals()) {
      const previous = globalSnapshots.get(name);
      // Globals can outlive an SPA switch. Never rebind the same old object.
      if (previous?.value === value && previous.generation !== generation) continue;
      globalSnapshots.set(name, { value, generation });
      if (value) inspect(value, { page: activePage, generation }, true);
      if (readyCandidate()) return;
    }
  }
  window.fetch = async function(...args) {
    syncPage();
    const context = { page: activePage, generation, url: String(args[0]?.url || args[0]) };
    const response = await originalFetch.apply(this, args);
    if (metadataURL(context.url)) responseContexts.set(response, context);
    return response;
  };
  Response.prototype.json = async function(...args) {
    const context = responseContexts.get(this) || { page: activePage, generation, url: this.url };
    const value = await originalResponseJSON.apply(this, args);
    try { if (metadataURL(context.url)) inspect(value, context); } catch { /* Keep native player parsing intact. */ }
    return value;
  };
  Response.prototype.text = async function(...args) {
    // Some players fetch JSON as text before parsing it. Keep the captured
    // request identity: anonymous DASH JSON cannot safely bind itself later.
    const context = responseContexts.get(this);
    const text = await originalResponseText.apply(this, args);
    try {
      if (context && metadataURL(context.url) && typeof text === 'string' && text.length <= MAX_METADATA) {
        inspect(originalParse(text), context);
      }
    } catch { /* Return the player's original text and parsing behavior intact. */ }
    return text;
  };
  JSON.parse = function(...args) {
    const value = originalParse.apply(this, args);
    try {
      if (typeof args[0] === 'string' && args[0].length <= MAX_METADATA && /"dash"\s*:/.test(args[0])) {
        syncPage();
        inspect(value, { page: activePage, generation });
      }
    } catch { /* Keep native player parsing intact. */ }
    return value;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._kageAudioURL = String(url);
    return originalOpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    syncPage();
    const context = { page: activePage, generation, url: this._kageAudioURL };
    if (metadataURL(context.url)) this.addEventListener('load', () => {
      try {
        if (this.responseType === 'json') inspect(this.response, context);
        else if ((!this.responseType || this.responseType === 'text') && typeof this.responseText === 'string'
            && this.responseText.length <= MAX_METADATA) inspect(originalParse(this.responseText), context);
      } catch { /* Never decode binary media or interfere with the player. */ }
    }, { once: true });
    return originalSend.apply(this, args);
  };
  const post = (type, request, fields = {}, transfer = []) => window.postMessage({ type, requestId: request.requestId, page: request.page, ...fields }, location.origin, transfer);
  function abortSession(request, error) {
    if (request.finished) return;
    request.finished = true;
    request.controller.abort();
    if (session === request) session = null;
    post('KAGE_BROWSER_AUDIO_ERROR', request, { error });
  }
  function safeMetadataError(message) {
    const error = new Error(message); error.safeMetadata = true; return error;
  }
  async function lookupEpisode(request) {
    const identity = currentIdentity();
    if (!identity?.episode) throw safeMetadataError(metadataIssue || 'Browser audio was not found for this video part. Refresh the tab and start the video briefly before trying again.');
    // This official endpoint and its DASH format flag follow yt-dlp's Bangumi
    // extractor. Request only the episode in this tab, after the panel click.
    const url = `https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=${identity.episode}&fnval=12240`;
    const timer = setTimeout(() => abortSession(request, 'Bilibili playback metadata request timed out. Check UfunR and try again.'), 20000);
    let reader;
    try {
      const response = await originalFetch.call(window, url, { credentials: 'include', redirect: 'error', signal: request.controller.signal });
      syncPage(); request.controller.signal.throwIfAborted();
      if (!response.ok) throw safeMetadataError(`Bilibili playback metadata request failed (HTTP ${Number(response.status) || 0}). Check episode access and UfunR.`);
      if (response.url && new URL(response.url).origin + new URL(response.url).pathname !== 'https://api.bilibili.com/pgc/player/web/v2/playurl') {
        throw safeMetadataError('Bilibili returned an unexpected playback metadata response.');
      }
      if (Number(response.headers.get('content-length')) > MAX_METADATA) throw safeMetadataError('Bilibili playback metadata exceeded the 2 MiB limit.');
      if (!response.body) throw safeMetadataError('Bilibili returned empty playback metadata.');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '', size = 0;
      while (true) {
        request.controller.signal.throwIfAborted();
        const { value, done } = await reader.read();
        syncPage(); request.controller.signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_METADATA) throw safeMetadataError('Bilibili playback metadata exceeded the 2 MiB limit.');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      let value;
      try { value = originalParse(text); }
      catch { throw safeMetadataError('Bilibili returned invalid playback metadata instead of JSON.'); }
      const blocked = knownWrappers(value).map(item => availabilityIssue(item.node)).find(Boolean);
      if (blocked) throw safeMetadataError(blocked);
      if (readyCandidate()) return;
      inspect(value, { page: request.page, generation: request.generation, url });
      if (!readyCandidate()) throw safeMetadataError(metadataIssue || 'Bilibili returned playback metadata without supported DASH audio.');
    } catch (error) {
      if (request.controller.signal.aborted || error?.safeMetadata) throw error;
      throw safeMetadataError('Browser could not fetch Bilibili playback metadata. The connection or browser access policy blocked the request; check UfunR and episode access.');
    } finally {
      clearTimeout(timer);
      if (reader) reader.cancel().catch(() => {});
    }
  }
  async function acquire(message) {
    syncPage();
    if (session) { post('KAGE_BROWSER_AUDIO_ERROR', message, { error: 'Audio preparation is already running in this tab.' }); return; }
    inspectGlobal();
    const request = { ...message, controller: new AbortController(), generation, finished: false };
    session = request;
    const navigation = setInterval(syncPage, 250);
    const timeout = setTimeout(() => abortSession(request, 'Browser audio download timed out. Check UfunR and try again.'), MAX_TIME);
    let idle, reader, chunks = [], received = 0;
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => abortSession(request, 'Browser audio download stalled. Check UfunR and try again.'), IDLE_TIME); };
    try {
      if (!readyCandidate()) {
        try { await lookupEpisode(request); }
        catch (error) {
          // The official player may reveal usable audio during the lookup.
          // Prefer its fresh, validated metadata to a failed fallback request.
          if (!readyCandidate() || request.controller.signal.aborted) throw error;
        }
      }
      request.controller.signal.throwIfAborted();
      const selected = candidate;
      touch();
      let response;
      for (const url of selected.urls) {
        request.controller.signal.throwIfAborted();
        try {
          // Referrer is supplied by the browser. Credentials stay inside the
          // browser; signed player URLs do not need exported login cookies.
          const attempt = await window.fetch(url, { credentials: 'omit', redirect: 'error', signal: request.controller.signal });
          if (!attempt.ok || !attempt.body || (attempt.url && !safeAudioURL(attempt.url))) throw new Error('Unavailable audio');
          response = attempt; break;
        } catch (error) { if (request.controller.signal.aborted) throw error; }
      }
      if (!response) throw new Error('Browser cannot download this episode’s audio through the current connection. Confirm that it plays with UfunR, refresh the tab, and try again.');
      const length = response.headers.get('content-length');
      const total = length && /^\d+$/.test(length) ? Number(length) : null;
      if (total > MAX_BYTES) throw new Error('Browser audio is larger than 128 MiB. Import a local audio file instead.');
      post('KAGE_BROWSER_AUDIO_PROGRESS', request, { received: 0, total });
      reader = response.body.getReader();
      while (true) {
        request.controller.signal.throwIfAborted();
        const { value, done } = await reader.read();
        syncPage();
        request.controller.signal.throwIfAborted();
        touch();
        if (done) break;
        if (!(value instanceof Uint8Array) || received + value.byteLength > MAX_BYTES) throw new Error('Browser audio is larger than 128 MiB. Import a local audio file instead.');
        received += value.byteLength;
        chunks.push(value);
        post('KAGE_BROWSER_AUDIO_PROGRESS', request, { received, total });
      }
      if (!received || (total !== null && received !== total)) throw new Error('Browser audio download was incomplete. Refresh the episode and try again.');
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      chunks = [];
      request.controller.signal.throwIfAborted();
      request.finished = true;
      const identity = currentIdentity();
      const suffix = /webm/i.test(selected.mimeType) ? 'webm' : /mpeg/i.test(selected.mimeType) ? 'mp3' : 'm4a';
      post('KAGE_BROWSER_AUDIO_RESULT', request, { bytes: bytes.buffer, mimeType: selected.mimeType, name: `Bilibili ${identity.episode ? `ep${identity.episode}` : `${identity.bvid} p${identity.part}`} (browser audio).${suffix}` }, [bytes.buffer]);
    } catch (error) {
      if (!request.finished) abortSession(request, error?.message || 'Browser audio download failed. Refresh the episode and try again.');
    } finally {
      chunks = [];
      clearInterval(navigation); clearTimeout(timeout); clearTimeout(idle);
      if (reader) reader.cancel().catch(() => {});
      if (session === request) session = null;
    }
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window || event.origin !== location.origin || !message || typeof message.requestId !== 'string'
        || !/^[a-zA-Z0-9_-]{16,80}$/.test(message.requestId) || typeof message.page !== 'string') return;
    if (message.type === 'KAGE_BROWSER_EPISODE_REQUEST') {
      if (message.page !== location.href) return;
      void (async () => {
        let episodes = [], error = '';
        try {
          const season = new URL(location.href).pathname.match(/^\/bangumi\/play\/ss(\d+)\/?$/i);
          if (season && message.lookup === true && (!canonicalPage(location.href) || message.episodeId)) {
            if (seasonCatalog?.href !== location.href) {
              const response = await window.fetch(`https://api.bilibili.com/pgc/view/web/season?season_id=${season[1]}`,
                { credentials: 'include', signal: AbortSignal.timeout(10000) });
              if (!response.ok) throw new Error('Bilibili episode list request failed.');
              const data = await response.json();
              if (data.code !== 0) throw new Error('Bilibili could not return the episode list through this browser.');
              const list = data.result?.episodes;
              if (!Array.isArray(list)) throw new Error('Bilibili returned no episode list.');
              seasonCatalog = { href: message.page, episodes: list.slice(0, 1000).filter(ep => /^\d{1,20}$/.test(String(ep.id)))
                .map(ep => ({ id: String(ep.id), title: String(ep.long_title || ep.title || ep.id).slice(0, 180) })) };
            }
            episodes = seasonCatalog.episodes;
            if (message.episodeId && episodes.some(ep => ep.id === message.episodeId)) selectedEpisode = { href: message.page, id: message.episodeId };
          }
        } catch (cause) { error = cause.message || 'Could not load the Bilibili episode list.'; }
        if (message.page !== location.href) return;
        window.postMessage({ type: 'KAGE_BROWSER_EPISODE_RESULT', requestId: message.requestId,
          page: message.page, episodeUrl: canonicalPage(location.href), episodes, error }, location.origin);
      })();
      return;
    }
    if (message.type === 'KAGE_BROWSER_AUDIO_CANCEL') {
      if (session?.requestId === message.requestId && session.page === message.page) abortSession(session, 'Browser audio preparation cancelled.');
      return;
    }
    if (message.type !== 'KAGE_BROWSER_AUDIO_REQUEST' || message.page !== canonicalPage(location.href)) return;
    void acquire({ requestId: message.requestId, page: message.page });
  });
  window.addEventListener('pagehide', () => { if (session) abortSession(session, 'Bilibili tab closed or navigated. Browser audio preparation cancelled.'); });
})();
