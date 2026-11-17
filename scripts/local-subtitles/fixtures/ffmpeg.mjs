// Test-only stand-in for FFmpeg: records its arguments and writes a small output file.
import { promises as fs } from 'node:fs';
const args = process.argv.slice(2);
const source = args[args.indexOf('-i') + 1];
const target = args.at(-1);
const mode = await fs.readFile(source, 'utf8');
if (mode === 'broken') { console.error('Fixture could not read the audio.'); process.exit(1); }
console.log('out_time_us=500000\nprogress=continue');
await fs.writeFile(`${target}.args.json`, JSON.stringify(args));
await fs.writeFile(target, 'condensed-mp3');
