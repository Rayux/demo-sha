// Reads on demand for the visible Clipboard panel watcher or an explicit shortcut/button.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'clipboard-reader' || message.type !== 'read-clipboard') return;
  const field = document.getElementById('clipboard');
  field.value = '';
  field.focus();
  let receivedPaste = false;
  const onPaste = event => {
    receivedPaste = true;
    event.preventDefault();
    field.value = event.clipboardData?.getData('text/plain') || '';
  };
  field.addEventListener('paste', onPaste, { once: true });
  try {
    const pasted = document.execCommand('paste');
    if (!pasted && !receivedPaste && !field.value) throw Error('Clipboard access failed. Paste the text into the Clipboard tab instead.');
    sendResponse({ text: field.value });
  } catch (error) { sendResponse({ error: error.message }); }
  finally { field.removeEventListener('paste', onPaste);field.value = ''; }
});
