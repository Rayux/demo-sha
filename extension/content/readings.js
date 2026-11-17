// Furigana is local and independent of the translation provider and its response timing.
(() => {
  let tokenizer = null;
  let state = 'loading';
  const cache = new Map();
  const CONTENT = new Set(['名詞', '動詞', '形容詞', '副詞', '連体詞', '接続詞', '感動詞']);
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
      // Content words can be marked as known, by dictionary form (食べた counts as 食べる).
      const content = CONTENT.has(token.pos) && token.pos_detail_1 !== '数' && /[\u3040-\u30ff\u3400-\u9fff]/.test(word);
      result.push({ japanese: word, furigana: /[\u3400-\u9fff々]/.test(word) && token.reading ? hiragana(token.reading) : '',
        ...(content ? { word: true, base: token.basic_form && token.basic_form !== '*' ? token.basic_form : word } : {}) });
      offset = start + word.length;
    }
    if (offset < text.length) result.push({ japanese: text.slice(offset) });
    cache.set(text, result);
    if (cache.size > 3000) cache.delete(cache.keys().next().value);
    return result;
  }
  // Every reading the dictionary has for exactly this word, such as いっ and おこなっ for 行っ.
  const known = new Map();
  function alternatives(word) {
    if (!tokenizer) return [];
    if (known.has(word)) return known.get(word);
    let readings = [];
    try {
      const dictionary = tokenizer.token_info_dictionary;
      const id = tokenizer.viterbi_builder.trie.lookup(word);
      readings = [...new Set((id >= 0 ? dictionary.target_map[id] || [] : [])
        .map(entry => hiragana(dictionary.getFeatures(String(entry)).split(',')[8] || '')).filter(Boolean))];
    } catch { /* The dictionary layout changed: only its first reading is used. */ }
    known.set(word, readings);
    if (known.size > 3000) known.delete(known.keys().next().value);
    return readings;
  }
  globalThis.KageReadings = { ready, chunks, hiragana, alternatives, get state() { return state; } };
})();
