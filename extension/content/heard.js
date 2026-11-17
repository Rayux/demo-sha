// Furigana from what was said. The helper writes each prepared line in kana as
// heard in the audio; this lines that kana up with the line's kanji.
// - A word the dictionary knows keeps a dictionary reading, and the audio picks
//   which one (外 as そと or ほか). A heard reading the dictionary does not list
//   is taken as a mishearing, so it cannot replace a correct reading.
// - A word the dictionary does not know, typically a name it can only read
//   kanji by kanji, is shown with exactly what was said.
(() => {
  const KANJI = /[㐀-鿿々〆]/;
  const hiragana = text => String(text || '').replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  // Spelling differences that are not differences in reading: small vowels, and
  // the long-vowel mark, which stands for the vowel before it (ラーメン is らあめん).
  const VOWELS = { あ: 'あかさたなはまやらわがざだばぱゃ', い: 'いきしちにひみりぎじぢびぴ', う: 'うくすつぬふむゆるぐずづぶぷゅ', え: 'えけせてねへめれげぜでべぺ', お: 'おこそとのほもよろをごぞどぼぽょ' };
  function plain(text) {
    let result = '';
    for (const char of hiragana(text).replace(/[ぁぃぅぇぉゎ]/g, c => String.fromCharCode(c.charCodeAt(0) + 1))) {
      if (char !== 'ー') { result += char; continue; }
      const vowel = Object.keys(VOWELS).find(key => VOWELS[key].includes(result.at(-1)));
      if (vowel) result += vowel;
    }
    return result;
  }
  // Reads `text` as kanji runs (to be filled in), kana (must match what was heard), and the rest.
  function parts(text) {
    const result = [];
    for (const match of text.matchAll(/([㐀-鿿々〆]+)|([ぁ-ゖァ-ヺー]+)|([A-Za-z0-9０-９Ａ-Ｚａ-ｚ]+)|[^]/g)) {
      if (match[1]) result.push({ kanji: match[1].length, start: match.index, end: match.index + match[1].length });
      else if (match[2]) { const literal = plain(match[2]); if (literal) result.push({ literal }); }
      else if (match[3]) result.push({ loose: true }); // Digits and Latin letters are spoken in an unknown number of kana.
    }
    return result;
  }
  // The reading of each kanji run of `text`, or [] when the kana does not fit the line.
  function align(text, kana) {
    const heard = plain(kana).replace(/[^ぁ-ゖ]/g, '');
    const items = parts(String(text || ''));
    if (!heard || !items.some(item => item.kanji)) return [];
    const failed = new Set();
    const lengths = new Array(items.length);
    function fit(index, position) {
      if (index === items.length) return position === heard.length;
      const key = index * 100000 + position;
      if (failed.has(key)) return false;
      const item = items[index];
      if (item.literal) {
        if (heard.startsWith(item.literal, position) && fit(index + 1, position + item.literal.length)) return true;
      } else {
        const least = item.kanji ? 1 : 0, most = Math.min(item.kanji ? item.kanji * 4 : 8, heard.length - position);
        for (let length = least; length <= most; length++) {
          if (fit(index + 1, position + length)) { lengths[index] = length; return true; }
        }
      }
      failed.add(key);
      return false;
    }
    if (!fit(0, 0)) return [];
    const runs = [];
    let position = 0;
    items.forEach((item, index) => {
      if (item.literal) position += item.literal.length;
      else {
        // Kanji next to digits or Latin letters cannot be told apart from them in kana (3時 is さんじ).
        if (item.kanji && !items[index - 1]?.loose && !items[index + 1]?.loose) runs.push({ start: item.start, end: item.end, reading: heard.slice(position, position + lengths[index]) });
        position += lengths[index];
      }
    });
    return runs;
  }
  // One reading per chunk whose concatenation is exactly what was heard.
  function combine(options, target, index = 0) {
    if (index === options.length) return target ? null : [];
    for (const option of options[index]) {
      if (!target.startsWith(option)) continue;
      const rest = combine(options, target.slice(option.length), index + 1);
      if (rest) return [option, ...rest];
    }
    return null;
  }
  // Replaces chunk furigana with heard readings. `alternatives(word)` lists the dictionary's readings.
  function apply(chunks, runs, alternatives = () => []) {
    if (!runs.length) return;
    const place = () => { let offset = 0; return chunks.map((chunk, index) => { const start = offset; offset += chunk.japanese.length; return { chunk, index, start, end: offset }; }); };
    // A run of kanji that the dictionary split into several words, such as 筑前 + 煮 or a name.
    for (const run of runs) {
      const covered = place().filter(item => item.end > run.start && item.start < run.end);
      if (covered.length < 2 || covered[0].start !== run.start || covered.at(-1).end !== run.end || covered.some(item => item.chunk.known)) continue;
      const options = covered.map(item => [...new Set([item.chunk.furigana, ...alternatives(item.chunk.japanese)].filter(Boolean))]);
      const readings = combine(options, run.reading);
      if (readings) covered.forEach((item, index) => { item.chunk.furigana = readings[index]; });
      // No real word here: the dictionary fell back to single kanji (a name such as 光雑,
      // said こうざく) or has no reading at all. Show the run as one piece, as it was said.
      else if (covered.every(item => item.chunk.japanese.length === 1) || covered.some(item => !item.chunk.furigana)) chunks.splice(covered[0].index, covered.length, { japanese: covered.map(item => item.chunk.japanese).join(''), furigana: run.reading });
    }
    for (const { chunk, start, end } of place()) {
      if (chunk.known || !KANJI.test(chunk.japanese)) continue;
      const inside = runs.filter(run => run.start >= start && run.end <= end);
      if (!inside.length) continue;
      // The word as heard: its kanji from the audio, its own kana as written.
      let heard = '', position = start, whole = true;
      for (const run of inside) {
        const between = chunk.japanese.slice(position - start, run.start - start);
        if (KANJI.test(between)) { whole = false; break; }
        heard += hiragana(between) + run.reading;
        position = run.end;
      }
      const tail = chunk.japanese.slice(position - start);
      if (!whole || KANJI.test(tail)) continue;
      heard += hiragana(tail);
      if (!chunk.furigana || alternatives(chunk.japanese).includes(heard)) chunk.furigana = heard;
    }
  }
  globalThis.KageHeard = { align, apply };
})();
