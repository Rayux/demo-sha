import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../content/anime1-audio-main.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const PAGE = 'https://anime1.me/30605';
const APIREQ = '%7B%22c%22%3A%222017%22%2C%22e%22%3A%224b%22%7D';

function harness({ apireq = APIREQ, respond } = {}) {
  const listeners = [], posted = [], calls = [];
  const location = { href: PAGE, hostname: 'anime1.me', origin: 'https://anime1.me' };
  const window = {
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    postMessage(data) { posted.push(data); },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return respond ? respond(url, options) : { ok: true, json: async () => ({ s: [{ src: '//hajime.v.anime1.me/2017/4b.mp4', type: 'video/mp4' }] }) };
    },
  };
  const document = { querySelector: selector => selector === 'video[data-apireq]' && apireq ? { getAttribute: () => apireq } : null };
  class XMLHttpRequest { open() {} send() {} addEventListener() {} }
  const context = vm.createContext({ window, location, document, URL, DOMException, AbortController, XMLHttpRequest,
    setTimeout, clearTimeout, setInterval, clearInterval });
  context.globalThis = context;
  vm.runInContext(source, context);
  const request = () => { for (const fn of listeners) fn({ source: window, origin: location.origin,
    data: { type: 'KAGE_BROWSER_AUDIO_REQUEST', requestId: 'r'.repeat(32), page: PAGE } }); };
  const cancel = () => { for (const fn of listeners) fn({ source: window, origin: location.origin,
    data: { type: 'KAGE_BROWSER_AUDIO_CANCEL', requestId: 'r'.repeat(32), page: PAGE } }); };
  return { calls, posted, request, cancel };
}

test('an episode source is requested like the player does, so preparation needs no play click', async () => {
  const h = harness();
  h.request();
  for (let i = 0; i < 10; i++) await flush();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://v.anime1.me/api');
  assert.equal(h.calls[0].options.method, 'POST');
  assert.equal(h.calls[0].options.credentials, 'include');
  assert.equal(h.calls[0].options.body, `d=${APIREQ}`);
  const media = h.posted.find(message => message.type === 'KAGE_ANIME1_MEDIA_URL');
  assert.equal(media?.src, 'https://hajime.v.anime1.me/2017/4b.mp4');
});

test('pages without a valid player token make no source request', async () => {
  const h = harness({ apireq: 'bad token<script>' });
  h.request();
  for (let i = 0; i < 10; i++) await flush();
  assert.equal(h.calls.length, 0);
  h.cancel();
  await new Promise(resolve => setTimeout(resolve, 250));
});
