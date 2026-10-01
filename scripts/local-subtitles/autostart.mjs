#!/usr/bin/env node
// Per-user launchd agent; no administrator privileges or system-wide service.
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const label = 'com.kage.local-subtitles';
const domain = `gui/${process.getuid()}`;
const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const data = path.join(root, '.local-subtitles');
const mode = process.argv[2] || 'install';
const xml = text => String(text).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const launch = (...args) => execFileSync('/bin/launchctl', args, { encoding:'utf8', stdio:['ignore','pipe','pipe'] });
function loaded() { try { launch('print', `${domain}/${label}`); return true; } catch { return false; } }
async function health() {
  try {
    const response = await fetch('http://127.0.0.1:8766/health', {signal:AbortSignal.timeout(2000)});
    return response.ok ? await response.json() : {starting:true};
  } catch { return null; }
}
async function assertIdle(status) {
  if (!status?.token) throw new Error('The helper is starting or unrecognized. Wait before changing automatic startup.');
  const entries = await fs.readdir(path.join(data,'jobs'), {withFileTypes:true});
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const response = await fetch(`http://127.0.0.1:8766/jobs/${entry.name}`, {headers:{'X-Kage-Token':status.token},signal:AbortSignal.timeout(3000)});
    if (response.status === 404) continue;
    if (!response.ok) throw new Error('Cannot verify active jobs. Leave the helper running and retry later.');
    const job = await response.json();
    if (!['complete','error','translation_error','cancelled'].includes(job.state)) throw new Error('Subtitles are still processing. Wait until they finish before changing automatic startup.');
  }
}
try {
  if (process.platform !== 'darwin') throw new Error('Automatic startup requires macOS.');
  if (!['install','remove','status'].includes(mode)) throw new Error('Use install, remove, or status.');
  const isLoaded = loaded();
  const status = await health();
  if (mode === 'status') {
    console.log(JSON.stringify({automaticStartup:isLoaded,helperReady:status?.ready === true,capabilities:status?.capabilities || {},processing:status?.processing || {}},null,2));
  } else if (mode === 'remove') {
    if (isLoaded && status) await assertIdle(status);
    if (isLoaded) launch('bootout', `${domain}/${label}`);
    await fs.rm(plist,{force:true});
    console.log('Automatic startup removed. Saved subtitles and models are unchanged.');
  } else {
    if (isLoaded && status) await assertIdle(status);
    if (!isLoaded && status) throw new Error('A manually started helper is already running. Stop it first, then run npm run subtitles:autostart.');
    await fs.access(path.join(data,'venv/bin/python'));
    await fs.mkdir(path.dirname(plist),{recursive:true});
    await fs.mkdir(path.join(data,'logs'),{recursive:true});
    const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(root,'scripts/local-subtitles/server.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict><key>KAGE_SUBTITLES_DIR</key><string>${xml(data)}</string><key>HF_HUB_OFFLINE</key><string>1</string><key>HF_HUB_DISABLE_TELEMETRY</key><string>1</string></dict>
<key>StandardOutPath</key><string>${xml(path.join(data,'logs/helper.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(data,'logs/helper-error.log'))}</string>
</dict></plist>
`;
    const temp = `${plist}.tmp`;
    await fs.writeFile(temp,contents,{mode:0o600});
    execFileSync('/usr/bin/plutil',['-lint',temp],{stdio:'pipe'});
    await fs.rename(temp,plist);
    if (isLoaded) launch('bootout',`${domain}/${label}`);
    launch('bootstrap',domain,plist);
    console.log('Kage subtitle helper now starts at login and restarts if it exits. No terminal is needed.');
    console.log('Keep Ollama running for Chinese translation.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode=1;
}
