// Manifest metadata determines language. Never infer Traditional Chinese from Han characters.
(() => {
  const traditional = language => /^zh[-_](?:Hant(?:[-_].*)?|TW|HK|MO)$/i.test(language || '');
  function safeURL(value) {
    if (typeof value !== 'string' || value.length > 8192) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && /(^|\.)(netflix\.com|nflxvideo\.net|nflxext\.com)$/.test(url.hostname) ? url.href : null;
    } catch { return null; }
  }
  function downloadURL(track) {
    const formats = track.ttDownloadables || track.downloadables || {};
    // Skip image-based subtitle formats; prefer WebVTT over TTML/DFXP.
    const names = Object.keys(formats).filter(name => /webvtt|dfxp|ttml|imsc/i.test(name)).sort((a, b) => Number(!/webvtt/i.test(a)) - Number(!/webvtt/i.test(b)));
    for (const name of names) {
      const format = formats[name];
      const values = format?.downloadUrls || format?.urls || {};
      for (const item of Object.values(values)) {
        const url = safeURL(typeof item === 'string' ? item : item?.url);
        if (url) return url;
      }
    }
    return null;
  }
  const titleId = value => (typeof value === 'string' || Number.isSafeInteger(value)) && /^\d{1,20}$/.test(String(value)) ? String(value) : null;
  function collect(value, wantedId = null) {
    const found = [];
    const seen = new WeakSet();
    let remaining = 5000;
    let properties = 20000;
    function visit(node, depth) {
      if (!node || typeof node !== 'object' || seen.has(node) || depth > 12 || --remaining < 0 || found.length >= 64) return;
      seen.add(node);
      const list = node.timedtexttracks || node.textTracks;
      const id = titleId(node.movieId ?? node.viewableId ?? node.videoId);
      // Keep each track attached to its explicit title; never borrow an ancestor's ID.
      if (id && (wantedId === null || id === wantedId) && Array.isArray(list)) {
        for (const track of list.slice(0, 128)) {
          if (found.length >= 64) break;
          if (!track || track.isNoneTrack || track.isForcedNarrative || /forced/i.test(track.rawTrackType || '')) continue;
          const language = track.language || track.bcp47 || '';
          const label = track.languageDescription || track.displayName || '';
          const hant = traditional(language) || (/^zh(?:[-_]|$)/i.test(language) && /traditional|繁體|繁体/i.test(label));
          if (!hant && !/^ja(?:[-_]|$)/i.test(language)) continue;
          const url = downloadURL(track);
          if (url) found.push({ id: String(track.new_track_id || track.id || url).slice(0, 8192), videoId: id, language: hant ? 'zh-Hant' : 'ja', url });
        }
      }
      for (const key in node) {
        if (--properties < 0 || remaining < 0 || found.length >= 64) break;
        if (Object.prototype.hasOwnProperty.call(node, key)) visit(node[key], depth + 1);
      }
    }
    visit(value, 0);
    return found;
  }
  function extract(value, wantedId) {
    const id = titleId(wantedId);
    return id ? collect(value, id) : [];
  }
  globalThis.KageNetflix = { extract, discover: value => collect(value), traditional, safeURL };
})();
