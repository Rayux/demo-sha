// Kage in a browser tab: the Mac fetches the episode and makes the subtitles;
// this page plays the video and shows the line being spoken.
(() => {
  const $ = id => document.getElementById(id);
  const views = { pair: $('pair'), home: $('home'), series: $('series'), watch: $('watch') };
  const video = $('video');
  const stage = $('stage');
  let session = null;
  let current = null; // { post, title, category, cues, version, timer, index }

  async function api(path, body) {
    let response;
    try {
      response = await fetch(path, body === undefined ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch { throw new Error('Cannot reach Kage on your Mac. Check that the Mac is awake and that this device is connected to it.'); }
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { session = { paired: false }; show('pair'); }
    if (!response.ok) throw new Error(data.error || `Kage returned an error (${response.status}).`);
    return data;
  }

  function show(name, back) {
    for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
    $('back').hidden = !back;
    if (back) { $('back').href = back.href; $('backLabel').textContent = back.label; }
    if (name !== 'watch') leave();
    if (name === 'pair') $('code').focus();
  }

  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  };

  // ── Furigana, from the same dictionary as the extension ──
  // The dictionary reads whole words (狙っ → ねらっ). Readings go over the kanji
  // only, so the kana around them are not written twice: 狙[ねら]っ, 取[と]り扱[あつか]い.
  const KANJI = /[㐀-鿿々〆ヶ]/;
  const hira = value => value.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  function rubyParts(word, reading) {
    const runs = word.match(/[㐀-鿿々〆ヶ]+|[^㐀-鿿々〆ヶ]+/g) || [word];
    if (runs.length === 1) return [{ text: word, reading }];
    const pattern = runs.map(run => KANJI.test(run) ? '(.+?)' : hira(run).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
    const found = hira(reading).match(new RegExp(`^${pattern}$`));
    if (!found) return [{ text: word, reading }];
    let group = 1;
    return runs.map(run => KANJI.test(run) ? { text: run, reading: found[group++] } : { text: run });
  }
  function japanese(target, line) {
    target.textContent = '';
    const chunks = window.KageReadings?.chunks(line);
    if (!chunks) { target.textContent = line; return; }
    for (const chunk of chunks) {
      if (!chunk.furigana) { target.append(chunk.japanese); continue; }
      for (const part of rubyParts(chunk.japanese, chunk.furigana)) {
        if (!part.reading) { target.append(part.text); continue; }
        // Not <ruby>: Safari spreads the kanji apart when the reading is wider (研 究).
        // Here the kanji stay together and get room on both sides instead.
        const word = text('span', part.text, 'rb');
        word.append(text('span', part.reading, 'rt'));
        const extra = (part.reading.length * 0.52 - part.text.length) / 2;
        if (extra > 0) word.style.setProperty('--room', `${extra.toFixed(2)}em`);
        target.append(word);
      }
    }
  }
  window.KageReadings?.ready.then(ok => { if (ok && current) { renderLines(); current.index = -2; tick(); } });

  // ── Lists ──
  function linkList(target, items, active) {
    target.textContent = '';
    for (const entry of items) {
      const link = text('a', entry.title);
      link.href = entry.href;
      if (entry.note) link.append(text('small', entry.note));
      if (entry.href === active) link.setAttribute('aria-current', 'true');
      const item = document.createElement('li');
      item.append(link);
      target.append(item);
    }
  }
  const episodeItems = episodes => episodes.map(episode => ({ title: episode.title, href: `#/watch/${episode.post}` }));

  // ── Home: search, or the latest episodes ──
  const episodePost = value => value.match(/^\d{1,12}$/)?.[0] || value.match(/anime1\.me\/(\d{1,12})/)?.[1] || value.match(/anime1\.me\/\?p=(\d{1,12})/)?.[1] || '';
  let latest = null, searchToken = 0, searchTimer = 0;

  async function refreshList() {
    const query = $('query').value.trim();
    const token = ++searchToken;
    $('openError').textContent = '';
    if (episodePost(query) && /anime1\.me|^\d+$/.test(query)) return; // A link: Enter opens it.
    try {
      if (!query) {
        $('listTitle').textContent = 'Latest episodes';
        if (!latest) { $('listStatus').textContent = 'Loading…'; latest = (await api('/api/anime1/latest')).episodes; }
        if (token !== searchToken) return;
        linkList($('results'), episodeItems(latest));
        $('listStatus').textContent = latest.length ? '' : 'Nothing to show right now.';
        return;
      }
      $('listTitle').textContent = 'Results';
      const { series } = await api(`/api/anime1/search?q=${encodeURIComponent(query)}`);
      if (token !== searchToken) return;
      linkList($('results'), series.map(item => ({ title: item.title, href: `#/series/${item.category}`,
        note: [item.status, [item.year, item.season].filter(Boolean).join(' ')].filter(Boolean).join(' · ') })));
      $('listStatus').textContent = series.length ? '' : 'No anime found. anime1.me lists titles in Chinese, so search with the Chinese name.';
    } catch (error) {
      if (token === searchToken) { $('results').textContent = ''; $('listStatus').textContent = error.message; }
    }
  }

  function home() {
    show('home');
    document.title = 'Kage';
    if (session.mac) {
      $('mac').hidden = false;
      $('macCode').textContent = session.code;
      $('addresses').textContent = '';
      for (const address of session.addresses) {
        const item = text('li', address.url);
        item.append(text('span', address.kind === 'anywhere' ? 'works anywhere' : 'on your home Wi-Fi'));
        $('addresses').append(item);
      }
      if (!session.addresses.length) $('addresses').append(text('li', 'This Mac is not connected to a network.'));
      $('awayHint').textContent = session.addresses.some(address => address.kind === 'anywhere') ? ''
        : 'To use Kage away from home, install Tailscale on this Mac and on the device, then reopen this page for a second address.';
    }
    if (!$('results').children.length) refreshList();
  }

  $('query').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(refreshList, 250); });
  $('openForm').addEventListener('submit', event => {
    event.preventDefault();
    clearTimeout(searchTimer);
    const query = $('query').value.trim();
    const post = /anime1\.me|^\d+$/.test(query) ? episodePost(query) : '';
    if (post) location.hash = `#/watch/${post}`;
    else { refreshList(); $('query').blur(); }
  });

  $('pairForm').addEventListener('submit', async event => {
    event.preventDefault();
    $('pairError').textContent = '';
    try {
      await api('/api/pair', { code: $('code').value });
      session = await api('/api/session');
      route();
    } catch (error) { $('pairError').textContent = error.message; }
  });

  // ── One series ──
  let seriesShown = '';
  async function series(category) {
    show('series', { href: '#/', label: 'Search' });
    if (seriesShown === category) return;
    seriesShown = category;
    $('seriesTitle').textContent = '';
    $('seriesEpisodes').textContent = '';
    $('seriesStatus').textContent = 'Loading episodes…';
    try {
      const data = await api(`/api/anime1/series/${category}`);
      if (seriesShown !== category) return;
      $('seriesTitle').textContent = data.title || 'Episodes';
      document.title = `${data.title || 'Episodes'} · Kage`;
      $('seriesStatus').textContent = data.episodes.length ? [data.status, `${data.episodes.length} episodes`].filter(Boolean).join(' · ') : 'No episodes found.';
      linkList($('seriesEpisodes'), episodeItems(data.episodes));
    } catch (error) { seriesShown = ''; $('seriesStatus').textContent = error.message; }
  }

  // ── Watching ──
  function leave() {
    if (!current) return;
    clearTimeout(current.timer);
    current = null;
    setFull(false);
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  const setStatus = (message, bad = false) => { $('status').textContent = message; $('status').classList.toggle('bad', bad); };

  async function watch(post, again = false) {
    leave();
    show('watch', { href: '#/', label: 'Search' });
    const mine = current = { post, title: '', category: '', cues: [], version: '', timer: 0, index: -2 };
    $('title').textContent = '';
    $('japanese').textContent = ''; $('chinese').textContent = ''; $('line').classList.add('empty');
    $('episodes').textContent = '';
    $('again').hidden = true;
    renderLines();
    showTime();
    wake();
    if (phoneSideways.matches) setFull(true, true);
    setStatus('Asking your Mac for this episode…');
    try {
      const episode = await api('/api/open', { url: post, again });
      if (current !== mine) return;
      Object.assign(current, episode);
      $('title').textContent = episode.title;
      document.title = `${episode.title} · Kage`;
      video.src = `/api/episode/${post}/video`;
      poll();
      if (episode.category) {
        show('watch', { href: `#/series/${episode.category}`, label: 'Episodes' });
        api(`/api/anime1/series/${episode.category}`).then(({ episodes }) => {
          if (current === mine) linkList($('episodes'), episodeItems(episodes), `#/watch/${post}`);
        }).catch(() => {});
      }
    } catch (error) {
      if (current === mine) { setStatus(error.message, true); $('again').hidden = false; }
    }
  }

  async function poll() {
    const mine = current;
    if (!mine) return;
    let delay = 2500;
    try {
      const data = await api(`/api/episode/${mine.post}/subtitles?v=${mine.version}`);
      if (current !== mine) return;
      mine.version = data.version;
      const job = data.job;
      if (job?.cues) { mine.cues = job.cues; mine.index = -2; renderLines(); tick(); }
      const done = job && ['complete', 'error', 'translation_error', 'cancelled'].includes(job.state);
      const failed = data.error || (job && ['error', 'translation_error', 'cancelled'].includes(job.state));
      $('again').hidden = !failed || !!data.downloading;
      if (data.error && !data.downloading) setStatus(data.error, true);
      else if (!job) setStatus(data.downloading ? 'Your Mac is fetching the episode…' : 'Waiting for your Mac…');
      else if (job.state === 'complete') setStatus(`${mine.cues.length} lines ready.`);
      else if (failed) setStatus(job.message || 'Subtitles stopped early.', true);
      else {
        const length = Number.isFinite(video.duration) && video.duration > 0 ? ` of ${clock(video.duration)}` : '';
        const through = job.processedThrough ? ` Japanese ready up to ${clock(job.processedThrough)}${length}.` : '';
        const chinese = job.translationTotal ? ` Chinese ${job.translationCompleted}/${job.translationTotal}.` : '';
        setStatus(`Making subtitles on your Mac.${through}${chinese}`);
      }
      if (done && !data.downloading) return; // Nothing more will change.
    } catch (error) {
      if (current !== mine) return;
      setStatus(error.message, true);
      delay = 6000;
    }
    mine.timer = setTimeout(poll, document.hidden ? 15000 : delay);
  }

  const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

  function renderLines() {
    const list = $('lines');
    list.textContent = '';
    if (!current?.cues.length) { list.append(text('li', 'Lines appear here as your Mac prepares them.', 'empty')); return; }
    const fragment = document.createDocumentFragment();
    current.cues.forEach((cue, index) => {
      const item = document.createElement('li');
      item.dataset.index = index;
      const ja = text('div', '', 'ja');
      ja.lang = 'ja';
      japanese(ja, cue.text);
      const zh = text('div', cue.translation, 'zh');
      zh.lang = 'zh-Hant';
      item.append(ja, zh);
      fragment.append(item);
    });
    list.append(fragment);
  }

  // The line being spoken, or -1 between lines.
  function activeIndex(time) {
    const cues = current?.cues || [];
    let low = 0, high = cues.length - 1, found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (cues[middle].start <= time) { found = middle; low = middle + 1; } else high = middle - 1;
    }
    // A line also shows from just before it starts: jumping to a line lands a moment early.
    if (found + 1 < cues.length && cues[found + 1].start - time <= 0.15) return found + 1;
    return found >= 0 && time < cues[found].end + 0.25 ? found : -1;
  }
  // The latest line that has started, for the previous / replay / next buttons.
  function nearestIndex() {
    const cues = current?.cues || [];
    let found = -1;
    for (let index = 0; index < cues.length && cues[index].start <= video.currentTime + 0.05; index++) found = index;
    return found;
  }

  function tick() {
    if (!current) return;
    const index = activeIndex(video.currentTime);
    if (index === current.index) return;
    current.index = index;
    const cue = current.cues[index];
    japanese($('japanese'), cue?.text || '');
    $('chinese').textContent = cue?.translation || '';
    // A class, not CSS :has(:empty): Safari does not always notice the text arriving.
    $('line').classList.toggle('empty', !cue);
    if ($('line').classList.contains('placed')) placeLine();
    const list = $('lines');
    list.querySelector('.current')?.classList.remove('current');
    const item = cue && list.children[index];
    if (item) {
      item.classList.add('current');
      if (!list.hidden && Date.now() - touched > 4000) list.scrollTo({ top: item.offsetTop - list.offsetTop - list.clientHeight / 3, behavior: 'smooth' });
    }
  }

  // Scrolling the list by hand pauses auto-scroll for a moment.
  let touched = 0;
  for (const type of ['touchstart', 'wheel']) $('lines').addEventListener(type, () => { touched = Date.now(); }, { passive: true });

  function jump(index) {
    const cue = current?.cues[index];
    if (!cue) return;
    video.currentTime = Math.max(0, cue.start - 0.05);
    void video.play().catch(() => {});
  }
  $('lines').addEventListener('click', event => {
    const item = event.target.closest('li[data-index]');
    if (item) { touched = 0; jump(Number(item.dataset.index)); }
  });
  $('replay').addEventListener('click', () => jump(Math.max(0, nearestIndex())));
  $('next').addEventListener('click', () => jump(nearestIndex() + 1));
  $('prev').addEventListener('click', () => {
    const index = nearestIndex();
    // Early in a line, go back one; later, restart the line (like a music player).
    jump(index > 0 && video.currentTime - current.cues[index].start < 1.5 ? index - 1 : Math.max(0, index));
  });
  $('again').addEventListener('click', () => { if (current) watch(current.post, true); });

  // ── Player controls ──
  // The controls fade out while playing and come back on any touch.
  let idleTimer = 0, seeking = false;
  function wake() {
    stage.classList.remove('idle');
    clearTimeout(idleTimer);
    if (!video.paused) idleTimer = setTimeout(() => { if (!video.paused && !seeking && !$('cover').classList.contains('editing')) stage.classList.add('idle'); }, 3000);
  }
  function showTime() {
    const length = Number.isFinite(video.duration) ? video.duration : 0;
    $('time').textContent = `${clock(video.currentTime || 0)} / ${clock(length)}`;
    if (!seeking) $('seek').value = length ? Math.round(video.currentTime / length * 1000) : 0;
  }
  const togglePlay = () => { if (video.paused) void video.play().catch(() => {}); else video.pause(); };
  $('play').addEventListener('click', togglePlay);
  // A tap on a picture with hidden controls only brings them back.
  video.addEventListener('click', () => tapPicture());
  for (const type of ['pointermove', 'pointerdown', 'keydown']) stage.addEventListener(type, event => { if (event.target !== video) wake(); }, { passive: true });
  for (const type of ['play', 'pause', 'ended']) video.addEventListener(type, () => {
    stage.classList.toggle('playing', !video.paused);
    $('play').setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    wake();
  });
  video.addEventListener('timeupdate', () => { tick(); showTime(); });
  video.addEventListener('seeked', () => { tick(); showTime(); });
  video.addEventListener('durationchange', showTime);
  video.addEventListener('loadedmetadata', () => {
    if (video.videoWidth && video.videoHeight) document.documentElement.style.setProperty('--ratio', (video.videoWidth / video.videoHeight).toFixed(4));
  });
  video.addEventListener('error', () => { if (current && video.error) setStatus('The video could not be played. Tap Prepare again, or check the Mac is awake.', true); });
  $('seek').addEventListener('input', () => {
    seeking = true;
    if (Number.isFinite(video.duration)) video.currentTime = $('seek').value / 1000 * video.duration;
    wake();
  });
  $('seek').addEventListener('change', () => { seeking = false; wake(); });

  // ── Dragging ──
  // `onMove(dx, dy)` runs once the finger has clearly moved; a press that never
  // moves is a tap and goes to `onTap`.
  function draggable(node, { onStart, onMove, onEnd, onTap }) {
    let origin = null, moved = false;
    node.addEventListener('pointerdown', event => {
      if (event.button > 0 || origin) return;
      origin = { id: event.pointerId, x: event.clientX, y: event.clientY };
      moved = false;
      try { node.setPointerCapture(event.pointerId); } catch { /* Still works without capture. */ }
      event.stopPropagation();
    });
    node.addEventListener('pointermove', event => {
      if (!origin || event.pointerId !== origin.id) return;
      const dx = event.clientX - origin.x, dy = event.clientY - origin.y;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      if (!moved) { moved = true; document.body.classList.add('dragging'); onStart?.(); }
      event.preventDefault();
      onMove(dx, dy);
      wake();
    });
    const finish = event => {
      if (!origin || event.pointerId !== origin.id) return;
      origin = null;
      document.body.classList.remove('dragging');
      if (moved) onEnd?.(); else if (event.type === 'pointerup') onTap?.();
    };
    node.addEventListener('pointerup', finish);
    node.addEventListener('pointercancel', finish);
  }
  const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
  const load = (key, fallback) => { try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return fallback; } };
  const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Private browsing. */ } };
  const tapPicture = () => { if (stage.classList.contains('idle')) wake(); else { togglePlay(); wake(); } };

  // ── Cover for subtitles that are part of the picture ──
  // Stored as fractions of the picture, so it lands on the same spot at any size.
  const frame = $('frame'), cover = $('cover');
  const coverState = load('kage-cover', { on: false, top: 0.8, height: 0.17 });
  function picture() {
    const ratio = Number(getComputedStyle(document.documentElement).getPropertyValue('--ratio')) || 16 / 9;
    let width = frame.clientWidth, height = width / ratio;
    if (height > frame.clientHeight) { height = frame.clientHeight; width = height * ratio; }
    return { left: (frame.clientWidth - width) / 2, top: (frame.clientHeight - height) / 2, width, height };
  }
  function layoutCover() {
    cover.hidden = !coverState.on;
    if (!coverState.on) cover.classList.remove('editing');
    $('coverToggle').setAttribute('aria-pressed', String(coverState.on));
    if (!coverState.on) return;
    coverState.height = clamp(Number(coverState.height) || 0.17, 0.04, 1);
    coverState.top = clamp(Number(coverState.top) || 0, 0, 1 - coverState.height);
    const box = picture();
    Object.assign(cover.style, { left: `${box.left}px`, width: `${box.width}px`,
      top: `${box.top + coverState.top * box.height}px`, height: `${coverState.height * box.height}px` });
  }
  $('coverToggle').addEventListener('click', () => { coverState.on = !coverState.on; save('kage-cover', coverState); layoutCover(); });
  let coverFrom = null;
  draggable(cover, {
    onStart: () => { coverFrom = { ...coverState }; },
    onMove: (dx, dy) => { coverState.top = coverFrom.top + dy / picture().height; layoutCover(); },
    onEnd: () => save('kage-cover', coverState),
    onTap: () => editCover(!cover.classList.contains('editing'))
  });
  function editCover(on) {
    cover.classList.toggle('editing', on);
    if (on) { stage.classList.remove('idle'); clearTimeout(idleTimer); } else wake();
  }
  // A touch anywhere else finishes adjusting.
  document.addEventListener('pointerdown', event => { if (!cover.contains(event.target)) editCover(false); }, true);
  // Each grip moves its own edge; the other edge stays put.
  draggable($('coverTop'), {
    onStart: () => { coverFrom = { ...coverState }; },
    onMove: (dx, dy) => {
      const bottom = coverFrom.top + coverFrom.height;
      const top = clamp(coverFrom.top + dy / picture().height, 0, bottom - 0.04);
      coverState.top = top; coverState.height = bottom - top;
      layoutCover();
    },
    onEnd: () => save('kage-cover', coverState),
    onTap: () => wake()
  });
  draggable($('coverBottom'), {
    onStart: () => { coverFrom = { ...coverState }; },
    onMove: (dx, dy) => {
      coverState.top = coverFrom.top;
      coverState.height = clamp(coverFrom.height + dy / picture().height, 0.04, 1 - coverFrom.top);
      layoutCover();
    },
    onEnd: () => save('kage-cover', coverState),
    onTap: () => wake()
  });
  new ResizeObserver(() => { layoutCover(); placeLine(); }).observe(frame);
  video.addEventListener('loadedmetadata', () => { layoutCover(); placeLine(); });

  // ── Moving the subtitle box (full screen) ──
  // Remembered separately for upright and sideways. Double-tap puts it back.
  const line = $('line');
  const lineKey = () => `kage-line-${window.matchMedia('(orientation: portrait)').matches ? 'portrait' : 'landscape'}`;
  function placeLine() {
    const spot = document.body.classList.contains('full') ? load(lineKey(), null) : null;
    if (!spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.y)) {
      line.classList.remove('placed');
      line.style.left = line.style.top = '';
      return;
    }
    line.classList.add('placed');
    const half = Math.min(line.offsetWidth, stage.clientWidth) / 2;
    line.style.left = `${clamp(spot.x * stage.clientWidth, half, stage.clientWidth - half)}px`;
    line.style.top = `${clamp(spot.y * stage.clientHeight, 0, stage.clientHeight - Math.max(40, line.offsetHeight))}px`;
  }
  let lineFrom = null, lastLineTap = 0;
  draggable(line, {
    onStart: () => {
      const box = line.getBoundingClientRect(), outer = stage.getBoundingClientRect();
      lineFrom = { x: box.left + box.width / 2 - outer.left, y: box.top - outer.top };
    },
    onMove: (dx, dy) => {
      if (!document.body.classList.contains('full')) return;
      save(lineKey(), { x: (lineFrom.x + dx) / stage.clientWidth, y: (lineFrom.y + dy) / stage.clientHeight });
      placeLine();
    },
    onTap: () => {
      if (!document.body.classList.contains('full')) return;
      if (Date.now() - lastLineTap < 350) { try { localStorage.removeItem(lineKey()); } catch { /* Private browsing. */ } placeLine(); lastLineTap = 0; }
      else { lastLineTap = Date.now(); tapPicture(); }
    }
  });
  window.addEventListener('resize', placeLine);

  // ── Full screen ──
  // The picture fills the screen and the line floats on it. Where the browser
  // can hide its own bars (iPad, Android, computers) it is asked to; on an
  // iPhone the page fills the browser window instead.
  const phoneSideways = window.matchMedia('(orientation: landscape) and (max-height: 519px)');
  const nativeFull = () => document.fullscreenElement || document.webkitFullscreenElement;
  // On iPad and iPhone, Safari's own full screen can lift a playing video above
  // everything else on the page, hiding the line and the controls. There the page
  // fills the window instead; added to the Home Screen, Kage has no browser bars at all.
  const appleTouch = /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  let fullByRotation = false;
  function setFull(on, byRotation = false) {
    document.body.classList.toggle('full', on);
    fullByRotation = on && byRotation;
    $('full').setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    placeLine();
    try {
      if (on && !byRotation && !appleTouch && !nativeFull()) {
        const request = stage.requestFullscreen || stage.webkitRequestFullscreen;
        const result = request?.call(stage);
        result?.catch?.(() => {});
      } else if (!on && nativeFull()) {
        const result = (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
        result?.catch?.(() => {});
      }
    } catch { /* The page still fills the window. */ }
    wake();
  }
  $('full').addEventListener('click', () => setFull(!document.body.classList.contains('full')));
  for (const type of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(type, () => {
    if (!nativeFull() && document.body.classList.contains('full') && !phoneSideways.matches) setFull(false);
  });
  // A phone turned sideways goes full screen by itself, and back when turned upright.
  phoneSideways.addEventListener('change', () => {
    if (!current) return;
    if (phoneSideways.matches && !document.body.classList.contains('full')) setFull(true, true);
    else if (!phoneSideways.matches && fullByRotation) setFull(false);
  });
  document.addEventListener('keydown', event => {
    if (!current || event.target.closest?.('input, button, a')) return;
    if (event.key === ' ') { event.preventDefault(); togglePlay(); }
    else if (event.key === 'f') setFull(!document.body.classList.contains('full'));
    else if (event.key === 'ArrowLeft') $('prev').click();
    else if (event.key === 'ArrowRight') $('next').click();
  });

  function toggle(button, className, key) {
    const apply = on => {
      button.setAttribute('aria-pressed', String(on));
      document.body.classList.toggle(className, !on);
      try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* Private browsing. */ }
    };
    let saved = null;
    try { saved = localStorage.getItem(key); } catch { /* Private browsing. */ }
    apply(saved !== '0');
    button.addEventListener('click', () => apply(button.getAttribute('aria-pressed') !== 'true'));
  }
  toggle($('furigana'), 'no-furigana', 'kage-furigana');
  toggle($('translation'), 'no-translation', 'kage-translation');

  function tab(lines) {
    $('tabLines').setAttribute('aria-selected', String(lines));
    $('tabEpisodes').setAttribute('aria-selected', String(!lines));
    $('lines').hidden = !lines;
    $('episodes').hidden = lines;
  }
  $('tabLines').addEventListener('click', () => tab(true));
  $('tabEpisodes').addEventListener('click', () => tab(false));

  // ── Routing ──
  function route() {
    if (!session?.paired) return show('pair');
    const post = location.hash.match(/^#\/watch\/(\d{1,12})$/)?.[1];
    const category = location.hash.match(/^#\/series\/(\d{1,12})$/)?.[1];
    if (post) { if (current?.post !== post) { tab(true); watch(post); } }
    else if (category) series(category);
    else home();
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && current && !$('status').classList.contains('bad')) { clearTimeout(current.timer); poll(); }
  });

  api('/api/session').then(data => { session = data; route(); })
    .catch(error => { show('pair'); $('pairError').textContent = error.message; });
})();
