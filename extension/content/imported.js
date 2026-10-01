(() => {
  const STORAGE_KEY = 'kageImportedTracksV1';
  const STORAGE_PREFIX = 'kageImportedTrackV2:';
  const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
  const MAX_TRACKS = 15;
  const MAX_STORAGE_BYTES = 3 * 1024 * 1024;
  const CHUNK_BYTES = 256 * 1024;
  const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
  const ACTIVE_STATES = new Set(['uploading', 'queued', 'downloading', 'preparing', 'transcribing', 'translating']);
  let pageKey = '', epoch = 0, video = null, documentState = null, loaded = false;
  let trackCache = null, timer = null, polling = false, uploading = false, stopping = false;
  let notice = '', error = false, storageQueue = Promise.resolve(), ui = null;
  let queueTimer = null, queueLoading = false;
  const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  const hasTranslation = cue => typeof cue.translation === 'string' && !!cue.translation.trim();
  const expiresAt = saved => Number(saved?.expiresAt) || (Number(saved?.updatedAt) || Date.now()) + RETENTION_MS;
  const preparingChinese = () => ['preparing', 'translating'].includes(documentState?.job?.state) || (documentState?.job?.state === 'queued' && !!documentState.cues.length);
  const TIMING_KEYS = ['queueMs', 'processingMs', 'workerWallMs', 'sourceSetupMs', 'audioWaitMs', 'recognitionMs', 'downloadMs', 'translationMs', 'translationQueueMs', 'translationRequests', 'translationRetries', 'batchSize'];
  function normalizeTimings(value) {
    if (!value || typeof value !== 'object') return null;
    const entries = TIMING_KEYS.filter(key => Number.isFinite(value[key]) && value[key] >= 0).map(key => [key, value[key]]);
    return entries.length ? Object.fromEntries(entries) : null;
  }
  function durationLabel(ms) {
    const seconds = ms / 1000;
    if (seconds < 1) return `${seconds.toFixed(1)}s`;
    const rounded = Math.round(seconds);
    return rounded < 60 ? `${rounded}s` : `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
  }

  function identity(href = location.href) {
    try {
      const url = new URL(href);
      if (!/(^|\.)bilibili\.com$/i.test(url.hostname)) return '';
      const episode = url.pathname.match(/^\/bangumi\/play\/(ep\d+)(?:\/|$)/i);
      if (episode) return `bilibili:${episode[1].toLowerCase()}`;
      const match = url.pathname.match(/^\/video\/(BV[a-z0-9]+)(?:\/|$)/i);
      if (!match) return '';
      const part = Math.max(1, Number.parseInt(url.searchParams.get('p') || '1', 10) || 1);
      return `bilibili:${match[1]}:p${part}`;
    } catch { return ''; }
  }
  function validContext(key, generation) { return key === pageKey && generation === epoch && identity() === key; }
  function emit() {
    trackCache = null;
    window.dispatchEvent(new CustomEvent('kage-import-change'));
  }
  function stopPolling() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function setNotice(text, isError = false) {
    // Reloading the extension leaves this page's old panel visible, but its
    // Chrome APIs no longer work. Helper setup cannot restore that connection.
    notice = isError && /extension context invalidated/i.test(text)
      ? 'Kage lost its connection to the extension. Refresh this Bilibili tab, then reopen Study. Your saved subtitles will remain.'
      : text;
    error = isError; render();
  }
  async function request(action, fields = {}) {
    const reply = await chrome.runtime.sendMessage({ type: 'LOCAL_SUBTITLES', action, ...fields });
    if (!reply?.success) throw new Error(reply?.error || 'The local subtitle helper did not respond.');
    return reply.data;
  }
  function normalizeCues(cues) {
    if (!Array.isArray(cues) || cues.length > 30000) throw new Error('The subtitle track is too large or invalid.');
    const result = cues.map((cue, index) => ({
      start: Number(cue.start), end: Number(cue.end), text: String(cue.text || '').replace(/\s+/g, ' ').trim(), id: index,
      ...(typeof cue.translation === 'string' ? { translation: cue.translation.replace(/\s+/g, ' ').trim() } : {})
    })).filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start && cue.text);
    result.sort((a, b) => a.start - b.start || a.end - b.end);
    if (result.some(cue => cue.text.length > 4000 || cue.translation?.length > 8000) || jsonBytes(result) > MAX_STORAGE_BYTES - 8192) {
      throw new Error('The subtitle track is too large to save in the extension.');
    }
    return result;
  }
  function normalizeDocument(saved, key) {
    if (!saved || saved.key !== key) return null;
    const offset = Number(saved.offset);
    return {
      key, name: String(saved.name || 'Imported media').slice(0, 240),
      cues: normalizeCues(saved.cues || []), enabled: saved.enabled !== false,
      offset: Number.isFinite(offset) ? Math.min(3600, Math.max(-3600, offset)) : 0,
      revision: Number(saved.revision) || 1, updatedAt: Number(saved.updatedAt) || Date.now(),
      expiresAt: expiresAt(saved),
      timings: normalizeTimings(saved.timings),
      job: saved.job && typeof saved.job.id === 'string' ? { ...saved.job } : null
    };
  }
  // Independent keys prevent simultaneous tabs from overwriting other videos.
  function persist(snapshot, key = snapshot?.key || pageKey, expectedJobId = null) {
    const copy = snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
    const operation = storageQueue.catch(() => {}).then(async () => {
      const storageKey = STORAGE_PREFIX + key;
      if (expectedJobId) {
        const existing = await chrome.storage.local.get(storageKey);
        if (existing[storageKey]?.job?.id !== expectedJobId) return;
      }
      if (copy) {
        copy.expiresAt = expiresAt(copy);
        if (jsonBytes(copy) > MAX_STORAGE_BYTES - 1024) throw new Error('This subtitle track is too large to save.');
        await chrome.storage.local.set({ [storageKey]: copy });
      } else {
        const legacy = await chrome.storage.local.get(STORAGE_KEY);
        if (legacy[STORAGE_KEY]?.some?.(item => item?.key === key)) {
          // A small tombstone prevents the old shared array from restoring a removed track.
          await chrome.storage.local.set({ [storageKey]: { key, deleted: true } });
        } else await chrome.storage.local.remove(storageKey);
      }
      const state = await chrome.storage.local.get(null);
      const documents = Object.entries(state).filter(([name, value]) => name.startsWith(STORAGE_PREFIX) && value && !value.deleted);
      documents.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
      const retained = documents.slice(0, MAX_TRACKS);
      while (retained.length > 1 && jsonBytes(retained) > MAX_STORAGE_BYTES) retained.pop();
      const kept = new Set(retained.map(([name]) => name));
      const expired = documents.filter(([name]) => !kept.has(name)).map(([name]) => name);
      if (expired.length) await chrome.storage.local.remove(expired);
    });
    storageQueue = operation;
    return operation;
  }
  async function saveCurrent() {
    if (!documentState) return;
    documentState.updatedAt = Date.now();
    await persist(documentState);
  }
  function schedulePoll(key, generation, jobId) {
    stopPolling();
    if (!validContext(key, generation)) return;
    timer = setTimeout(() => { timer = null; poll(key, generation, jobId); }, 1000);
  }
  async function poll(key, generation, jobId) {
    if (!validContext(key, generation) || polling || documentState?.job?.id !== jobId) return;
    polling = true;
    try {
      const status = await request('status', { id: jobId });
      if (!validContext(key, generation) || documentState?.job?.id !== jobId || stopping) return;
      if (status.timings) documentState.timings = normalizeTimings(status.timings);
      // Use the helper's deadline even when the tab was closed at completion.
      documentState.expiresAt = Number(status.expiresAt) || Date.now() + RETENTION_MS;
      if (documentState.expiresAt <= Date.now()) { expireCurrent(); return; }
      const wasPreparingChinese = preparingChinese();
      documentState.job = { ...documentState.job, ...status, cues: undefined };
      if (status.state === 'complete' || (['preparing', 'translating', 'translation_error', 'error', 'cancelled'].includes(status.state) && Array.isArray(status.cues))) {
        let cues;
        try {
          cues = normalizeCues(status.cues);
          if (!cues.length && status.state !== 'preparing') throw new Error(status.message || 'No Japanese speech was found. Try a file with clearer dialogue.');
        } catch (cause) {
          documentState.job = { ...documentState.job, state: 'error', message: cause.message };
          if (wasPreparingChinese !== preparingChinese()) emit();
          await saveCurrent();
          if (validContext(key, generation)) setNotice(cause.message, true);
          return;
        }
        const enable = documentState.job.cuesSaved ? documentState.enabled : true;
        const changed = JSON.stringify(documentState.cues) !== JSON.stringify(cues) || documentState.enabled !== enable;
        if (changed) {
          documentState.cues = cues;
          documentState.revision++;
        }
        documentState.enabled = enable;
        documentState.job.cuesSaved = true;
        documentState.name = documentState.job.name || documentState.name;
        if (status.state === 'complete') documentState.job = null;
        if (changed || wasPreparingChinese !== preparingChinese()) emit();
        await saveCurrent();
        if (!validContext(key, generation)) return;
        if (status.state === 'complete') {
          setNotice(cues.every(hasTranslation)
            ? `${cues.length} lines ready with Japanese and Traditional Chinese. Play the video to use your subtitles.`
            : `${cues.length} Japanese subtitle lines saved. Chinese translations are not prepared yet.`);
        } else if (status.state === 'translation_error') {
          setNotice(`Japanese subtitles saved. ${status.message || 'Traditional Chinese translation stopped.'} Select Retry Chinese translations to continue.`, true);
        } else if (status.state === 'cancelled') {
          setNotice(`${cues.length} ready subtitle lines kept. Processing stopped.`);
        } else if (status.state === 'error') {
          setNotice(`${cues.length} subtitle lines saved. ${status.message || 'Processing stopped.'} Download or import again to prepare the full video.`, true);
        } else {
          notice = ''; error = false; render();
          schedulePoll(key, generation, jobId);
        }
      } else if (status.state === 'error' || status.state === 'cancelled' || status.state === 'translation_error') {
        if (wasPreparingChinese !== preparingChinese()) emit();
        await saveCurrent();
        if (validContext(key, generation)) setNotice(status.state === 'translation_error'
          ? `Japanese subtitles saved. ${status.message || 'Traditional Chinese translation stopped.'} Select Retry Chinese translations to continue.`
          : status.message || (status.state === 'cancelled' ? 'Processing cancelled.' : 'Transcription failed.'), status.state !== 'cancelled');
      } else if (status.state === 'uploading' && !uploading) {
        if (wasPreparingChinese !== preparingChinese()) emit();
        setNotice('Upload interrupted. Cancel this upload and choose the file again.', true);
      } else {
        if (wasPreparingChinese !== preparingChinese()) emit();
        render();
        schedulePoll(key, generation, jobId);
      }
    } catch (cause) {
      if (validContext(key, generation)) setNotice(`${cause.message} Start the local helper and select Reconnect.`, true);
    } finally {
      if (validContext(key, generation)) { polling = false; render(); }
    }
  }
  async function load(key, generation) {
    try {
      const storageKey = STORAGE_PREFIX + key;
      const state = await chrome.storage.local.get([storageKey, STORAGE_KEY]);
      if (!validContext(key, generation)) return;
      const documents = Array.isArray(state[STORAGE_KEY]) ? state[STORAGE_KEY] : [];
      const saved = state[storageKey] || documents.find(item => item?.key === key);
      const expired = saved && !saved.deleted && expiresAt(saved) <= Date.now();
      documentState = saved?.deleted || expired ? null : normalizeDocument(saved, key);
      if (expired) { notice = 'Saved subtitles expired after 3 days. Prepare this video again to continue.'; void persist(null, key).catch(() => {}); }
      loaded = true; emit(); render();
      if (documentState?.job && ACTIVE_STATES.has(documentState.job.state)) poll(key, generation, documentState.job.id);
    } catch (cause) {
      if (validContext(key, generation)) { loaded = true; setNotice(`Could not load saved subtitles. ${cause.message}`, true); }
    }
  }
  function expireCurrent() {
    const key = pageKey;
    stopPolling(); documentState = null;
    notice = 'Saved subtitles expired after 3 days. Prepare this video again to continue.';
    if (ui) ui.editor.hidden = true;
    emit(); render();
    void persist(null, key).catch(() => {});
  }
  function observe(currentVideo) {
    video = currentVideo || null;
    const key = identity();
    if (key === pageKey) {
      if (documentState && expiresAt(documentState) <= Date.now()) expireCurrent();
      return;
    }
    pageKey = key; epoch++;
    stopPolling(); documentState = null; loaded = false; polling = false; uploading = false; stopping = false;
    notice = ''; error = false;
    if (ui) ui.editor.hidden = true;
    emit(); render();
    if (key) load(key, epoch);
  }
  function getTrack(currentVideo) {
    observe(currentVideo);
    if (!pageKey || !documentState?.enabled || !documentState.cues.length) return null;
    if (!trackCache) {
      const offset = documentState.offset;
      const cues = documentState.cues.map(cue => ({ ...cue, start: cue.start + offset, end: cue.end + offset }));
      cues.language = 'ja';
      trackCache = [`imported:${pageKey}:${documentState.revision}:${offset}`, cues];
    }
    return trackCache;
  }
  function current(currentVideo) {
    const track = getTrack(currentVideo);
    if (!track) return null;
    const time = Number(currentVideo?.currentTime);
    const cues = track[1].filter(cue => cue.start <= time && time < cue.end);
    return { text: cues.map(cue => cue.text).join(' '), id: cues.length ? `${track[0]}:${cues.map(cue => cue.id).join(',')}` : '' };
  }
  function chinese(currentVideo) {
    const track = getTrack(currentVideo);
    if (!track) return { available: false, text: '' };
    const time = Number(currentVideo?.currentTime);
    const cues = track[1].filter(cue => cue.start <= time && time < cue.end);
    const available = cues.length ? cues.every(hasTranslation) : track[1].every(hasTranslation);
    return { available, text: available ? cues.map(cue => cue.translation).join(' ') : '' };
  }
  function base64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary);
  }
  async function importFile(file, download = false) {
    if ((!file && !download) || !pageKey || !loaded || uploading || stopping || ACTIVE_STATES.has(documentState?.job?.state)) return;
    if (!download && (!file.size || file.size > MAX_FILE_BYTES)) { setNotice('Choose a video or audio file smaller than 4 GiB (up to 6 hours).', true); return; }
    const key = pageKey, generation = epoch;
    const name = download ? `Bilibili ${key.slice(9)} (audio)` : file.name;
    let jobId = null, ownedDocument = null, started = false, failure = null;
    uploading = true; setNotice('Connecting to the local subtitle helper…');
    try {
      const health = await request('health');
      if (!validContext(key, generation)) return;
      if (health?.ready === false) throw new Error(health.error || 'Local transcription is not installed yet. Run npm run subtitles:setup.');
      const created = download ? await request('download') : await request('create', { name, size: file.size });
      if (typeof created?.id !== 'string') throw new Error('The local helper returned an invalid job.');
      jobId = created.id;
      if (!validContext(key, generation)) return;
      documentState ||= { key, name, cues: [], enabled: true, offset: 0, revision: 1, updatedAt: Date.now(), job: null };
      ownedDocument = documentState;
      documentState.job = { id: jobId, name, size: download ? 0 : file.size, received: 0, state: 'uploading', progress: 0 };
      documentState.timings = null;
      documentState.expiresAt = Date.now() + RETENTION_MS;
      await saveCurrent();
      for (let offset = 0; !download && offset < file.size; offset += CHUNK_BYTES) {
        if (!validContext(key, generation) || documentState?.job?.id !== jobId || stopping) return;
        const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
        if (!validContext(key, generation) || documentState?.job?.id !== jobId || stopping) return;
        const result = await request('upload', { id: jobId, offset, data: base64(bytes) });
        if (!validContext(key, generation) || documentState?.job?.id !== jobId || stopping) return;
        documentState.job.received = Number(result?.received) || Math.min(offset + bytes.length, file.size);
        documentState.job.progress = documentState.job.received / file.size;
        notice = ''; render();
      }
      if (!validContext(key, generation) || documentState?.job?.id !== jobId || stopping) return;
      await request('start', { id: jobId });
      started = true;
      if (!validContext(key, generation) || documentState?.job?.id !== jobId || stopping) return;
      const wasPreparingChinese = preparingChinese();
      documentState.job.state = 'queued'; documentState.job.progress = 0;
      notice = ''; error = false;
      if (wasPreparingChinese !== preparingChinese()) emit();
      await saveCurrent();
      if (validContext(key, generation)) { uploading = false; await poll(key, generation, jobId); }
    } catch (cause) {
      failure = cause;
      if (validContext(key, generation) && !stopping) {
        setNotice(cause.message, true);
        if (/queue|upload.*limit/i.test(cause.message) && ui) { ui.queue.open = true; void refreshQueue(); }
      }
    } finally {
      // A page navigation or failed transfer must not leave a partial media file behind.
      // Jobs that have started transcription can finish and reconnect on a later visit.
      if (jobId && !started) {
        try { await request('cancel', { id: jobId }); } catch { /* The helper also expires abandoned jobs. */ }
        if (validContext(key, generation) && documentState === ownedDocument && documentState?.job?.id === jobId) {
          documentState.job = { ...documentState.job, state: failure ? 'error' : 'cancelled', message: failure?.message || 'Upload cancelled.' };
          try { await saveCurrent(); } catch { /* The original transfer error is more useful. */ }
        } else if (ownedDocument?.job?.id === jobId) {
          const abandoned = { ...ownedDocument, job: { ...ownedDocument.job, state: 'cancelled', message: 'Upload stopped after leaving this video.' } };
          try { await persist(abandoned, key, jobId); } catch { /* Reconnecting can still recover the helper status. */ }
        }
      }
      if (validContext(key, generation)) { uploading = false; render(); }
    }
  }
  async function cancel(forget = false) {
    const key = pageKey, generation = epoch, jobId = documentState?.job?.id;
    if (!jobId || stopping) return;
    stopping = true; stopPolling(); render();
    try {
      const stopped = await request('cancel', { id: jobId });
      if (!validContext(key, generation) || documentState?.job?.id !== jobId) return;
      documentState.expiresAt = Number(stopped.expiresAt) || Date.now() + RETENTION_MS;
      if (stopped.timings) documentState.timings = normalizeTimings(stopped.timings);
      const wasPreparingChinese = preparingChinese();
      if (Array.isArray(stopped.cues) && stopped.cues.length) {
        documentState.cues = normalizeCues(stopped.cues); documentState.revision++; emit();
      }
      documentState.job = null; uploading = false;
      if (wasPreparingChinese !== preparingChinese()) emit();
      await saveCurrent();
      if (validContext(key, generation)) setNotice('Processing stopped. Ready subtitles are kept. You can queue another video.');
    } catch (cause) {
      if (validContext(key, generation)) {
        if (forget && documentState?.job?.id === jobId) {
          const wasPreparingChinese = preparingChinese();
          documentState.job = null; uploading = false;
          if (wasPreparingChinese !== preparingChinese()) emit();
          try {
            await saveCurrent();
            if (validContext(key, generation)) setNotice('Pending import discarded. The helper could not confirm cancellation; restart it if processing continues.');
          } catch (saveError) {
            if (validContext(key, generation)) setNotice(`Could not save the discarded import. ${saveError.message}`, true);
          }
        } else setNotice(`Could not cancel the local job. ${cause.message}`, true);
      }
    } finally {
      if (validContext(key, generation)) { stopping = false; render(); }
    }
  }
  async function retryTranslation() {
    const key = pageKey, generation = epoch, jobId = documentState?.job?.id;
    if (!jobId || documentState.job.state !== 'translation_error' || polling || stopping) return;
    documentState.job.state = 'translating';
    emit();
    notice = ''; error = false; render();
    try {
      await request('start', { id: jobId });
      if (!validContext(key, generation) || documentState?.job?.id !== jobId || stopping) return;
      await saveCurrent();
      if (validContext(key, generation)) await poll(key, generation, jobId);
    } catch (cause) {
      if (!validContext(key, generation) || documentState?.job?.id !== jobId || stopping) return;
      documentState.job.state = 'translation_error';
      documentState.job.message = cause.message;
      emit();
      try { await saveCurrent(); } catch { /* Keep the translation error and retry control available. */ }
      if (validContext(key, generation)) setNotice(`Japanese subtitles saved. ${cause.message} Select Retry Chinese translations to continue.`, true);
    }
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function button(text, handler) {
    const element = node('button', 'kage-text-button', text); element.type = 'button'; element.addEventListener('click', handler); return element;
  }
  function render() {
    if (!ui) return;
    ui.card.hidden = !pageKey;
    const hasTrack = !!documentState?.cues.length;
    const job = documentState?.job;
    const busy = uploading || stopping || ACTIVE_STATES.has(job?.state);
    ui.file.disabled = !loaded || busy;
    ui.choose.disabled = ui.file.disabled;
    ui.download.disabled = ui.file.disabled;
    ui.toggleRow.hidden = !hasTrack;
    ui.toggle.checked = documentState?.enabled !== false;
    ui.adjust.hidden = !hasTrack;
    if (document.activeElement !== ui.offset) ui.offset.value = String(documentState?.offset || 0);
    ui.source.textContent = hasTrack ? `${documentState.name} · ${documentState.cues.length} lines` : 'No imported subtitles for this video part.';
    ui.remove.hidden = !documentState;
    ui.remove.disabled = busy;
    ui.cancel.hidden = !job || !ACTIVE_STATES.has(job.state);
    ui.cancel.disabled = stopping;
    ui.reconnect.hidden = !job || uploading || stopping || job.state === 'translation_error';
    ui.reconnect.disabled = polling;
    ui.retry.hidden = job?.state !== 'translation_error';
    ui.retry.disabled = polling || stopping;
    ui.discard.hidden = !error || !job || uploading || stopping || !ACTIVE_STATES.has(job.state);
    ui.edit.disabled = !hasTrack || busy;
    ui.choose.textContent = hasTrack ? 'Import another video / audio' : 'Import video / audio';
    let message = notice;
    if (!message && busy) {
      const progress = Number(job?.progress);
      const percent = Number.isFinite(progress) ? ` · ${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` : '';
      const total = Math.max(0, Number(job?.translationTotal) || 0);
      const completed = Math.min(total, Math.max(0, Number(job?.translationCompleted) || 0));
      message = stopping ? 'Cancelling…'
        : job?.state === 'queued' ? `Queued${Number(job.queuePosition) > 0 ? ` · position ${job.queuePosition}` : ''}. Waiting for a processing slot. See Video queue below.`
        : job?.state === 'downloading' ? 'Connecting to Bilibili audio. The first subtitles will appear as they are prepared…'
        : job?.state === 'preparing' && !(Number(job.processedThrough) > 0) ? 'Preparing the first minute. Subtitles will appear as soon as they are ready…'
        : job?.state === 'preparing' ? `Preparing subtitles in sections · Japanese through ${Math.floor((Number(job.processedThrough) || 0) / 60)}:${String(Math.floor((Number(job.processedThrough) || 0) % 60)).padStart(2, '0')}${total ? ` · ${completed} / ${total} lines translated` : ''}. You can play the ready sections now.`
        : job?.state === 'uploading' ? `Sending media to your local helper${percent}`
          : job?.state === 'translating' ? `Translating Traditional Chinese locally${total ? ` · ${completed} / ${total} lines` : percent}. Keep the local helper and Ollama running.`
            : job?.message || `Transcribing Japanese locally${percent}. Traditional Chinese translation will follow automatically.`;
    }
    if (!message && job?.state === 'translation_error') message = `Japanese subtitles saved. ${job.message || 'Traditional Chinese translation stopped.'} Select Retry Chinese translations to continue.`;
    if (!message) message = loaded ? hasTrack ? `Saved on this device until ${new Date(documentState.expiresAt).toLocaleString()}. Reopen this video to restore subtitles.` : 'Download this Bilibili video to prepare subtitles, or import a matching file.' : 'Loading saved subtitles…';
    ui.status.textContent = message;
    ui.status.classList.toggle('kage-import-error', error || job?.state === 'translation_error');
    const timings = documentState?.timings;
    ui.timings.hidden = !timings;
    const labels = { processingMs: 'Processing', queueMs: 'Waiting to start', recognitionMs: 'Japanese recognition', translationMs: 'Chinese translation', translationQueueMs: 'Waiting for translation', sourceSetupMs: 'Audio setup', audioWaitMs: 'Waiting for audio', downloadMs: 'Download' };
    ui.timingValues.textContent = timings ? Object.entries(labels).filter(([key]) => Number.isFinite(timings[key]))
      .map(([key, label]) => `${label}: ${durationLabel(timings[key])}`).join(' · ') : '';
    ui.timingRequests.textContent = timings && Number.isFinite(timings.translationRequests)
      ? `${timings.translationRequests} translation requests · ${timings.translationRetries || 0} retries · up to ${timings.batchSize || 4} lines per batch` : '';
    ui.progress.hidden = !busy;
    if (job?.state === 'queued') ui.progress.hidden = true;
    ui.progress.value = job?.state === 'translating' && Number(job.translationTotal) > 0
      ? Math.max(0, Math.min(1, Number(job.translationCompleted) / Number(job.translationTotal) || 0))
      : Math.max(0, Math.min(1, Number(job?.progress) || 0));
  }
  function editCue() {
    if (!documentState?.cues.length || uploading || stopping || ACTIVE_STATES.has(documentState.job?.state)) return;
    const time = Number(video?.currentTime || 0) - documentState.offset;
    const upcoming = documentState.cues.findIndex(cue => cue.end > time);
    const index = upcoming < 0 ? documentState.cues.length - 1 : upcoming;
    const cue = documentState.cues[index];
    ui.editor.dataset.index = String(index);
    ui.editor.dataset.key = pageKey;
    ui.editor.dataset.revision = String(documentState.revision);
    ui.editText.value = cue.text; ui.start.value = String(cue.start); ui.end.value = String(cue.end);
    ui.editor.hidden = false; ui.editText.focus();
  }
  async function saveEdit() {
    if (!documentState || uploading || stopping || ACTIVE_STATES.has(documentState.job?.state) || ui.editor.dataset.key !== pageKey || ui.editor.dataset.revision !== String(documentState.revision)) return;
    const start = Number(ui.start.value), end = Number(ui.end.value), text = ui.editText.value.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 4000 || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      setNotice('Enter Japanese text and an end time later than the non-negative start time.', true); return;
    }
    const index = Number(ui.editor.dataset.index);
    const previous = documentState.cues[index];
    const textChanged = previous.text !== text;
    const detached = documentState.job?.state === 'translation_error' && (textChanged || previous.start !== start || previous.end !== end);
    if (textChanged) delete previous.translation;
    // A failed helper job retains the old transcript; retrying it must not overwrite manual corrections.
    if (detached) documentState.job = null;
    documentState.cues[index] = { ...documentState.cues[index], start, end, text };
    documentState.cues.sort((a, b) => a.start - b.start || a.end - b.end);
    documentState.revision++; ui.editor.hidden = true; emit();
    const key = pageKey, generation = epoch;
    try {
      await saveCurrent();
      if (validContext(key, generation)) setNotice(textChanged
        ? 'Subtitle correction saved. Chinese for the edited text will use your local model.'
        : 'Subtitle correction saved.');
    }
    catch (cause) { if (validContext(key, generation)) setNotice(`The correction is active but could not be saved. ${cause.message}`, true); }
  }
  function labeledInput(labelText, type, value) {
    const label = node('label', 'kage-import-row');
    const caption = node('span', '', labelText);
    const input = node('input'); input.type = type; input.value = value;
    if (type === 'number') input.step = '0.1';
    label.append(caption, input); return { label, input };
  }
  async function refreshQueue() {
    if (!ui?.queue.open || queueLoading) return;
    clearTimeout(queueTimer); queueTimer = null;
    queueLoading = true;
    ui.queueRefresh.disabled = true;
    try {
      const result = await request('list');
      const waiting = result.jobs.filter(job => job.state === 'queued').length;
      const processing = result.jobs.filter(job => !['queued', 'uploading'].includes(job.state)).length;
      const concurrency = Math.max(1, Number(result.concurrency) || 1);
      ui.queueSummary.textContent = `Video queue${result.jobs.length ? ` · ${result.jobs.length} / ${result.limit}` : ''}`;
      ui.queueStatus.textContent = result.jobs.length
        ? `${processing} processing · ${waiting} waiting · ${concurrency === 1 ? 'one video processes at a time' : `up to ${concurrency} videos process at once`}.`
        : 'No active jobs. The helper is running. Queue videos from their Bilibili tabs.';
      const rank = job => job.state === 'queued' ? 1 : job.state === 'uploading' ? 2 : 0;
      const ordered = [...result.jobs].sort((a, b) => rank(a) - rank(b) || (a.queuePosition || 0) - (b.queuePosition || 0));
      const ownJob = result.jobs.find(job => job.id === documentState?.job?.id);
      if (ownJob?.state === 'queued' && documentState.job.state === 'queued') {
        documentState.job.queuePosition = ownJob.queuePosition;
        render();
      }
      const rows = ordered.map(job => {
        const row = node('div', 'kage-queue-job');
        const label = node('p', 'kage-queue-title', `${job.name}${job.id === documentState?.job?.id ? ' · This video' : ''}`);
        const stages = { downloading: 'Downloading audio', preparing: 'Preparing subtitles', transcribing: 'Transcribing Japanese', translating: 'Translating Chinese', uploading: 'Uploading audio' };
        const status = node('p', 'kage-import-hint', job.state === 'queued'
          ? `Queued · position ${job.queuePosition}` : `${stages[job.state] || job.state}${Number.isFinite(job.progress) ? ` · ${Math.round(Math.max(0, Math.min(1, job.progress)) * 100)}%` : ''}`);
        const stop = button('Stop', async () => {
          stop.disabled = true;
          clearTimeout(queueTimer); queueTimer = null;
          try {
            if (documentState?.job?.id === job.id) await cancel();
            else await request('cancel', { id: job.id });
            await refreshQueue();
          } catch (cause) { ui.queueStatus.textContent = cause.message; stop.disabled = false; }
        });
        stop.setAttribute('aria-label', `Stop ${job.name}`);
        row.append(label, status);
        try {
          const url = new URL(job.sourceUrl);
          if (url.protocol === 'https:' && /(^|\.)bilibili\.com$/i.test(url.hostname)) {
            const link = node('a', 'kage-text-button', 'Open video');
            link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
            row.append(link);
          }
        } catch { /* Manually imported files may not have a source URL. */ }
        row.append(stop); return row;
      });
      ui.queueJobs.replaceChildren(...rows);
      if (ui.queue.open) queueTimer = setTimeout(refreshQueue, result.jobs.length ? 2000 : 10000);
    } catch (cause) {
      ui.queueStatus.textContent = cause.message;
      ui.queueJobs.replaceChildren();
      if (ui.queue.open) queueTimer = setTimeout(refreshQueue, 10000);
    } finally { queueLoading = false; ui.queueRefresh.disabled = false; }
  }
  function mount(slot) {
    if (!slot || ui) return;
    const card = node('section', 'kage-import-card kage-source-card');
    card.append(node('span', 'kage-eyebrow', 'Video subtitles'), node('h3', '', 'Learn from this video'));
    card.append(node('p', 'kage-import-hint', 'Japanese, Chinese, and furigana from this video’s audio. Start watching as each section becomes ready.'));
    const source = node('p', 'kage-import-source');
    const file = node('input'); file.type = 'file'; file.accept = 'video/*,audio/*,.mkv,.flac,.m4a,.opus'; file.hidden = true;
    file.setAttribute('aria-label', 'Choose a local video or audio file');
    const choose = button('Import video / audio', () => file.click());
    const download = button('Download audio & prepare subtitles', () => importFile(null, true));
    download.className = 'kage-primary-action';
    file.addEventListener('change', () => { const selected = file.files?.[0]; file.value = ''; importFile(selected); });
    const cancelButton = button('Stop processing', () => cancel());
    const discard = button('Discard pending import', () => cancel(true));
    const reconnect = button('Reconnect', () => {
      if (!documentState?.job || polling) return;
      notice = ''; error = false; poll(pageKey, epoch, documentState.job.id);
    });
    const retry = button('Retry Chinese translations', retryTranslation);
    const actions = node('div', 'kage-import-actions'); actions.append(download, choose, cancelButton, reconnect, retry, discard);
    const progress = node('progress'); progress.max = 1; progress.setAttribute('aria-label', 'Subtitle preparation progress');
    const status = node('p', 'kage-import-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const timings = node('details', 'kage-import-timings'); timings.hidden = true;
    const timingValues = node('p', 'kage-import-hint');
    const timingRequests = node('p', 'kage-import-hint');
    timings.append(node('summary', '', 'Processing timings'), timingValues, timingRequests,
      node('p', 'kage-import-hint', 'Stages overlap, so their times do not add up to the processing total. Audio wait includes waiting for streamed audio and decoding. Retries are included.'));
    const queue = node('details', 'kage-import-queue');
    queue.open = !!identity();
    const queueSummary = node('summary', '', 'Video queue');
    const queueStatus = node('p', 'kage-import-hint', 'Loading the video queue…');
    queueStatus.setAttribute('role', 'status');
    const queueJobs = node('div', 'kage-queue-jobs');
    const queueRefresh = button('Refresh queue', refreshQueue);
    queue.append(queueSummary, queueStatus, queueJobs, queueRefresh);
    queue.addEventListener('toggle', () => {
      if (queue.open) void refreshQueue();
      else { clearTimeout(queueTimer); queueTimer = null; }
    });
    const setup = node('details', 'kage-import-setup');
    setup.append(node('summary', '', 'Local helper setup'));
    setup.append(node('p', '', 'On your Mac, run these commands once in the shadowing project to install the helper and start it automatically at login:'));
    setup.append(node('code', '', 'npm run subtitles:setup'), node('br'), node('code', '', 'npm run subtitles:autostart'));
    setup.append(node('p', '', 'Keep Ollama running for Chinese translation. No terminal is needed after automatic startup is installed. Downloading needs internet; subtitle processing runs locally. Login-only or unavailable videos may need a manual import.'));
    const toggleRow = node('label', 'kage-import-toggle'); const toggle = node('input'); toggle.type = 'checkbox';
    toggleRow.append(toggle, node('span', '', 'Use imported subtitles'));
    toggle.addEventListener('change', async () => {
      if (!documentState) return;
      documentState.enabled = toggle.checked; emit();
      const key = pageKey, generation = epoch;
      try { await saveCurrent(); if (validContext(key, generation)) setNotice(toggle.checked ? 'Imported subtitles enabled.' : 'Imported subtitles disabled.'); }
      catch (cause) { if (validContext(key, generation)) setNotice(`Could not save this preference. ${cause.message}`, true); }
    });
    const adjust = node('details', 'kage-import-adjust');
    adjust.append(node('summary', '', 'Timing & corrections'));
    const offsetField = labeledInput('Timing offset (seconds)', 'number', '0'); offsetField.input.min = '-3600'; offsetField.input.max = '3600';
    offsetField.input.addEventListener('change', async () => {
      if (!documentState) return;
      const value = Number(offsetField.input.value);
      if (!Number.isFinite(value) || Math.abs(value) > 3600) { setNotice('Use a timing offset between −3600 and 3600 seconds.', true); return; }
      documentState.offset = value; emit();
      const key = pageKey, generation = epoch;
      try { await saveCurrent(); if (validContext(key, generation)) setNotice('Timing offset saved.'); }
      catch (cause) { if (validContext(key, generation)) setNotice(`Could not save this offset. ${cause.message}`, true); }
    });
    const edit = button('Edit line at playhead', editCue);
    adjust.append(offsetField.label, node('p', 'kage-import-hint', 'Positive values display subtitles later. Match the downloaded version to the video playing here.'), edit);
    const editor = node('div', 'kage-import-editor'); editor.hidden = true;
    const textLabel = node('label', 'kage-import-row', 'Japanese subtitle'); const editText = node('textarea'); editText.rows = 3; editText.maxLength = 4000; editText.lang = 'ja'; textLabel.append(editText);
    const start = labeledInput('Start (seconds in file)', 'number', '0'), end = labeledInput('End (seconds in file)', 'number', '1');
    start.input.min = '0'; end.input.min = '0';
    const editorButtons = node('div', 'kage-import-actions'); editorButtons.append(button('Save correction', saveEdit), button('Close editor', () => { editor.hidden = true; }));
    editor.append(textLabel, start.label, end.label, editorButtons);
    const remove = button('Remove saved subtitles', async () => {
      if (!documentState || uploading || ACTIVE_STATES.has(documentState.job?.state)) return;
      const key = pageKey, generation = epoch;
      documentState = null; editor.hidden = true; emit(); render();
      try { await persist(null, key); if (validContext(key, generation)) setNotice('Saved subtitles removed for this video part.'); }
      catch (cause) { if (validContext(key, generation)) setNotice(`Could not remove the saved subtitles. ${cause.message}`, true); }
    });
    remove.className = 'kage-danger-action';
    adjust.append(editor, remove);
    card.append(source, file, actions, progress, status, toggleRow, adjust, timings, queue, setup); slot.appendChild(card);
    ui = { card, source, file, choose, download, cancel: cancelButton, reconnect, retry, discard, progress, status, timings, timingValues, timingRequests, queue, queueSummary, queueStatus, queueJobs, queueRefresh, toggleRow, toggle, adjust, offset: offsetField.input, edit, editor, editText, start: start.input, end: end.input, remove };
    observe(video); render();
  }
  globalThis.KageImport = {
    mount, observe, current, chinese, track: getTrack,
    get hasTrack() { return !!documentState?.cues.length; },
    get enabled() { return !!documentState?.enabled && !!documentState.cues.length; },
    get preparingChinese() { return preparingChinese(); },
    get sourceName() { return documentState?.name || ''; }
  };
})();
