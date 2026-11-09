// Reads an upload that is still growing, like worker.py --follow-bytes.
import { promises as fs } from 'node:fs';
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
if (args.includes('--check')) process.exit(0);
const input = value('--input'), output = value('--output'), expected = Number(value('--follow-bytes'));
const emit = item => console.log(JSON.stringify(item));
if (!expected) { console.error('Expected --follow-bytes for a streamed upload.'); process.exit(2); }
const size = async () => (await fs.stat(input)).size;
const until = async ready => { for (let i = 0; i < 500 && !await ready(); i++) await new Promise(r => setTimeout(r, 10)); };
const first = { start: 0.2, end: 1.8, text: 'はい。' }, second = { start: 30.2, end: 31.8, text: 'いいえ。' };
await fs.writeFile(input + '.pid', String(process.pid));
await until(async () => await size() >= 8);
emit({ type: 'chunk', duration: 60, processedThrough: 30, cues: [first] });
await until(async () => await size() >= expected);
if (await size() < expected) { console.error('Upload stopped.'); process.exit(1); }
emit({ type: 'chunk', duration: 60, processedThrough: 60, cues: [second] });
await fs.writeFile(output, JSON.stringify({ duration: 60, cues: [first, second] }));
