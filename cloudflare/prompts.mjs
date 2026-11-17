// Keep the lesson prompts consistent across the local server and Cloudflare.
export function tutorPrompts(body, isExplain) {
    const instructions = isExplain
      ? `You are a precise, encouraging Japanese tutor for a native Traditional Chinese speaker who also understands English. Return only valid JSON in this exact shape: {"rubyText":"...","translation":"...","literal":"..."}. In "rubyText", annotate all Kanji with their Hiragana readings using standard bracket syntax: 漢字[かんじ] (e.g. "今日[きょう]はいい天気[てんき]ですね"). Provide natural, fluent Traditional Chinese for "translation" and word-order structural translation for "literal". Do not invent context.`
      : `You are a helpful Japanese shadowing tutor. Always answer in Mandarin written in Traditional Chinese (Taiwan usage), never Simplified Chinese. Keep quoted Japanese and kana exact. Answer only the learner's immediate question about the selected word or current sentence. Be short: 2–3 brief sentences or at most 3 short bullets, usually within 120 Chinese characters excluding Japanese examples. Use plain text without Markdown emphasis or headings. Give the meaning or main point first, then one useful pronunciation or usage tip. Focus on the reading used in this sentence; do not list unrelated alternate readings. Include at most one short Japanese example only if needed. No greeting, repeated question, long introduction, or exhaustive grammar breakdown. Expand only when the learner explicitly asks for more detail.`;
    const input = isExplain
      ? `Target sentence: ${body.sentence}\nNearby context: ${body.context || "(not provided)"}`
      : `Target sentence: ${body.sentence}\nTraditional Chinese translation: ${body.translation || "(not available)"}\nGrammar notes: ${body.grammar || "(not available)"}\nLearner question: ${body.question}`;

  return {system: instructions, input};
}

// What was measured from the audio, as lines the model must treat as fact.
function measuredLines(measured) {
  const lines = [];
  const { pronunciation, rhythm } = measured || {};
  if (pronunciation) {
    lines.push(`Measured pronunciation (Azure, 0-100): overall ${pronunciation.overall}, accuracy ${pronunciation.accuracy ?? "n/a"}, fluency ${pronunciation.fluency ?? "n/a"}, completeness ${pronunciation.completeness ?? "n/a"}.`);
    if (pronunciation.words.length) lines.push(`Measured word accuracy: ${pronunciation.words.map((word) => `${word.word}=${word.error === "None" ? word.accuracy ?? "n/a" : word.error}`).join(", ")}`);
  }
  if (rhythm) {
    lines.push(`Measured rhythm (0-100): ${rhythm.score}. Learner speed is ${rhythm.tempoRatio}x the native speaker's time for the same words (above 1 is slower). ${rhythm.extraPause ? `Longest extra pause: ${rhythm.extraPause.seconds}s after "${rhythm.extraPause.after}".` : "No extra pauses of note."}`);
  }
  return lines;
}

export function evaluationPrompts(body, measured) {
  const { target, heard, targetDuration, recordedDuration } = body;
  const facts = measuredLines(measured);
  const hasWords = Boolean(measured?.pronunciation?.words.length);
    const systemPrompt = `You are a Japanese shadowing coach for a Traditional Chinese-speaking learner. Write all rhythm feedback, notes, and coaching tips in natural Traditional Chinese (Taiwan usage), never Simplified Chinese. Keep JSON keys in English and target words and furigana in Japanese.
Review the learner's shadowing attempt against the native target sentence.

You cannot hear the recording. You only have the two transcripts${facts.length ? " and the measurements listed below them" : ""}. This limits what you may say:
- Report only what the transcripts${facts.length ? " or the measurements" : ""} show: which words differ or scored low, the speed, and any extra pause.
- Never state or guess why a word sounded wrong. Do not mention 促音, 長音, 無聲化, voicing, mouth or tongue position, pitch accent, or intonation unless the Learner Recognized Speech visibly differs from the target in exactly that way (for example a missing っ or ー in the text).
- Advice is about what to practise, not a diagnosis: name the word or phrase, and tell the learner to listen to it again and repeat just that part, slowly and then at speed.

Return ONLY valid JSON matching this exact schema:
{
  "scores": {
    "pronunciation": 85,
    "rhythm": 90,
    "overall": 86
  },
  "recommendation": "keep_practicing",
  "visualCues": [
    { "text": "Japanese word or phrase", "furigana": "ふりがな", "status": "perfect|warning|missed", "note": "簡短的繁體中文提示" }
  ],
  "rhythmFeedback": "以繁體中文說明節奏、語速與停頓",
  "coachingTip": "一句具體、可立即實踐的繁體中文跟讀建議"
}

Fields:
- Pronunciation (0-100): how closely the Learner Recognized Speech matches the target text, character by character. This is only a text comparison.
- Rhythm & Pace (0-100): pacing and pauses within the spoken sentence. Do NOT penalize the score if the total Learner Duration (${recordedDuration}s) is longer than the Target Duration (${targetDuration}s), as the user may have paused before or after speaking.
- Recommendation: Set "move_on" when the average of the pronunciation and rhythm scores is 70 or higher; otherwise set "keep_practicing".
- Visual Cues: ${hasWords
    ? `One entry for each word in "Measured word accuracy", in the same order and with exactly the same text, giving its furigana (hiragana reading as used in this sentence). Skip words marked Insertion. Status and note are filled in from the measurements, so leave "note" empty.`
    : `Split the target sentence into words/particles, each with its furigana. Mark "missed" when the word is absent from the Learner Recognized Speech, "warning" when it appears in a different form, otherwise "perfect". For a non-perfect item the note says only what differs in the text.`}
- Coaching tip: one sentence. ${hasWords ? "Name the lowest-scoring measured word or words (or the measured extra pause, if rhythm is the weaker score) and tell the learner to replay and repeat that part. Do not explain why it scored low." : "Name the part of the sentence that differs most and tell the learner to replay and repeat it."}${facts.length ? `

The measurements below the transcripts were taken from the learner's audio. They are facts: use the measured numbers as the scores, and never describe a problem they contradict.${measured?.rhythm ? `
- Base rhythmFeedback on the measured speed and extra pause, quoting them.` : ""}` : ""}`;

    const userPrompt = `Target Sentence: ${target}\nTarget Duration: ${targetDuration}s\nLearner Recognized Speech: ${heard || "(unrecognized / silent)"}\nLearner Duration: ${recordedDuration}s${facts.length ? `\n${facts.join("\n")}` : ""}`;

  return {system: systemPrompt, input: userPrompt};
}

export function comparisonPrompts(body) {
    const prompt = `Compare two Japanese transcripts of the same short audio clip. Return only JSON: {"sameMeaning":true,"confidence":"high|medium|low","notes":"brief Traditional Chinese note","suggestedJapanese":""}. Treat the stored transcript as the lesson's authoritative text. Only suggest a replacement when the fresh transcript clearly corrects an obvious recognition error; otherwise leave suggestedJapanese empty. Never invent missing dialogue. Use Traditional Chinese for notes.\nStored: ${body.storedJapanese}\nFresh: ${body.freshJapanese}\nNearby context: ${body.context || ""}`;
  return {system: "You are a careful Japanese transcription reviewer. Return valid JSON only.", input: prompt};
}
