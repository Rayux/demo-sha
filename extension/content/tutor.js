(() => {
  let root, panel, launcher, launcherGroup, downloadLauncher, input, messages, contextJP, contextZH, contextSource;
  let live = null;
  let pinned = null;
  let panelOpen = false;
  let activeTab = 'tutor';
  let autoExplainedText = '';
  let activeRequest = null;
  let sequence = 0;
  let subtitleFailure = '';
  let positionLauncher = () => {};
  function enableLauncherDrag() {
    const storageKey = 'kageStudyPositionV1';
    const margin = 8;
    let position = null, drag = null, suppressClick = false, edited = false;
    const clamp = value => Math.max(0, Math.min(1, value));
    function bounds() {
      const rect = launcherGroup.getBoundingClientRect();
      return { width: Math.max(0, window.innerWidth - rect.width - 2 * margin),
        height: Math.max(0, window.innerHeight - rect.height - 2 * margin) };
    }
    positionLauncher = () => {
      if (!position) return;
      const area = bounds();
      root.style.right = 'auto';
      root.style.left = `${margin + position.x * area.width}px`;
      root.style.top = `${margin + position.y * area.height}px`;
    };
    function move(left, top) {
      const area = bounds();
      position = { x: area.width ? clamp((left - margin) / area.width) : 0,
        y: area.height ? clamp((top - margin) / area.height) : 0 };
      edited = true;
      positionLauncher();
    }
    function save() {
      chrome.storage.local.set({ [storageKey]: position }).catch(() => {});
    }
    chrome.storage.local.get(storageKey).then(state => {
      const saved = state[storageKey];
      if (edited || !Number.isFinite(saved?.x) || !Number.isFinite(saved?.y)) return;
      position = { x: clamp(saved.x), y: clamp(saved.y) };
      positionLauncher();
    }).catch(() => {});
    for (const control of [launcher, downloadLauncher]) {
      control.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.isPrimary === false || drag) return;
        const rect = launcherGroup.getBoundingClientRect();
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
        suppressClick = false;
        control.setPointerCapture(event.pointerId);
        event.stopPropagation();
      });
      control.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.id) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 5) return;
        drag.moved = true;
        root.classList.add('kage-launcher-dragging');
        move(drag.left + dx, drag.top + dy);
        event.preventDefault(); event.stopPropagation();
      });
      function finish(event) {
        if (!drag || event.pointerId !== drag.id) return;
        const ended = drag; drag = null;
        suppressClick = ended.moved;
        root.classList.remove('kage-launcher-dragging');
        if (control.hasPointerCapture(ended.id)) control.releasePointerCapture(ended.id);
        if (ended.moved) save();
        event.stopPropagation();
      }
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) control.addEventListener(name, finish);
      control.addEventListener('click', event => {
        // Pointer drags also emit a click; keyboard activation must still work.
        if (suppressClick && event?.detail !== 0) {
          suppressClick = false; event.preventDefault(); event.stopPropagation(); return;
        }
        if (control === downloadLauncher) {
          globalThis.KageImport?.download();
        } else show(panel.hidden);
      });
      control.addEventListener('keydown', event => {
        const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!event.altKey || !direction) return;
        const rect = launcherGroup.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
        move(rect.left + direction[0] * step, rect.top + direction[1] * step);
        save(); event.preventDefault(); event.stopPropagation();
      });
    }
    window.addEventListener('resize', positionLauncher);
  }
  function renderSubtitleError() {
    if (!launcher) return;
    root.querySelector('.kage-launcher-badge').hidden = !subtitleFailure;
    launcher.title = subtitleFailure ? `Subtitle error: ${subtitleFailure}` : 'Click to study · Drag to move · Alt + arrow keys to move';
    launcher.setAttribute('aria-label', subtitleFailure ? 'Open Kage study panel: subtitle error' : 'Open Kage study panel');
  }
  let sourceMessage = 'Netflix subtitles are used when a Traditional Chinese text track is available.';
  const icon = path => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const closeIcon = icon('<path d="m6 6 12 12M18 6 6 18"/>');
  function setText(node, text) { if (node && node.textContent !== text) node.textContent = text; }
  // Build only known DOM elements; model output is never interpreted as HTML.
  function renderAnswer(body, text) {
    function inline(parent, value) {
      const tokens = /(`+)([^`]+?)\1|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^*\n]+?)\*|\\([\\`*_])/g;
      let offset = 0;
      for (const match of value.matchAll(tokens)) {
        parent.appendChild(document.createTextNode(value.slice(offset, match.index)));
        if (match[6]) parent.appendChild(document.createTextNode(match[6]));
        else {
          const tag = match[1] ? 'code' : match[3] || match[4] ? 'strong' : 'em';
          const element = document.createElement(tag);
          const content = match[2] || match[3] || match[4] || match[5];
          if (tag === 'code') element.textContent = content;
          else inline(element, content);
          parent.appendChild(element);
        }
        offset = match.index + match[0].length;
      }
      parent.appendChild(document.createTextNode(value.slice(offset)));
    }
    body.replaceChildren();
    let paragraph = null, list = null, code = null;
    for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
      if (/^\s*```/.test(line)) {
        if (code) code = null;
        else {
          const pre = document.createElement('pre'); code = document.createElement('code');
          pre.appendChild(code); body.appendChild(pre);
        }
        paragraph = list = null; continue;
      }
      if (code) { code.textContent += `${line}\n`; continue; }
      if (!line.trim()) { paragraph = list = null; continue; }
      const heading = line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/);
      const entry = line.match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
      if (heading) {
        const element = document.createElement('h4'); inline(element, heading[1]); body.appendChild(element);
        paragraph = list = null;
      } else if (entry) {
        const tag = entry[2] ? 'ol' : 'ul';
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = document.createElement(tag);
          if (entry[2]) list.setAttribute('start', entry[2]);
          body.appendChild(list);
        }
        const item = document.createElement('li'); inline(item, entry[3]); list.appendChild(item); paragraph = null;
      } else {
        list = null;
        if (!paragraph) { paragraph = document.createElement('p'); body.appendChild(paragraph); }
        else paragraph.appendChild(document.createTextNode('\n'));
        inline(paragraph, line);
      }
    }
  }
  function selectTab(name) {
    activeTab = name;
    for (const tab of root.querySelectorAll('[role="tab"]')) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const view of root.querySelectorAll('[role="tabpanel"]')) view.hidden = view.dataset.view !== name;
    if (panelOpen && name === 'tutor') { if (!pinned) capture(); explainCurrent(); }
  }
  function renderPinnedJapanese() {
    const text = pinned?.text || 'Play a Japanese subtitle to begin.';
    const chunks = pinned && globalThis.KageReadings?.chunks(text);
    const signature = JSON.stringify(chunks || text);
    if (contextJP.dataset.signature === signature) return;
    contextJP.dataset.signature = signature;
    if (!chunks) { contextJP.textContent = text; return; }
    const nodes = chunks.map(chunk => {
      const node = document.createElement(chunk.furigana ? 'ruby' : 'span');
      node.textContent = chunk.japanese;
      if (chunk.furigana) { const rt = document.createElement('rt'); rt.textContent = chunk.furigana; node.appendChild(rt); }
      return node;
    });
    contextJP.replaceChildren(...nodes);
  }
  function capture() {
    pinned = live ? { ...live } : null;
    renderPinnedJapanese();
    setText(contextZH, pinned?.translation || 'Open the panel during a subtitle to study it.');
    setText(contextSource, pinned?.source || 'Sentence context');
    root.querySelector('.kage-context-pinned').hidden = !pinned;
  }
  function explainCurrent() {
    const sentence = pinned?.text || '';
    if (!sentence || autoExplainedText === sentence) return;
    stopAnswer();
    autoExplainedText = sentence;
    send('請用繁體中文為日文學習者解釋這句話：先說明整句意思，再簡要分析重要文法、語氣與適合使用的情境。', true);
  }
  function show(open) {
    panelOpen = open;
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    root.classList.toggle('kage-study-open', open);
    document.body.classList.toggle('kage-panel-open', open);
    if (open && subtitleFailure) { selectTab('subtitles'); root.querySelector('[data-tab="subtitles"]').focus(); }
    else if (open) { capture(); selectTab('tutor'); input.focus(); }
    else { stopAnswer(); launcher.focus(); }
  }
  function message(text, role, sentence = '') {
    root.querySelector('.kage-chat-empty')?.remove();
    const item = document.createElement('article');
    item.className = `kage-chat-message ${role}`;
    item.id = `kage-message-${++sequence}`;
    const label = document.createElement('span');
    label.className = 'kage-message-label';
    label.textContent = role === 'user' ? 'You' : 'Kage Tutor';
    item.appendChild(label);
    if (sentence) {
      const quote = document.createElement('div'); quote.className = 'kage-message-context'; quote.textContent = sentence; item.appendChild(quote);
    }
    const body = document.createElement('div'); body.className = 'kage-message-text'; body.textContent = text;
    item.appendChild(body); messages.appendChild(item); messages.scrollTop = messages.scrollHeight;
    return body;
  }
  // Answers are fetched whole and kept per sentence and question, so asking
  // again (or clicking a quick action that was prefetched on hover) shows the
  // answer in the same frame. Nothing is revealed word by word.
  const answers = new Map();
  const ANSWER_CACHE_LIMIT = 40;
  const lostConnection = 'Connection lost. Reload this tab after reloading the extension.';
  function fetchAnswer(sentence, question) {
    const key = JSON.stringify([sentence, question]);
    const cached = answers.get(key);
    if (cached) return cached;
    const entry = { key, text: '', done: false, error: '', port: null, listeners: new Set() };
    const notify = () => { for (const listener of [...entry.listeners]) listener(entry); };
    const fail = error => {
      if (entry.done || entry.error) return;
      entry.error = error || lostConnection;
      if (answers.get(key) === entry) answers.delete(key);
      const port = entry.port; entry.port = null;
      port?.disconnect();
      notify();
    };
    answers.set(key, entry);
    while (answers.size > ANSWER_CACHE_LIMIT) answers.delete(answers.keys().next().value);
    try {
      const port = chrome.runtime.connect({ name: 'kage-tutor' });
      entry.port = port;
      port.onMessage.addListener(response => {
        if (entry.done || entry.error) return;
        if (response.type === 'delta' || response.type === 'done') {
          entry.text = response.answer;
          if (response.type === 'done') {
            entry.done = true; entry.port = null;
            port.disconnect();
            notify();
          }
        } else if (response.type === 'error') fail(response.error);
      });
      port.onDisconnect.addListener(() => fail(chrome.runtime.lastError?.message));
      port.postMessage({ type: 'ASK_AI', sentence, question, provider: 'groq' });
    } catch { fail(lostConnection); }
    return entry;
  }
  function cancelAnswer(entry) {
    if (entry.done || entry.error) return;
    if (answers.get(entry.key) === entry) answers.delete(entry.key);
    entry.error = 'Stopped.';
    const port = entry.port; entry.port = null;
    port?.disconnect();
  }
  function prefetch(prompt) {
    if (!panelOpen || !prompt) return;
    if (!pinned) capture();
    if (pinned?.text) fetchAnswer(pinned.text, prompt);
  }
  function loading(body) {
    body.replaceChildren();
    body.classList.add('kage-message-loading');
    const dots = document.createElement('span');
    dots.className = 'kage-loading-dots';
    dots.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('i'));
    const label = document.createElement('span');
    label.className = 'kage-sr-only';
    label.textContent = 'Thinking…';
    body.appendChild(dots);
    body.appendChild(label);
  }
  function stopAnswer() {
    if (!activeRequest) return;
    const request = activeRequest;
    activeRequest = null;
    request.entry.listeners.delete(request.render);
    cancelAnswer(request.entry);
    request.answer.classList.remove('kage-message-loading');
    renderAnswer(request.answer, request.entry.text ? `${request.entry.text}\n\nStopped.` : 'Stopped.');
    request.answer.removeAttribute('role');
    if (request.automatic && autoExplainedText === request.sentence) autoExplainedText = '';
  }
  function send(prompt, automatic = false) {
    const question = (typeof prompt === 'string' ? prompt : input.value).trim();
    if (!question) return;
    stopAnswer();
    if (!pinned) capture();
    const sentence = pinned?.text || '';
    if (!automatic) input.value = '';
    if (!automatic) message(question, 'user', sentence);
    const answer = message('', 'ai');
    answer.setAttribute('role', 'status');
    loading(answer);
    const entry = fetchAnswer(sentence, question);
    const request = { answer, sentence, automatic, entry, render: null };
    activeRequest = request;
    request.render = () => {
      if (activeRequest !== request || (!entry.done && !entry.error)) return;
      activeRequest = null;
      entry.listeners.delete(request.render);
      answer.classList.remove('kage-message-loading');
      if (entry.error) {
        renderAnswer(answer, `${entry.text ? `${entry.text}\n\n` : ''}Unable to answer. ${entry.error}`);
        answer.classList.add('kage-message-error');
        if (automatic && autoExplainedText === sentence) autoExplainedText = '';
      } else renderAnswer(answer, entry.text);
      answer.removeAttribute('role');
      messages.scrollTop = messages.scrollHeight;
    };
    entry.listeners.add(request.render);
    request.render(); // A cached answer appears immediately.
  }
  globalThis.KageTutor = {
    mount() {
      if (root) return;
      root = document.createElement('div'); root.className = 'kage-ai-widget'; root.id = 'kage-study';
      root.innerHTML = `
        <div class="kage-launcher-group" role="group" aria-label="Kage tools">
          <button type="button" class="kage-launcher" aria-label="Open Kage study panel" aria-expanded="false" aria-controls="kagePanel">
            ${icon('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5zm0 13A2.5 2.5 0 0 1 6.5 16H20M8 7h8M8 11h5"/>')}<span class="kage-launcher-badge" aria-hidden="true" hidden></span>
          </button>
          <button type="button" class="kage-download-launcher" aria-label="Download audio and prepare subtitles" title="Download audio & prepare subtitles" aria-controls="kagePanel" hidden>
            ${icon('<path d="M12 3v12m-5-5 5 5 5-5M5 16v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4"/>')}
          </button>
        </div>
        <aside id="kagePanel" class="kage-chat-panel" aria-label="Kage study panel" hidden>
          <header class="kage-chat-header"><div class="kage-brand"><span class="kage-brand-mark" aria-hidden="true">影</span><div><h2>Kage</h2><span class="kage-brand-caption">Your Japanese companion</span></div></div><button type="button" class="kage-icon-button kage-chat-close" aria-label="Close study panel">${closeIcon}</button></header>
          <nav class="kage-tabs" role="tablist" aria-label="Study tools">
            <button id="kageTutorTab" type="button" role="tab" aria-selected="true" aria-controls="kageTutorView" data-tab="tutor">${icon('<path d="M8 10h8M8 14h5M5 3h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H9l-6 3V5a2 2 0 0 1 2-2Z"/>')}Tutor</button>
            <button id="kageSubtitleTab" type="button" role="tab" aria-selected="false" aria-controls="kageSubtitleView" tabindex="-1" data-tab="subtitles">${icon('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 10h4m3 0h3M7 14h2m3 0h5"/>')}Subtitles</button>
          </nav>
          <section id="kageTutorView" class="kage-tutor-view" role="tabpanel" aria-labelledby="kageTutorTab" data-view="tutor">
            <section class="kage-context-card" aria-label="Selected sentence"><div class="kage-card-top"><span class="kage-eyebrow">Selected sentence</span><button type="button" class="kage-text-button" id="kageUseCurrent">${icon('<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>')}Use current line</button></div><p class="kage-context-jp" id="kageChatContext" lang="ja"></p><p class="kage-context-zh" lang="zh-Hant"></p><div class="kage-context-meta"><span class="kage-context-source"></span><span class="kage-context-pinned">Pinned for study</span></div></section>
            <div class="kage-chat-body" id="kageChatBody" role="log" aria-live="polite" aria-label="Tutor conversation"><div class="kage-chat-empty"><h3>Explore this sentence</h3><p>Choose a topic below or ask a question.</p></div></div>
            <div class="kage-quick-actions"><button type="button" data-prompt="請用繁體中文解釋這句話中助詞的用法與作用。如果沒有助詞，請直接說明。">Particle</button><button type="button" data-prompt="請用繁體中文分析這句話的動詞原形、活用形式與意思，並給一個簡短例句。如果沒有動詞，請直接說明。">Verb form</button><button type="button" data-prompt="請用繁體中文解釋這句話中的俚語、口語縮略與語氣，以及適合使用的情境。如果沒有俚語或縮略，請直接說明，不要臆造。">Slang</button></div>
            <form class="kage-chat-input-area"><label class="kage-sr-only" for="kageChatInput">Ask about the selected sentence</label><textarea id="kageChatInput" rows="2" maxlength="8000" placeholder="Ask about this sentence…"></textarea><div class="kage-composer-footer"><span>Enter to send · Shift + Enter for a new line</span><button id="kageChatSend" type="submit" aria-label="Send question">${icon('<path d="M12 19V5m-6 6 6-6 6 6"/>')}</button></div></form>
          </section>
          <section id="kageSubtitleView" role="tabpanel" aria-labelledby="kageSubtitleTab" data-view="subtitles" hidden>
            <div class="kage-view-heading"><h3>Subtitles</h3><p>Everything you need to follow along.</p></div>
            <div class="kage-import-slot"></div>
            <section class="kage-source-card"><span class="kage-eyebrow">Translation</span><h3>Subtitle source</h3><p id="kageSourceStatus" role="status"></p></section>
            <section class="kage-reading-card"><span class="kage-eyebrow">Readings</span><h3>Offline furigana</h3><p>Japanese readings come from a bundled dictionary on your device. They stay visible when translations change. Readings are inferred from the Japanese text, not the audio; names and ambiguous kanji can be incorrect.</p><span id="kageDictionaryStatus" role="status">Loading local dictionary…</span></section>
            <div class="kage-prepare-slot"></div>
          </section>
          <footer class="kage-panel-footer"><span id="kageModelStatus">Groq · GPT OSS 120B</span><button type="button" class="kage-text-button" id="kageSettings">Settings ${icon('<path d="m9 5 7 7-7 7"/>')}</button></footer>
        </aside>`;
      document.body.appendChild(root);
      panel = root.querySelector('.kage-chat-panel'); launcher = root.querySelector('.kage-launcher');
      launcherGroup = root.querySelector('.kage-launcher-group'); downloadLauncher = root.querySelector('.kage-download-launcher');
      input = root.querySelector('#kageChatInput'); messages = root.querySelector('#kageChatBody');
      contextJP = root.querySelector('.kage-context-jp'); contextZH = root.querySelector('.kage-context-zh'); contextSource = root.querySelector('.kage-context-source');
      capture(); this.sourceStatus(sourceMessage); renderSubtitleError();
      globalThis.KageImport?.mount(root.querySelector('.kage-import-slot'));
      enableLauncherDrag();
      root.querySelector('.kage-chat-close').addEventListener('click', () => show(false));
      root.querySelector('#kageUseCurrent').addEventListener('click', () => {
        if (!live?.text) return;
        stopAnswer(); capture(); explainCurrent(); input.focus();
      });
      root.querySelectorAll('[role="tab"]').forEach(tab => {
        tab.addEventListener('click', () => selectTab(tab.dataset.tab));
        tab.addEventListener('keydown', event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          const name = tab.dataset.tab === 'tutor' ? 'subtitles' : 'tutor'; selectTab(name); root.querySelector(`[data-tab="${name}"]`).focus();
        });
      });
      root.querySelectorAll('[data-prompt]').forEach(button => {
        button.addEventListener('click', () => send(button.dataset.prompt));
        // Start the answer while the pointer is on its way to the click.
        button.addEventListener('pointerenter', () => prefetch(button.dataset.prompt));
        button.addEventListener('focus', () => prefetch(button.dataset.prompt));
      });
      root.querySelector('form').addEventListener('submit', event => { event.preventDefault(); send(); });
      root.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); show(false); }
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
      });
      root.querySelector('#kageSettings').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }).catch(() => {}));
      const refreshModel = () => chrome.storage.local.get(['groqApiKey']).then(state => {
        setText(root.querySelector('#kageModelStatus'), state.groqApiKey ? 'Groq · GPT OSS 120B' : 'Groq · API key required');
      });
      refreshModel();
      chrome.storage.onChanged.addListener(changes => { if (changes.groqApiKey) refreshModel(); });
      globalThis.KageReadings?.ready.then(() => { renderPinnedJapanese(); setText(root.querySelector('#kageDictionaryStatus'), KageReadings.state === 'ready' ? 'Dictionary ready · offline' : 'Dictionary unavailable · refresh this tab'); });
      document.addEventListener('fullscreenchange', () => {
        const target = document.fullscreenElement || document.body;
        if (target.tagName !== 'VIDEO') target.appendChild(root);
        positionLauncher();
      });
    },
    update(text, data, source, localOnly = false) {
      live = { text, translation: data.sentence_translation || '', source, localOnly };
      if (!panelOpen) return;
      if (!pinned) { capture(); if (activeTab === 'tutor') explainCurrent(); }
      else if (pinned.text === text) {
        pinned = { ...live }; setText(contextZH, live.translation); setText(contextSource, source);
      }
    },
    clearCurrent() { live = null; },
    openSubtitles() {
      show(true); selectTab('subtitles');
    },
    downloadState(available, busy) {
      if (!downloadLauncher) return;
      downloadLauncher.hidden = !available;
      downloadLauncher.disabled = busy;
      downloadLauncher.setAttribute('aria-busy', String(busy));
      downloadLauncher.title = busy ? 'Loading or preparing subtitles…' : 'Download audio & prepare subtitles';
      positionLauncher();
    },
    subtitleError(text) { subtitleFailure = String(text || ''); renderSubtitleError(); },
    sourceStatus(text) { sourceMessage = text; if (root) setText(root.querySelector('#kageSourceStatus'), text); }
  };
})();
