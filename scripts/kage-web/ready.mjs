#!/usr/bin/env node
// One step before leaving the Mac: make sure everything Kage needs is on,
// keep the Mac awake for the next 12 hours, and say what (if anything) is not ready.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const AWAKE_SECONDS = 12 * 60 * 60;
const port = Number(process.env.KAGE_WEB_PORT || 8780);
const domain = `gui/${process.getuid()}`;
const results = [];
const report = (ok, name, detail) => { results.push(ok); console.log(`${ok ? '[ ok ]' : '[ !! ]'} ${name.padEnd(16)} ${detail}`); };

async function json(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
async function until(check, seconds) {
  for (let waited = 0; waited < seconds * 2; waited++) {
    const value = await check();
    if (value) return value;
    await delay(500);
  }
  return null;
}
function kick(label) {
  try { execFileSync('/bin/launchctl', ['kickstart', `${domain}/${label}`], { stdio: 'ignore' }); return true; } catch { return false; }
}

// The link that lets a phone or tablet reach this Mac away from home.
async function tailscale() {
  const binary = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'].find(existsSync);
  if (!binary) return report(false, 'Tailscale', 'not installed. Kage will only work on your home Wi-Fi.');
  // `ip` answers even while the link is off, so ask whether it is actually running.
  const address = async () => {
    try {
      const status = JSON.parse((await run(binary, ['status', '--json'], { timeout: 5000 })).stdout);
      return status.BackendState === 'Running' ? status.TailscaleIPs?.find(value => /^\d+\./.test(value)) || '' : '';
    } catch { return ''; }
  };
  let ip = await address();
  if (!ip) {
    try { await run(binary, ['up'], { timeout: 20000 }); } catch { /* Reported below. */ }
    ip = await until(address, 10);
  }
  report(!!ip, 'Tailscale', ip ? `connected (${ip})` : 'could not connect. Open the Tailscale icon in the menu bar and sign in.');
  return ip ? binary : null;
}

// The https address Tailscale gives this Mac ("tailscale serve"), if it points at Kage.
// Only devices signed in to the same Tailscale account can open it.
async function secureAddress(binary) {
  try {
    const web = JSON.parse((await run(binary, ['serve', 'status', '--json'], { timeout: 5000 })).stdout).Web || {};
    for (const [host, site] of Object.entries(web)) {
      if (Object.values(site.Handlers || {}).some(handler => handler.Proxy === `http://127.0.0.1:${port}`)) return `https://${host.replace(/:443$/, '')}`;
    }
  } catch { /* No https address: the numbered one still works. */ }
  return '';
}

// Chinese translations.
async function ollama() {
  const up = () => json('http://127.0.0.1:11434/api/tags');
  let ready = await up();
  if (!ready) {
    try { await run('/usr/bin/open', ['-ga', 'Ollama']); } catch { /* Reported below. */ }
    ready = await until(up, 20);
  }
  report(!!ready, 'Ollama', ready ? 'running (Chinese translations)' : 'did not start. Open the Ollama app; without it there is no Chinese.');
}

// Japanese lines.
async function helper() {
  const up = async () => (await json('http://127.0.0.1:8766/health'))?.ready === true;
  let ready = await up();
  if (!ready && kick('com.kage.local-subtitles')) ready = await until(up, 30);
  report(!!ready, 'Subtitle helper', ready ? 'running (Japanese lines)' : 'not running. Run: npm run subtitles:autostart');
}

// The page itself.
async function web() {
  const up = () => json(`http://127.0.0.1:${port}/api/session`);
  let session = await up();
  if (!session && kick('com.kage.web')) session = await until(up, 15);
  report(!!session, 'Kage web', session ? 'running' : 'not running. Run: npm run web:autostart');
  return session;
}

// The Mac must not fall asleep while you are out.
async function awake() {
  let plugged = false;
  try { plugged = /AC Power/.test((await run('/usr/bin/pmset', ['-g', 'batt'])).stdout); } catch { /* Treated as on battery. */ }
  try { execFileSync('/usr/bin/pkill', ['-f', `caffeinate -s -t ${AWAKE_SECONDS}`], { stdio: 'ignore' }); } catch { /* None was running. */ }
  spawn('/usr/bin/caffeinate', ['-s', '-t', String(AWAKE_SECONDS)], { detached: true, stdio: 'ignore' }).unref();
  report(plugged, 'Stay awake', plugged ? 'on for the next 12 hours' : 'the charger is not connected. Plug it in, or the Mac will go to sleep.');
}

console.log('Getting Kage ready…\n');
const tailscaleBinary = await tailscale();
const secure = tailscaleBinary ? await secureAddress(tailscaleBinary) : '';
await ollama();
await helper();
let session = await web();
await awake();
// A link that has only just connected takes a moment to show up as an address.
if (session && results[0]) {
  session = await until(async () => { const now = await json(`http://127.0.0.1:${port}/api/session`); return now?.addresses?.some(entry => entry.kind === 'anywhere') ? now : null; }, 8) || session;
}

console.log('');
if (session?.addresses?.length) {
  for (const entry of session.addresses) console.log(`${entry.kind === 'anywhere' ? 'Away from home:' : 'On home Wi-Fi: '}  ${entry.kind === 'anywhere' && secure ? secure : entry.url}`);
  console.log(`Pairing code:    ${session.code}  (only for a new device)`);
}
console.log(results.every(Boolean)
  ? '\nEverything is on. Leave the lid open and the charger connected; the screen may turn off.'
  : '\nSomething above needs attention before you leave.');
process.exitCode = results.every(Boolean) ? 0 : 1;
