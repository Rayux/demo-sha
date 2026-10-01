// Explicit preparation runs in the open video tab, with results saved by the worker.
// It never changes subtitle timing, enables cloud fallback, or starts playback.
(() => {
  let selected = null;
  let position = 0;
  let panel = null;
  let serial = 0;
  let context = '';
  let running = false;
  let nativeAvailable = false;
  let nativeMessage = '';
  let localOnly = false;
  let selectionBlocked = false;
  let progress = '';
  let statusNode;
  let nextButton;
  let allButton;
  let stopButton;
  const { matchingTrack, active, normalize } = KageSubtitles;
  function render() {
    if (!panel) return;
    const trackStatus = selected
      ? `${selected.cues.length} timed subtitle lines captured.`
      : 'Waiting for a Japanese subtitle track. On Bilibili, import video/audio above when no subtitles are available. Otherwise try Find subtitles or select Japanese subtitles in the player.';
    const label = nativeAvailable ? nativeMessage || 'Netflix Traditional Chinese is ready. Furigana runs locally; no translation preparation is needed.' : progress || trackStatus;
    if (statusNode.textContent !== label) statusNode.textContent = label;
    nextButton.disabled = !selected || running || nativeAvailable;
    allButton.disabled = !selected || running || nativeAvailable;
    stopButton.disabled = !running;
  }
  function stop() {
    serial++;
    running = false;
    chrome.runtime.sendMessage({ type: 'CLEAR_PREFETCH', context }).catch(() => {});
    progress = 'Preparation stopped. Completed translations are saved; the current batch may finish.';
    render();
  }
  async function prepare(whole) {
    if (!selected || running || nativeAvailable) return;
    const track = selected;
    const epoch = ++serial;
    const requestContext = context;
    const requestLocalOnly = localOnly;
    running = true;
    // Replace speculative rolling work, but leave the active caption request intact.
    chrome.runtime.sendMessage({ type: 'CLEAR_PREFETCH', context }).catch(() => {});
    const upcoming = track.cues.filter(c => c.start > position);
    const cues = whole ? [...upcoming, ...track.cues.filter(c => c.start <= position)] : upcoming.slice(0, 10);
    const texts = [...new Set(cues.map(c => c.text))];
    progress = `Preparing 0 / ${texts.length} lines. You can pause the video to let translation get ahead.`;
    render();
    const started = Date.now();
    try {
      for (let i = 0; i < texts.length; i += 4) {
        if (epoch !== serial) return;
        const response = await chrome.runtime.sendMessage({ type: 'PREPARE_SUBTITLES', texts: texts.slice(i, i + 4), context: requestContext, ...(requestLocalOnly ? { localOnly: true } : {}) });
        if (epoch !== serial) return;
        if (!response?.success) throw new Error(response?.error || 'Translation request failed.');
        const seconds = Math.round((Date.now() - started) / 1000);
        progress = `Prepared ${Math.min(i + 4, texts.length)} / ${texts.length} lines (${seconds}s). Completed translations are saved.`;
        render();
      }
      progress = `${texts.length} lines prepared. Replay or continue watching to use the saved translations.`;
    } catch (error) {
      if (epoch !== serial) return;
      progress = `Preparation paused: ${error.message} Completed translations are saved. Try again to resume.`;
    } finally {
      if (epoch === serial) { running = false; render(); }
    }
  }
  globalThis.KagePreparation = {
    mount(parent) {
      if (panel) return;
      panel = document.createElement('section');
      panel.className = 'kage-preparation';
      const title = document.createElement('strong');
      title.textContent = 'Prepare subtitles';
      statusNode = document.createElement('p');
      statusNode.setAttribute('role', 'status');
      const buttons = document.createElement('div');
      const button = (label, action) => {
        const node = document.createElement('button');
        node.type = 'button'; node.textContent = label;
        node.addEventListener('click', action); buttons.appendChild(node); return node;
      };
      nextButton = button('Next 10 lines', () => prepare(false));
      allButton = button('Whole track', () => prepare(true));
      stopButton = button('Stop', stop);
      button('Find subtitles', () => {
        progress = '';
        window.postMessage({ type: 'KAGE_TRACKS_READY' }, location.origin);
        render();
      });
      panel.append(title, statusNode, buttons);
      const slot = parent.querySelector('.kage-prepare-slot');
      if (slot) slot.appendChild(panel);
      else parent.querySelector('.kage-chat-header').after(panel);
      render();
    },
    observe(tracks, video, text, imported = false) {
      localOnly = imported;
      position = video.currentTime;
      let match = matchingTrack(tracks, position, text);
      if (text && match && normalize(active(match[1], position).map(c => c.text).join('')).replace(/\s/g, '') !== normalize(text).replace(/\s/g, '')) match = null;
      if (!text && selectionBlocked) match = null;
      // Cue gaps do not change the player's selected subtitle language.
      if (!text && selected && tracks.get(selected.url) === selected.cues) match = [selected.url, selected.cues];
      if (!match) {
        if (selected) this.reset();
        if (text) selectionBlocked = true;
        return;
      }
      if (text) selectionBlocked = false;
      if (selected?.url !== match[0]) {
        if (running) stop();
        selected = { url: match[0], cues: match[1] };
        progress = '';
      }
      render();
    },
    setContext(value) {
      if (context === value) return;
      context = value;
      selectionBlocked = false;
      serial++; running = false; progress = ''; render();
    },
    setNativeAvailable(value, message = '') {
      if (value && running) stop();
      nativeAvailable = value; nativeMessage = message; render();
    },
    reset() {
      localOnly = false;
      nativeAvailable = false;
      selectionBlocked = false;
      serial++; running = false; selected = null; progress = ''; render();
    },
    get running() { return running; }
  };
})();
