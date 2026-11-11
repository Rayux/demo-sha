// A strip over the lower part of the video that hides subtitles embedded in the
// picture. The strip itself lets clicks through to the player; only its top
// edge (resize) and its grip (move) take the pointer.
(() => {
  const KEY = `kageCoverStripV1:${location.hostname.replace(/^www\./, '')}`;
  const MIN_HEIGHT = 0.04, STEP = 0.01;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const state = { on: false, top: 0.8, height: 0.14 };
  let strip = null, grip = null, edge = null, target = null, held = null;
  function read(saved) {
    if (!saved || typeof saved !== 'object') return;
    state.on = saved.on === true;
    if (Number.isFinite(saved.height)) state.height = clamp(saved.height, MIN_HEIGHT, 1);
    if (Number.isFinite(saved.top)) state.top = clamp(saved.top, 0, 1 - state.height);
  }
  function save() {
    try { chrome.storage.local.set({ [KEY]: { ...state } }).catch(() => {}); } catch { /* Reloaded extension: keep this page's strip. */ }
  }
  function apply() {
    if (!strip) return;
    const visible = state.on && !!target;
    if (visible && strip.parentNode !== target) target.appendChild(strip);
    if (!visible && strip.parentNode) strip.remove();
    let top = state.top, height = state.height;
    if (held && !(visible && held.isConnected !== false)) release();
    if (held) {
      // Grow upward when a line needs more room than the strip has; the bottom
      // stays where it was put. The saved height is not changed.
      const size = target.getBoundingClientRect().height || 1;
      const needed = Math.min(1, ((held.offsetHeight || 0) + 12) / size);
      if (needed > height) { const bottom = top + height; height = Math.min(needed, bottom); top = bottom - height; }
      Object.assign(held.style, { top: `${(top + height / 2) * 100}%`, bottom: 'auto', left: '50%', transform: 'translate(-50%, -50%)' });
    }
    strip.style.top = `${top * 100}%`;
    strip.style.height = `${height * 100}%`;
  }
  function release() {
    if (!held) return;
    held.classList.remove('kage-on-strip');
    Object.assign(held.style, { top: '', bottom: '', left: '', transform: '' });
    held = null;
  }
  function move(delta) { state.top = clamp(state.top + delta, 0, 1 - state.height); apply(); }
  // The bottom stays where it is while the top edge moves.
  function resize(delta) {
    const bottom = state.top + state.height;
    state.top = clamp(state.top + delta, 0, bottom - MIN_HEIGHT);
    state.height = bottom - state.top;
    apply();
  }
  function draggable(handle, change) {
    let drag = null;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.isPrimary === false || !target) return;
      drag = { id: event.pointerId, y: event.clientY, size: target.getBoundingClientRect().height || 1 };
      try { handle.setPointerCapture?.(event.pointerId); } catch { /* The drag still works while the pointer stays on the handle. */ }
      strip.classList.add('kage-cover-adjusting');
      event.preventDefault(); event.stopPropagation();
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      change((event.clientY - drag.y) / drag.size);
      drag.y = event.clientY;
      event.preventDefault(); event.stopPropagation();
    });
    const finish = event => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null;
      strip.classList.remove('kage-cover-adjusting');
      save();
      event.stopPropagation();
    };
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(name, finish);
    // The player must not treat adjusting the strip as a click on the video.
    for (const name of ['click', 'dblclick', 'mousedown', 'mouseup']) handle.addEventListener(name, event => { event.preventDefault(); event.stopPropagation(); });
  }
  function build() {
    strip = document.createElement('div');
    strip.className = 'kage-cover-strip';
    edge = document.createElement('div');
    edge.className = 'kage-cover-edge';
    edge.title = 'Drag to change the cover height';
    grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'kage-cover-grip';
    grip.title = 'Drag to move the cover · Arrow keys move it · Shift + arrow keys resize it';
    grip.setAttribute('aria-label', 'Move the subtitle cover');
    grip.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/></svg>';
    // The glass is its own layer so its fade toward the sides leaves the grip alone.
    const glass = document.createElement('div');
    glass.className = 'kage-cover-glass';
    strip.append(glass, edge, grip);
    draggable(grip, move);
    draggable(edge, resize);
    grip.addEventListener('keydown', event => {
      const direction = { ArrowUp: -1, ArrowDown: 1 }[event.key];
      if (direction) {
        if (event.shiftKey) resize(direction * STEP); else move(direction * STEP);
        save(); event.preventDefault();
      }
      event.stopPropagation(); // Player shortcuts stay off while the grip has focus.
    });
    grip.addEventListener('keyup', event => event.stopPropagation());
  }
  globalThis.KageCover = {
    // Called on every sync with the player element, or null when there is no video.
    update(next) {
      if (!strip) build();
      if (next === target && (!state.on || !target || strip.parentNode === target)) return;
      target = next || null;
      apply();
    },
    // Puts Kage's subtitle box on the strip (the "on the cover" setting). Returns
    // false when the cover is off, so the caller keeps its own placement.
    hold(container) {
      if (!strip) build();
      if (!container || !state.on || !target) { release(); apply(); return false; }
      if (held && held !== container) release();
      held = container;
      held.classList.add('kage-on-strip');
      apply();
      return true;
    },
    toggle() {
      state.on = !state.on;
      apply(); save();
      return state.on;
    },
    get on() { return state.on; }
  };
  try {
    chrome.storage.local.get(KEY).then(saved => { read(saved[KEY]); apply(); }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) { read(changes[KEY].newValue); apply(); }
    });
  } catch { /* Reloaded extension: the strip keeps its defaults. */ }
})();
