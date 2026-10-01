// Publish a plain-text/TSV transcript exported from ChatGPT.
// Format:
// SOURCE<TAB>exact MP3 filename
// DURATION<TAB>653.87
// CLIP<TAB>start<TAB>end<TAB>Japanese<TAB>Japanese with 漢字[かんじ]<TAB>繁體中文
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const root = path.resolve(import.meta.dirname, "..");
for (const line of (await fs.readFile(path.join(root, ".env"), "utf8")).split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}
const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/publish-prepared-text.mjs path/to/episode.tsv");
const lines = (await fs.readFile(path.resolve(input), "utf8")).split(/\r?\n/);
let source = "", duration = 0;
const clips = [];
for (const raw of lines) {
  if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
  const fields = raw.split("\t");
  if (fields[0] === "SOURCE") { source = fields.slice(1).join("\t").trim(); continue; }
  if (fields[0] === "DURATION") { duration = Number(fields[1]); continue; }
  if (fields[0] !== "CLIP") continue;
  if (fields.length < 6) throw new Error(`Invalid CLIP row: ${raw}`);
  clips.push({ start: Number(fields[1]), end: Number(fields[2]), japanese: fields[3], rubyText: fields[4], translation: fields.slice(5).join("\t") });
}
if (!source || !duration || !clips.length) throw new Error("SOURCE, DURATION, and at least one CLIP row are required.");
const audioPath = path.join(root, "audio", path.basename(source));
const audio = await fs.readFile(audioPath).catch(() => null);
if (!audio) throw new Error(`Matching audio file not found: audio/${path.basename(source)}`);
let previous = 0;
for (const [i, clip] of clips.entries()) {
  if (![clip.start, clip.end].every(Number.isFinite) || clip.start < previous - .02 || clip.end <= clip.start || clip.end > duration + .1) throw new Error(`Invalid timestamp at clip ${i + 1}`);
  if (!clip.japanese || !clip.rubyText || !clip.translation) throw new Error(`Missing field at clip ${i + 1}`);
  if (clip.rubyText.replace(/\[[^\]]*\]/g, "") !== clip.japanese) throw new Error(`Furigana changes Japanese at clip ${i + 1}`);
  previous = clip.end;
}
const payload = { source: path.basename(source), duration, clipCount: clips.length, clips, protectedImport: true, importedAt: new Date().toISOString(), sourceSha256: createHash("sha256").update(audio).digest("hex"), provenance: { transcription: "ChatGPT-provided", translation: "ChatGPT-provided Traditional Chinese", humanVerified: false } };
if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) throw new Error("Firebase credentials are required.");
initializeApp({ credential: cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n") }) });
const db = getFirestore();
const id = payload.source.replace(/\.[^.]+$/, "");
const backupDir = path.join(root, "import-data", "publish-backups", new Date().toISOString().replace(/:/g, "-"));
await fs.mkdir(backupDir, { recursive: true });
for (const collection of ["transcripts", "transcriptOverrides"]) {
  const ref = db.collection(collection).doc(id);
  const existing = await ref.get();
  await fs.writeFile(path.join(backupDir, `${collection}-${id}.json`), JSON.stringify(existing.exists ? existing.data() : null, null, 2));
}
await db.collection("transcriptOverrides").doc(id).set(payload);
const saved = await db.collection("transcriptOverrides").doc(id).get();
if (!saved.exists || saved.data().sourceSha256 !== payload.sourceSha256) throw new Error("Firestore readback failed.");
for (const directory of ["transcripts/overrides", "public/transcripts/overrides"]) {
  await fs.mkdir(path.join(root, directory), { recursive: true });
  await fs.writeFile(path.join(root, directory, `${id}.json`), JSON.stringify(payload, null, 2));
}
console.log(`Published and verified ${payload.source} (${clips.length} clips)`);
