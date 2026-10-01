// Shared cue utilities. Timing is kept even when the same sentence repeats.
(() => {
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
  function time(value, tickRate = 1, frameRate = 30) {
    const s = String(value || '').trim();
    const offset = s.match(/^([\d.]+)(h|m|s|ms|t|f)$/);
    if (offset) return Number(offset[1]) * ({ h: 3600, m: 60, s: 1, ms: .001, t: 1 / tickRate, f: 1 / frameRate }[offset[2]]);
    const parts = s.split(':').map(Number);
    if (parts.some(n => !Number.isFinite(n)) || !s) return NaN;
    if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / frameRate;
    return parts.reduce((a, b) => a * 60 + b, 0);
  }
  function parse(raw) {
    let cues = [];
    const clean = text => {
      const doc = new DOMParser().parseFromString(String(text).replace(/<br\s*\/?\s*>/gi, ' '), 'text/html');
      return normalize(doc.body.textContent);
    };
    if (raw.trim().startsWith('{')) {
      const data = JSON.parse(raw);
      cues = (data.body || []).map(c => ({ start: Number(c.from), end: Number(c.to), text: normalize(c.content) }));
    } else if (raw.includes('WEBVTT')) {
      for (const block of raw.replace(/\r/g, '').split(/\n\s*\n/)) {
        const lines = block.split('\n');
        const i = lines.findIndex(line => line.includes('-->'));
        if (i < 0) continue;
        const [start, end] = lines[i].split('-->').map(s => s.trim().split(/\s/)[0]);
        cues.push({ start: time(start), end: time(end), text: clean(lines.slice(i + 1).join(' ')) });
      }
    } else {
      const doc = new DOMParser().parseFromString(raw, 'text/xml');
      if (doc.querySelector('parsererror')) return [];
      const root = doc.documentElement;
      const attr = name => Array.from(root.attributes).find(a => a.localName === name)?.value;
      const frameRate = Number(attr('frameRate') || 30);
      const multiplier = (attr('frameRateMultiplier') || '1 1').split(/\s+/).map(Number);
      const fps = frameRate * multiplier[0] / multiplier[1];
      const ticks = Number(attr('tickRate') || (attr('frameRate') ? fps * Number(attr('subFrameRate') || 1) : 1));
      const seconds = value => time(value, ticks, fps);
      for (const p of doc.getElementsByTagNameNS('*', 'p')) {
        let base = 0;
        for (let parent = p.parentElement; parent && parent !== root; parent = parent.parentElement) {
          if (parent.hasAttribute('begin')) base += seconds(parent.getAttribute('begin'));
        }
        const start = base + seconds(p.getAttribute('begin') || '0s');
        const end = p.hasAttribute('end') ? base + seconds(p.getAttribute('end')) : start + seconds(p.getAttribute('dur'));
        const copy = p.cloneNode(true);
        for (const rt of Array.from(copy.getElementsByTagNameNS('*', 'rt'))) rt.remove();
        for (const br of Array.from(copy.getElementsByTagNameNS('*', 'br'))) br.replaceWith(' ');
        cues.push({ start, end, text: normalize(copy.textContent) });
      }
    }
    return cues.filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.text)
      .sort((a, b) => a.start - b.start).map((c, id) => ({ ...c, id }));
  }
  const active = (cues, position) => cues.filter(c => c.start <= position && position < c.end);
  function matchingTrack(tracks, position, text) {
    const compact = value => normalize(value).replace(/\s/g, '');
    const candidates = [...tracks].filter(([, cues]) => cues.length && (!cues.language || /^ja(?:[-_]|$)/i.test(cues.language)));
    const exact = text && candidates.find(([, cues]) => compact(active(cues, position).map(c => c.text).join('')) === compact(text));
    if (exact) return exact;
    // Explicit language metadata is sufficient even in caption gaps or with different line breaks.
    const japanese = candidates.filter(([, cues]) => /^ja(?:[-_]|$)/i.test(cues.language || ''));
    return japanese.length === 1 ? japanese[0] : null;
  }
  globalThis.KageSubtitles = { normalize, time, parse, active, matchingTrack };
})();
