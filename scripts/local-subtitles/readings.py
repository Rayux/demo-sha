"""Words whose reading depends on what was said, not on how they are written.

The extension's furigana comes from a dictionary that only sees the text, so it
reads 行った the same way in 一人で行った (いった) and 会議を行った (おこなった).
The worker has the audio: for each word here it asks Whisper which candidate
reading best matches the sound. Only this short list is checked, so the pass
stays quick and cannot disturb words that have a single reading.
"""
import re

_KANJI = '一-龯々'


def _alone(word):
    """The word with no kanji touching it, so 方 does not match inside 方法 or 夕方."""
    return rf'(?<![{_KANJI}])({word})(?![{_KANJI}])'


# (pattern with one group for the characters being read, candidate readings of that group)
HETERONYMS = [(re.compile(pattern), readings) for pattern, readings in [
    (r'(行っ)(?=[たてち])', ['いっ', 'おこなっ']),
    (r'(通っ)(?=[たてち])', ['とおっ', 'かよっ']),
    (r'(開い)(?=[たて])', ['あい', 'ひらい']),
    (r'(開)(?=く)', ['あ', 'ひら']),
    (r'(空い)(?=[たて])', ['あい', 'すい']),
    (r'(止)(?=め[るたてなろよま])', ['と', 'や']),
    (r'(描)(?=[くいかけこき])', ['か', 'えが']),
    (r'(抱)(?=[くいかけこき])', ['だ', 'いだ']),
    (r'(弾)(?=[くいかけこき])', ['ひ', 'はじ']),
    (r'(怒)(?=[るっらりれろ])', ['おこ', 'いか']),
    (r'(脅か)(?=[すしさせそ])', ['おどか', 'おびやか']),
    (r'(被っ)(?=[たて])', ['かぶっ', 'こうむっ']),
    (r'(辛)(?=い|く|かっ|さ|そう)', ['から', 'つら']),
    (r'(臭い)', ['くさい', 'におい']),
    (r'(汚れ)', ['よごれ', 'けがれ']),
    (_alone('方'), ['かた', 'ほう', 'がた']),
    (_alone('私'), ['わたし', 'わたくし', 'あたし']),
    (_alone('何'), ['なに', 'なん']),
    (_alone('家'), ['いえ', 'うち']),
    (_alone('間'), ['あいだ', 'ま']),
    (_alone('後') + '(?!ろ)', ['あと', 'のち']),
    (_alone('他'), ['ほか', 'た']),
    (_alone('外'), ['そと', 'ほか']),
    (_alone('側'), ['そば', 'がわ']),
    (_alone('辺'), ['あたり', 'へん']),
    (_alone('訳'), ['わけ', 'やく']),
    (_alone('金'), ['かね', 'きん']),
    (_alone('風'), ['かぜ', 'ふう']),
    (_alone('角'), ['かど', 'つの', 'かく']),
    (_alone('床'), ['ゆか', 'とこ']),
    (_alone('魚'), ['さかな', 'うお']),
    (_alone('頭'), ['あたま', 'かしら']),
    (_alone('君'), ['きみ', 'くん']),
    (_alone('表'), ['おもて', 'ひょう']),
    (_alone('人気'), ['にんき', 'ひとけ']),
    (_alone('市場'), ['いちば', 'しじょう']),
    (_alone('工場'), ['こうじょう', 'こうば']),
    (_alone('牧場'), ['ぼくじょう', 'まきば']),
    (_alone('今日'), ['きょう', 'こんにち']),
    (_alone('明日'), ['あした', 'あす', 'みょうにち']),
    (_alone('昨日'), ['きのう', 'さくじつ']),
    (_alone('一日'), ['いちにち', 'ついたち']),
    (_alone('一時'), ['いちじ', 'いっとき', 'ひととき']),
    (_alone('何人'), ['なんにん', 'なにじん']),
    (_alone('上手'), ['じょうず', 'うま', 'かみて']),
    (_alone('下手'), ['へた', 'したて', 'しもて']),
    (_alone('大事'), ['だいじ', 'おおごと']),
    (_alone('最中'), ['さいちゅう', 'もなか']),
    (_alone('寒気'), ['さむけ', 'かんき']),
    (_alone('博士'), ['はかせ', 'はくし']),
    (_alone('身体'), ['からだ', 'しんたい']),
    # Dialogue often gives these a spoken reading that differs from the written word.
    (_alone('理由'), ['りゆう', 'わけ']),
    (_alone('運命'), ['うんめい', 'さだめ']),
    (_alone('本気'), ['ほんき', 'まじ']),
]]
CONTEXT = 2
MAX_PER_CUE = 6


def ambiguous(text):
    """Spans of `text` to check: (start, end, candidate readings), left to right, never overlapping."""
    found = []
    for pattern, readings in HETERONYMS:
        for match in pattern.finditer(text):
            found.append((match.start(1), match.end(1), readings))
    found.sort(key=lambda item: (item[0], -item[1]))
    spans, cursor = [], 0
    for start, end, readings in found:
        if start >= cursor:
            spans.append((start, end, readings))
            cursor = end
    return spans[:MAX_PER_CUE]


def choose(scores, margin):
    """The best candidate, or None when the audio does not clearly favour one."""
    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    if len(ranked) < 2 or ranked[0][1] - ranked[1][1] < margin:
        return None
    return ranked[0][0]


def check_cue(cue, scorer, margin=2.0):
    """Corrections for one cue. `scorer(text)` returns how well `text` matches the cue's audio."""
    text = cue['text']
    results = []
    for start, end, readings in ambiguous(text):
        scores = {reading: scorer(text[:start] + reading + text[end:]) for reading in readings}
        reading = choose(scores, margin)
        if reading:
            # The helper may split a long line, so the word is found again by its neighbours.
            results.append({'from': cue['start'], 'to': cue['end'], 'surface': text[start:end], 'reading': reading,
                            'before': text[max(0, start - CONTEXT):start], 'after': text[end:end + CONTEXT]})
    return results
