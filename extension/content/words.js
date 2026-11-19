// Word tracking without marking everything. You click only the words you do
// not know; those are highlighted, keep their furigana, and are collected for a
// short review at the end of the video. A word that has gone past several
// times without a click is taken as known and loses its furigana.
// Words are stored by dictionary form, so 食べた and 食べる count as one word.
(() => {
  const KEY = 'kageWordsV2';
  const OLD_KEY = 'kageKnownWordsV1';
  const SIGHTINGS = 5; // Unclicked sightings before a word counts as known.
  const KNOWN_LIMIT = 50000, LEARNING_LIMIT = 2000, SEEN_LIMIT = 20000;
  let known = new Set();
  let learning = new Map(); // base -> where it was clicked: { key, title, text, translation, start, end, added, reviewed }
  let seen = new Map(); // base -> sightings so far, for words not yet known
  const counted = new Set(); // Lines already counted on this page.
  let cues = null, stats = null, countNode = null, videoNode = null, review = null, pending = null, saving = null, lastWrite = '';
  const pageKey = () => globalThis.KageSaved?.pageKey?.() || location.href;
  function coverage(texts) {
    let total = 0, hit = 0;
    const fresh = new Set();
    for (const text of texts) {
      for (const chunk of globalThis.KageReadings?.chunks(text) || []) {
        if (!chunk.word) continue;
        total++;
        if (known.has(chunk.base)) hit++; else fresh.add(chunk.base);
      }
    }
    return { total, known: hit, fresh: fresh.size };
  }
  function snapshot() {
    return { known: [...known], learning: Object.fromEntries(learning), seen: Object.fromEntries(seen) };
  }
  function write() {
    saving = null;
    const value = snapshot();
    lastWrite = JSON.stringify(value);
    try { chrome.storage.local.set({ [KEY]: value }).catch(() => {}); } catch { /* Reloaded extension: kept for this page. */ }
  }
  // Clicks save at once; sightings arrive with every line, so they are batched.
  function save(soon = false) {
    if (!soon) { if (saving !== null) clearTimeout(saving); write(); return; }
    if (saving === null) saving = setTimeout(write, 3000);
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function button(text, handler, className = 'kage-text-button') {
    const element = node('button', className, text);
    element.type = 'button';
    element.addEventListener('click', handler);
    return element;
  }
  function row(base, context, current) {
    const item = node('div', 'kage-word-row');
    const head = node('div', 'kage-word-head');
    const word = node('span', 'kage-word-base', base); word.lang = 'ja';
    head.append(word);
    if (Number.isFinite(context.start)) {
      head.append(current
        ? button('Replay', () => globalThis.KageSaved?.replay?.(context.start, context.end))
        : button('Open video', () => { location.href = `${context.key}#kage-t=${Math.max(0, Math.floor(context.start))}`; }));
    }
    item.append(head);
    if (context.text) { const line = node('p', 'kage-word-line', context.text); line.lang = 'ja'; item.append(line); }
    if (context.translation) { const meaning = node('p', 'kage-word-meaning', context.translation); meaning.lang = 'zh-Hant'; item.append(meaning); }
    const actions = node('div', 'kage-word-actions');
    actions.append(button('Got it', () => { learning.delete(base); if (known.size < KNOWN_LIMIT) known.add(base); save(); changed(); }, 'kage-word-done'));
    if (!context.reviewed) actions.append(button('Still learning', () => { context.reviewed = Date.now(); save(); render(); }, 'kage-word-keep'));
    item.append(actions);
    return item;
  }
  function render() {
    if (!stats) return;
    countNode.textContent = `${learning.size} to learn · ${known.size} known`;
    const result = cues?.length ? coverage(cues.map(cue => cue.text)) : null;
    videoNode.textContent = !result?.total ? 'Open a video with subtitles to see how much of it you already know.'
      : `This video: you know ${Math.round(result.known / result.total * 100)}% of its words.`;
    const key = pageKey();
    const entries = [...learning].sort((a, b) => (b[1].added || 0) - (a[1].added || 0));
    const fresh = entries.filter(([, context]) => context.key === key && !context.reviewed);
    const rest = entries.filter(([, context]) => !(context.key === key && !context.reviewed));
    const parts = [];
    if (fresh.length) parts.push(node('h4', 'kage-saved-heading', 'From this video'), ...fresh.map(([base, context]) => row(base, context, true)));
    if (rest.length) parts.push(node('h4', 'kage-saved-heading', 'Still learning'), ...rest.slice(0, 100).map(([base, context]) => row(base, context, context.key === key)));
    if (!parts.length) parts.push(node('p', 'kage-import-hint', 'No words to review. Click a word in Kage’s subtitle when you don’t know it, and it will wait for you here with its line.'));
    review.replaceChildren(...parts);
  }
  function schedule() {
    if (pending !== null || !stats) return;
    pending = setTimeout(() => { pending = null; render(); }, 300);
  }
  function changed() {
    window.dispatchEvent(new CustomEvent('kage-words-change'));
    schedule();
  }
  globalThis.KageWords = {
    has: base => known.has(base),
    learning: base => learning.has(base),
    // A click on a word: unknown words start being learned; a word being learned is now known.
    toggle(base, context = {}) {
      if (typeof base !== 'string' || !base) return false;
      if (learning.has(base)) {
        learning.delete(base);
        if (known.size < KNOWN_LIMIT) known.add(base);
      } else {
        known.delete(base); seen.delete(base);
        if (learning.size >= LEARNING_LIMIT) learning.delete(learning.keys().next().value);
        learning.set(base, { key: pageKey(), title: String(document.title || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          text: String(context.text || '').slice(0, 500), translation: String(context.translation || '').slice(0, 500),
          ...(Number.isFinite(context.start) ? { start: Math.max(0, context.start), end: Number.isFinite(context.end) && context.end > context.start ? context.end : context.start + 6 } : {}),
          added: Date.now() });
      }
      save(); changed();
      return learning.has(base);
    },
    // A line was shown. Each of its words that was not clicked moves one step toward known.
    sighted(text) {
      if (typeof text !== 'string' || counted.has(text)) return;
      const chunks = globalThis.KageReadings?.chunks(text);
      if (!chunks) return; // The dictionary is still loading; the line will be counted another time.
      counted.add(text);
      if (counted.size > 5000) counted.delete(counted.values().next().value);
      let promoted = false;
      for (const base of new Set(chunks.filter(chunk => chunk.word).map(chunk => chunk.base))) {
        if (known.has(base) || learning.has(base)) continue;
        const count = (seen.get(base) || 0) + 1;
        if (count >= SIGHTINGS && known.size < KNOWN_LIMIT) { seen.delete(base); known.add(base); promoted = true; }
        else {
          seen.set(base, count);
          if (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value);
        }
      }
      save(true);
      // The line on screen keeps its furigana; the word is plain from its next appearance.
      if (promoted) schedule();
    },
    // Words clicked in this video that have not been reviewed yet.
    waiting() {
      const key = pageKey();
      return [...learning.values()].filter(context => context.key === key && !context.reviewed).length;
    },
    get size() { return known.size; },
    coverage,
    // Called on every sync with the current subtitle track (or null).
    observe(list) {
      if (list === cues) return;
      cues = list || null;
      schedule();
    },
    mount(slot) {
      if (!slot || stats) return;
      stats = node('section', 'kage-source-card kage-words-card');
      countNode = node('h3');
      videoNode = node('p'); videoNode.setAttribute('role', 'status');
      stats.append(node('span', 'kage-eyebrow', 'Words'), countNode, videoNode,
        node('p', 'kage-import-hint', `Click a word you don’t know. It is highlighted and kept for review. Words you pass ${SIGHTINGS} times without clicking count as known and lose their furigana; click one to get its reading back.`));
      const card = node('section', 'kage-source-card kage-review-card');
      review = node('div', 'kage-word-list');
      card.append(node('span', 'kage-eyebrow', 'Word review'), review);
      slot.append(stats, card);
      render();
    }
  };
  function read(value, old) {
    const state = value && typeof value === 'object' ? value : {};
    const strings = list => (Array.isArray(list) ? list : []).filter(item => typeof item === 'string' && item);
    // Words marked as known in the first version stay known.
    known = new Set([...strings(state.known), ...strings(old)].slice(0, KNOWN_LIMIT));
    learning = new Map(Object.entries(state.learning && typeof state.learning === 'object' ? state.learning : {})
      .filter(([base, context]) => base && context && typeof context === 'object').slice(-LEARNING_LIMIT));
    seen = new Map(Object.entries(state.seen && typeof state.seen === 'object' ? state.seen : {})
      .filter(([base, count]) => base && Number.isFinite(count) && !known.has(base)).slice(-SEEN_LIMIT));
    for (const base of learning.keys()) known.delete(base);
  }
  try {
    chrome.storage.local.get([KEY, OLD_KEY]).then(state => { read(state[KEY], state[OLD_KEY]); changed(); }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      // Another tab changed the words; this tab's own write comes back unchanged.
      if (area === 'local' && changes[KEY] && JSON.stringify(changes[KEY].newValue) !== lastWrite) { read(changes[KEY].newValue); changed(); }
    });
  } catch { /* Reloaded extension: this page keeps what it has. */ }
  globalThis.KageReadings?.ready?.then(schedule);
})();
