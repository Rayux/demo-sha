import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const AUDIO = path.join(ROOT, "audio");
const TRANSCRIPTS = path.join(ROOT, "transcripts");
const PORT = Number(process.env.PORT || 4173);

await loadDotEnv();

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  // This intentionally supports only simple KEY=value lines so no dependency is needed.
  return readFile(envPath, "utf8").then((contents) => {
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['\"]|['\"]$/g, "");
    }
  });
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".wav": "audio/wav" })[ext] || "application/octet-stream";
}

async function readBody(req, maxBytes = 42 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("The request is too large. Analyze one short clip at a time.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function groqTranscribe(audioBytes, mimeType = "audio/wav", filename = "clip.wav") {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) return null;
  const model = process.env.GROQ_MODEL || "whisper-large-v3-turbo";
  try {
    const form = new FormData();
    const blob = new Blob([audioBytes], { type: mimeType });
    form.append("file", blob, filename);
    form.append("model", model);
    form.append("language", "ja");
    form.append("response_format", "json");

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}` },
      body: form
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[Groq Whisper] Request failed (${response.status}):`, errorText);
      return null;
    }

    const data = await response.json();
    return {
      text: (data.text || "").trim(),
      modelUsed: `Groq Whisper (${model})`,
      provider: "groq"
    };
  } catch (err) {
    console.warn("[Groq Whisper] Network/processing error:", err.message);
    return null;
  }
}

async function openaiTranscribe(audioBytes, mimeType = "audio/wav", filename = "clip.wav") {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const model = process.env.OPENAI_WHISPER_MODEL || "whisper-1";
  try {
    const form = new FormData();
    const blob = new Blob([audioBytes], { type: mimeType });
    form.append("file", blob, filename);
    form.append("model", model);
    form.append("language", "ja");
    form.append("response_format", "json");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}` },
      body: form
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[OpenAI Whisper] Request failed (${response.status}):`, errorText);
      return null;
    }

    const data = await response.json();
    return {
      text: (data.text || "").trim(),
      modelUsed: `OpenAI Whisper (${model})`,
      provider: "openai"
    };
  } catch (err) {
    console.warn("[OpenAI Whisper] Network/processing error:", err.message);
    return null;
  }
}

async function groqChat(systemInstruction, userContent, jsonMode = false) {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured.");
  const model = process.env.GROQ_CHAT_MODEL || "openai/gpt-oss-120b";

  const payload = {
    model,
    messages: [
      { role: "system", content: systemInstruction },
      { role: "user", content: userContent }
    ],
    temperature: 0.2
  };
  if (jsonMode) {
    payload.response_format = { type: "json_object" };
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

async function openaiChat(systemInstruction, userContent, jsonMode = false, modelOverride = null) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");
  const model = modelOverride || process.env.OPENAI_MODEL || "gpt-4o-mini";

  const payload = {
    model,
    messages: [
      { role: "system", content: systemInstruction },
      { role: "user", content: userContent }
    ],
    temperature: 0.2
  };
  if (jsonMode) {
    payload.response_format = { type: "json_object" };
  }

  let response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    if (model === "gpt-6" && (response.status === 404 || errText.includes("model_not_found"))) {
      console.warn("[openaiChat] 'gpt-6' not yet available on OpenAI API, falling back to gpt-4o...");
      payload.model = "gpt-4o";
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      if (response.ok) {
        const data = await response.json();
        return data.choices?.[0]?.message?.content || "";
      }
    }
    throw new Error(`OpenAI API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

async function geminiRequest(payload) {
  const model = encodeURIComponent(process.env.GEMINI_MODEL || "gemini-3.8-flash");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) {
    const rawMsg = result?.error?.message || "";
    if (response.status === 503 || response.status === 429 || rawMsg.toLowerCase().includes("demand") || rawMsg.toLowerCase().includes("overloaded")) {
      throw new Error("Gemini 3.8 Flash is currently experiencing high demand. Please wait a few moments and try again.");
    }
    throw new Error(rawMsg || `Gemini API request failed with status ${response.status}.`);
  }
  return result;
}

function geminiText(response) {
  return (response.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("\n");
}

async function proxyTranscription(req, res) {
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasGroq = Boolean(process.env.GROQ_API_KEY?.trim());
  const hasGemini = Boolean(process.env.GEMINI_API_KEY?.trim());
  if (!hasOpenAI && !hasGroq && !hasGemini) {
    return json(res, 503, { error: "AI is not configured. Add OPENAI_API_KEY, GROQ_API_KEY, or GEMINI_API_KEY to .env and restart." });
  }

  try {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) throw new Error("Expected an audio file upload.");
    const body = await readBody(req, 8 * 1024 * 1024);
    const form = await new Request("http://localhost/upload", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body
    }).formData();
    const file = form.get("file");
    if (!file || typeof file.arrayBuffer !== "function") throw new Error("No audio clip was included in the request.");
    const audioBytes = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || "audio/wav";
    const filename = file.name || "clip.wav";

    // 1. Try Groq Whisper first (ultra-fast & free tier)
    if (hasGroq) {
      const groqResult = await groqTranscribe(audioBytes, mimeType, filename);
      if (groqResult) {
        return json(res, 200, {
          text: groqResult.text || "",
          words: [],
          modelUsed: groqResult.modelUsed,
          provider: "groq",
          fallbackTriggered: false
        });
      }
      console.warn("[Transcription] Groq Whisper failed or unavailable. Falling back to OpenAI/Gemini...");
    }

    // 2. Try OpenAI Whisper as backup
    if (hasOpenAI) {
      const openaiResult = await openaiTranscribe(audioBytes, mimeType, filename);
      if (openaiResult) {
        return json(res, 200, {
          text: openaiResult.text || "",
          words: [],
          modelUsed: openaiResult.modelUsed,
          provider: "openai",
          fallbackTriggered: Boolean(hasGroq)
        });
      }
      console.warn("[Transcription] OpenAI Whisper failed. Falling back to Gemini...");
    }

    // 3. Fall back to Gemini
    if (!hasGemini) {
      throw new Error("Whisper transcription was unavailable and no GEMINI_API_KEY is configured as backup.");
    }

    const payload = {
      contents: [{
        role: "user",
        parts: [
          { text: "Transcribe the spoken Japanese in this short audio clip exactly. Return only the Japanese transcription, with natural punctuation. Do not explain or translate." },
          { inlineData: { mimeType: mimeType || "audio/wav", data: audioBytes.toString("base64") } }
        ]
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 1024 }
    };

    const result = await geminiRequest(payload);
    json(res, 200, {
      text: geminiText(result),
      words: [],
      modelUsed: "gemini-3.8-flash",
      provider: "gemini"
    });
  } catch (error) {
    json(res, 500, { error: error.message || "Unable to transcribe this clip." });
  }
}

async function askModel(req, res, kind) {
  const hasGroq = Boolean(process.env.GROQ_API_KEY?.trim());
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasGemini = Boolean(process.env.GEMINI_API_KEY?.trim());
  if (!hasGroq && !hasOpenAI && !hasGemini) return json(res, 503, { error: "AI is not configured. Add GROQ_API_KEY to .env and restart." });

  try {
    const isExplain = kind === "explain";
    const body = JSON.parse((await readBody(req, 512 * 1024)).toString("utf8"));
    const instructions = isExplain
      ? `You are a precise, encouraging Japanese tutor for a native Traditional Chinese speaker who also understands English. Return only valid JSON in this exact shape: {"rubyText":"...","translation":"...","literal":"..."}. In "rubyText", annotate all Kanji with their Hiragana readings using standard bracket syntax: 漢字[かんじ] (e.g. "今日[きょう]はいい天気[てんき]ですね"). Provide natural, fluent Traditional Chinese for "translation" and word-order structural translation for "literal". Do not invent context.`
      : `You are a helpful Japanese shadowing tutor. Always answer in Mandarin written in Traditional Chinese (Taiwan usage), never Simplified Chinese. Keep quoted Japanese and kana exact. Answer only the learner's immediate question about the selected word or current sentence. Be short: 2–3 brief sentences or at most 3 short bullets, usually within 120 Chinese characters excluding Japanese examples. Use plain text without Markdown emphasis or headings. Give the meaning or main point first, then one useful pronunciation or usage tip. Focus on the reading used in this sentence; do not list unrelated alternate readings. Include at most one short Japanese example only if needed. No greeting, repeated question, long introduction, or exhaustive grammar breakdown. Expand only when the learner explicitly asks for more detail.`;
    const input = isExplain
      ? `Target sentence: ${body.sentence}\nNearby context: ${body.context || "(not provided)"}`
      : `Target sentence: ${body.sentence}\nTraditional Chinese translation: ${body.translation || "(not available)"}\nGrammar notes: ${body.grammar || "(not available)"}\nLearner question: ${body.question}`;

    // 1. Prioritize Groq
    if (hasGroq) {
      try {
        const text = await groqChat(instructions, input, isExplain);
        const groqModel = process.env.GROQ_CHAT_MODEL || "openai/gpt-oss-120b";
        if (isExplain) {
          const cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
          try { return json(res, 200, { analysis: JSON.parse(cleaned), modelUsed: `Groq (${groqModel})`, provider: "groq" }); }
          catch { return json(res, 200, { analysis: { rubyText: "", translation: "", literal: "", raw: text }, modelUsed: `Groq (${groqModel})`, provider: "groq" }); }
        }
        return json(res, 200, { answer: text, modelUsed: `Groq (${groqModel})`, provider: "groq" });
      } catch (err) {
        console.warn("[askModel] Groq failed, falling back to OpenAI/Gemini:", err.message);
        if (!hasOpenAI && !hasGemini) throw err;
      }
    }

    // 2. Fallback to OpenAI
    if (hasOpenAI) {
      try {
        const selectedModel = process.env.OPENAI_MODEL || "gpt-4o-mini";
        const text = await openaiChat(instructions, input, isExplain, selectedModel);
        if (isExplain) {
          const cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
          try { return json(res, 200, { analysis: JSON.parse(cleaned), modelUsed: selectedModel, provider: "openai" }); }
          catch { return json(res, 200, { analysis: { rubyText: "", translation: "", literal: "", raw: text }, modelUsed: selectedModel, provider: "openai" }); }
        }
        return json(res, 200, { answer: text, modelUsed: selectedModel, provider: "openai" });
      } catch (err) {
        console.warn("[askModel] OpenAI failed, falling back to Gemini:", err.message);
        if (!hasGemini) throw err;
      }
    }

    const payload = {
      systemInstruction: { parts: [{ text: instructions }] },
      contents: [{ role: "user", parts: [{ text: input }] }],
      generationConfig: isExplain ? { temperature: 0.25, responseMimeType: "application/json" } : { temperature: 0.3 }
    };

    const result = await geminiRequest(payload);
    const text = geminiText(result);
    if (isExplain) {
      const cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
      try { return json(res, 200, { analysis: JSON.parse(cleaned), modelUsed: "gemini-3.8-flash" }); }
      catch { return json(res, 200, { analysis: { rubyText: "", translation: "", literal: "", raw: text }, modelUsed: "gemini-3.8-flash" }); }
    }
    json(res, 200, { answer: text, modelUsed: "gemini-3.8-flash" });
  } catch (error) {
    json(res, 500, { error: error.message || "The AI request could not be completed." });
  }
}

async function evaluateSpeech(req, res) {
  const hasGroq = Boolean(process.env.GROQ_API_KEY?.trim());
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasGemini = Boolean(process.env.GEMINI_API_KEY?.trim());
  if (!hasGroq && !hasOpenAI && !hasGemini) {
    return json(res, 503, { error: "AI is not configured for speech evaluation. Add GROQ_API_KEY to .env." });
  }

  try {
    const body = JSON.parse((await readBody(req, 512 * 1024)).toString("utf8"));
    const { target, heard, targetDuration, recordedDuration } = body;

    const systemPrompt = `You are an elite Japanese phonetician and speech shadowing coach for a Traditional Chinese-speaking learner. Write all rhythm feedback, intonation feedback, pronunciation notes, and coaching tips in natural Traditional Chinese (Taiwan usage), never Simplified Chinese. Keep JSON keys in English and target words and furigana in Japanese.
Analyze the learner's shadowing attempt compared to the native target sentence.

Return ONLY valid JSON matching this exact schema:
{
  "scores": {
    "pronunciation": 85,
    "rhythm": 90,
    "intonation": 82,
    "overall": 86
  },
  "visualCues": [
    { "text": "Japanese word or phrase", "furigana": "ふりがな", "status": "perfect|warning|missed", "note": "簡短、具體的繁體中文發音提示" }
  ],
  "rhythmFeedback": "以繁體中文說明節奏、語速與停頓",
  "intonationFeedback": "以繁體中文說明語調與音高的練習重點",
  "coachingTip": "一句具體、可立即實踐的繁體中文跟讀建議"
}

Scoring criteria:
- Pronunciation (0-100): Mora accuracy, phonetic fidelity, glottal stops (促音), long vowels (長音), and devoicing (無聲化).
- Rhythm & Pace (0-100): Pacing match between target (${targetDuration}s) and user (${recordedDuration}s). Check pauses and smooth mora flow.
- Intonation (0-100): Particle tone (e.g. rising ↗ for questions/agreement, falling ↘ for statements), pitch accent (頭高/中高/尾高/平板) stability.
- Visual Cues: Split the target sentence into words/particles. Mark status as "perfect", "warning" (slight accent/timing hesitation), or "missed". Provide a short note in Traditional Chinese for any non-perfect item.`;

    const userPrompt = `Target Sentence: ${target}\nTarget Duration: ${targetDuration}s\nLearner Recognized Speech: ${heard || "(unrecognized / silent)"}\nLearner Duration: ${recordedDuration}s`;

    let evaluation = null;
    let modelUsed = "";

    // 1. Prioritize Groq
    if (hasGroq) {
      try {
        const reply = await groqChat(systemPrompt, userPrompt, true);
        evaluation = JSON.parse(reply.replace(/^```json\s*|\s*```$/g, "").trim());
        const groqModel = process.env.GROQ_CHAT_MODEL || "openai/gpt-oss-120b";
        modelUsed = `Groq (${groqModel})`;
      } catch (err) {
        console.warn("[evaluateSpeech] Groq failed, falling back to OpenAI/Gemini:", err.message);
        if (!hasOpenAI && !hasGemini) throw err;
      }
    }

    // 2. Fallback to OpenAI
    if (!evaluation && hasOpenAI) {
      try {
        const selectedModel = process.env.OPENAI_MODEL || "gpt-4o-mini";
        const reply = await openaiChat(systemPrompt, userPrompt, true, selectedModel);
        evaluation = JSON.parse(reply.replace(/^```json\s*|\s*```$/g, "").trim());
        modelUsed = selectedModel;
      } catch (err) {
        console.warn("[evaluateSpeech] OpenAI failed, falling back to Gemini:", err.message);
        if (!hasGemini) throw err;
      }
    }

    if (!evaluation && hasGemini) {
      const payload = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
      };
      const result = await geminiRequest(payload);
      const text = geminiText(result).replace(/^```json\s*|\s*```$/g, "").trim();
      evaluation = JSON.parse(text);
      modelUsed = process.env.GEMINI_MODEL || "gemini-3.8-flash";
    }

    json(res, 200, { evaluation, modelUsed });
  } catch (error) {
    console.error("Speech evaluation error:", error);
    json(res, 500, { error: error.message || "Speech evaluation failed." });
  }
}

async function listLibrary(res) {
  try {
    const files = await readdir(AUDIO);
    const audioFiles = files.filter((name) => /\.(mp3|mp4|m4a|wav)$/i.test(name)).sort();
    json(res, 200, { files: audioFiles.map((name) => ({ name, url: `/audio/${encodeURIComponent(name)}` })) });
  } catch {
    json(res, 200, { files: [] });
  }
}

async function serveFile(req, res, directory, pathname) {
  const decoded = decodeURIComponent(pathname);
  const file = path.resolve(directory, `.${decoded}`);
  if (!file.startsWith(directory)) return json(res, 403, { error: "Forbidden" });
  try {
    const info = await stat(file);
    if (!info.isFile()) return json(res, 404, { error: "Not found" });
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      if (start > end || start >= info.size) return json(res, 416, { error: "Requested range is unavailable." });
      res.writeHead(206, {
        "Content-Type": contentType(file),
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${info.size}`,
        "Accept-Ranges": "bytes"
      });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": contentType(file), "Content-Length": info.size, "Accept-Ranges": "bytes" });
    createReadStream(file).pipe(res);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/api/status") {
    const hasGroq = Boolean(process.env.GROQ_API_KEY?.trim());
    const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
    const hasGemini = Boolean(process.env.GEMINI_API_KEY?.trim());
    const groqChatModel = process.env.GROQ_CHAT_MODEL || "openai/gpt-oss-120b";
    const groqModel = process.env.GROQ_MODEL || "whisper-large-v3-turbo";
    const primaryModel = hasGroq ? groqChatModel : (hasOpenAI ? (process.env.OPENAI_MODEL || "gpt-4o-mini") : "gemini-3.8-flash");
    return json(res, 200, {
      aiConfigured: hasGroq || hasOpenAI || hasGemini,
      hasGroq,
      hasOpenAI,
      hasGemini,
      primaryModel,
      groqWhisper: groqModel,
      groqChatModel,
      activeProvider: hasGroq ? "groq" : (hasOpenAI ? "openai" : "gemini")
    });
  }
  if (req.method === "GET" && url.pathname === "/api/library") return listLibrary(res);
  if (req.method === "GET" && url.pathname === "/api/transcript") return getTranscript(req, res, url.searchParams);
  if (req.method === "POST" && url.pathname === "/api/transcript") return saveTranscript(req, res);
  if (req.method === "POST" && url.pathname === "/api/transcribe") return proxyTranscription(req, res);
  if (req.method === "POST" && url.pathname === "/api/explain") return askModel(req, res, "explain");
  if (req.method === "POST" && url.pathname === "/api/chat") return askModel(req, res, "chat");
  if (req.method === "POST" && url.pathname === "/api/evaluate-speech") return evaluateSpeech(req, res);
  if (req.method === "GET" && url.pathname.startsWith("/audio/")) return serveFile(req, res, AUDIO, url.pathname.slice("/audio".length));
  if (req.method === "GET") return serveFile(req, res, PUBLIC, url.pathname === "/" ? "/index.html" : url.pathname);
  json(res, 404, { error: "Not found" });
});

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function generateMarkdownTranscript(filename, clips) {
  let md = `# Shadowing Transcript: ${filename}\n\n`;
  md += `*Updated on ${new Date().toLocaleString()}*\n\n`;
  md += `| # | Time | Japanese Transcript (with Furigana) | 繁體中文翻譯 | 直譯 |\n`;
  md += `| :---: | :---: | :--- | :--- | :--- |\n`;
  clips.forEach((clip, i) => {
    const time = `${formatTime(clip.start)} - ${formatTime(clip.end)}`;
    const jp = (clip.rubyText || clip.japanese || "").replace(/\|/g, "\\|");
    const zh = (clip.translation || "").replace(/\|/g, "\\|");
    const lit = (clip.literal || "").replace(/\|/g, "\\|");
    md += `| ${String(i + 1).padStart(2, "0")} | \`${time}\` | ${jp} | ${zh} | ${lit} |\n`;
  });
  return md;
}

async function getTranscript(req, res, searchParams) {
  const file = searchParams.get("file");
  if (!file) return json(res, 400, { error: "Filename required" });
  const baseName = path.basename(file).replace(/\.[^.]+$/, "");
  const jsonPath = path.join(TRANSCRIPTS, `${baseName}.json`);
  try {
    const raw = await readFile(jsonPath, "utf8");
    const data = JSON.parse(raw);
    json(res, 200, { exists: true, data });
  } catch {
    json(res, 200, { exists: false, data: null });
  }
}

async function saveTranscript(req, res) {
  try {
    const body = JSON.parse((await readBody(req, 10 * 1024 * 1024)).toString("utf8"));
    const { filename, clips } = body;
    if (!filename || !Array.isArray(clips)) return json(res, 400, { error: "Invalid payload" });
    const baseName = path.basename(filename).replace(/\.[^.]+$/, "");
    if (!existsSync(TRANSCRIPTS)) await mkdir(TRANSCRIPTS, { recursive: true });

    // 1. Write formatted JSON data
    const jsonPath = path.join(TRANSCRIPTS, `${baseName}.json`);
    const payload = {
      source: filename,
      updatedAt: new Date().toISOString(),
      clipCount: clips.length,
      clips
    };
    await writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");

    // 2. Write readable Markdown summary
    const mdPath = path.join(TRANSCRIPTS, `${baseName}.md`);
    const mdContent = generateMarkdownTranscript(filename, clips);
    await writeFile(mdPath, mdContent, "utf8");

    json(res, 200, {
      success: true,
      jsonFile: `transcripts/${baseName}.json`,
      mdFile: `transcripts/${baseName}.md`
    });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

server.listen(PORT, "127.0.0.1", () => console.log(`Kage is ready at http://localhost:${PORT}`));
