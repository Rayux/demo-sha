// Lines you saved while watching, replayed from the original video instead of
// reviewed as cards. Each line remembers its video and its time in that video.
(() => {
  const KEY = 'kageSavedLinesV1';
  const LIMIT = 500;
  const SEEK = /[#&]kage-t=(\d+(?:\.\d+)?)/;
  let lines = [], video = null, list = null, status = null, playAll = null;
  let playing = null; // { queue, index } while saved clips are being replayed
  let shownKey = '';
  let pendingSeek = SEEK.exec(location.hash)?.[1];
  // One identity per video: tracking parameters must not split a video's lines.
  function pageKey(href = location.href) {
    try {
      const url = new URL(href);
      const keep = new URLSearchParams();
      for (const name of ['v', 'p']) if (url.searchParams.get(name)) keep.set(name, url.searchParams.get(name));
      const query = keep.toString();
      return `${url.origin}${url.pathname.replace(/\/$/, '')}${query ? `?${query}` : ''}`;
    } catch { return ''; }
  }
  const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  const here = () => lines.filter(line => line.key === pageKey()).sort((a, b) => a.start - b.start);
  function persist() {
    try { chrome.storage.local.set({ [KEY]: lines }).catch(() => {}); } catch { /* Reloaded extension: kept for this page. */ }
  }
  function changed() {
    window.dispatchEvent(new CustomEvent('kage-saved-change'));
    render();
  }
  function stop(message = '') {
    playing = null;
    if (status) status.textContent = message;
    if (playAll) playAll.textContent = 'Play all';
  }
  function playAt(index) {
    const line = playing?.queue[index];
    if (!line || !video) { stop(); return; }
    playing.index = index;
    video.currentTime = line.start;
    Promise.resolve(video.play?.()).catch(() => {});
    if (status) status.textContent = playing.queue.length > 1 ? `Playing saved line ${index + 1} of ${playing.queue.length}` : 'Playing saved line';
    if (playAll) playAll.textContent = 'Stop';
  }
  // Follows playback: the end of a clip pauses the video or starts the next one.
  function tick() {
    if (!playing || !video) return;
    const line = playing.queue[playing.index];
    const time = video.currentTime;
    // Seeking somewhere else means the viewer took over.
    if (time < line.start - 1.5 || time > line.end + 1.5) { stop(); return; }
    if (time < line.end) return;
    if (playing.index + 1 < playing.queue.length) playAt(playing.index + 1);
    else { video.pause?.(); stop(); }
  }
  function play(queue) {
    if (!video || !queue.length) return;
    playing = { queue, index: 0 };
    playAt(0);
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function row(line, current) {
    const item = node('div', 'kage-saved-line');
    const open = node('button', 'kage-saved-open');
    open.type = 'button';
    const japanese = node('span', 'kage-saved-jp', line.text); japanese.lang = 'ja';
    open.append(japanese);
    if (line.translation) { const chinese = node('span', 'kage-saved-zh', line.translation); chinese.lang = 'zh-Hant'; open.append(chinese); }
    open.append(node('span', 'kage-saved-time', clock(line.start)));
    open.setAttribute('aria-label', `${current ? 'Play' : 'Open'} saved line at ${clock(line.start)}: ${line.text}`);
    open.addEventListener('click', () => {
      if (current) play([line]);
      else location.href = `${line.key}#kage-t=${Math.max(0, Math.floor(line.start))}`;
    });
    const remove = node('button', 'kage-saved-remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove saved line: ${line.text}`);
    remove.title = 'Remove';
    remove.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    remove.addEventListener('click', () => { lines = lines.filter(other => other.id !== line.id); persist(); changed(); });
    item.append(open, remove);
    return item;
  }
  function render() {
    shownKey = pageKey();
    if (!list) return;
    const current = here();
    const groups = new Map();
    for (const line of lines) {
      if (line.key === pageKey()) continue;
      if (!groups.has(line.key)) groups.set(line.key, []);
      groups.get(line.key).push(line);
    }
    const parts = [];
    if (current.length) {
      parts.push(node('h4', 'kage-saved-heading', 'This video'), ...current.map(line => row(line, true)));
    }
    for (const group of [...groups.values()].sort((a, b) => Math.max(...b.map(line => line.savedAt)) - Math.max(...a.map(line => line.savedAt)))) {
      group.sort((a, b) => a.start - b.start);
      parts.push(node('h4', 'kage-saved-heading', group[0].title || 'Another video'), ...group.map(line => row(line, false)));
    }
    if (!parts.length) parts.push(node('p', 'kage-import-hint', 'Nothing saved yet. Hover Kage’s subtitle and choose the bookmark to keep a line. Saved lines replay from the video itself.'));
    list.replaceChildren(...parts);
    playAll.hidden = !current.length;
  }
  globalThis.KageSaved = {
    pageKey,
    has: text => lines.some(line => line.key === pageKey() && line.text === text),
    // Saves the line, or removes it if this video already has it.
    toggle({ text, translation = '', start, end }) {
      const key = pageKey();
      if (!key || typeof text !== 'string' || !text.trim() || !Number.isFinite(start)) return false;
      const existing = lines.find(line => line.key === key && line.text === text);
      if (existing) lines = lines.filter(line => line !== existing);
      else {
        const finish = Number.isFinite(end) && end > start ? end : start + 6;
        lines.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, key,
          title: String(document.title || '').replace(/\s+/g, ' ').trim().slice(0, 120), text: text.slice(0, 500),
          translation: String(translation || '').slice(0, 500), start: Math.max(0, start), end: finish, savedAt: Date.now() });
        // The oldest lines make room once the limit is reached.
        if (lines.length > LIMIT) lines = lines.sort((a, b) => a.savedAt - b.savedAt).slice(-LIMIT);
      }
      persist(); changed();
      return !existing;
    },
    // Plays one stretch of this video and pauses at its end.
    replay(start, end) { if (Number.isFinite(start) && Number.isFinite(end) && end > start) play([{ start, end }]); },
    // Called on every sync with the page's video (or null).
    observe(next) {
      // A new video, or a new page in the same tab, starts a fresh list.
      if (next !== video || pageKey() !== shownKey) { video = next || null; stop(); render(); }
      if (video && pendingSeek !== undefined && video.readyState > 0) {
        // Opened from a saved line in another video: start at that line.
        video.currentTime = Number(pendingSeek);
        pendingSeek = undefined;
      }
      tick();
    },
    mount(slot) {
      if (!slot || list) return;
      const card = node('section', 'kage-source-card kage-saved-card');
      const top = node('div', 'kage-card-top');
      top.append(node('span', 'kage-eyebrow', 'Saved lines'));
      playAll = node('button', 'kage-text-button', 'Play all'); playAll.type = 'button';
      playAll.addEventListener('click', () => { if (playing) { video?.pause?.(); stop(); } else play(here()); });
      top.append(playAll);
      status = node('p', 'kage-import-hint'); status.setAttribute('role', 'status');
      list = node('div', 'kage-saved-list');
      card.append(top, status, list);
      slot.appendChild(card);
      render();
    }
  };
  function read(value) {
    lines = (Array.isArray(value) ? value : []).filter(line => line && typeof line.id === 'string' && typeof line.key === 'string'
      && typeof line.text === 'string' && Number.isFinite(line.start) && Number.isFinite(line.end)).slice(-LIMIT);
  }
  try {
    chrome.storage.local.get(KEY).then(state => { read(state[KEY]); changed(); }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) { read(changes[KEY].newValue); changed(); }
    });
  } catch { /* Reloaded extension: this page keeps what it has. */ }
})();
