(() => {
  let root, panel, launcher, input, messages, contextJP, contextZH, contextSource;
  let live = null;
  let pinned = null;
  let panelOpen = false;
  let autoExplainedText = '';
  let activeRequest = null;
  let sequence = 0;
  let sourceMessage = 'Netflix subtitles are used when a Traditional Chinese text track is available.';
  const icon = path => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const closeIcon = icon('<path d="m6 6 12 12M18 6 6 18"/>');
  function setText(node, text) { if (node && node.textContent !== text) node.textContent = text; }
  function selectTab(name) {
    for (const tab of root.querySelectorAll('[role="tab"]')) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const view of root.querySelectorAll('[role="tabpanel"]')) view.hidden = view.dataset.view !== name;
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
    document.body.classList.toggle('kage-panel-open', open);
    if (open) { capture(); explainCurrent(); input.focus(); }
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
  function stopAnswer() {
    if (!activeRequest) return;
    const request = activeRequest;
    activeRequest = null;
    request.port?.disconnect();
    request.answer.textContent = request.text ? `${request.text}\n\nStopped.` : 'Stopped.';
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
    const answer = message('Thinking with your local model…', 'ai');
    answer.setAttribute('role', 'status');
    const request = { answer, sentence, automatic, text: '', port: null };
    activeRequest = request;
    function finish(error) {
      if (activeRequest !== request) return;
      activeRequest = null;
      if (error) {
        answer.textContent = `${request.text ? `${request.text}\n\n` : ''}Unable to answer. ${error}`;
        answer.classList.add('kage-message-error');
        if (automatic && autoExplainedText === sentence) autoExplainedText = '';
      }
      answer.removeAttribute('role');
      request.port?.disconnect();
      messages.scrollTop = messages.scrollHeight;
    }
    try {
      const port = chrome.runtime.connect({ name: 'kage-tutor' });
      request.port = port;
      port.onMessage.addListener(response => {
        if (activeRequest !== request) return;
        if (response.type === 'delta' || response.type === 'done') {
          request.text = response.answer;
          answer.textContent = request.text;
          messages.scrollTop = messages.scrollHeight;
        }
        if (response.type === 'done') finish();
        else if (response.type === 'error') finish(response.error);
      });
      port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError?.message;
        finish(error || 'Connection lost. Reload this tab after reloading the extension.');
      });
      port.postMessage({ type: 'ASK_AI', sentence, question, ...(pinned?.localOnly ? { localOnly: true } : {}) });
    } catch {
      finish('Connection lost. Reload this tab after reloading the extension.');
    }
  }
  globalThis.KageTutor = {
    mount() {
      if (root) return;
      root = document.createElement('div'); root.className = 'kage-ai-widget'; root.id = 'kage-study';
      root.innerHTML = `
        <button type="button" class="kage-launcher" aria-label="Open Kage study panel" aria-expanded="false" aria-controls="kagePanel">
          ${icon('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5zm0 13A2.5 2.5 0 0 1 6.5 16H20M8 7h8M8 11h5"/>')}<span>Study</span>
        </button>
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
            <section class="kage-reading-card"><span class="kage-eyebrow">Readings</span><h3>Offline furigana</h3><p>Japanese readings come from a bundled dictionary on your device. They stay visible when translations change.</p><span id="kageDictionaryStatus" role="status">Loading local dictionary…</span></section>
            <div class="kage-prepare-slot"></div>
          </section>
          <footer class="kage-panel-footer"><span id="kageModelStatus">Local · Gemma 2</span><button type="button" class="kage-text-button" id="kageSettings">Settings ${icon('<path d="m9 5 7 7-7 7"/>')}</button></footer>
        </aside>`;
      document.body.appendChild(root);
      panel = root.querySelector('.kage-chat-panel'); launcher = root.querySelector('.kage-launcher');
      input = root.querySelector('#kageChatInput'); messages = root.querySelector('#kageChatBody');
      contextJP = root.querySelector('.kage-context-jp'); contextZH = root.querySelector('.kage-context-zh'); contextSource = root.querySelector('.kage-context-source');
      capture(); this.sourceStatus(sourceMessage);
      globalThis.KageImport?.mount(root.querySelector('.kage-import-slot'));
      launcher.addEventListener('click', () => show(panel.hidden));
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
      root.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => send(button.dataset.prompt)));
      root.querySelector('form').addEventListener('submit', event => { event.preventDefault(); send(); });
      root.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); show(false); }
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
      });
      root.querySelector('#kageSettings').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }).catch(() => {}));
      const refreshModel = () => chrome.storage.local.get(['apiModel', 'groqFallback']).then(state => {
        setText(root.querySelector('#kageModelStatus'), `Local · ${state.apiModel || 'gemma2'}${state.groqFallback === true ? ' · backup enabled' : ''}`);
      });
      refreshModel();
      chrome.storage.onChanged.addListener(changes => { if (changes.apiModel || changes.groqFallback) refreshModel(); });
      globalThis.KageReadings?.ready.then(() => { renderPinnedJapanese(); setText(root.querySelector('#kageDictionaryStatus'), KageReadings.state === 'ready' ? 'Dictionary ready · offline' : 'Dictionary unavailable · refresh this tab'); });
      document.addEventListener('fullscreenchange', () => {
        const target = document.fullscreenElement || document.body;
        if (target.tagName !== 'VIDEO') target.appendChild(root);
      });
    },
    update(text, data, source, localOnly = false) {
      live = { text, translation: data.sentence_translation || '', source, localOnly };
      if (!panelOpen) return;
      if (!pinned) { capture(); explainCurrent(); }
      else if (pinned.text === text) {
        pinned = { ...live }; setText(contextZH, live.translation); setText(contextSource, source);
      }
    },
    clearCurrent() { live = null; },
    sourceStatus(text) { sourceMessage = text; if (root) setText(root.querySelector('#kageSourceStatus'), text); }
  };
})();
