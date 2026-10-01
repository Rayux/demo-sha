import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pass only the four required secrets to Wrangler over stdin. Never write an
// unencrypted secrets export into the public directory, git, or shell history.
const root = fileURLToPath(new URL('../', import.meta.url));
const local = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
const names = ['GROQ_API_KEY', 'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
const secrets = Object.fromEntries(names.map(name => [name, process.env[name] || local[name]]));
const missing = names.filter(name => !secrets[name]?.trim());
if (missing.length) throw new Error(`Missing required values in .env: ${missing.join(', ')}`);
if (process.argv.includes('--dry-run')) {
  console.log(`Ready to upload these secret names (values hidden): ${names.join(', ')}`);
} else {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'secret', 'bulk'], {
    cwd: root, stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
  });
  child.stdin.on('error', () => {}); // The child may exit before consuming stdin.
  child.stdin.end(JSON.stringify(secrets));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
