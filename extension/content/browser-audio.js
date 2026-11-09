(() => {
  const MAX_BYTES = 128 * 1024 * 1024;
  const TIMEOUT_MS = 15 * 60 * 1000;
  const TYPES = new Set(['KAGE_BROWSER_AUDIO_PROGRESS', 'KAGE_BROWSER_AUDIO_RESULT', 'KAGE_BROWSER_AUDIO_ERROR']);
  const MIME_EXTENSIONS = new Map([['video/mp4', 'mp4'], ['audio/mp4', 'm4a'], ['audio/x-m4a', 'm4a'], ['audio/webm', 'webm'], ['audio/mpeg', 'mp3'], ['audio/ogg', 'ogg']]);

  let resolved = null;
  function currentPage() { return resolved?.href === location.href ? resolved.url : ''; }
  let catalog = [], resolutionError = '';
  function resolveEpisode({ lookup = false, episodeId } = {}) {
    const href = location.href, origin = location.origin;
    if (!/^https:\/\/(?:www\.)?bilibili\.com\/bangumi\/play\/ss\d+(?:[/?#]|$)/i.test(href)) return Promise.resolve('');
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    return new Promise(resolve => {
      const timer = setTimeout(() => { resolutionError = 'Episode lookup timed out. Reload the extension and refresh this tab.'; finish(''); }, lookup ? 12000 : 3000);
      function finish(url) { clearTimeout(timer); window.removeEventListener('message', receive); resolve(url); }
      function receive(event) {
        const data = event.data;
        if (event.source !== window || event.origin !== origin || data?.type !== 'KAGE_BROWSER_EPISODE_RESULT'
          || data.requestId !== requestId || data.page !== href) return;
        const url = /^https:\/\/www\.bilibili\.com\/bangumi\/play\/ep\d+$/.test(data.episodeUrl) ? data.episodeUrl : '';
        if (location.href === href) {
          resolved = { href, url };
          if (lookup) {
            catalog = Array.isArray(data.episodes) ? data.episodes.filter(ep => /^\d{1,20}$/.test(ep?.id)).slice(0, 1000) : [];
            resolutionError = typeof data.error === 'string' ? data.error.slice(0, 500) : '';
          }
        }
        finish(url);
      }
      window.addEventListener('message', receive);
      window.postMessage({ type: 'KAGE_BROWSER_EPISODE_REQUEST', requestId, page: href, lookup, episodeId }, origin);
    });
  }
  function page() {
    try {
      const url = new URL(location.href);
      if (url.protocol === 'https:' && ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
        const id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})\/?$/)?.[1];
        return /^[\w-]{11}$/.test(id || '') ? `https://www.youtube.com/watch?v=${id}` : '';
      }
      if (url.protocol === 'https:' && /(^|\.)anime1\.me$/i.test(url.hostname) && /^\/\d+/.test(url.pathname)) {
        return url.origin + url.pathname;
      }
      if (url.protocol !== 'https:' || !/(^|\.)bilibili\.com$/i.test(url.hostname)) return '';
      const episode = url.pathname.match(/^\/bangumi\/play\/(ep\d+)(?:\/|$)/i);
      if (episode) return `https://www.bilibili.com/bangumi/play/${episode[1].toLowerCase()}`;
      const video = url.pathname.match(/^\/video\/(BV[a-z0-9]+)(?:\/|$)/i);
      if (!video) return currentPage();
      const part = Math.max(1, Number.parseInt(url.searchParams.get('p') || '1', 10) || 1);
      return `https://www.bilibili.com/video/${video[1]}?p=${part}`;
    } catch { return ''; }
  }

  function abortError(message = 'Browser audio preparation stopped.') { return new DOMException(message, 'AbortError'); }

  function download({ signal, onProgress } = {}) {
    const currentPage = page(), origin = location.origin;
    if (!currentPage) return Promise.reject(new Error('Open a Bilibili or YouTube video to prepare browser audio.'));
    if (signal?.aborted) return Promise.reject(abortError());
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    return new Promise((resolve, reject) => {
      let finished = false, timeout = null, navigation = null;
      let relayUsed = false, mediaPort = null;
      const post = type => window.postMessage({ type, requestId, page: currentPage }, origin);
      function complete(error, result, cancel = false) {
        if (finished) return;
        finished = true;
        window.removeEventListener('message', receive);
        signal?.removeEventListener('abort', aborted);
        clearTimeout(timeout); clearInterval(navigation);
        if (relayUsed) {
          try { chrome.runtime.sendMessage({ type: 'CHROME_AUDIO_FETCH', action: 'cancel', requestId, page: currentPage }).catch(() => {}); } catch { /* Reloaded extension: the old stream times out. */ }
        }
        if (mediaPort) { try { mediaPort.disconnect(); } catch { /* already closed */ } mediaPort = null; }
        if (cancel) post('KAGE_BROWSER_AUDIO_CANCEL');
        if (error) reject(error); else resolve(result);
      }
      const aborted = () => complete(abortError(), null, true);
      function receive(event) {
        const data = event.data;
        if (event.source !== window || event.origin !== origin || !data
          || data.requestId !== requestId || data.page !== currentPage) return;
        if (page() !== currentPage) { complete(abortError('Browser audio stopped after leaving this video.'), null, true); return; }
        if (data.type === 'KAGE_CHROME_AUDIO_REQUEST' && currentPage.startsWith('https://www.youtube.com/watch?')
            && Number.isSafeInteger(data.rpcId) && data.rpcId > 0 && ['open', 'read', 'close'].includes(data.action)
            && /^[1-9]\d{0,6}$/.test(data.fetchId || '')) {
          relayUsed = true;
          const fields = { type: 'CHROME_AUDIO_FETCH', action: data.action, requestId, fetchId: data.fetchId, page: currentPage,
            ...(data.action === 'open' ? { url: data.url } : {}) };
          Promise.resolve().then(() => chrome.runtime.sendMessage(fields)).then(reply => {
            if (!finished && page() === currentPage) window.postMessage({ type: 'KAGE_CHROME_AUDIO_REPLY', requestId, page: currentPage,
              rpcId: data.rpcId, success: reply?.success === true, data: reply?.data,
              error: reply?.success ? undefined : /^YouTube audio \[YT_[A-Z0-9_]+\]:/.test(reply?.error || '') ? reply.error
                : 'YouTube audio [YT_CHROME_RELAY]: Chrome’s audio downloader could not complete this request.' }, origin);
          }).catch(() => {
            if (!finished && page() === currentPage) window.postMessage({ type: 'KAGE_CHROME_AUDIO_REPLY', requestId, page: currentPage,
              rpcId: data.rpcId, success: false, error: 'YouTube audio [YT_EXTENSION_RELOAD]: reload Kage and refresh this video tab to restore the Chrome downloader.' }, origin);
          });
          return;
        }
        if (data.type === 'KAGE_ANIME1_MEDIA_URL' && /^https:\/\/(?:www\.)?anime1\.me\/\d+/.test(currentPage)
            && typeof data.src === 'string' && !mediaPort) {
          startAnime1Download(data.src);
          return;
        }
        if (data.type === 'KAGE_BROWSER_AUDIO_STREAM') { startStream(data); return; }
        if (!TYPES.has(data.type)) return;
        if (data.type === 'KAGE_BROWSER_AUDIO_ERROR') {
          complete(new Error(typeof data.error === 'string' && data.error.trim() ? data.error.slice(0, 1000) : 'Could not fetch audio from this player.'));
        } else if (data.type === 'KAGE_BROWSER_AUDIO_PROGRESS') {
          if (!Number.isSafeInteger(data.received) || data.received < 0) return;
          if (data.received > MAX_BYTES || (Number.isSafeInteger(data.total) && data.total > MAX_BYTES)) {
            complete(new Error('Browser audio is larger than 128 MiB. Import a matching local file instead.'), null, true); return;
          }
          const total = Number.isSafeInteger(data.total) && data.total >= data.received ? data.total : null;
          try { onProgress?.({ received: data.received, total }); } catch { /* UI callbacks cannot interrupt a transfer. */ }
        } else {
          if (!(data.bytes instanceof ArrayBuffer) || !data.bytes.byteLength || data.bytes.byteLength > MAX_BYTES) {
            complete(new Error('The browser returned empty, invalid, or oversized audio. Import a matching local file instead.'), null, true); return;
          }
          const mimeType = String(data.mimeType || '').toLowerCase().split(';')[0].trim();
          const extension = MIME_EXTENSIONS.get(mimeType);
          if (!extension) { complete(new Error('The browser returned an unsupported audio format.'), null, true); return; }
          // Only complete media bytes become a local File. Signed URLs stay in
          // Chrome's transport; cookies and helper credentials are not forwarded.
          const name = typeof data.name === 'string' ? data.name.replace(/[\x00-\x1f/\\]/g, '_').slice(0, 180) : '';
          const fileName = name && name.toLowerCase().endsWith(`.${extension}`) ? name : `browser-audio.${extension}`;
          complete(null, new File([data.bytes], fileName, { type: mimeType }));
        }
      }
      // Bilibili: the page streams pieces while it downloads. Resolve at once
      // with a File-like source the importer uploads in order, so the helper
      // transcribes during the download instead of after it.
      function startStream(data) {
        const size = data.total;
        const mimeType = String(data.mimeType || '').toLowerCase().split(';')[0].trim();
        const extension = MIME_EXTENSIONS.get(mimeType);
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES) {
          complete(new Error('Browser audio is larger than 128 MiB. Import a local audio file instead.'), null, true); return;
        }
        if (!extension) { complete(new Error('The browser returned an unsupported audio format.'), null, true); return; }
        const name = typeof data.name === 'string' ? data.name.replace(/[\x00-\x1f/\\]/g, '_').slice(0, 180) : '';
        const fileName = name && name.toLowerCase().endsWith(`.${extension}`) ? name : `browser-audio.${extension}`;
        const pieces = [];
        let buffered = 0, arrived = 0, consumed = 0, ended = false, broken = null, waiting = null, open = true;
        const settle = () => {
          if (!waiting) return;
          if (broken) { const { reject: rejectRead } = waiting; waiting = null; rejectRead(broken); return; }
          if (buffered < waiting.want && !ended) return;
          const { resolve: resolveRead, want } = waiting; waiting = null;
          if (buffered < want) { breakStream(new Error('Browser audio download was incomplete. Refresh the episode and try again.')); return; }
          const out = new Uint8Array(want);
          let filled = 0;
          while (filled < want) {
            const head = pieces[0], take = Math.min(head.byteLength, want - filled);
            out.set(head.subarray(0, take), filled); filled += take;
            if (take === head.byteLength) pieces.shift(); else pieces[0] = head.subarray(take);
          }
          buffered -= want; consumed += want;
          if (consumed >= size) close(false);
          resolveRead(out.buffer);
        };
        function breakStream(error) { broken ||= error; close(true); settle(); }
        function close(cancel = true) {
          if (!open) return;
          open = false;
          window.removeEventListener('message', streamed);
          clearInterval(watch);
          pieces.length = 0; buffered = 0;
          if (cancel && !ended) post('KAGE_BROWSER_AUDIO_CANCEL');
        }
        function streamed(event) {
          const item = event.data;
          if (!open || event.source !== window || event.origin !== origin || !item || item.requestId !== requestId || item.page !== currentPage) return;
          if (item.type === 'KAGE_BROWSER_AUDIO_CHUNK') {
            if (!(item.bytes instanceof ArrayBuffer) || !item.bytes.byteLength || arrived + item.bytes.byteLength > size) {
              breakStream(new Error('The browser returned invalid audio. Refresh the episode and try again.')); return;
            }
            pieces.push(new Uint8Array(item.bytes)); buffered += item.bytes.byteLength; arrived += item.bytes.byteLength;
            settle();
          } else if (item.type === 'KAGE_BROWSER_AUDIO_END') {
            if (arrived !== size) { breakStream(new Error('Browser audio download was incomplete. Refresh the episode and try again.')); return; }
            ended = true; settle();
          } else if (item.type === 'KAGE_BROWSER_AUDIO_ERROR') {
            ended = true;
            breakStream(new Error(typeof item.error === 'string' && item.error.trim() ? item.error.slice(0, 1000) : 'Could not fetch audio from this player.'));
          }
        }
        const watch = setInterval(() => {
          if (page() !== currentPage) breakStream(abortError('Browser audio stopped after leaving this video.'));
        }, 500);
        function pull(start, end) {
          if (broken) return Promise.reject(broken);
          const want = Math.min(end, size) - start;
          if (start !== consumed || waiting || want <= 0) return Promise.reject(new Error('Browser audio was read out of order. Start preparation again.'));
          return new Promise((resolveRead, rejectRead) => { waiting = { resolve: resolveRead, reject: rejectRead, want }; settle(); });
        }
        window.addEventListener('message', streamed);
        // Stop the request's own listener and timers; the stream listener owns the transfer now.
        complete(null, { name: fileName, size, type: mimeType, close: () => close(true),
          slice: (start = 0, end = size) => ({ arrayBuffer: () => pull(start, end) }) });
      }
      // anime1.me: the page hands over the signed MP4 URL and the extension's
      // service worker downloads it (the CDN's CORS policy blocks the page).
      // Episodes can be hundreds of MB, so this resolves with a File-like source
      // that pulls the body in order while the importer uploads it.
      function startAnime1Download(src) {
        let port;
        try { port = chrome.runtime.connect({ name: 'kage-anime1-media' }); }
        catch { complete(new Error('Reload Kage and refresh this anime1.me tab to enable browser audio.')); return; }
        mediaPort = port;
        let handedOff = false, broken = null, waiting = null, consumed = 0, size = 0, open = true;
        const close = () => { if (!open) return; open = false; try { port.disconnect(); } catch { /* already closed */ } };
        const breakStream = error => {
          broken ||= error; close();
          if (waiting) { const { reject: rejectRead } = waiting; waiting = null; rejectRead(broken); }
        };
        function pull(start, end) {
          if (broken) return Promise.reject(broken);
          const want = Math.min(end, size) - start;
          if (start !== consumed || waiting || want <= 0) return Promise.reject(new Error('Browser audio was read out of order. Start preparation again.'));
          return new Promise((resolveRead, rejectRead) => {
            waiting = { resolve: resolveRead, reject: rejectRead, want };
            try { port.postMessage({ type: 'read', size: want }); } catch { breakStream(new Error('Kage’s audio downloader stopped. Reload Kage, refresh this tab, and try again.')); }
          });
        }
        port.onMessage.addListener(message => {
          if (handedOff) {
            if (message?.type === 'data' && waiting && typeof message.data === 'string') {
              const binary = atob(message.data);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              const { resolve: resolveRead, want } = waiting; waiting = null;
              consumed += bytes.byteLength;
              if (bytes.byteLength !== want) { breakStream(new Error('Browser audio download was incomplete. Refresh the page and try again.')); return; }
              if (consumed >= size) close();
              resolveRead(bytes.buffer);
            } else if (message?.type === 'error') {
              breakStream(new Error(typeof message.error === 'string' && message.error.trim() ? message.error.slice(0, 1000) : 'Could not fetch audio from this player.'));
            }
            return;
          }
          if (finished || mediaPort !== port) return;
          if (page() !== currentPage) { complete(abortError('Browser audio stopped after leaving this episode.'), null, true); return; }
          if (message?.type === 'ready' && Number.isSafeInteger(message.total) && message.total > 0) {
            size = message.total;
            handedOff = true; mediaPort = null; // The importer owns the stream from here.
            try { onProgress?.({ received: size, total: size }); } catch { /* UI only */ }
            const name = `anime1-${new URL(currentPage).pathname.replace(/\D/g, '')}.mp4`;
            complete(null, { name, size, type: 'video/mp4', close,
              slice: (start = 0, end = size) => ({ arrayBuffer: () => pull(start, end) }) });
          } else if (message?.type === 'error') {
            complete(new Error(typeof message.error === 'string' && message.error.trim() ? message.error.slice(0, 1000) : 'Could not fetch audio from this player.'));
          }
        });
        port.onDisconnect.addListener(() => {
          open = false;
          if (handedOff) { if (consumed < size) breakStream(new Error('Kage’s audio downloader stopped. Reload Kage, refresh this tab, and try again.')); return; }
          if (!finished && mediaPort === port) complete(new Error('Kage’s audio downloader stopped. Reload Kage, refresh this tab, and try again.'));
        });
        port.postMessage({ type: 'start', src, page: currentPage });
      }
      window.addEventListener('message', receive);
      signal?.addEventListener('abort', aborted, { once: true });
      navigation = setInterval(() => {
        if (page() !== currentPage) complete(abortError('Browser audio stopped after leaving this video.'), null, true);
      }, 500);
      timeout = setTimeout(() => complete(new Error('Browser audio download timed out. Keep the tab open and check your connection before trying again.'), null, true), TIMEOUT_MS);
      if (currentPage.startsWith('https://www.youtube.com/watch?') && globalThis.chrome?.runtime?.sendMessage) {
        Promise.resolve().then(() => chrome.runtime.sendMessage({ type: 'CHROME_AUDIO_FETCH', action: 'status' })).then(reply => {
          if (!finished) window.postMessage({ type: 'KAGE_BROWSER_AUDIO_REQUEST', requestId, page: currentPage,
            transport: reply?.success && reply.data?.available === true ? 'extension' : 'page' }, origin);
        }).catch(() => { if (!finished) post('KAGE_BROWSER_AUDIO_REQUEST'); });
      } else window.postMessage({ type: 'KAGE_BROWSER_AUDIO_REQUEST', requestId, page: currentPage, stream: true }, origin);
    });
  }

  globalThis.KageBrowserAudio = { download, resolveEpisode, currentPage, get episodes() { return catalog; }, get resolutionError() { return resolutionError; } };
})();
