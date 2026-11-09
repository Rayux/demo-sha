(() => {
  const origins = ['https://*.googlevideo.com/*'];
  const button = document.getElementById('youtubeDownloadsBtn');
  const status = document.getElementById('youtubeDownloadsStatus');
  let enabled = false;
  function render() {
    button.disabled = false;
    button.textContent = enabled ? 'Disable YouTube media access' : 'Enable YouTube media access';
    status.textContent = enabled
      ? 'Enabled and remembered. Kage uses this access automatically; no changes are needed when switching your VPN on or off.'
      : 'Optional access is not enabled. Kage still tries the player’s audio automatically. Enable only if a full-file download needs media-server access.';
  }
  chrome.permissions.contains({ origins }).then(value => { enabled = value; render(); })
    .catch(() => { button.disabled = true; status.textContent = 'Reload Kage to check YouTube media-server access.'; });
  button.addEventListener('click', () => {
    // Call request directly during the real user's click, before any await.
    const operation = enabled ? chrome.permissions.remove({ origins }) : chrome.permissions.request({ origins });
    button.disabled = true;
    operation.then(async () => { enabled = await chrome.permissions.contains({ origins }); render(); })
      .catch(() => { button.disabled = false; status.textContent = 'Access was not changed. You can try again or keep using the existing preparation options.'; });
  });
})();
