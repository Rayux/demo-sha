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

(async () => {
  await loadDotEnv();
  const apiKey = process.env.GROQ_API_KEY?.trim();
  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { "Authorization": "Bearer " + apiKey }
  });
  const data = await res.json();
  console.log(data.data.map(m => m.id));
})();
