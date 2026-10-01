// Publish ChatGPT-prepared episode JSON files into the protected lesson store.
// Usage: node scripts/publish-prepared.mjs import-data/prepared/*.json
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const root = path.resolve(import.meta.dirname, "..");
for (const line of (await fs.readFile(path.join(root, ".env"), "utf8")).split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
}

const files = process.argv.slice(2);
if (!files.length) throw new Error("Provide one or more prepared JSON files.");
const simplified = /[这个们来为说过时对发会从与还没实进动开关让给现]/;
const stripReading = value => value.replace(/\[[^\]]*\]/g, "");
const loaded = [];

for (const supplied of files) {
  const file = path.resolve(supplied);
  const payload = JSON.parse(await fs.readFile(file, "utf8"));
  if (!payload.source || !Array.isArray(payload.clips) || !payload.clips.length) throw new Error(`${file}: source and clips are required`);
  const audioPath = path.join(root, "audio", path.basename(payload.source));
  const audio = await fs.readFile(audioPath).catch(() => null);
  if (!audio) throw new Error(`${file}: no matching audio/${path.basename(payload.source)}`);
  if (!Number.isFinite(payload.duration) || payload.duration <= 0) throw new Error(`${file}: duration is required`);
  let previous = 0;
  for (const [index, clip] of payload.clips.entries()) {
    if (![clip.start, clip.end].every(Number.isFinite) || clip.start < previous - .02 || clip.end <= clip.start || clip.end > payload.duration + .1) throw new Error(`${file} clip ${index}: invalid chronological timestamps`);
    if (!["japanese", "rubyText", "translation"].every(key => typeof clip[key] === "string" && clip[key].trim())) throw new Error(`${file} clip ${index}: Japanese, furigana, and translation are required`);
    if (stripReading(clip.rubyText) !== clip.japanese || /[<>]/.test(clip.rubyText)) throw new Error(`${file} clip ${index}: furigana does not preserve Japanese exactly`);
    if (simplified.test(clip.translation)) throw new Error(`${file} clip ${index}: translation appears to contain Simplified Chinese`);
    previous = clip.end;
  }
  const sourceSha256 = createHash("sha256").update(audio).digest("hex");
  loaded.push({ ...payload, source: path.basename(payload.source), sourceSha256, protectedImport: true, importedAt: new Date().toISOString(), provenance: { ...(payload.provenance || {}), humanVerified: false } });
}

if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) throw new Error("Firebase credentials are required to publish.");
initializeApp({ credential: cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n") }) });
const db = getFirestore();
const backupDir = path.join(root, "import-data", "publish-backups", new Date().toISOString().replace(/:/g, "-"));
await fs.mkdir(backupDir, { recursive: true });
const batch = db.batch();
for (const payload of loaded) {
  const id = payload.source.replace(/\.[^.]+$/, "");
  for (const collection of ["transcripts", "transcriptOverrides"]) {
    const ref = db.collection(collection).doc(id);
    const existing = await ref.get();
    await fs.writeFile(path.join(backupDir, `${collection}-${id}.json`), JSON.stringify(existing.exists ? existing.data() : null, null, 2));
  }
  batch.set(db.collection("transcriptOverrides").doc(id), payload);
}
await batch.commit();

for (const payload of loaded) {
  const id = payload.source.replace(/\.[^.]+$/, "");
  const saved = await db.collection("transcriptOverrides").doc(id).get();
  if (!saved.exists || saved.data().sourceSha256 !== payload.sourceSha256 || saved.data().clipCount !== payload.clips.length) throw new Error(`Firestore readback failed for ${payload.source}`);
  for (const directory of ["transcripts/overrides", "public/transcripts/overrides"]) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
    await fs.writeFile(path.join(root, directory, `${id}.json`), JSON.stringify(payload, null, 2));
  }
  console.log(`Published and verified ${payload.source} (${payload.clips.length} clips)`);
}
