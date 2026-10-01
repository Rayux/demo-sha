import { promises as fs } from 'node:fs';
import path from 'node:path';
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const directory = arg('--directory');
const url = arg('--url');
await fs.mkdir(path.join(directory, 'download'));
await fs.writeFile(path.join(directory, 'download', 'video.mp4.part'), 'partial');
console.log(JSON.stringify({ type: 'progress', progress: 0.4 }));
if (url.includes('BVslow')) await new Promise(resolve => setTimeout(resolve, 30000));
if (url.includes('BVfail')) { console.error('Bilibili download failed. Import a local file.'); process.exit(1); }
await fs.writeFile(path.join(directory, 'input.media'), 'hello');
