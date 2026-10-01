const DEFAULTS = {
  endpoint: "http://127.0.0.1:11434/v1/chat/completions",
  model: "qwen2.5vl:7b",
  apiKey: ""
};

const capturingWindows = new Set();

async function captureAndOpen(sourceTab, openPanel = true) {
  // Invoke open directly from the action/command gesture, before capture or storage awaits.
  const panelOpening = openPanel && sourceTab?.windowId != null
    ? chrome.sidePanel.open({ windowId: sourceTab.windowId }) : Promise.resolve();
  let windowId = sourceTab?.windowId;
  let locked = false;
  try {
    await panelOpening;
    if (!sourceTab) [sourceTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    windowId = sourceTab?.windowId;
    if (windowId == null) throw new Error("No active browser tab is available.");
    if (capturingWindows.has(windowId)) return;
    capturingWindows.add(windowId);
    locked = true;
    if (sourceTab.url?.startsWith(chrome.runtime.getURL(""))) {
      throw new Error("Select the page you want to study, then click the extension toolbar button.");
    }
    const image = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (activeTab?.id !== sourceTab.id) throw new Error("The active tab changed during capture. Capture the page again.");
    await chrome.storage.session.set({ [`panel-mode-${windowId}`]: "screenshot", [`study-${windowId}`]: {
      image, sourceTabId: sourceTab.id, sourceUrl: sourceTab.url || "",
      sourceTitle: sourceTab.title || "Captured page", capturedAt: new Date().toISOString()
    } });
    return { ok: true };
  } catch (error) {
    const message = `${error.message || "Could not capture this page."} Use the extension toolbar button on the source page to grant capture access.`;
    if (windowId != null) await chrome.storage.session.set({ [`panel-mode-${windowId}`]: "screenshot", [`study-${windowId}`]: { error: message } });
    return { error: message };
  } finally {
    if (locked) capturingWindows.delete(windowId);
  }
}

let creatingClipboard;
const clipboardRuns = new Map();
async function readClipboard(allowEmpty = false) {
  const url = chrome.runtime.getURL("clipboard.html");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (!contexts.length) {
    if (!creatingClipboard) {
      creatingClipboard = chrome.offscreen.createDocument({
        url: "clipboard.html", reasons: ["CLIPBOARD"],
        justification: "Read copied Japanese while the user enables auto-translation in the visible Clipboard panel, or invokes the shortcut or button."
      }).finally(() => { creatingClipboard = null; });
    }
    await creatingClipboard;
  }
  if (creatingClipboard) await creatingClipboard;
  const response = await chrome.runtime.sendMessage({ target: "clipboard-reader", type: "read-clipboard" });
  if (response?.error) throw Error(response.error);
  if (typeof response?.text !== "string" || (!allowEmpty && !response.text.trim())) throw Error("The clipboard has no text. Copy Japanese text first, then use the shortcut again.");
  if (response.text.length > 12000) throw Error("Copy a shorter passage (up to 12,000 characters).");
  return response.text.trim();
}

async function translateClipboard(windowId, panelOpening = Promise.resolve()) {
  const run = (clipboardRuns.get(windowId) || 0) + 1;
  clipboardRuns.set(windowId, run);
  // Observe opening errors immediately; clipboard delivery can still be saved for reopening.
  const opening = panelOpening.catch(() => null);
  try {
    const text = await readClipboard();
    if (clipboardRuns.get(windowId) !== run) return { ignored: true };
    await chrome.storage.session.set({
      [`panel-mode-${windowId}`]: "text",
      [`clipboard-error-${windowId}`]: "",
      [`selected-${windowId}`]: { id: crypto.randomUUID(), text, sourceTitle: "Clipboard" }
    });
    await opening;
    return { ok: true };
  } catch (error) {
    if (clipboardRuns.get(windowId) !== run) return { ignored: true };
    await chrome.storage.session.set({ [`panel-mode-${windowId}`]: "text", [`clipboard-error-${windowId}`]: error.message });
    return { error: error.message };
  }
}

function clipboardCommand(tab) {
  // Open synchronously within the command gesture, including global commands
  // with no tab argument. Current Chrome resolves WINDOW_ID_CURRENT here.
  const opening = chrome.sidePanel.open({ windowId: tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT }).catch(() => null);
  const destination = tab?.windowId != null
    ? Promise.resolve(tab.windowId)
    : chrome.windows.getLastFocused({ windowTypes: ["normal"] }).then(window => window.id);
  return destination.then(windowId => {
    void chrome.windows.update(windowId, { focused: true }).catch(() => {});
    return translateClipboard(windowId, opening);
  }).catch(() => ({ error: "Open a Chrome window before using the clipboard shortcut." }));
}
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "capture-study") void captureAndOpen(tab);
  if (command === "clipboard-study") void clipboardCommand(tab);
});
chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ windowId: tab.windowId }).then(() =>
    chrome.storage.session.set({ [`panel-mode-${tab.windowId}`]: "text" })
  ).catch(() => {});
});
chrome.windows.onRemoved.addListener(windowId => {
  clipboardRuns.delete(windowId);
  void chrome.storage.session.remove([`study-${windowId}`, `selected-${windowId}`, `panel-mode-${windowId}`, `clipboard-error-${windowId}`]);
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "clipboard-reader") return;
  if (message.type === "clipboard-preview") {
    if (sender.tab) return;
    readClipboard(true).then(text => sendResponse({ text })).catch(error => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === "clipboard-study") {
    if (sender.tab || !Number.isInteger(message.windowId)) return;
    translateClipboard(message.windowId).then(sendResponse).catch(error => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === "capture-now") {
    chrome.tabs.query({ active: true, windowId: message.windowId })
      .then(([tab]) => captureAndOpen(tab, false)).then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type !== "get-settings") return;
  chrome.storage.local.get(DEFAULTS).then(sendResponse);
  return true;
});
