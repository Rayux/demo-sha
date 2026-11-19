import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../content/heard.js', import.meta.url), 'utf8'), context);
const { align, apply } = context.KageHeard;
const plain = value => JSON.parse(JSON.stringify(value));
// The dictionary's readings for a word, as the extension's tokenizer reports them.
const dictionary = { '行っ': ['いっ', 'おこなっ'], '外': ['ほか', 'がい', 'そと'], '前': ['まえ', 'ぜん'], '今日': ['きょう', 'こんにち'],
  '辛い': ['つらい', 'からい'], '筑前': ['ちくぜん'], '煮': ['に'], '一': ['いち', 'ひと'], '人': ['ひと', 'にん', 'じん', 'り'] };
const alternatives = word => dictionary[word] || [];

test('heard kana is lined up with the kanji of a line, using the line’s own kana as anchors', () => {
  assert.deepEqual(plain(align('一人で行ったの?', 'ひとりでいったの')), [{ start: 0, end: 2, reading: 'ひとり' }, { start: 3, end: 4, reading: 'い' }]);
  assert.deepEqual(plain(align('ねぇレイ、外へ行ったら何したい?', 'ねぇれいそとへいったらなにしたい')),
    [{ start: 5, end: 6, reading: 'そと' }, { start: 7, end: 8, reading: 'い' }, { start: 11, end: 12, reading: 'なに' }]);
  // Katakana, long-vowel marks and small vowels are spelling, not reading.
  assert.deepEqual(plain(align('辛いラーメンが好き。', 'からいらあめんがすき')), [{ start: 0, end: 1, reading: 'から' }, { start: 7, end: 8, reading: 'す' }]);
  assert.deepEqual(plain(align('お、今日は逐前に。いただきます。', 'おきょうはちくぜんにいただきます')), [{ start: 2, end: 4, reading: 'きょう' }, { start: 5, end: 7, reading: 'ちくぜん' }]);
  // Digits are spoken in an unknown number of kana: the kanji beside them is left to the dictionary, the rest still lines up.
  assert.deepEqual(plain(align('3時に行く', 'さんじにいく')), [{ start: 3, end: 4, reading: 'い' }]);
});

test('kana that does not fit the line is ignored rather than forced', () => {
  assert.deepEqual(plain(align('わかんねぇ、エマは外?', 'もうこんねえまはそと')), []);
  assert.deepEqual(plain(align('そうかな', 'そうかな')), [], 'no kanji, nothing to read');
  assert.deepEqual(plain(align('会議を行った', '')), []);
});

test('the audio picks among the readings the dictionary knows for a word', () => {
  const line = '一人で行ったの?';
  const chunks = [{ japanese: '一', furigana: 'いち' }, { japanese: '人', furigana: 'にん' }, { japanese: 'で' }, { japanese: '行っ', furigana: 'おこなっ' }, { japanese: 'た' }, { japanese: 'の' }, { japanese: '?' }];
  apply(chunks, align(line, 'ひとりでいったの'), alternatives);
  assert.deepEqual(chunks.map(chunk => chunk.furigana || ''), ['ひと', 'り', '', 'いっ', '', '', ''], '一人 is shared out between its two words; 行っ gets its spoken reading');

  const guessed = [{ japanese: '外', furigana: 'ほか' }, { japanese: 'へ' }];
  apply(guessed, align('外へ', 'そとへ'), alternatives);
  assert.equal(guessed[0].furigana, 'そと');
  // A whole word with okurigana: 辛い heard as からい.
  const spicy = [{ japanese: '辛い', furigana: 'つらい' }, { japanese: 'ラーメン' }];
  apply(spicy, align('辛いラーメン', 'からいらーめん'), alternatives);
  assert.equal(spicy[0].furigana, 'からい');
  // A mishearing (そこ for 外) is not a reading of the word, so the dictionary's stays.
  const misheard = [{ japanese: '外', furigana: 'そと' }, { japanese: 'へ' }];
  apply(misheard, align('外へ', 'そこへ'), alternatives);
  assert.equal(misheard[0].furigana, 'そと');
  // The same for a real compound: 一時的 misheard as いじじてき keeps いちじ + てき.
  const compound = [{ japanese: '一時', furigana: 'いちじ' }, { japanese: '的', furigana: 'てき' }];
  apply(compound, align('一時的', 'いじじてき'), word => ({ '一時': ['いちじ', 'いっとき'], '的': ['てき', 'まと'] }[word] || []));
  assert.deepEqual(compound.map(chunk => [chunk.japanese, chunk.furigana]), [['一時', 'いちじ'], ['的', 'てき']]);
});

test('a name the dictionary reads word by word is shown as one piece with the reading that was said', () => {
  // The audio says こうざく; the dictionary would show ひかり + ざつ.
  const name = [{ japanese: 'やはり' }, { japanese: '光', furigana: 'ひかり', word: true, base: '光' }, { japanese: '雑', furigana: 'ざつ', word: true, base: '雑' }, { japanese: 'は' }, { japanese: 'ここ' }];
  apply(name, align('やはり光雑はここ', 'やはりこうざくはここ'), word => ({ '光': ['ひかり', 'こう'], '雑': ['ざつ', 'ぞう'] }[word] || []));
  assert.deepEqual(name.map(chunk => [chunk.japanese, chunk.furigana || '']), [['やはり', ''], ['光雑', 'こうざく'], ['は', ''], ['ここ', '']]);

  // 逐 is not in the dictionary: the run 逐前 is read from the audio as a whole.
  const chunks = [{ japanese: '今日', furigana: 'きょう' }, { japanese: 'は' }, { japanese: '逐', furigana: '' }, { japanese: '前', furigana: 'まえ' }, { japanese: 'に' }];
  apply(chunks, align('今日は逐前に', 'きょうはちくぜんに'), alternatives);
  assert.deepEqual(chunks.map(chunk => [chunk.japanese, chunk.furigana || '']), [['今日', 'きょう'], ['は', ''], ['逐前', 'ちくぜん'], ['に', '']]);
  // The correct kanji reads the same way from the dictionary and the audio.
  const correct = [{ japanese: '筑前', furigana: 'ちくぜん' }, { japanese: '煮', furigana: 'に' }];
  apply(correct, align('筑前煮', 'ちくぜんに'), alternatives);
  assert.deepEqual(correct.map(chunk => chunk.furigana), ['ちくぜん', 'に']);
  // A word marked as known shows no furigana and gets none back.
  const known = [{ japanese: '行っ', furigana: '', known: true }, { japanese: 'た' }];
  apply(known, align('行った', 'いった'), alternatives);
  assert.equal(known[0].furigana, '');
  // Kana that does not fit the line changes nothing.
  const kept = [{ japanese: '外', furigana: 'そと' }, { japanese: 'へ' }];
  apply(kept, align('外へ', 'まったくちがう'), alternatives);
  assert.equal(kept[0].furigana, 'そと');
});
