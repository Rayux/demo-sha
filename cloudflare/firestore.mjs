// Firestore's REST API avoids Node gRPC dependencies in the Worker runtime.
import { HttpError } from './http.mjs';

let cachedToken;
let pendingToken;

export function hasFirestore(env) {
  return Boolean(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const encodedJSON = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));

async function accessToken(env) {
  const identity = `${env.FIREBASE_CLIENT_EMAIL}:${env.FIREBASE_PRIVATE_KEY}`;
  if (cachedToken?.identity === identity && cachedToken.expires > Date.now() + 60000) return cachedToken.token;
  if (pendingToken?.identity === identity) return pendingToken.promise;
  const promise = (async () => {
    const now = Math.floor(Date.now() / 1000);
    const input = `${encodedJSON({ alg: 'RS256', typ: 'JWT' })}.${encodedJSON({
      iss: env.FIREBASE_CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
    })}`;
    const pem = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${base64url(new Uint8Array(signature))}` }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new HttpError(503, 'Database authentication is unavailable.');
    const result = await response.json();
    if (!result.access_token) throw new HttpError(503, 'Database authentication is unavailable.');
    cachedToken = { identity, token: result.access_token, expires: Date.now() + Number(result.expires_in || 3600) * 1000 };
    return result.access_token;
  })();
  pendingToken = { identity, promise };
  try { return await promise; }
  finally { if (pendingToken?.promise === promise) pendingToken = null; }
}

export function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeValue(v)])) } };
}

export function decodeValue(value) {
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([k, v]) => [k, decodeValue(v)]));
  return null;
}

async function documentRequest(env, collection, id, options = {}, mask = []) {
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/${collection}/${encodeURIComponent(id)}`);
  for (const field of mask) url.searchParams.append('updateMask.fieldPaths', field);
  const token = await accessToken(env);
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (response.status === 404 && !options.method) return null;
  if (!response.ok) {
    if (response.status === 401) cachedToken = null;
    throw new HttpError(503, 'Database request failed. Try again later.');
  }
  return response.json();
}

export async function getDocument(env, collection, id) {
  const document = await documentRequest(env, collection, id);
  return document ? decodeValue({ mapValue: { fields: document.fields || {} } }) : null;
}

export async function setDocument(env, collection, id, data, mask = []) {
  await documentRequest(env, collection, id, { method: 'PATCH', body: JSON.stringify({ fields: encodeValue(data).mapValue.fields }) }, mask);
}

export function progressFieldPath(key) {
  return 'mastered.`' + key.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}
