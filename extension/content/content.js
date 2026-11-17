let isEnabled = false;
let autoTranslate = true;
let chineseHidden = false;
let coverSubtitleMode = 'separate';
let currentSubtitleText = '';
let subtitleContainer = null;
let subtitleObserver = null;
let generation = 0;
let activeIdentity = '';
let video = null;
let videoEvents = null;
let dragEvents = null;
let subtitlePosition = null;
let subtitleAnchor = null;
let subtitleResizeObserver = null;
let page = location.href;
let tracks = new Map();
let lastPrefetch = '';
let currentData = null;
let renderedSignature = '';
const translationMemory = new Map();
let translationVersion = 0;
const subtitleSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let subtitleEpoch = 0;
let subtitleContext = `${subtitleSession}:${subtitleEpoch}`;
let prefetchTrack = null;
let prefetchBlocked = false;
let wasSeeking = false;
let lastChineseFrame = '';
let netflixStatus = 'Checking Netflix subtitle tracks…';

const { normalize, parse, active } = KageSubtitles;
const escapeHTML = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
globalThis.KagePreparation?.setContext(subtitleContext);

function clearDemand() {
  chrome.runtime.sendMessage({ type: 'CLEAR_SUBTITLE', context: subtitleContext }).catch(() => {});
}
function resetBuffer() {
  subtitleContext = `${subtitleSession}:${++subtitleEpoch}`;
  // The same native text may remain visible across a track/context change.
  // Let sync submit it again under the new context without hiding it first.
  activeIdentity = '';
  generation++;
  prefetchTrack = null;
  prefetchBlocked = false;
  lastPrefetch = '';
  globalThis.KagePreparation?.setContext(subtitleContext);
  chrome.runtime.sendMessage({ type: 'PRELOAD_TRACK', texts: [], context: subtitleContext }).catch(() => {});
}
function rememberTranslation(text, data) {
  if (typeof text !== 'string' || !data || typeof data.sentence_translation !== 'string') return false;
  const cached = { ...data };
  if (normalize(cached.chunks?.map(c => c.japanese).join('')).replace(/\s/g, '') !== text.replace(/\s/g, '')) cached.chunks = [{ japanese: text }];
  translationMemory.set(text, cached);
  if (translationMemory.size > 1000) translationMemory.delete(translationMemory.keys().next().value);
  return true;
}

function getPlatform() {
  if (location.hostname.endsWith('netflix.com')) return 'netflix';
  if (location.hostname.endsWith('bilibili.com')) return 'bilibili';
  return 'youtube';
}
function clearSubtitle() {
  if (activeIdentity) clearDemand();
  generation++;
  activeIdentity = '';
  currentSubtitleText = '';
  globalThis.KageTutor?.clearCurrent();
  currentData = null;
  renderedSignature = '';
  removeSubtitleContainer();
}
function removeSubtitleContainer() {
  globalThis.KageCover?.hold(null);
  dragEvents?.abort();
  subtitleResizeObserver?.disconnect();
  subtitleContainer?.remove();
  subtitleContainer = null;
  document.body.classList.remove('kage-has-subtitle');
}
function createSubtitleContainer(target) {
  if (!subtitleContainer) {
    subtitleContainer = document.createElement('div');
    subtitleContainer.className = 'kage-subtitle-container';
  }
  if (subtitleContainer.parentNode !== target) {
    target.appendChild(subtitleContainer);
    subtitleResizeObserver?.disconnect();
    if (typeof ResizeObserver === 'function') {
      subtitleResizeObserver = new ResizeObserver(positionSubtitles);
      subtitleResizeObserver.observe(subtitleContainer.offsetParent || target);
      subtitleResizeObserver.observe(subtitleContainer);
    }
  }
  document.body.classList.add('kage-has-subtitle');
}
function subtitleBounds(container) {
  const parent = container.offsetParent || document.documentElement;
  if (!parent) return null;
  const width = parent.clientWidth || parent.offsetWidth;
  const height = parent.clientHeight || parent.offsetHeight;
  return width > 0 && height > 0 ? { width, height,
    x: (container.offsetParent ? parent.scrollLeft : window.scrollX) || 0,
    y: (container.offsetParent ? parent.scrollTop : window.scrollY) || 0
  } : null;
}
function rememberSubtitlePosition(position) {
  subtitlePosition = position;
  const bounds = subtitleBounds(subtitleContainer);
  subtitleAnchor = bounds ? {
    x: (position.centerX - bounds.x) / bounds.width,
    y: (position.top - bounds.y) / bounds.height
  } : null;
}
function positionSubtitles() {
  if (!subtitleContainer) return;
  // With "on the cover" chosen and the cover up, the strip places the subtitle.
  if (globalThis.KageCover?.hold(coverSubtitleMode === 'strip' ? subtitleContainer : null)) return;
  if (!subtitlePosition) return;
  const bounds = subtitleBounds(subtitleContainer);
  if (bounds && subtitleAnchor) {
    const halfWidth = Math.min((subtitleContainer.offsetWidth || 0) / 2, bounds.width / 2);
    const maxTop = Math.max(0, bounds.height - (subtitleContainer.offsetHeight || 0) - 8);
    subtitlePosition = {
      centerX: bounds.x + Math.min(bounds.width - halfWidth, Math.max(halfWidth, subtitleAnchor.x * bounds.width)),
      top: bounds.y + Math.min(maxTop, Math.max(0, subtitleAnchor.y * bounds.height))
    };
  }
  Object.assign(subtitleContainer.style, {
    left: `${subtitlePosition.centerX}px`, top: `${subtitlePosition.top}px`,
    bottom: 'auto', transform: 'translateX(-50%)'
  });
}
function subtitlePoint(container, clientX, clientY) {
  const parent = container.offsetParent;
  if (!parent) return { x: clientX + window.scrollX, y: clientY + window.scrollY };
  const rect = parent.getBoundingClientRect();
  const scaleX = rect.width / parent.offsetWidth || 1;
  const scaleY = rect.height / parent.offsetHeight || 1;
  return {
    x: (clientX - rect.left) / scaleX - parent.clientLeft + parent.scrollLeft,
    y: (clientY - rect.top) / scaleY - parent.clientTop + parent.scrollTop
  };
}
function attachSubtitleDrag(container) {
  // Bind to the persistent container so replacing caption text cannot end a drag.
  if (dragEvents && !dragEvents.signal.aborted) return;
  dragEvents = new AbortController();
  const options = { signal: dragEvents.signal };
  let dragging = null;
  let suppressClick = false;
  container.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.isPrimary === false || !e.target.closest('#kageSubDrag')) return;
    const rect = container.getBoundingClientRect();
    const origin = subtitlePoint(container, rect.left + rect.width / 2, rect.top);
    const point = subtitlePoint(container, e.clientX, e.clientY);
    dragging = { id: e.pointerId, x: point.x - origin.x, y: point.y - origin.y };
    rememberSubtitlePosition({ centerX: origin.x, top: origin.y });
    positionSubtitles();
    container.setPointerCapture(e.pointerId);
    container.classList.add('kage-dragging');
    suppressClick = true;
    e.preventDefault(); e.stopPropagation();
  }, options);
  container.addEventListener('pointermove', e => {
    if (!dragging || e.pointerId !== dragging.id) return;
    const point = subtitlePoint(container, e.clientX, e.clientY);
    rememberSubtitlePosition({ centerX: point.x - dragging.x, top: point.y - dragging.y });
    positionSubtitles();
    e.preventDefault(); e.stopPropagation();
  }, options);
  const finish = e => {
    if (!dragging || (e.pointerId !== undefined && e.pointerId !== dragging.id)) return;
    const id = dragging.id;
    dragging = null;
    container.classList.remove('kage-dragging');
    if (container.hasPointerCapture(id)) container.releasePointerCapture(id);
  };
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) container.addEventListener(event, finish, options);
  window.addEventListener('blur', finish, options);
  container.addEventListener('click', e => {
    if (suppressClick || e.target.closest('#kageSubDrag')) { e.preventDefault(); e.stopPropagation(); }
    suppressClick = false;
  }, options);
}
function updateSaveLine() {
  const button = subtitleContainer?.querySelector('#kageSaveLine');
  if (!button) return;
  const saved = !!globalThis.KageSaved?.has(currentSubtitleText);
  const label = saved ? 'Remove this line from saved lines' : 'Save this line to replay later';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', String(saved));
}
// When this line starts and ends in the video, from the subtitle track when one is known.
function currentCueSpan() {
  const position = video?.currentTime || 0;
  const cues = (globalThis.KageImport?.track(video) || prefetchTrack)?.[1];
  const current = cues ? active(cues, position) : [];
  return current.length ? { start: Math.min(...current.map(c => c.start)), end: Math.max(...current.map(c => c.end)) }
    : { start: Math.max(0, position - 1), end: position + 5 };
}
function updateCoverToggle() {
  const button = subtitleContainer?.querySelector('#kageCoverToggle');
  if (!button) return;
  const on = !!globalThis.KageCover?.on;
  const label = on ? 'Remove the cover over embedded subtitles' : 'Cover subtitles embedded in the video';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', String(on));
}
function updateChineseVisibility() {
  if (!subtitleContainer) return;
  subtitleContainer.classList.toggle('kage-hide-chinese', chineseHidden);
  const button = subtitleContainer.querySelector('#kageChineseToggle');
  if (!button) return;
  const label = chineseHidden ? 'Show Chinese translation' : 'Hide Chinese translation';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', String(chineseHidden));
  button.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>
    ${chineseHidden ? '<path d="m3 3 18 18"/>' : ''}
  </svg>`;
}
function setEnabled(enabled) {
  isEnabled = enabled;
  if (!enabled) { resetBuffer(); globalThis.KagePreparation?.reset(); }
  document.body.classList.toggle('kage-enabled', enabled);
  clearSubtitle();
  if (enabled) sync();
}
// Kage reloaded itself after its files changed, and this page still runs the
// old scripts. Refresh now, or at the next pause so playback is not interrupted.
let updatePending = false;
function refreshForUpdate() {
  if (updatePending) return;
  updatePending = true;
  const playing = () => !!video && !video.paused && !video.ended;
  if (!playing()) { location.reload(); return; }
  const wait = setInterval(() => { if (!playing()) { clearInterval(wait); location.reload(); } }, 500);
}
chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'TOGGLE_STATE') setEnabled(message.enabled);
  if (message.type === 'KAGE_EXTENSION_UPDATED') refreshForUpdate();
  if (message.type === 'SUBTITLES_READY' && isEnabled && message.context === subtitleContext && Array.isArray(message.results)) {
    let updated = false;
    for (const result of message.results) {
      if (result && rememberTranslation(result.text, result.data) && result.text === currentSubtitleText) updated = true;
    }
    if (updated && subtitleContainer) {
      generation++;
      currentData = translationMemory.get(currentSubtitleText);
      renderCurrent();
    }
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.coverSubtitleMode) {
    coverSubtitleMode = changes.coverSubtitleMode.newValue === 'strip' ? 'strip' : 'separate';
    positionSubtitles();
  }
  if (changes.chineseHidden) {
    chineseHidden = changes.chineseHidden.newValue === true;
    updateChineseVisibility();
  }
  if (changes.autoTranslate || changes.apiEndpoint || changes.apiModel || changes.apiKey || changes.groqApiKey || changes.groqFallback || changes.detailedSubtitles) {
    translationVersion++;
    translationMemory.clear();
    resetBuffer();
  }
  if (changes.autoTranslate) autoTranslate = changes.autoTranslate.newValue !== 'false';
  if (changes.enabled) setEnabled(changes.enabled.newValue !== false);
  else if (changes.autoTranslate || changes.groqApiKey || changes.apiEndpoint || changes.apiModel || changes.apiKey || changes.groqFallback || changes.detailedSubtitles) { globalThis.KagePreparation?.reset(); clearSubtitle(); sync(); }
});

function nativeSubtitle() {
  // The site's selected track is authoritative. Intercepted tracks may be another language.
  const selectors = getPlatform() === 'netflix'
    ? ['.player-timedtext-text-container']
    : getPlatform() === 'bilibili'
      ? ['.bpx-player-subtitle-panel-text', '.bilibili-player-video-subtitle']
      : ['.ytp-caption-segment'];
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    const text = normalize(nodes.map(n => { if (!n.cloneNode) return n.textContent; const copy = n.cloneNode(true); copy.querySelectorAll('rt, rp').forEach(r => r.remove()); return copy.textContent; }).join(' '));
    if (text) return { text, id: text };
  }
  // HTML text tracks provide exact cue identity and follow seeks/pauses automatically.
  for (const track of Array.from(video?.textTracks || [])) {
    if (track.mode !== 'showing') continue;
    const cues = Array.from(track.activeCues || []);
    if (cues.length) return {
      text: normalize(cues.map(c => c.text).join(' ')),
      id: cues.map(c => `${c.startTime}:${c.endTime}:${c.text}`).join('|')
    };
  }
  return { text: '', id: '' };
}
function prefetch(text, preload = true) {
  if (!video) return;
  const position = video.currentTime;
  const imported = globalThis.KageImport?.track(video);
  const availableTracks = imported ? new Map([imported]) : tracks;
  let selected = imported || KageSubtitles.matchingTrack(availableTracks, position, text);
  // A nonempty player caption must match; metadata alone cannot identify the selected language.
  if (!imported && text && selected && normalize(active(selected[1], position).map(c => c.text).join('')).replace(/\s/g, '') !== text.replace(/\s/g, '')) selected = null;
  if (!imported && !text && prefetchBlocked) selected = null;
  if (!text && prefetchTrack && availableTracks.get(prefetchTrack[0]) === prefetchTrack[1]) selected = prefetchTrack;
  if (prefetchTrack && (!selected || selected[0] !== prefetchTrack[0])) resetBuffer();
  if (text) prefetchBlocked = !selected;
  prefetchTrack = selected;
  globalThis.KagePreparation?.setNativeAvailable(nativeChinese().available, imported
    ? globalThis.KageImport?.preparingChinese ? 'Preparing Traditional Chinese as part of this import. Progress is shown above.'
      : 'Imported Traditional Chinese is ready. Furigana runs locally; no translation preparation is needed.'
    : undefined);
  globalThis.KagePreparation?.observe(availableTracks, video, text, !!imported);
  if (!preload || globalThis.KagePreparation?.running || nativeChinese().available) return;
  if (selected) {
    const [url, cues] = selected;
    const index = cues.findIndex(c => c.start > position);
    if (index < 0) return;
    const key = `${url}:${index}`;
    if (key !== lastPrefetch) {
      lastPrefetch = key;
      const texts = [...new Set(cues.slice(index, index + 24).filter(c => c.start < position + 120).map(c => c.text))];
      chrome.runtime.sendMessage({ type: 'PRELOAD_TRACK', texts, context: subtitleContext, ...(imported ? { localOnly: true } : {}) }).catch(() => {});
    }
    return;
  }
}
function sync() {
  if (page !== location.href) {
    page = location.href;
    tracks.clear();
    resetBuffer();
    globalThis.KagePreparation?.reset();
    netflixStatus = 'Checking Netflix subtitle tracks…';
    globalThis.KageTutor?.sourceStatus(netflixStatus);
    clearSubtitle();
    window.postMessage({ type: 'KAGE_TRACKS_READY' }, location.origin);
  }
  const nextVideo = Array.from(document.querySelectorAll('video')).find(v => v.getBoundingClientRect().width > 0) || null;
  if (nextVideo !== video) {
    videoEvents?.abort();
    videoEvents = new AbortController();
    if (video) resetBuffer();
    video = nextVideo;
    wasSeeking = false;
    clearSubtitle();
    if (video) {
      video.addEventListener('seeking', sync, { signal: videoEvents.signal });
      // The words clicked during the video are waiting in the Review tab.
      video.addEventListener('ended', () => { if (isEnabled && globalThis.KageWords?.waiting()) globalThis.KageTutor?.openReview?.(); }, { signal: videoEvents.signal });
      for (const event of ['seeked', 'timeupdate', 'loadedmetadata', 'emptied']) video.addEventListener(event, sync, { signal: videoEvents.signal });
    }
  }
  // The cover stays up between lines; embedded subtitles do not follow Kage's timing.
  globalThis.KageCover?.update(isEnabled && video
    ? document.fullscreenElement || video.closest('.watch-video--player-view, .html5-video-player, .bpx-player-container, .bilibili-player-video-wrap') || video.parentElement
    : null);
  globalThis.KageSaved?.observe(isEnabled ? video : null);
  globalThis.KageWords?.observe((globalThis.KageImport?.track(video) || prefetchTrack)?.[1] || null);
  if (video?.seeking && !wasSeeking) resetBuffer();
  wasSeeking = !!video?.seeking;
  globalThis.KageImport?.observe(video);
  if (getPlatform() === 'bilibili' || getPlatform() === 'youtube') globalThis.KageTutor?.sourceStatus(globalThis.KageImport?.track(video)
    ? globalThis.KageImport?.preparingChinese ? 'Japanese subtitles are ready. The local helper is preparing Traditional Chinese automatically.'
      : nativeChinese().available ? 'Imported Japanese and Traditional Chinese subtitles · saved on this device.'
        : 'Imported Japanese subtitles · local Chinese translation. Whole track prepares translations for older imports.'
    : 'Use the player’s Japanese subtitles, or import this video’s audio to generate a local subtitle track.');
  if (!isEnabled || !video || video.seeking || video.readyState === 0) {
    if (activeIdentity || subtitleContainer) clearSubtitle();
    return;
  }
  const { text, id } = globalThis.KageImport?.current(video) ?? nativeSubtitle();
  if (!text) { if (activeIdentity || subtitleContainer) clearSubtitle(); prefetch(''); return; }
  prefetch(text, false);
  const target = document.fullscreenElement || video.closest('.watch-video--player-view, .html5-video-player, .bpx-player-container, .bilibili-player-video-wrap') || video.parentElement;
  // Fullscreen can change the containing block while the same caption is paused.
  if (subtitleContainer) { createSubtitleContainer(target); positionSubtitles(); }
  if (id === activeIdentity && subtitleContainer?.isConnected) { renderCurrent(); prefetch(text); return; }
  activeIdentity = id;
  currentSubtitleText = text;
  processAndRenderSubtitle(text, target);
  prefetch(text);
}
function nativeChinese() {
  const imported = globalThis.KageImport?.chinese?.(video);
  if (imported?.available) return imported;
  if (globalThis.KageImport?.preparingChinese && globalThis.KageImport?.track(video)) return { available: true, text: '', pending: true };
  if (getPlatform() !== 'netflix') return { available: false, text: '' };
  for (const cues of tracks.values()) {
    if (cues.language === 'zh-Hant') return {
      available: true,
      text: normalize(active(cues, video?.currentTime || 0).map(c => c.text).join(' '))
    };
  }
  return { available: false, text: '' };
}
function renderCurrent() {
  if (!currentData || !subtitleContainer) return;
  const chinese = nativeChinese();
  const localChunks = globalThis.KageReadings?.chunks(currentSubtitleText);
  const data = { ...currentData, chunks: localChunks ? localChunks.map(chunk => {
    const aiChunk = currentData.chunks?.find(candidate => candidate.japanese === chunk.japanese);
    const learning = !!chunk.word && !!globalThis.KageWords?.learning(chunk.base);
    const known = !learning && !!chunk.word && !!globalThis.KageWords?.has(chunk.base);
    // A known word needs no reading; a word being learned is highlighted.
    return { ...chunk, furigana: known ? '' : chunk.furigana || aiChunk?.furigana || '', translation: aiChunk?.translation || '',
      ...(known ? { known: true } : {}), ...(learning ? { learning: true } : {}) };
  }) : currentData.chunks };
  // The line as heard in the audio picks among the readings the dictionary knows for each word.
  if (localChunks && globalThis.KageHeard) {
    const runs = globalThis.KageImport?.heard?.(video) || [];
    if (runs.length) globalThis.KageHeard.apply(data.chunks, runs, word => globalThis.KageReadings?.alternatives?.(word) || []);
  }
  // Where the helper heard a different reading in the audio, it replaces the dictionary's.
  const heard = localChunks ? globalThis.KageImport?.readings?.(video) || [] : [];
  if (heard.length) {
    let offset = 0;
    for (const chunk of data.chunks) {
      const start = offset, end = offset + chunk.japanese.length;
      offset = end;
      for (const fix of heard) {
        const tail = fix.end < end ? chunk.japanese.slice(fix.end - start) : '';
        if (fix.start === start && !chunk.known && /^[ぁ-ゖァ-ヶー]*$/.test(tail)) chunk.furigana = fix.reading + KageReadings.hiragana(tail);
        else if (fix.start < start && fix.end > start) chunk.furigana = ''; // Covered by the reading on the word's first part.
      }
    }
  }
  if (chinese.available) { data.sentence_translation = chinese.text; data.translation_status = chinese.pending ? '正在本機準備繁體中文字幕…' : ''; }
  data.reading_status = globalThis.KageReadings?.state === 'loading' ? '正在載入本機注音字典…'
    : globalThis.KageReadings?.state === 'error' ? '讀音字典載入失敗，請重新整理頁面。' : '';
  const signature = JSON.stringify(data);
  if (signature !== renderedSignature) {
    renderedSignature = signature;
    renderParsedData(data);
  }
  const imported = !!globalThis.KageImport?.track(video);
  globalThis.KageTutor?.update(currentSubtitleText, data, imported ? 'Imported audio · local translation' : chinese.available ? 'Netflix · 繁體中文' : '本機模型翻譯', imported);
}
async function processAndRenderSubtitle(text, target) {
  const request = ++generation;
  const version = translationVersion;
  const context = subtitleContext;
  createSubtitleContainer(target);
  const needsTranslation = /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
  currentData = translationMemory.get(text) || { chunks: [{ japanese: text }], translation_status: needsTranslation ? '正在翻譯…可在字幕面板預先準備。' : '' };
  renderedSignature = '';
  renderCurrent();
  globalThis.KageWords?.sighted(text);
  if (!needsTranslation || nativeChinese().available || translationMemory.has(text)) { clearDemand(); return; }
  try {
    const response = await chrome.runtime.sendMessage({ type: 'PROCESS_SUBTITLE', text, context, ...(globalThis.KageImport?.track(video) ? { localOnly: true } : {}) });
    if (response?.success && version === translationVersion && context === subtitleContext) rememberTranslation(text, response.data);
    sync();
    if (!isEnabled || request !== generation || context !== subtitleContext || !subtitleContainer) return;
    if (!response?.success) {
      currentData = { chunks: [{ japanese: text }], translation_status: `翻譯失敗：${response?.error || '請檢查本機模型設定。'}` };
    } else {
      currentData = { ...response.data };
      if (normalize(currentData.chunks?.map(c => c.japanese).join('')).replace(/\s/g, '') !== text.replace(/\s/g, '')) currentData.chunks = [{ japanese: text }];
    }
    renderCurrent();
  } catch {
    sync();
    if (isEnabled && request === generation && context === subtitleContext && subtitleContainer) {
      currentData = { chunks: [{ japanese: text }], translation_status: '無法連線至翻譯服務，請重新載入擴充功能與影片頁面。' };
      renderCurrent();
    }
  }
}

window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.page !== location.href) return;
  if (event.data.type === 'KAGE_NETFLIX_STATUS') {
    netflixStatus = String(event.data.status || '');
    globalThis.KageTutor?.sourceStatus(netflixStatus);
    return;
  }
  if (event.data.type !== 'KAGE_RAW_SUBTITLES') return;
  if (event.data.page !== location.href || typeof event.data.text !== 'string' || event.data.text.length > 2000000) return;
  try {
    if (page !== location.href) sync();
    if (getPlatform() === 'youtube') {
      const captionURL = new URL(event.data.url);
      if (captionURL.hostname.endsWith('.youtube.com') && captionURL.pathname === '/api/timedtext'
          && /^ja(?:-|$)/i.test(captionURL.searchParams.get('lang') || '') && !captionURL.searchParams.has('tlang')) {
        globalThis.KageImport?.captionSource?.(captionURL.searchParams.get('kind') === 'asr' ? 'asr' : 'manual');
      }
    }
    const cues = parse(event.data.text);
    if (cues.length) {
      if (page !== location.href) sync();
      cues.language = event.data.language;
      tracks.set(event.data.url, cues);
      if (cues.language === 'zh-Hant') {
        netflixStatus = 'Netflix 繁體中文字幕已就緒 · 無需模型翻譯';
        globalThis.KageTutor?.sourceStatus(netflixStatus);
        globalThis.KagePreparation?.setNativeAvailable(true);
        clearDemand();
        chrome.runtime.sendMessage({ type: 'CLEAR_PREFETCH' }).catch(() => {});
      }
      if (tracks.size > 8) tracks.delete(tracks.keys().next().value);
      if (isEnabled) sync();
    }
  } catch { /* Unsupported subtitle formats retain native DOM synchronization. */ }
});
window.postMessage({ type: 'KAGE_TRACKS_READY' }, location.origin);
window.addEventListener('kage-words-change', () => { renderedSignature = ''; renderCurrent(); });
window.addEventListener('kage-saved-change', updateSaveLine);
window.addEventListener('kage-readings-change', () => { renderedSignature = ''; renderCurrent(); });
window.addEventListener('kage-import-change', () => {
  translationVersion++;
  translationMemory.clear();
  resetBuffer();
  globalThis.KagePreparation?.reset();
  clearSubtitle();
  sync();
});

// Native Chinese cue boundaries can fall between the browser's timeupdate events.
function syncChineseFrame() {
  if (isEnabled && video && !video.paused && !video.seeking && globalThis.KageImport?.track(video)) {
    const cue = KageImport.current(video);
    if (cue && cue.id !== activeIdentity) sync();
  }
  if (isEnabled && video && !video.paused && !video.seeking && currentData) {
    const chinese = nativeChinese();
    const key = chinese.available ? chinese.text : '';
    if (key !== lastChineseFrame) { lastChineseFrame = key; renderCurrent(); }
  }
  requestAnimationFrame(syncChineseFrame);
}

async function init() {
  const state = await chrome.storage.local.get(['enabled', 'autoTranslate', 'chineseHidden', 'coverSubtitleMode']);
  coverSubtitleMode = state.coverSubtitleMode === 'strip' ? 'strip' : 'separate';
  autoTranslate = state.autoTranslate !== 'false';
  chineseHidden = state.chineseHidden === true;
  setEnabled(state.enabled !== false);
  document.addEventListener('fullscreenchange', () => {
    sync();
    requestAnimationFrame(sync); // Recheck after the player's fullscreen styles settle.
  });
  window.addEventListener('resize', sync);
  // Ignore our own renders to avoid observer feedback loops.
  subtitleObserver = new MutationObserver(mutations => {
    if (mutations.some(m => !(m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest('.kage-subtitle-container, .kage-ai-widget'))) sync();
  });
  subtitleObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  // Native DOM mutations and video events drive captions; this only detects SPA/player replacement.
  setInterval(sync, 500);
  requestAnimationFrame(syncChineseFrame);
}

function renderParsedData(data) {
  if (!subtitleContainer) return;

  const chunks = data.chunks || [];
  const sentenceTranslation = data.sentence_translation || "";

  // Construct HTML
  let html = `<div class="kage-pills-wrapper">`;

  // Japanese Pill
  html += `<div class="kage-japanese-row"><div class="kage-pill kage-japanese-pill"><div class="kage-japanese">`;
  for (const chunk of chunks) {
    const japanese = escapeHTML(chunk.japanese);
    const furigana = escapeHTML(chunk.furigana);
    const translation = escapeHTML(chunk.translation);

    // Simple heuristic: if it has kanji/katakana and is longer than 1 char, highlight it yellow like the screenshot
    const isHighlight = japanese.length > 1 && !/^[ぁ-ん]+$/.test(japanese);

    const word = chunk.word && globalThis.KageWords ? ` kage-word${chunk.known ? ' kage-known' : chunk.learning ? ' kage-learning' : ''}" data-base="${escapeHTML(chunk.base)}" title="${chunk.learning ? 'You are learning this word. Click when you know it' : chunk.known ? 'Counted as known. Click if you need its reading' : 'Click if you don’t know this word'}` : '';
    html += `<span class="kage-chunk ${isHighlight ? 'highlight' : ''}${word}">`;
    if (furigana) {
      html += `<ruby>${japanese}<rt>${furigana}</rt></ruby>`;
    } else {
      html += `<span>${japanese}</span>`;
    }

    if (translation) {
      html += `
        <span class="kage-tooltip">
          <span class="kage-tooltip-headword">${japanese}</span>
          <span class="kage-tooltip-meaning">${translation}</span>
        </span>
      `;
    }
    html += `</span>`;
  }
  html += `</div></div>`;
  html += `
    <div class="kage-subtitle-controls">
    <div class="kage-drag-handle" id="kageSubDrag" title="Drag to move subtitles" aria-label="Drag to move subtitles">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/>
        <circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>
      </svg>
    </div>
    <button type="button" class="kage-chinese-toggle" id="kageChineseToggle"></button>
    ${globalThis.KageSaved ? `<button type="button" class="kage-cover-toggle" id="kageSaveLine"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1Z"/></svg></button>` : ''}
    ${globalThis.KageCover ? `<button type="button" class="kage-cover-toggle" id="kageCoverToggle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18"/><path d="M7 17h10"/></svg></button>` : ''}
    </div>
  `;
  html += `</div>`;

  if (data.translation_status && autoTranslate) {
    html += `<div class="kage-pill kage-chinese-pill"><div class="kage-translation-status" role="status">${escapeHTML(data.translation_status)}</div></div>`;
  }

  if (data.reading_status) html += `<div class="kage-reading-status" role="status">${escapeHTML(data.reading_status)}</div>`;

  // Translation Pill
  if (sentenceTranslation && autoTranslate) {
    html += `<div class="kage-pill kage-chinese-pill"><div class="kage-translation">${escapeHTML(sentenceTranslation)}</div></div>`;
  }

  html += `</div>`; // end wrapper

  subtitleContainer.innerHTML = html;
  updateChineseVisibility();
  const chineseToggle = subtitleContainer.querySelector('#kageChineseToggle');
  // Keep player click and keyboard shortcuts from firing while using this control.
  for (const event of ['pointerdown', 'mousedown', 'keydown', 'keyup']) chineseToggle.addEventListener(event, e => e.stopPropagation());
  chineseToggle.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    chineseHidden = !chineseHidden;
    updateChineseVisibility();
    chrome.storage.local.set({ chineseHidden }).catch(() => {});
  });
  for (const word of globalThis.KageWords ? subtitleContainer.querySelectorAll('.kage-word') : []) {
    // The player must not treat marking a word as a click on the video.
    for (const event of ['pointerdown', 'mousedown']) word.addEventListener(event, e => e.stopPropagation());
    word.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      globalThis.KageWords.toggle(word.dataset.base, { text: currentSubtitleText, translation: data.sentence_translation || '', ...currentCueSpan() });
    });
  }
  const saveLine = subtitleContainer.querySelector('#kageSaveLine');
  if (saveLine) {
    updateSaveLine();
    for (const event of ['pointerdown', 'mousedown', 'keydown', 'keyup']) saveLine.addEventListener(event, e => e.stopPropagation());
    saveLine.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const span = currentCueSpan();
      globalThis.KageSaved.toggle({ text: currentSubtitleText, translation: data.sentence_translation || '', ...span });
      updateSaveLine();
    });
  }
  const coverToggle = subtitleContainer.querySelector('#kageCoverToggle');
  if (coverToggle) {
    updateCoverToggle();
    for (const event of ['pointerdown', 'mousedown', 'keydown', 'keyup']) coverToggle.addEventListener(event, e => e.stopPropagation());
    coverToggle.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      globalThis.KageCover.toggle();
      updateCoverToggle();
      positionSubtitles();
    });
  }
  positionSubtitles();
  attachSubtitleDrag(subtitleContainer);
}


// --- Sparkle AI UI ---
// The panel module owns its UI and events; the caption renderer owns playback state.
globalThis.KageTutor?.mount();
globalThis.KageTutor?.sourceStatus(getPlatform() === 'netflix' ? netflixStatus : 'Local translation is active. Netflix can also supply an existing Traditional Chinese subtitle track.');
globalThis.KagePreparation?.mount(document.querySelector('.kage-chat-panel'));
globalThis.KageReadings?.ready.then(() => { renderedSignature = ''; renderCurrent(); });
init();
