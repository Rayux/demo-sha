#!/usr/bin/env node
// Starts Kage for phones and tablets at login, as a per-user launchd agent.
// No administrator privileges; remove it with `npm run web:autostart:remove`.
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activateAgent } from '../local-subtitles/launch-agent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const label = 'com.kage.web';
const port = Number(process.env.KAGE_WEB_PORT || 8780);
const domain = `gui/${process.getuid()}`;
const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const logs = path.join(root, '.local-subtitles', 'logs');
const mode = process.argv[2] || 'install';
const xml = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
const launch = (...args) => execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function loaded() { try { launch('print', `${domain}/${label}`); return true; } catch { return false; } }
async function session() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

try {
  if (process.platform !== 'darwin') throw new Error('Automatic startup requires macOS.');
  if (!['install', 'remove', 'status'].includes(mode)) throw new Error('Use install, remove, or status.');
  const isLoaded = loaded();
  const running = await session();
  if (mode === 'status') {
    console.log(JSON.stringify({ automaticStartup: isLoaded, running: !!running, addresses: running?.addresses?.map(entry => entry.url) || [] }, null, 2));
  } else if (mode === 'remove') {
    if (isLoaded) launch('bootout', `${domain}/${label}`);
    await fs.rm(plist, { force: true });
    console.log('Kage web no longer starts at login. Paired devices and saved subtitles are unchanged.');
  } else {
    if (!isLoaded && running) throw new Error('Kage web is already running in a Terminal window or another app. Stop it first, then run npm run web:autostart.');
    await fs.mkdir(path.dirname(plist), { recursive: true });
    await fs.mkdir(logs, { recursive: true });
    const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(root, 'scripts/kage-web/server.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'web.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'web-error.log'))}</string>
</dict></plist>
`;
    let previous;
    try { previous = await fs.readFile(plist, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const unchanged = previous === contents;
    if (!unchanged) {
      const temp = `${plist}.tmp`;
      await fs.writeFile(temp, contents, { mode: 0o600 });
      execFileSync('/usr/bin/plutil', ['-lint', temp], { stdio: 'pipe' });
      await fs.rename(temp, plist);
    }
    await activateAgent({ launch, domain, label, plist, isLoaded, unchanged });
    console.log(`Kage web now starts at login and restarts if it exits. No terminal is needed.\nOn this Mac, open http://127.0.0.1:${port} for the addresses and pairing code.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
