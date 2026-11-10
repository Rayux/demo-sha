// An unpacked install keeps running the code it loaded until someone presses
// Reload, so edits on disk go unused without any sign. This compares the files
// on disk with what was loaded and reloads Kage when they differ. Store
// installs (which have an update_url) never run it.
(() => {
  const ALARM = 'kage-dev-reload';
  const KEY = 'kageLoadedFingerprintV1';
  if (!chrome.runtime.getManifest || !chrome.storage.session || chrome.runtime.getManifest().update_url) return;
  const read = async path => {
    const response = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Cannot read ${path}`);
    return response.text();
  };
  async function fingerprint() {
    const manifestText = await read('manifest.json');
    const manifest = JSON.parse(manifestText);
    const worker = manifest.background?.service_worker || '';
    const options = manifest.options_ui?.page || '';
    const [workerText, optionsText] = await Promise.all([worker ? read(worker) : '', options ? read(options) : '']);
    const folder = path => path.slice(0, path.lastIndexOf('/') + 1);
    const quoted = text => [...text.matchAll(/['"]([^'"]+\.js)['"]/g)].map(match => match[1]);
    const paths = new Set([
      ...(manifest.content_scripts || []).flatMap(entry => [...(entry.js || []), ...(entry.css || [])]),
      ...[...workerText.matchAll(/importScripts\(([^)]*)\)/g)].flatMap(match => quoted(match[1])).map(name => folder(worker) + name),
      ...[...optionsText.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)].map(match => folder(options) + match[1]),
    ]);
    // Vendored libraries are large and only change with a manifest edit.
    const names = [...paths].filter(path => !path.startsWith('vendor/')).sort();
    const texts = await Promise.all(names.map(read));
    const bytes = new TextEncoder().encode([manifestText, workerText, optionsText, ...texts].join('\u0000'));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  let checking = null;
  function check() {
    checking ||= (async () => {
      try {
        const current = await fingerprint();
        const loaded = (await chrome.storage.session.get(KEY))[KEY];
        if (loaded === current) return;
        // Session storage is emptied by a reload, so a missing value means this
        // is the first check of the code now running. Saving before reloading
        // also rules out a reload loop.
        await chrome.storage.session.set({ [KEY]: current });
        if (!loaded) return;
        // Old pages keep their old scripts; ask them to refresh themselves.
        const tabs = await chrome.tabs.query({}).catch(() => []);
        await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'KAGE_EXTENSION_UPDATED' })));
        chrome.runtime.reload();
      } catch { /* An unreadable or half-written file is checked again next time. */ }
      finally { checking = null; }
    })();
    return checking;
  }
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void check(); });
  void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  void check();
})();
