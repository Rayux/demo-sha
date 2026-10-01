import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.cloudflare');
const assets = path.join(out, 'public');
const maxAsset = 25 * 1024 * 1024;
const partSize = 4 * 1024 * 1024;
await rm(out, { recursive: true, force: true });
await mkdir(assets, { recursive: true });
// Explicit public directory only: never package .env, dependencies, or source files.
await cp(path.join(root, 'public'), assets, { recursive: true, filter: source => !path.basename(source).startsWith('.') });
await rm(path.join(assets, 'audio'), { recursive: true, force: true });
await mkdir(path.join(assets, 'audio'), { recursive: true });
await mkdir(path.join(assets, '__media'), { recursive: true });
await mkdir(path.join(assets, 'data'), { recursive: true });
await cp(path.join(root, 'transcripts'), path.join(assets, 'transcripts'), { recursive: true, filter: source => !path.basename(source).startsWith('.') });

const manifest = { files: [], chunked: {} };
const types = { '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.wav': 'audio/wav' };
for (const name of (await readdir(path.join(root, 'audio'))).filter(n => /\.(mp3|mp4|m4a|wav)$/i.test(n)).sort()) {
  const source = path.join(root, 'audio', name);
  const info = await stat(source);
  if (!info.isFile()) continue;
  manifest.files.push({ name, url: `/audio/${encodeURIComponent(name)}` });
  // Package all tracks the same way so seeking also works when the asset
  // backend ignores Range. Small parts bound the bytes discarded on a seek.
  const bytes = await readFile(source);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += partSize) {
    const part = bytes.subarray(offset, offset + partSize);
    const relative = `/__media/${hash}-${parts.length}.bin`;
    await writeFile(path.join(assets, relative), part);
    parts.push({ path: relative, offset, size: part.length });
  }
  manifest.chunked[name] = { size: bytes.length, type: types[path.extname(name).toLowerCase()], hash, parts };
}
await writeFile(path.join(out, 'media.json'), JSON.stringify(manifest));
await writeFile(path.join(assets, 'data/library.json'), JSON.stringify({ files: manifest.files }, null, 2));

let count = 0;
async function validate(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await validate(file);
    else {
      count++;
      if ((await stat(file)).size > maxAsset) throw new Error(`Asset exceeds Cloudflare's 25 MiB limit: ${path.relative(assets, file)}`);
    }
  }
}
await validate(assets);
if (count > 20000) throw new Error('The build exceeds the free plan’s 20,000 asset limit.');
console.log(`Cloudflare build: ${manifest.files.length} audio tracks packaged losslessly, ${count} assets.`);
