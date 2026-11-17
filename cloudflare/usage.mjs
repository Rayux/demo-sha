// How much audio this site has sent to Azure Speech this month. Azure has no
// "quota remaining" lookup for a Speech key, so the site keeps its own count.
import { hasFirestore, getDocument, setDocument, incrementField } from './firestore.mjs';

const COLLECTION = 'usage';
const monthKey = (date = new Date()) => date.toISOString().slice(0, 7);
const documentId = (month) => `azure-speech-${month}`;

// The free tier's monthly allowance, in hours. Override it if the Azure portal shows another figure.
function allowanceSeconds(env) {
  const hours = Number(env.AZURE_SPEECH_MONTHLY_HOURS);
  return Math.round((Number.isFinite(hours) && hours > 0 ? hours : 5) * 3600);
}

/** Length in seconds of the 16 kHz mono 16-bit WAV sent for assessment. */
export const wavSeconds = (byteLength) => Math.max(0, (byteLength - 44) / 32000);

/** Add an assessed recording to this month's total. Scoring must never fail because counting did. */
export async function recordAzureUsage(env, seconds) {
  if (!hasFirestore(env) || !(seconds > 0)) return;
  try { await incrementField(env, COLLECTION, documentId(monthKey()), { seconds: Math.round(seconds * 10) / 10, requests: 1 }); }
  catch { /* The count is a convenience. */ }
}

/** Remember when Azure last turned a request away as busy or over quota. */
export async function recordAzureRefusal(env) {
  if (!hasFirestore(env)) return;
  try { await setDocument(env, COLLECTION, documentId(monthKey()), { refusedAt: new Date().toISOString() }, ['refusedAt']); }
  catch { /* The count is a convenience. */ }
}

export async function azureUsage(env, configured) {
  const month = monthKey();
  const usage = { configured, tracked: false, month, secondsUsed: 0, requests: 0, allowanceSeconds: allowanceSeconds(env), refusedAt: null };
  if (!configured || !hasFirestore(env)) return usage;
  try {
    const data = await getDocument(env, COLLECTION, documentId(month));
    return { ...usage, tracked: true, secondsUsed: Math.round(Number(data?.seconds) || 0), requests: Number(data?.requests) || 0, refusedAt: data?.refusedAt || null };
  } catch { return usage; }
}
