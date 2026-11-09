// Keep YouTube's native SABR session inside this page. Only a verified complete
// audio file leaves MAIN world; signed addresses, request bodies and tokens do not.
(() => {
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(location.hostname) || window.KageYouTubeSabr) return;
  const MAX_TEMPLATE = 256 * 1024, MAX_BYTES = 128 * 1024 * 1024;
  const TEMPLATE_AGE = 2 * 60 * 1000, IDLE_MS = 30000, DEADLINE_MS = 10 * 60 * 1000;
  const nativeFetch = window.fetch, templates = [];
  const xhrState = new WeakMap();
  let running = false;
  const messages = {
    YT_SABR_NOT_READY: 'The player has not exposed a supported browser download session yet. Play briefly, pause, and retry Prepare browser audio.',
    YT_SABR_UNSUPPORTED: 'This video does not expose supported unencrypted, non-live browser audio.',
    YT_SABR_NETWORK: 'The browser could not finish YouTube’s segmented audio download. Refresh this video and try again.',
    YT_SABR_INCOMPLETE: 'YouTube returned incomplete or inconsistent segmented audio. A partial file was not imported.',
    YT_SABR_DURATION: 'The downloaded audio does not cover this video’s complete duration.',
    YT_SABR_IDENTITY: 'YouTube returned audio for an unexpected format or video.',
    YT_SABR_SEQUENCE: 'YouTube returned audio segments with a gap or unexpected order.',
    YT_SABR_BYTES: 'YouTube returned incomplete or unsupported audio segment bytes.',
    YT_SABR_TIMEOUT: 'YouTube’s segmented audio download timed out. Try preparing this video again.',
    YT_SABR_CANCELLED: 'Browser audio preparation stopped.',
    YT_SABR_BUSY: 'Browser audio preparation is already running in this tab.',
    YT_AUDIO_TOO_LARGE: 'Audio exceeds the 128 MiB browser limit. Import a matching local file.'
  };
  const error = code => new Error(`YouTube audio [${code}]: ${messages[code] || messages.YT_SABR_NETWORK}`);
  function notReady(reason) {
    const result = error('YT_SABR_NOT_READY');
    result.sabrReason = reason;
    return result;
  }
  function page() {
    try {
      const url = new URL(location.href);
      const id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})\/?$/)?.[1];
      return /^[\w-]{11}$/.test(id || '') ? `https://www.youtube.com/watch?v=${id}` : '';
    } catch { return ''; }
  }
  function mediaURL(value) {
    try {
      if (typeof value !== 'string' || value.length > 16384) return null;
      const url = new URL(value);
      return url.protocol === 'https:' && /(^|\.)googlevideo\.com$/.test(url.hostname)
        && !url.port && !url.username && !url.password && !url.hash && url.pathname === '/videoplayback' ? url : null;
    } catch { return null; }
  }
  function clearStale() {
    const current = page(), now = Date.now();
    for (let i = templates.length - 1; i >= 0; i--) {
      if (templates[i].page !== current || now - templates[i].time > TEMPLATE_AGE) templates.splice(i, 1);
    }
  }
  window.addEventListener('yt-navigate-start', () => templates.splice(0));
  window.addEventListener('pagehide', () => templates.splice(0));
  function copied(body) {
    if (body instanceof ArrayBuffer) return body.byteLength <= MAX_TEMPLATE ? new Uint8Array(body.slice(0)) : null;
    if (ArrayBuffer.isView(body)) return body.byteLength <= MAX_TEMPLATE
      ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice() : null;
    return null;
  }
  async function copyBody(body, request) {
    const bytes = copied(body);
    if (bytes) return bytes;
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      return body.size <= MAX_TEMPLATE ? new Uint8Array(await body.arrayBuffer()) : null;
    }
    if (!request || request.bodyUsed || typeof request.clone !== 'function') return null;
    let reader;
    try {
      const clone = request.clone();
      if (!clone.body) return null;
      reader = clone.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || (size += part.value.byteLength) > MAX_TEMPLATE) return null;
        chunks.push(part.value.slice());
      }
      const result = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      return result;
    } catch { return null; }
    finally { if (reader) Promise.resolve(reader.cancel()).catch(() => {}); }
  }
  function retain(candidate, responseURL, status, contentType) {
    if (status < 200 || status >= 300 || contentType.split(';')[0].trim() !== 'application/vnd.yt-ump') return;
    const url = mediaURL(responseURL || candidate.url);
    if (!url || candidate.page !== page()) return;
    candidate.body.then(bytes => {
      if (!bytes?.length || candidate.page !== page()) return;
      clearStale();
      templates.push({ page: candidate.page, url: url.href, bytes, credentials: candidate.credentials, headers: candidate.headers, time: Date.now() });
      while (templates.length > 3) templates.shift();
    }).catch(() => {});
  }
  function requestHeaders(value) {
    try {
      const headers = new Headers(value);
      return Object.fromEntries(['content-type', 'accept'].filter(name => headers.has(name)).map(name => [name, headers.get(name)]));
    } catch { return {}; }
  }
  window.fetch = function(input, options) {
    let candidate;
    try {
      const url = mediaURL(String(input?.url || input));
      const method = String(options?.method || input?.method || 'GET').toUpperCase();
      if (url && method === 'POST' && page()) {
        const body = options && Object.prototype.hasOwnProperty.call(options, 'body') ? options.body : undefined;
        candidate = { page: page(), url: url.href, body: copyBody(body, body === undefined ? input : null),
          credentials: options?.credentials || input?.credentials || 'same-origin', headers: requestHeaders(options?.headers || input?.headers) };
      }
    } catch { /* Observation must never change player requests. */ }
    const result = nativeFetch.apply(this, arguments);
    if (!candidate) return result;
    return result.then(response => {
      try { retain(candidate, response.url, response.status, response.headers.get('content-type') || ''); } catch {}
      return response;
    });
  };
  if (typeof XMLHttpRequest !== 'undefined') {
    const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send, setHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function(method, url) {
      xhrState.delete(this);
      try {
        const address = mediaURL(String(url));
        if (String(method).toUpperCase() === 'POST' && address && page()) xhrState.set(this, { page: page(), url: address.href, headers: {} });
      } catch {}
      return open.apply(this, arguments);
    };
    if (typeof setHeader === 'function') XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
      const state = xhrState.get(this);
      if (state && ['content-type', 'accept'].includes(String(name).toLowerCase())) state.headers[String(name).toLowerCase()] = String(value);
      return setHeader.apply(this, arguments);
    };
    if (typeof send === 'function') XMLHttpRequest.prototype.send = function(body) {
      const state = xhrState.get(this);
      if (state) {
        const candidate = { ...state, headers: requestHeaders(state.headers), credentials: this.withCredentials ? 'include' : 'omit', body: copyBody(body) };
        this.addEventListener('load', () => {
          try { retain(candidate, this.responseURL, this.status, this.getResponseHeader('content-type') || ''); } catch {}
        }, { once: true });
      }
      return send.apply(this, arguments);
    };
  }
  // Preserve unknown protobuf context fields rather than re-encoding native
  // session data using only the fields known to the bundled protocol library.
  function fields(bytes) {
    const result = []; let offset = 0;
    function integer() {
      let value = 0, shift = 0;
      for (let i = 0; i < 10; i++) {
        if (offset >= bytes.length) throw error('YT_SABR_INCOMPLETE');
        const byte = bytes[offset++];
        if (shift < 49) value += (byte & 127) * 2 ** shift;
        if (!(byte & 128)) return value;
        shift += 7;
      }
      throw error('YT_SABR_INCOMPLETE');
    }
    while (offset < bytes.length) {
      if (result.length >= 4096) throw error('YT_SABR_INCOMPLETE');
      const start = offset, tag = integer(), number = Math.floor(tag / 8), wire = tag % 8;
      let payload;
      if (!Number.isSafeInteger(tag) || !number) throw error('YT_SABR_INCOMPLETE');
      if (wire === 0) integer();
      else if (wire === 1) offset += 8;
      else if (wire === 5) offset += 4;
      else if (wire === 2) { const length = integer(); payload = bytes.subarray(offset, offset + length); offset += length; }
      else throw error('YT_SABR_INCOMPLETE');
      if (offset > bytes.length) throw error('YT_SABR_INCOMPLETE');
      result.push({ number, payload, bytes: bytes.subarray(start, offset) });
    }
    return result;
  }
  function join(parts) {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0)); let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
    return output;
  }
  function varint(value) {
    const output = [];
    do { const part = value % 128; value = Math.floor(value / 128); output.push(part | (value ? 128 : 0)); } while (value);
    return new Uint8Array(output);
  }
  function preserveContext(body, nativeBody) {
    const original = fields(nativeBody).find(field => field.number === 19)?.payload;
    if (!original) return body;
    const outgoing = fields(body), context = outgoing.find(field => field.number === 19)?.payload;
    if (!context) throw error('YT_SABR_INCOMPLETE');
    // The native client info may contain fields newer than this protocol build.
    // The library never updates client info, so retain its original wire bytes.
    const generated = fields(context).filter(field => field.number !== 1), replaced = new Set(generated.map(field => field.number));
    const combined = join([...fields(original).filter(field => !replaced.has(field.number)).map(field => field.bytes), ...generated.map(field => field.bytes)]);
    const encoded = join([varint(19 * 8 + 2), varint(combined.length), combined]);
    return join(outgoing.map(field => field.number === 19 ? encoded : field.bytes));
  }
  function base64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }
  function currentPlayer(expected) {
    const id = new URL(expected).searchParams.get('v');
    let response;
    try { response = document.getElementById('movie_player')?.getPlayerResponse?.(); } catch {}
    if (response?.videoDetails?.videoId !== id) response = window.ytInitialPlayerResponse;
    if (response?.videoDetails?.videoId !== id) throw error('YT_SABR_NOT_READY');
    if (response.playabilityStatus?.status !== 'OK' || response.videoDetails.isLiveContent || response.streamingData?.licenseInfos?.length) throw error('YT_SABR_UNSUPPORTED');
    return response;
  }
  async function download({ page: expectedPage, signal, onProgress, maxBytes = MAX_BYTES } = {}) {
    clearStale();
    if (!expectedPage || page() !== expectedPage) throw notReady('page');
    if (!window.KageSabrProtocol) throw notReady('runtime');
    if (!templates.length) throw notReady('capture');
    if (running) throw error('YT_SABR_BUSY');
    const protocol = window.KageSabrProtocol;
    protocol.Logger?.getInstance?.().setLogLevels(0);
    const response = currentPlayer(expectedPage), videoId = response.videoDetails.videoId;
    const limit = Math.min(MAX_BYTES, Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : MAX_BYTES);
    const candidates = (response.streamingData?.adaptiveFormats || []).slice(0, 100).filter(format => /^(?:audio\/mp4|audio\/webm)(?:;|$)/.test(format.mimeType || '') && !format.drmFamilies?.length && !format.drmTrackType);
    let template, decoded, audio, unavailable = 'decode';
    for (const candidate of [...templates].reverse()) {
      try {
        const body = protocol.VideoPlaybackAbrRequest.decode(candidate.bytes);
        const ids = body.selectedAudioFormatIds?.length ? body.selectedAudioFormatIds : body.initializationFormatIds || [];
        const nativeId = ids.find(id => Number.isSafeInteger(id.itag) && id.itag > 0 && /^\d{1,20}$/.test(String(id.lastModified || ''))
          && String(id.lastModified) !== '0' && typeof (id.xtags || '') === 'string' && (id.xtags || '').length <= 2048
          && candidates.some(item => item.itag === id.itag));
        const format = candidates.find(item => item.itag === nativeId?.itag);
        if (!format) { unavailable = ids.length ? 'metadata' : 'audio-ids'; continue; }
        if (!body.streamerContext?.clientInfo || !body.videoPlaybackUstreamerConfig?.length) { unavailable = 'config'; continue; }
        template = candidate; decoded = body;
        // The player's successful SABR request identifies the active rendition.
        // Watch-page metadata can omit its language tags or last-modified ID.
        // Verify that exact native identity again on every completed segment.
        audio = protocol.buildSabrFormat({ ...format, lastModified: String(nativeId.lastModified), xtags: nativeId.xtags || '',
          is_drc: Boolean(format.isDrc || format.is_drc), audioTrackId: format.audioTrack?.id || format.audioTrackId });
        break;
      } catch { /* Skip malformed native templates without exposing their data. */ }
    }
    if (!template || !audio) throw notReady(unavailable);
    if (audio.contentLength > limit) throw error('YT_AUDIO_TOO_LARGE');
    const duration = Number(audio.approxDurationMs) || Number(response.videoDetails.lengthSeconds) * 1000;
    if (!Number.isFinite(duration) || duration <= 0) throw error('YT_SABR_UNSUPPORTED');
    running = true;
    const controller = new AbortController(), chunks = [], ledger = new Map();
    let stream, reader, finished = false, failure, size = 0, wireSize = 0, requests = 0, expectedSize = 0;
    let metadata, lastMediaNumber = null, lastMediaEnd = 0, initSeen = false;
    const stop = code => {
      if (!failure) failure = error(code);
      controller.abort();
      if (stream) Promise.resolve(stream.abort()).catch(() => {});
    };
    const check = () => {
      if (page() !== expectedPage || signal?.aborted) stop('YT_SABR_CANCELLED');
      if (failure) throw failure;
    };
    const aborted = () => stop('YT_SABR_CANCELLED');
    signal?.addEventListener('abort', aborted, { once: true });
    const deadline = setTimeout(() => stop('YT_SABR_TIMEOUT'), DEADLINE_MS);
    const navigation = setInterval(() => { if (page() !== expectedPage) stop('YT_SABR_CANCELLED'); }, 500);
    function captureTrack(track) {
      if (track?.type !== 'audio') return;
      try {
        if (track.formatId?.itag !== audio.itag || (track.formatId?.xtags || '') !== (audio.xtags || '')
            || Number(track.formatId?.lastModified || 0) > 0 && String(track.formatId.lastModified) !== String(audio.lastModified)) throw error('YT_SABR_IDENTITY');
        const endSegmentNum = Number(track.endSegmentNum), endTimeMs = Number(track.endTimeMs);
        if (!Number.isSafeInteger(endSegmentNum) || endSegmentNum < 1 || !Number.isFinite(endTimeMs) || endTimeMs <= 0 || Math.abs(endTimeMs - duration) > 1500) throw error('YT_SABR_DURATION');
        if (metadata && (metadata.endSegmentNum !== endSegmentNum || metadata.endTimeMs !== endTimeMs)) throw error('YT_SABR_DURATION');
        metadata = { endSegmentNum, endTimeMs };
        for (const [number, segment] of track.trackedSegments || []) {
          const header = segment.mediaHeader || {}, declaredSize = Number(header.segmentLengthBytes);
          if (header.videoId !== videoId
              || Number(header.itag || 0) > 0 && header.itag !== audio.itag
              || Number(header.lmt || 0) > 0 && String(header.lmt) !== String(audio.lastModified)
              || header.xtags && header.xtags !== (audio.xtags || '')
              || header.formatId?.itag !== undefined && header.formatId.itag !== audio.itag
              || Number(header.formatId?.lastModified || 0) > 0 && String(header.formatId.lastModified) !== String(audio.lastModified)
              || header.formatId && (header.formatId.xtags || '') !== (audio.xtags || '')) throw error('YT_SABR_IDENTITY');
          if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || Number(header.compressionType || 0) !== 0
              || Number(header.offsetFromStartOfSegment || 0) !== 0 || Number(header.partialBytesToReturn || 0) !== 0) throw error('YT_SABR_BYTES');
          if (ledger.has(number)) {
            const previous = ledger.get(number);
            if (previous.size !== declaredSize || previous.start !== segment.startTimeMs || previous.end !== segment.endTimeMs) throw error('YT_SABR_SEQUENCE');
            continue;
          }
          if (!Number.isSafeInteger(number) || number < 0 || ledger.size >= 10000) throw error('YT_SABR_SEQUENCE');
          if (header.isInitializationSegment) {
            if (number !== 0 || initSeen || lastMediaNumber !== null) throw error('YT_SABR_SEQUENCE');
            initSeen = true;
          } else {
            const start = Number(segment.startTimeMs), end = Number(segment.endTimeMs);
            if (!initSeen || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start
                || lastMediaNumber === null && (number !== 1 || start > 250)
                || lastMediaNumber !== null && (number !== lastMediaNumber + 1 || Math.abs(start - lastMediaEnd) > 250)) throw error('YT_SABR_SEQUENCE');
            lastMediaNumber = number; lastMediaEnd = end;
          }
          ledger.set(number, { size: declaredSize, start: segment.startTimeMs, end: segment.endTimeMs });
          expectedSize += declaredSize;
          if (expectedSize > limit) throw error('YT_AUDIO_TOO_LARGE');
        }
      } catch (caught) { stop(caught.message.match(/\[(YT_(?:SABR_[A-Z_]+|AUDIO_TOO_LARGE))\]/)?.[1] || 'YT_SABR_INCOMPLETE'); }
    }
    async function fetchStream(input, options = {}) {
      check();
      const url = mediaURL(String(input));
      if (!url || String(options.method).toUpperCase() !== 'POST' || ++requests > 500) { stop('YT_SABR_INCOMPLETE'); check(); }
      const requestController = new AbortController();
      let timer, bodyReader, result;
      const cleanup = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', abortRequest); options.signal?.removeEventListener('abort', abortRequest); };
      const abortRequest = () => {
        cleanup(); requestController.abort();
        if (bodyReader) Promise.resolve(bodyReader.cancel()).catch(() => {});
      };
      const touch = () => {
        clearTimeout(timer);
        if (!controller.signal.aborted && !options.signal?.aborted)
          timer = setTimeout(() => stop('YT_SABR_TIMEOUT'), IDLE_MS);
      };
      controller.signal.addEventListener('abort', abortRequest, { once: true });
      options.signal?.addEventListener('abort', abortRequest, { once: true });
      touch();
      try {
        const body = copied(options.body);
        if (!body?.length) throw error('YT_SABR_INCOMPLETE');
        const outgoing = preserveContext(body, template.bytes);
        result = await nativeFetch.call(window, url.href, { method: 'POST', body: outgoing,
          headers: template.headers, credentials: template.credentials, redirect: 'error', signal: requestController.signal });
        check();
        if (!result.ok || result.headers.get('content-type')?.split(';')[0].trim() !== 'application/vnd.yt-ump' || !result.body
            || result.url && !mediaURL(result.url)) throw error('YT_SABR_NETWORK');
        bodyReader = result.body.getReader(); touch();
        const bounded = new ReadableStream({
          async pull(output) {
            try {
              check();
              const part = await bodyReader.read(); check(); touch();
              if (part.done) { cleanup(); output.close(); return; }
              if (!(part.value instanceof Uint8Array)) throw error('YT_SABR_INCOMPLETE');
              wireSize += part.value.byteLength;
              if (wireSize > Math.min(192 * 1024 * 1024, limit + 64 * 1024 * 1024)) throw error('YT_AUDIO_TOO_LARGE');
              output.enqueue(part.value);
            } catch (caught) {
              cleanup(); Promise.resolve(bodyReader.cancel()).catch(() => {});
              stop(caught.message.includes('[YT_AUDIO_TOO_LARGE]') ? 'YT_AUDIO_TOO_LARGE' : failure ? 'YT_SABR_CANCELLED' : 'YT_SABR_NETWORK');
              output.error(failure);
            }
          },
          cancel() { cleanup(); requestController.abort(); return bodyReader.cancel().catch(() => {}); }
        }, { highWaterMark: 0 });
        return new Response(bounded, { status: result.status, headers: { 'content-type': 'application/vnd.yt-ump' } });
      } catch (caught) {
        cleanup(); requestController.abort();
        if (bodyReader) Promise.resolve(bodyReader.cancel()).catch(() => {});
        else if (result?.body) Promise.resolve(result.body.cancel()).catch(() => {});
        stop(failure ? 'YT_SABR_CANCELLED' : caught.message.includes('[YT_SABR_INCOMPLETE]') ? 'YT_SABR_INCOMPLETE' : 'YT_SABR_NETWORK');
        check();
      }
    }
    try {
      check();
      stream = new protocol.SabrStream({ videoId, serverAbrStreamingUrl: template.url,
        videoPlaybackUstreamerConfig: base64(decoded.videoPlaybackUstreamerConfig), clientInfo: decoded.streamerContext.clientInfo,
        poToken: decoded.streamerContext.poToken?.length ? base64(decoded.streamerContext.poToken) : undefined,
        formats: [audio], fetchFunction: fetchStream, audioHighWaterMark: 256 * 1024, videoHighWaterMark: 1 });
      stream.on('formatInitialization', captureTrack);
      stream.on('trackStateUpdate', collection => captureTrack(collection.audio));
      stream.on('liveMetadataUpdate', () => stop('YT_SABR_UNSUPPORTED'));
      stream.on('error', () => stop('YT_SABR_NETWORK'));
      stream.on('finish', () => { finished = true; });
      const output = stream.start({ audioFormat: audio, enabledTrackTypes: protocol.EnabledTrackTypes.AUDIO_ONLY,
        startTimeMs: 0, isPostLiveDvr: false, maxRetries: 0, stallDetectionMs: IDLE_MS });
      reader = output.audioStream.getReader();
      while (true) {
        check(); const part = await reader.read(); check();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) throw error('YT_SABR_INCOMPLETE');
        size += part.value.byteLength;
        if (size > limit) throw error('YT_AUDIO_TOO_LARGE');
        chunks.push(part.value.slice());
        if (typeof onProgress === 'function') onProgress({ received: size, total: null });
      }
      check();
      if (!finished || stream.isErrored || stream.isAborted || !initSeen || !metadata || !size || size !== expectedSize
          || lastMediaNumber !== metadata.endSegmentNum || Math.abs(lastMediaEnd - metadata.endTimeMs) > 250
          || Math.abs(lastMediaEnd - duration) > 1500) throw error('YT_SABR_INCOMPLETE');
      return { bytes: join(chunks).buffer, mime: String(audio.mimeType).split(';')[0] };
    } catch (caught) {
      if (failure) throw failure;
      if (/^YouTube audio \[(?:YT_SABR_[A-Z_]+|YT_AUDIO_TOO_LARGE)\]:/.test(caught?.message || '')) throw caught;
      throw error('YT_SABR_NETWORK');
    } finally {
      clearTimeout(deadline); clearInterval(navigation);
      signal?.removeEventListener('abort', aborted);
      controller.abort();
      if (reader) await Promise.resolve(reader.cancel()).catch(() => {});
      if (stream && !finished) {
        await Promise.resolve(stream.abort()).catch(() => {});
        await stream.waitForIdle?.();
      }
      chunks.length = 0; ledger.clear(); templates.splice(0); running = false;
    }
  }
  window.KageYouTubeSabr = Object.freeze({ download });
})();
