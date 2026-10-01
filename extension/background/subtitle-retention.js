// Chrome alarms also run when no Bilibili tabs are open.
(() => {
  const PREFIX = 'kageImportedTrackV2:';
  const LEGACY = 'kageImportedTracksV1';
  const ALARM = 'kage-subtitle-retention';
  const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
  const expired = value => value && !value.deleted &&
    (Number(value.expiresAt) || (Number(value.updatedAt) || Date.now()) + RETENTION_MS) <= Date.now();
  let cleanup = Promise.resolve();
  function sweep() {
    cleanup = cleanup.catch(() => {}).then(async () => {
      const state = await chrome.storage.local.get(null);
      // Remove legacy copies first so deleting a V2 record cannot resurrect one.
      if (Array.isArray(state[LEGACY])) {
        const kept = state[LEGACY].filter(value => !expired(value) && !state[PREFIX + value?.key]);
        if (kept.length !== state[LEGACY].length) await chrome.storage.local.set({ [LEGACY]: kept });
      }
      const keys = Object.entries(state).filter(([key, value]) => key.startsWith(PREFIX) && expired(value)).map(([key]) => key);
      if (keys.length) await chrome.storage.local.remove(keys);
    });
    return cleanup.catch(error => console.warn('Subtitle cleanup failed:', error.message));
  }
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void sweep(); });
  void chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  void sweep();
})();
