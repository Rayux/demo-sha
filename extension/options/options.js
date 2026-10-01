document.addEventListener('DOMContentLoaded', async () => {
  const previous = await chrome.storage.local.get('gemmaRestoredV1');
  if (!previous.gemmaRestoredV1) await chrome.storage.local.set({ apiModel: 'gemma2', gemmaRestoredV1: true, detailedSubtitles: false });
  const state = await chrome.storage.local.get(['apiEndpoint', 'apiModel', 'apiKey', 'groqApiKey', 'groqFallback', 'autoTranslate', 'detailedSubtitles']);
  let local = false;
  try { local = ['localhost', '127.0.0.1'].includes(new URL(state.apiEndpoint).hostname); } catch {}
  document.getElementById('apiEndpoint').value = local ? state.apiEndpoint : 'http://127.0.0.1:11434/v1/chat/completions';
  document.getElementById('apiModel').value = local ? state.apiModel || 'gemma2' : 'gemma2';
  document.getElementById('apiKey').value = local ? state.apiKey || '' : '';
  document.getElementById('groqApiKey').value = state.groqApiKey || '';
  document.getElementById('detailedSubtitles').checked = state.detailedSubtitles === true;
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
  } catch { status.textContent = 'Enter a localhost or 127.0.0.1 endpoint and a model name.'; return; }
  await chrome.storage.local.set({ apiEndpoint, apiModel,
    detailedSubtitles: document.getElementById('detailedSubtitles').checked,
    apiKey: document.getElementById('apiKey').value.trim(),
    groqApiKey: document.getElementById('groqApiKey').value.trim(),
    groqFallback: document.getElementById('groqFallback').checked,
    autoTranslate: document.getElementById('autoTranslate').value });
  status.textContent = 'Settings saved.';
  setTimeout(() => { status.textContent = ''; }, 3000);
});
