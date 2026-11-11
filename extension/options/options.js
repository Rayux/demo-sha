document.addEventListener('DOMContentLoaded', async () => {
  const previous = await chrome.storage.local.get('gemmaRestoredV1');
  if (!previous.gemmaRestoredV1) await chrome.storage.local.set({ apiModel: 'gemma2', gemmaRestoredV1: true, detailedSubtitles: false });
  const state = await chrome.storage.local.get(['apiEndpoint', 'apiModel', 'apiKey', 'groqApiKey', 'groqFallback', 'groqConnection', 'autoTranslate', 'detailedSubtitles', 'autoPrepareSubtitles', 'coverSubtitleMode']);
  let local = false;
  try { local = ['localhost', '127.0.0.1'].includes(new URL(state.apiEndpoint).hostname); } catch {}
  document.getElementById('apiEndpoint').value = local ? state.apiEndpoint : 'http://127.0.0.1:11434/v1/chat/completions';
  document.getElementById('apiModel').value = local ? state.apiModel || 'gemma2' : 'gemma2';
  document.getElementById('apiKey').value = local ? state.apiKey || '' : '';
  document.getElementById('groqApiKey').value = state.groqApiKey || '';
  document.getElementById('groqConnection').value = ['browser', 'helper'].includes(state.groqConnection) ? state.groqConnection : 'auto';
  document.getElementById('detailedSubtitles').checked = state.detailedSubtitles === true;
  document.getElementById('autoPrepareSubtitles').checked = state.autoPrepareSubtitles !== false;
  document.getElementById('coverSubtitleMode').value = state.coverSubtitleMode === 'strip' ? 'strip' : 'separate';
  document.getElementById('groqFallback').checked = state.groqFallback === true;
  document.getElementById('autoTranslate').value = state.autoTranslate || 'true';
});
document.getElementById('saveBtn').addEventListener('click', async () => {
  const status = document.getElementById('status');
  const apiEndpoint = document.getElementById('apiEndpoint').value.trim();
  const apiModel = document.getElementById('apiModel').value.trim();
  try {
    const url = new URL(apiEndpoint);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) throw new Error();
    if (!apiModel) throw new Error();
  } catch { status.className = 'error'; status.textContent = 'Enter a localhost or 127.0.0.1 endpoint and a model name.'; return; }
  await chrome.storage.local.set({ apiEndpoint, apiModel,
    detailedSubtitles: document.getElementById('detailedSubtitles').checked,
    autoPrepareSubtitles: document.getElementById('autoPrepareSubtitles').checked,
    coverSubtitleMode: document.getElementById('coverSubtitleMode').value === 'strip' ? 'strip' : 'separate',
    apiKey: document.getElementById('apiKey').value.trim(),
    groqApiKey: document.getElementById('groqApiKey').value.trim(),
    groqConnection: document.getElementById('groqConnection').value,
    groqFallback: document.getElementById('groqFallback').checked,
    autoTranslate: document.getElementById('autoTranslate').value });
  status.className = '';
  status.textContent = 'Settings saved.';
  setTimeout(() => { status.textContent = ''; }, 3000);
});
