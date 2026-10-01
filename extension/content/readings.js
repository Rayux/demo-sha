// Furigana is local and independent of the translation provider and its response timing.
(() => {
  let tokenizer = null;
  let state = 'loading';
  const cache = new Map();
  const hiragana = text => String(text || '').replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const ready = new Promise(resolve => {
    kuromoji.builder({ dicPath: chrome.runtime.getURL('vendor/kuromoji/dict') }).build((error, value) => {
      tokenizer = error ? null : value;
      state = error ? 'error' : 'ready';
      resolve(!error);
    });
  });
  function chunks(text) {
    if (!tokenizer) return null;
    if (cache.has(text)) return cache.get(text);
    const tokens = tokenizer.tokenize(text);
    // Keep whitespace and punctuation exactly as in the original caption.
    let offset = 0;
    const result = [];
    for (const token of tokens) {
      const word = token.surface_form;
      const start = text.indexOf(word, offset);
      if (start < 0) return [{ japanese: text }];
      if (start > offset) result.push({ japanese: text.slice(offset, start) });
      result.push({ japanese: word, furigana: /[\u3400-\u9fff々]/.test(word) && token.reading ? hiragana(token.reading) : '' });
      offset = start + word.length;
    }
    if (offset < text.length) result.push({ japanese: text.slice(offset) });
    cache.set(text, result);
    if (cache.size > 3000) cache.delete(cache.keys().next().value);
    return result;
  }
  globalThis.KageReadings = { ready, chunks, hiragana, get state() { return state; } };
})();
