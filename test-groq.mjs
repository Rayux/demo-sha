import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

async function loadDotEnv() {
  const envPath = ".env";
  if (!existsSync(envPath)) return;
  const contents = await readFile(envPath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

async function groqChat(systemInstruction, userContent, jsonMode = false) {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  const envModel = process.env.GROQ_CHAT_MODEL || "openai/gpt-oss-120b";
  console.log("Using model:", envModel);

  const payload = {
    model: envModel,
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
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error("Groq API error (" + response.status + "): " + errText);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

const instructions = `You are a precise, encouraging Japanese tutor for a native Traditional Chinese speaker who also understands English. Return only valid JSON in this exact shape: {"rubyText":"...","translation":"...","literal":"..."}. In "rubyText", annotate all Kanji with their Hiragana readings using standard bracket syntax: 漢字[かんじ] (e.g. "今日[きょう]はいい天気[てんき]ですね"). Provide natural, fluent Traditional Chinese for "translation" and word-order structural translation for "literal". Do not invent context.`;
const input = `Target sentence: 今日はいい天気ですね\nNearby context: (not provided)`;

(async () => {
  try {
    await loadDotEnv();
    const text = await groqChat(instructions, input, true);
    console.log("Raw output:");
    console.log(text);
  } catch (err) {
    console.error(err);
  }
})();
