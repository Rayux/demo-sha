// Fetch the current player's unencrypted audio through the browser only after
// an explicit request. The optional Chrome relay keeps signed URLs inside the
// browser; only completed media bytes go to the local subtitle helper.
(() => {
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(location.hostname) || window.__kageYouTubeAudio) return;
  window.__kageYouTubeAudio = true;
  const MAX_BYTES = 128 * 1024 * 1024, RANGE_BYTES = 2 * 1024 * 1024;
  const nativeFetch = window.fetch;
  const observed = new Map();
  let session = null;
  function page() {
    try {
      const url = new URL(location.href);
      const id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})\/?$/)?.[1];
      return /^[\w-]{11}$/.test(id || '') ? `https://www.youtube.com/watch?v=${id}` : '';
    } catch { return ''; }
  }
  function safeURL(value, expectedMime = '') {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && /(^|\.)googlevideo\.com$/.test(url.hostname) && !url.port
        && !url.username && !url.password && url.pathname === '/videoplayback'
        && (!url.searchParams.has('mime') || /^(?:audio\/(?:mp4|webm)|video\/mp4)$/.test(url.searchParams.get('mime')))
        && (!expectedMime || !url.searchParams.has('mime') || url.searchParams.get('mime') === expectedMime) ? url : null;
    } catch { return null; }
  }
  function remember(value, current = page(), outcome = null) {
    const url = safeURL(value);
    if (!url || !current) return;
    const confidence = outcome === true ? 2 : outcome === false ? -1 : observed.get(url.href)?.confidence ?? 1;
    observed.delete(url.href);
    observed.set(url.href, { page: current, url, confidence });
    if (observed.size > 24) observed.delete(observed.keys().next().value);
  }
  window.fetch = function(...args) {
    const current = page(), address = String(args[0]?.url || args[0]);
    try { remember(address, current); } catch {}
    return nativeFetch.apply(this, args).then(response => {
      try {
        if (response.ok) remember(response.url || address, current, true);
        else if (response.status >= 400) remember(response.url || address, current, false);
      } catch { /* Keep player response behavior intact. */ }
      return response;
    });
  };
  const nativeOpen = XMLHttpRequest.prototype.open;
  const xhrRequests = new WeakMap();
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    try { const current = page(); remember(String(url), current); xhrRequests.set(this, { url: String(url), page: current }); } catch {}
    return nativeOpen.call(this, method, url, ...args);
  };
  const nativeSend = XMLHttpRequest.prototype.send;
  if (typeof nativeSend === 'function') XMLHttpRequest.prototype.send = function(...args) {
    const context = xhrRequests.get(this);
    if (context) this.addEventListener('load', () => {
      try {
        if (this.status >= 200 && this.status < 300) remember(this.responseURL || context.url, context.page, true);
        else if (this.status >= 400) remember(this.responseURL || context.url, context.page, false);
      } catch { /* Never read binary media to observe success. */ }
    }, { once: true });
    return nativeSend.apply(this, args);
  };
  function selectAudio() {
    const current = page(), id = new URL(current).searchParams.get('v');
    const player = document.getElementById('movie_player');
    let response;
    try { response = player?.getPlayerResponse?.(); } catch {}
    if (response?.videoDetails?.videoId !== id) response = window.ytInitialPlayerResponse;
    if (response?.videoDetails?.videoId !== id || response.videoDetails.isLiveContent && !response.videoDetails.lengthSeconds) {
      throw new Error('The current video’s audio metadata is not ready. Play this video briefly, then try Prepare browser audio again.');
    }
    if (response.streamingData?.licenseInfos?.length || response.playabilityStatus?.status !== 'OK') {
      throw new Error('This video does not expose supported unencrypted audio to the browser. Import a matching local file instead.');
    }
    const choices = [];
    const counts = { audio: 0, protected: 0, missingURL: 0, segmented: 0, oversized: 0, needsCapture: 0, signedRange: 0 };
    const streaming = response.streamingData || {};
    const formats = [...(streaming.adaptiveFormats || []).slice(0, 100),
      ...(streaming.formats || []).slice(0, 20).filter(format => format.audioQuality && Number(format.height) > 0 && Number(format.height) <= 360)];
    // Resource timing can contain requests made before the extension loaded.
    // Accept them only when their opaque media identity also matches this video's metadata.
    const resources = (performance.getEntriesByType('resource') || []).slice(-500)
      .filter(entry => !(entry.responseStatus >= 400))
      .map(entry => ({ url: safeURL(entry.name), confidence: entry.responseStatus >= 200 && entry.responseStatus < 300 ? 2 : 1 }))
      .filter(entry => entry.url);
    for (const format of formats) {
      const mime = String(format.mimeType || '').split(';')[0];
      if (!['audio/mp4', 'audio/webm', 'video/mp4'].includes(mime)) continue;
      // Combined video is allowed only as the explicitly bounded 360p fallback.
      if (mime === 'video/mp4' && !(format.audioQuality && Number(format.height) > 0 && Number(format.height) <= 360)) continue;
      counts.audio++;
      if (format.drmFamilies?.length || format.drmTrackType) { counts.protected++; continue; }
      if (format.type === 'FORMAT_STREAM_TYPE_OTF') { counts.segmented++; continue; }
      let base = safeURL(format.url, mime);
      if (!base) {
        try { base = safeURL(new URLSearchParams(format.signatureCipher || format.cipher).get('url'), mime); } catch {}
      }
      if (!base || !base.searchParams.get('id')) { counts.missingURL++; continue; }
      const matches = url => url.searchParams.get('id') === base.searchParams.get('id')
        && url.searchParams.get('itag') === String(format.itag) && (!url.searchParams.has('mime') || url.searchParams.get('mime') === mime)
        && url.searchParams.get('xtags') === base.searchParams.get('xtags');
      const captured = [...observed.values()].filter(entry => entry.page === current && matches(entry.url) && entry.confidence >= 0);
      const rejected = new Set([...observed.values()].filter(entry => entry.page === current && entry.confidence < 0).map(entry => entry.url.href));
      const urls = [...captured.reverse(), ...resources.filter(entry => matches(entry.url)).reverse(), ...(format.url ? [{ url: base, confidence: 0 }] : [])]
        .filter(entry => !rejected.has(entry.url.href));
      if (!urls.length) counts.needsCapture++;
      for (const entry of urls) {
        const candidate = entry.url;
        if (candidate.searchParams.has('sq') || candidate.searchParams.get('source') === 'yt_otf' || candidate.searchParams.get('otf') === '1') { counts.segmented++; continue; }
        const reportedSize = Number(format.contentLength || candidate.searchParams.get('clen') || base.searchParams.get('clen'));
        const size = Number.isSafeInteger(reportedSize) && reportedSize > 0 ? reportedSize : null;
        if (size > MAX_BYTES) { counts.oversized++; continue; }
        // Never change parameters included in the stream's signed parameter list.
        if (['sparams', 'lsparams'].some(key => (candidate.searchParams.get(key) || '').split(',').includes('range'))) { counts.signedRange++; continue; }
        choices.push({ url: candidate, size, mime, bitrate: Number(format.bitrate) || 0, confidence: entry.confidence });
      }
    }
    choices.sort((a, b) => b.confidence - a.confidence || Number(a.mime === 'video/mp4') - Number(b.mime === 'video/mp4') || a.bitrate - b.bitrate);
    if (!choices.length) {
      // Fixed diagnoses expose no signed URLs, account data, or player response bodies.
      if (counts.segmented || streaming.serverAbrStreamingUrl && (!counts.audio || counts.missingURL === counts.audio - counts.protected)) {
        throw new Error('YouTube audio [YT_STREAMING_ONLY]: this player exposes segmented playback without a complete file URL. Use Import video / audio with a matching local file.');
      }
      if (counts.oversized) throw new Error('YouTube audio [YT_AUDIO_TOO_LARGE]: available audio exceeds the 128 MiB browser limit. Use Import video / audio with a matching local file.');
      if (counts.needsCapture) throw new Error('YouTube audio [YT_WAIT_FOR_PLAYER]: the audio URL needs the player’s signature. Start playback, then retry Prepare browser audio.');
      if (counts.signedRange) throw new Error('YouTube audio [YT_SIGNED_RANGE]: the available stream only permits its original range. Use Import video / audio with a matching local file.');
      throw new Error(`YouTube audio [YT_NO_FILE_URL]: no usable complete file URL was found (${counts.audio} audio formats, ${counts.missingURL} without a usable URL, ${counts.protected} protected). Use Import video / audio with a matching local file.`);
    }
    const distinct = new Map();
    for (const choice of choices) {
      const key = new URL(choice.url);
      const signed = new Set(['sparams', 'lsparams'].flatMap(name => (key.searchParams.get(name) || '').split(',')));
      for (const name of ['range', 'rn', 'rbuf']) if (!signed.has(name)) key.searchParams.delete(name);
      if (!distinct.has(key.href)) distinct.set(key.href, choice);
    }
    return [...distinct.values()].slice(0, 3);
  }
  const post = (type, request, fields = {}, transfer = []) => window.postMessage({ type: `KAGE_BROWSER_AUDIO_${type}`, requestId: request.requestId, page: request.page, ...fields }, location.origin, transfer);
  function check(request) {
    if (page() !== request.page) request.controller.abort();
    request.controller.signal.throwIfAborted();
  }
  function relayCall(action, fields, request) {
    check(request);
    const rpcId = ++request.rpcSequence;
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        window.removeEventListener('message', receive);
        request.controller.signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve(value);
      };
      const aborted = () => finish(new Error('cancelled'));
      function receive(event) {
        const data = event.data;
        if (event.source !== window || event.origin !== location.origin || data?.type !== 'KAGE_CHROME_AUDIO_REPLY'
            || data.requestId !== request.requestId || data.page !== request.page || data.rpcId !== rpcId) return;
        if (data.success) finish(null, data.data);
        else finish(new Error(/^YouTube audio \[YT_[A-Z0-9_]+\]:/.test(data.error || '') ? data.error
          : 'YouTube audio [YT_CHROME_RELAY]: Chrome’s audio downloader could not complete this request.'));
      }
      const timer = setTimeout(() => finish(new Error('YouTube audio [YT_CHROME_RELAY_TIMEOUT]: Chrome’s audio downloader stopped responding. Refresh the tab after reloading Kage.')), 35000);
      window.addEventListener('message', receive);
      request.controller.signal.addEventListener('abort', aborted, { once: true });
      window.postMessage({ type: 'KAGE_CHROME_AUDIO_REQUEST', requestId: request.requestId, page: request.page, rpcId, action, ...fields }, location.origin);
    });
  }
  async function mediaFetch(url, request) {
    if (request.transport !== 'extension') {
      try { return await nativeFetch.call(window, url, { credentials: 'omit', redirect: 'error', signal: request.controller.signal }); }
      catch (error) {
        check(request);
        throw new Error('YouTube audio [YT_PAGE_NETWORK]: the page could not fetch this audio. In Kage Settings, enable YouTube downloads in Chrome, then retry Prepare browser audio.');
      }
    }
    const fetchId = String(++request.fetchSequence);
    const result = await relayCall('open', { fetchId, url }, request);
    let sequence = 0;
    const body = result.body ? new ReadableStream({
      async pull(controller) {
        try {
          const part = await relayCall('read', { fetchId }, request);
          if (!Number.isSafeInteger(part.sequence) || part.sequence !== ++sequence
              || typeof part.data !== 'string' || part.data.length > 90000) throw new Error('relay data');
          const binary = atob(part.data);
          if (binary.length > 65536 || (!part.done && !binary.length)) throw new Error('relay data');
          if (binary.length) controller.enqueue(Uint8Array.from(binary, byte => byte.charCodeAt(0)));
          if (part.done) controller.close();
        } catch (error) { controller.error(error); }
      },
      cancel() { return relayCall('close', { fetchId }, request).catch(() => {}); }
    }, { highWaterMark: 0 }) : null;
    return new Response(body, { status: result.status, headers: Object.fromEntries(Object.entries(result.headers || {}).filter(([, value]) => typeof value === 'string')) });
  }
  const tooLarge = () => new Error('YouTube audio [YT_AUDIO_TOO_LARGE]: audio exceeds the 128 MiB browser limit. Use Import video / audio with a matching local file.');
  function validateResponse(response, selected) {
    if (!response.ok) {
      const status = Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 0;
      throw new Error(`YouTube audio [YT_HTTP_${status}]: the audio server refused Kage’s download${status ? ` (HTTP ${status})` : ''}. The refusal does not identify whether the cause is the playback link, session requirements, or the VPN route.`);
    }
    if (!response.body || (response.url && !safeURL(response.url, selected.mime))) throw new Error('YouTube audio [YT_RESPONSE_INVALID]: Chrome returned an empty or unexpected audio response.');
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim();
    if (mime !== selected.mime && mime !== 'application/octet-stream') throw new Error('YouTube audio [YT_RESPONSE_TYPE]: the audio server returned a different format than the selected player stream.');
  }
  function contentRange(response) {
    const value = response.headers.get('content-range');
    if (!value) return null;
    const match = value.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
    if (!match) throw new Error('range');
    const [start, end, total] = match.slice(1).map(Number);
    if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || end >= total) throw new Error('range');
    if (total > MAX_BYTES) throw tooLarge();
    return { start, end, total };
  }
  function discard(response) { return response?.body?.cancel().catch(() => {}) || Promise.resolve(); }
  function idleGuard(request) {
    let timer;
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => request.controller.abort(), 30000); };
    touch();
    return { touch, stop: () => clearTimeout(timer) };
  }
  async function discoverSize(selected, request) {
    // A probe's Content-Length is only the probe size, never the whole file.
    // Only Content-Range's explicit total can establish the full audio size.
    const url = new URL(selected.url);
    url.searchParams.set('range', '0-0');
    const idle = idleGuard(request);
    let response;
    try {
      response = await mediaFetch(url.href, request);
      check(request);
      validateResponse(response, selected);
      const range = contentRange(response);
      if (range && range.start !== 0) throw new Error('range');
      return range?.total || null;
    } catch (error) {
      check(request);
      if (/^YouTube audio \[YT_AUDIO_TOO_LARGE\]/.test(error.message)) throw error;
      if (/^YouTube audio \[YT_HTTP_429\]/.test(error.message)) throw error;
      // Some CDNs reject the one-byte probe or hide its range headers. Try an
      // ordinary full response, still enforcing the size cap while reading.
      return null;
    } finally { idle.stop(); await discard(response); }
  }
  async function fetchFull(selected, request) {
    const url = new URL(selected.url);
    url.searchParams.delete('range');
    const idle = idleGuard(request);
    let response, reader;
    try {
      response = await mediaFetch(url.href, request);
      check(request);
      validateResponse(response, selected);
      const range = contentRange(response);
      if (range) {
        if (range.start !== 0) throw new Error('range');
        // Discard a partial response and switch to verified contiguous ranges.
        if (range.end + 1 !== range.total) return { size: range.total };
      } else if (response.status !== 200) {
        throw new Error('YouTube audio [YT_AUDIO_SIZE_UNKNOWN]: the server returned partial audio without its full size. A complete download could not be verified. Use Import video / audio with a matching local file.');
      }
      const header = response.headers.get('content-length');
      const length = header === null ? null : Number(header);
      if (length !== null && (!Number.isSafeInteger(length) || length <= 0)) throw new Error('length');
      if (length > MAX_BYTES) throw tooLarge();
      if (range && length !== null && length !== range.total) throw new Error('length');
      const expected = range?.total || length;
      let received = 0;
      const chunks = [];
      reader = response.body.getReader();
      post('PROGRESS', request, { received, total: expected });
      while (true) {
        const { value, done } = await reader.read();
        check(request); idle.touch();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error('bytes');
        if (received + value.byteLength > MAX_BYTES) throw tooLarge();
        if (expected !== null && received + value.byteLength > expected) throw new Error('length');
        chunks.push(value); received += value.byteLength;
        request.mediaBytes = received;
        post('PROGRESS', request, { received, total: expected });
      }
      if (!received || (expected !== null && received !== expected)) throw new Error('incomplete');
      const output = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
      return { bytes: output.buffer };
    } finally {
      idle.stop();
      if (reader) reader.cancel().catch(() => {});
      else await discard(response);
    }
  }
  function publishAudio(bytes, selected, request) {
    check(request);
    post('RESULT', request, { bytes, mimeType: selected.mime, name: `YouTube-${new URL(request.page).searchParams.get('v')}.${selected.mime === 'audio/mp4' ? 'm4a' : selected.mime === 'video/mp4' ? 'mp4' : 'webm'}` }, [bytes]);
  }
  async function downloadSelected(selected, request) {
    let reader;
    try {
      if (!selected.size) {
        post('PROGRESS', request, { received: 0, total: null });
        selected.size = await discoverSize(selected, request);
        check(request);
        if (!selected.size) {
          const full = await fetchFull(selected, request);
          if (full.bytes) { publishAudio(full.bytes, selected, request); return; }
          selected.size = full.size;
        }
      }
      const output = new Uint8Array(selected.size);
      let received = 0;
      post('PROGRESS', request, { received, total: selected.size });
      // YouTube throttles large un-ranged requests. Fetch bounded, contiguous ranges
      // and reject short/mismatched responses rather than importing partial audio.
      while (received < selected.size) {
        check(request);
        const start = received, end = Math.min(selected.size - 1, start + RANGE_BYTES - 1);
        const url = new URL(selected.url);
        url.searchParams.set('range', `${start}-${end}`);
        const idle = idleGuard(request);
        let response;
        try {
          response = await mediaFetch(url.href, request);
          validateResponse(response, selected);
          const range = contentRange(response);
          if (range && (range.start !== start || range.end !== end || range.total !== selected.size)) throw new Error('range');
          reader = response.body.getReader();
          while (true) {
            const { value, done } = await reader.read();
            check(request); idle.touch();
            if (done) break;
            if (!(value instanceof Uint8Array) || received + value.byteLength > end + 1) throw new Error('size');
            output.set(value, received); received += value.byteLength;
            request.mediaBytes = received;
            post('PROGRESS', request, { received, total: selected.size });
          }
          if (received !== end + 1) throw new Error('incomplete');
        } finally { idle.stop(); if (reader) { reader.cancel().catch(() => {}); reader = null; } else await discard(response); }
      }
      check(request);
      publishAudio(output.buffer, selected, request);
    } finally { if (reader) reader.cancel().catch(() => {}); }
  }
  async function acquire(message) {
    if (session) { post('ERROR', message, { error: 'Audio preparation is already running in this tab.' }); return; }
    const request = { ...message, controller: new AbortController(), rpcSequence: 0, fetchSequence: 0 };
    session = request;
    const timeout = setTimeout(() => request.controller.abort(), 10 * 60 * 1000);
    const navigation = setInterval(() => { if (page() !== request.page) request.controller.abort(); }, 250);
    try {
      check(request);
      // A working player may expose SABR POSTs instead of a downloadable file.
      // The protocol adapter keeps its playback context inside this page and
      // returns only a verified complete audio track to the existing importer.
      if (typeof window.KageYouTubeSabr?.download === 'function') {
        try {
          const audio = await window.KageYouTubeSabr.download({ page: request.page,
            signal: request.controller.signal, maxBytes: MAX_BYTES,
            onProgress: progress => post('PROGRESS', request, progress) });
          check(request);
          if (!(audio.bytes instanceof ArrayBuffer) || !audio.bytes.byteLength || audio.bytes.byteLength > MAX_BYTES
              || !['audio/mp4', 'audio/webm'].includes(audio.mime)) throw new Error('bytes');
          publishAudio(audio.bytes, { mime: audio.mime }, request);
          return;
        } catch (error) {
          check(request);
          if (!/^YouTube audio \[YT_SABR_NOT_READY\]:/.test(error.message)) throw error;
        }
      }
      const candidates = selectAudio();
      let refusal;
      for (const candidate of candidates) {
        check(request);
        request.mediaBytes = 0;
        request.candidateAttempts = (request.candidateAttempts || 0) + 1;
        try { await downloadSelected({ ...candidate }, request); return; }
        catch (error) {
          check(request);
          if (request.mediaBytes > 0 || !/^YouTube audio \[YT_HTTP_(?:403|410)\]/.test(error.message)) throw error;
          refusal = error;
        }
      }
      throw refusal;
    } catch (error) {
      post('ERROR', request, { error: request.controller.signal.aborted ? 'Browser audio preparation stopped or timed out. Keep this video’s tab open and try again.'
        : /^(The current video|This video does not expose|YouTube audio \[YT_)/.test(error.message) ? error.message + (/^YouTube audio \[YT_HTTP_(?:403|410)\]/.test(error.message) ? ` Kage tried ${request.candidateAttempts || 1} distinct media link(s).` : '')
          : ['range', 'length', 'bytes', 'size', 'incomplete'].includes(error.message)
            ? 'YouTube audio [YT_TRANSFER_INCOMPLETE]: the audio response was incomplete or did not match the requested byte range. It was not imported.'
            : 'YouTube audio [YT_TRANSFER_ERROR]: the audio transfer failed. If Chrome downloads are enabled, the VPN route, stream format, or signed URL may be incompatible.' });
    } finally {
      clearTimeout(timeout); clearInterval(navigation);
      if (session === request) session = null;
    }
  }
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || !data || !/^[a-f0-9]{32}$/.test(data.requestId || '')) return;
    if (data.type === 'KAGE_BROWSER_AUDIO_CANCEL' && session?.requestId === data.requestId && session.page === data.page) { session.controller.abort(); return; }
    if (data.type === 'KAGE_BROWSER_AUDIO_REQUEST' && page() && data.page === page()) void acquire(data);
  });
})();
