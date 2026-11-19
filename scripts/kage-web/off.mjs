#!/usr/bin/env node
// The reverse of ready.mjs, for when you are back at the Mac: let it sleep
// normally again and disconnect the away-from-home link. Kage web, the subtitle
// helper and Ollama are left running: they are idle unless used, and the Chrome
// extension on this Mac needs the last two.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const say = (name, detail) => console.log(`[ ok ] ${name.padEnd(16)} ${detail}`);
const warn = (name, detail) => console.log(`[ !! ] ${name.padEnd(16)} ${detail}`);

console.log('Closing Kage for phones and tablets…\n');

let wasAwake = true;
try { execFileSync('/usr/bin/pkill', ['-f', 'caffeinate -s -t 43200'], { stdio: 'ignore' }); } catch { wasAwake = false; }
say('Stay awake', wasAwake ? 'off. The Mac sleeps normally again.' : 'was already off.');

const binary = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'].find(existsSync);
if (binary) {
  try {
    const state = JSON.parse((await run(binary, ['status', '--json'], { timeout: 5000 })).stdout).BackendState;
    if (state === 'Running') { await run(binary, ['down'], { timeout: 15000 }); say('Tailscale', 'disconnected.'); }
    else say('Tailscale', 'was already disconnected.');
  } catch { warn('Tailscale', 'could not be disconnected. Use its icon in the menu bar.'); }
}

// Subtitles still being made would stop if the Mac went to sleep now.
try {
  const health = await (await fetch('http://127.0.0.1:8766/health', { signal: AbortSignal.timeout(3000) })).json();
  const queue = await (await fetch('http://127.0.0.1:8766/jobs', { headers: { 'X-Kage-Token': health.token }, signal: AbortSignal.timeout(3000) })).json();
  if (queue.jobs?.length) warn('Subtitles', `${queue.jobs.length} video${queue.jobs.length > 1 ? 's are' : ' is'} still being prepared. Keep the Mac awake until that finishes.`);
} catch { /* The helper is not running: nothing in progress. */ }

console.log('\nKage web, the subtitle helper and Ollama stay on for the Chrome extension.\nAt home, your iPad still reaches Kage on the home Wi-Fi address while the Mac is awake.');
