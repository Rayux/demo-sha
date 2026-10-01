// Test-only deterministic worker: no media decoder, model, or network is used.
import { promises as fs } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
if (args.includes('--check')) {
  if (value('--model').endsWith('not-ready')) { console.error('Install the test model.'); process.exit(1); }
  process.exit(0);
}
const input = value('--input');
const output = value('--output');
const mode = await fs.readFile(input, 'utf8');
const log = path.join(value('--model'), 'workers.log');
await fs.appendFile(log, `start:${path.basename(path.dirname(input))}\n`);
console.log(JSON.stringify({ type: 'progress', progress: 0.5, message: 'Fixture transcription.' }));
await new Promise(resolve => setTimeout(resolve, mode === 'slow' ? 10000 : 100));
if (mode === 'fail') { console.error('Fixture could not decode audio.'); process.exit(1); }
const result = mode === 'silent' ? { duration: 2, cues: [] } : mode === 'multi' ? {
  duration: 6, cues: Array.from({ length: 5 }, (_, index) => ({ start: index, end: index + 0.9, text: `日本語${index}。` })),
} : { duration: 2, cues: [{ start: mode === 'invalid' ? -1 : 0.25, end: 1.5, text: 'こんにちは。' }] };
await fs.writeFile(output, JSON.stringify(result));
await fs.appendFile(log, `finish:${path.basename(path.dirname(input))}\n`);
