// The Audio tab: condensed audio of the current video (only the stretches
// where someone speaks), made by the local helper and saved by Chrome.
(() => {
  const SETTINGS_KEY = 'kageCondensedAudio';
  const POLL_MS = 700;
  let ui = null, status = null, notice = '', error = false;
  let checking = false, creating = false, saving = false, timer = null, revision = 0;
  // Only a file asked for in this visit downloads by itself; one found ready later waits for a click.
  let saveWhenReady = false;

  const supported = () => /(^|\.)(youtube\.com|bilibili\.com|anime1\.me)$/i.test(location.hostname);
  const pageUrl = () => globalThis.KageBrowserAudio?.currentPage?.() || location.href;
  function clock(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60);
    return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(total % 60).padStart(2, '0')}`;
  }
  const megabytes = bytes => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  function videoTitle() {
    return String(document.title || '').replace(/\s*[-–|_]\s*(YouTube|哔哩哔哩.*|bilibili.*|Anime1\.me.*)\s*$/i, '').replace(/^\(\d+\)\s*/, '').trim();
  }
  async function request(action, fields = {}) {
    const reply = await chrome.runtime.sendMessage({ type: 'LOCAL_SUBTITLES', action, ...fields, pageUrl: pageUrl() });
    if (!reply?.success) throw new Error(reply?.error || 'The local helper did not respond.');
    return reply.data;
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function stopPolling() { clearTimeout(timer); timer = null; }
  function fail(cause) {
    notice = /extension context invalidated/i.test(cause.message)
      ? 'Kage lost its connection to the extension. Refresh this video tab, then reopen the panel.' : cause.message;
    error = true;
  }
  async function refresh() {
    if (!ui || !supported() || checking) return;
    const current = ++revision;
    checking = true; stopPolling(); render();
    try {
      const next = await request('audio');
      if (current !== revision) return;
      status = next;
      if (!creating && !saving) { notice = ''; error = false; }
      if (status.export?.state === 'working') timer = setTimeout(refresh, POLL_MS);
      else if (status.export?.state === 'ready' && saveWhenReady) { saveWhenReady = false; checking = false; await save(); return; }
      else if (status.export?.state === 'error') saveWhenReady = false;
    } catch (cause) {
      if (current !== revision) return;
      status = null; saveWhenReady = false; fail(cause);
    } finally {
      if (current === revision) { checking = false; render(); }
    }
  }
  async function createAudio() {
    if (creating || saving || !status?.available || status.export?.state === 'working') return;
    const padding = Number(ui.padding.value);
    if (!Number.isFinite(padding) || padding < 0 || padding > 10) { notice = 'Use a padding between 0 and 10 seconds.'; error = true; render(); return; }
    const skipSongs = ui.skip.checked;
    creating = true; notice = ''; error = false; render();
    try {
      try { await chrome.storage.local.set({ [SETTINGS_KEY]: { padding, skipSongs } }); } catch { /* The choice still applies to this file. */ }
      status = await request('condense', { padding, skipSongs, title: videoTitle() });
      saveWhenReady = true;
    } catch (cause) { fail(cause); }
    finally { creating = false; render(); }
    if (saveWhenReady) await refresh();
  }
  async function save() {
    if (saving) return;
    saving = true; notice = ''; error = false; render();
    try {
      await request('saveAudio');
      notice = `Downloading “${status?.export?.filename || 'condensed audio'}” to your Downloads folder.`;
    } catch (cause) { fail(cause); }
    finally { saving = false; render(); }
  }
  function render() {
    if (!ui) return;
    const available = supported();
    ui.card.hidden = !available;
    ui.unsupported.hidden = available;
    if (!available) return;
    const made = status?.export;
    const working = made?.state === 'working' || creating;
    const ready = made?.state === 'ready';
    ui.create.disabled = !status?.available || working || saving;
    ui.create.textContent = ready ? 'Create again with these settings' : 'Create condensed audio';
    ui.create.className = ready ? 'kage-text-button' : 'kage-primary-action';
    ui.padding.disabled = ui.skip.disabled = working;
    ui.download.hidden = !ready;
    ui.download.disabled = saving;
    ui.result.hidden = !ready;
    if (ready) {
      ui.result.textContent = `${clock(made.seconds)} of dialogue from a ${clock(status.duration)} video · ${made.clips} ${made.clips === 1 ? 'clip' : 'clips'} · ${megabytes(made.bytes)}`;
    }
    ui.progress.hidden = !working;
    if (made?.state === 'working' && made.progress > 0) ui.progress.value = Math.min(1, made.progress);
    else ui.progress.removeAttribute('value');
    let message = notice;
    if (!message && made?.state === 'error') message = `The audio file could not be created. ${made.message || ''}`.trim();
    const failed = error || (!notice && made?.state === 'error');
    if (!message) {
      message = working ? `Cutting the audio down to its dialogue${made?.progress > 0 ? ` · ${Math.round(made.progress * 100)}%` : '…'}`
        : saving ? 'Starting the download…'
        : !status ? (checking ? 'Checking for this video’s audio…' : '')
        : status.available ? (ready ? 'Ready. Choose Download MP3 to save it again.' : `${status.lines} lines across ${clock(status.duration)} are ready to condense.`)
        : status.reason === 'preparing' ? 'Subtitles are still being prepared. Condensed audio is available once every Japanese line is ready.'
        : status.reason === 'no_audio' ? 'This video was prepared before Kage kept its audio. Prepare it again in the Subtitles tab to create condensed audio.'
        : status.reason === 'incomplete' ? 'Subtitle preparation stopped before the end of this video. Prepare it again in the Subtitles tab first.'
        : 'Prepare subtitles for this video in the Subtitles tab first. The audio is kept on your Mac with them for 3 days.';
    }
    ui.status.textContent = message;
    ui.status.classList.toggle('kage-import-error', !!failed);
  }
  function mount(slot) {
    if (!slot || ui) return;
    const card = node('section', 'kage-import-card kage-source-card kage-audio-card');
    card.append(node('span', 'kage-eyebrow', 'Condensed audio'), node('h3', '', 'Download the dialogue only'));
    card.append(node('p', 'kage-import-hint', 'An MP3 of this video with the music, action and silence between spoken lines removed. Listen to it away from the screen to review what you watched.'));
    const paddingRow = node('label', 'kage-import-row');
    const padding = node('input'); padding.type = 'number'; padding.min = '0'; padding.max = '10'; padding.step = '0.1'; padding.value = '1.5';
    paddingRow.append(node('span', '', 'Padding around each line (seconds)'), padding);
    const paddingHint = node('p', 'kage-import-hint', 'More padding sounds less chopped up; less padding makes a shorter file.');
    const skipRow = node('label', 'kage-import-toggle'); const skip = node('input'); skip.type = 'checkbox';
    skipRow.append(skip, node('span', '', 'Leave out the first and last 90 seconds (opening and ending songs)'));
    const create = node('button', 'kage-primary-action', 'Create condensed audio'); create.type = 'button';
    create.addEventListener('click', createAudio);
    const download = node('button', 'kage-primary-action', 'Download MP3'); download.type = 'button'; download.hidden = true;
    download.addEventListener('click', save);
    const actions = node('div', 'kage-import-actions'); actions.append(download, create);
    const progress = node('progress'); progress.max = 1; progress.hidden = true; progress.setAttribute('aria-label', 'Condensed audio progress');
    const result = node('p', 'kage-import-source'); result.hidden = true;
    const state = node('p', 'kage-import-status'); state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite');
    card.append(paddingRow, paddingHint, skipRow, actions, progress, result, state);
    const unsupported = node('section', 'kage-source-card');
    unsupported.append(node('span', 'kage-eyebrow', 'Condensed audio'), node('h3', '', 'Not available on this site'),
      node('p', '', 'Condensed audio is made from videos Kage prepares from their sound: YouTube, Bilibili and anime1.me.'));
    slot.append(card, unsupported);
    ui = { card, unsupported, padding, skip, create, download, progress, result, status: state };
    chrome.storage.local.get(SETTINGS_KEY).then(saved => {
      const settings = saved?.[SETTINGS_KEY];
      if (Number.isFinite(settings?.padding) && settings.padding >= 0 && settings.padding <= 10) padding.value = String(settings.padding);
      skip.checked = settings?.skipSongs === true;
    }).catch(() => {});
    // A different video, or new lines for this one, changes what can be made.
    window.addEventListener('kage-import-change', () => {
      status = null; notice = ''; error = false; saveWhenReady = false; revision++; checking = false; stopPolling();
      if (slot.closest('[role="tabpanel"]')?.hidden === false) void refresh(); else render();
    });
    render();
  }
  globalThis.KageAudio = { mount, refresh };
})();
