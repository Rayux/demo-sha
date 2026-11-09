import { setTimeout as delay } from 'node:timers/promises';

// launchd can briefly reject bootstrap with EIO while bootout is settling.
// Keep unchanged registrations in place and bound retries for changed ones.
export async function activateAgent({ launch, domain, label, plist, isLoaded, unchanged, wait = delay }) {
  if (isLoaded && unchanged) {
    launch('kickstart', '-k', `${domain}/${label}`);
    return;
  }
  if (isLoaded) launch('bootout', `${domain}/${label}`);
  const delays = [250, 500, 1000, 2000];
  for (let attempt = 0; ; attempt++) {
    try { launch('bootstrap', domain, plist); return; }
    catch (error) {
      if (error.status !== 5 || attempt >= delays.length) throw error;
      await wait(delays[attempt]);
    }
  }
}
