import https from 'node:https';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'openai/gpt-oss-120b';
const MAX_RESPONSE = 2 * 1024 * 1024;
const problem = (status, message) => Object.assign(new Error(message), { status });

export function validateGroqRequest(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)
      || Object.keys(spec).some(key => !['apiKey', 'messages', 'stream', 'max_completion_tokens', 'temperature', 'response_format', 'model', 'reasoning_effort'].includes(key)))
    throw problem(400, 'Invalid Groq tutor request.');
  if (typeof spec.apiKey !== 'string' || !/^[\x21-\x7e]{20,512}$/.test(spec.apiKey))
    throw problem(400, 'Add a valid Groq API key in Kage Settings.');
  if (spec.model !== MODEL || !Array.isArray(spec.messages) || !spec.messages.length || spec.messages.length > 12
      || spec.messages.some(item => !item || !['system', 'user', 'assistant'].includes(item.role)
        || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 20000)
      || spec.messages.reduce((size, item) => size + item.content.length, 0) > 32000
      || typeof spec.stream !== 'boolean' || !Number.isInteger(spec.max_completion_tokens)
      || spec.max_completion_tokens < 1 || spec.max_completion_tokens > 2048
      || spec.temperature !== 0.1
      || spec.response_format !== undefined && spec.response_format?.type !== 'json_object'
      || spec.reasoning_effort !== undefined && !['low', 'medium', 'high'].includes(spec.reasoning_effort))
    throw problem(400, 'Invalid Groq tutor request.');
  return { model: MODEL, messages: spec.messages.map(({ role, content }) => ({ role, content })),
    stream: spec.stream, temperature: 0.1, max_completion_tokens: spec.max_completion_tokens,
    ...(spec.response_format ? { response_format: { type: 'json_object' } } : {}),
    ...(spec.reasoning_effort ? { reasoning_effort: spec.reasoning_effort } : {}) };
}

function safeFailure(status, bytes) {
  let code;
  try { code = JSON.parse(bytes.toString('utf8')).error?.code; } catch {}
  const hints = {
    model_permission_blocked_org: 'The Groq model is blocked by your organization settings.',
    model_permission_blocked_project: 'The Groq model is blocked by your project settings.'
  };
  return (typeof code === 'string' && Object.hasOwn(hints, code) ? hints[code] : '') || (status === 401 ? 'Groq rejected this API key. Check the Groq key saved in Kage Settings.'
    : status === 403 ? 'Groq refused the helper’s direct connection (403). Check account permissions or network restrictions.'
      : status === 429 ? 'Groq’s request limit was reached. Wait and try again.'
        : `Groq’s direct request failed (${status}). Try again shortly.`);
}

export function createGroqRelay({ request = https.request, timeoutMs = 30000 } = {}) {
  // An explicit agent has no browser proxy and does not inherit proxy settings
  // from Node's global agent. This does not bypass a system-wide VPN.
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4, proxyEnv: {} });
  const active = new Set();
  return {
    async handle(req, res, spec) {
      const payload = validateGroqRequest(spec);
      if (active.size >= 4) throw problem(429, 'The local Groq connection is busy. Try again shortly.');
      const authorization = `Bearer ${spec.apiKey}`;
      delete spec.apiKey;
      const bytes = Buffer.from(JSON.stringify(payload));
      await new Promise(resolve => {
        let outgoing, upstream, settled = false;
        const finish = () => {
          if (settled) return;
          settled = true; clearTimeout(timer); active.delete(cancel);
          req.removeListener('aborted', cancel); res.removeListener('close', cancel);
          resolve();
        };
        const cancel = (destroyClient = false) => {
          if (destroyClient === true && !res.destroyed) res.destroy();
          outgoing?.destroy(); upstream?.destroy(); finish();
        };
        const failure = (status, message) => {
          if (settled) return;
          if (res.headersSent) res.destroy();
          else if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: message })); }
          cancel();
        };
        const timer = setTimeout(() => failure(504, 'The direct Groq connection timed out. Try again.'), timeoutMs);
        active.add(cancel);
        req.once('aborted', cancel); res.once('close', cancel);
        try {
          outgoing = request(ENDPOINT, { method: 'POST', agent, headers: {
            Authorization: authorization, 'Content-Type': 'application/json', 'Content-Length': bytes.length,
            Accept: payload.stream ? 'text/event-stream' : 'application/json'
          } }, response => {
            upstream = response;
            const status = response.statusCode || 502;
            if (status !== 200) {
              const parts = []; let size = 0;
              response.on('data', chunk => {
                if ((size += chunk.length) <= 16384) parts.push(chunk);
                else failure(502, 'Groq returned an unexpected error response.');
              });
              response.on('end', () => failure(status >= 400 && status <= 599 ? status : 502, safeFailure(status, Buffer.concat(parts))));
            } else {
              const mime = String(response.headers['content-type'] || '').split(';')[0].trim();
              if (mime !== (payload.stream ? 'text/event-stream' : 'application/json')) {
                failure(502, 'Groq returned an unexpected response format.'); return;
              }
              res.writeHead(200, { 'Content-Type': payload.stream ? 'text/event-stream; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store' });
              let size = 0;
              response.on('data', chunk => {
                if (settled) return;
                if ((size += chunk.length) > MAX_RESPONSE) { failure(502, 'Groq returned an oversized answer.'); return; }
                if (!res.write(chunk)) { response.pause(); res.once('drain', () => response.resume()); }
              });
              response.on('end', () => { if (!settled) res.end(); finish(); });
            }
            response.once('error', () => failure(502, 'The direct Groq connection ended early. Try again.'));
            response.once('aborted', () => failure(502, 'The direct Groq connection ended early. Try again.'));
          });
          outgoing.once('error', () => failure(502, 'Cannot reach Groq from the local helper. Check this Mac’s Internet connection.'));
          outgoing.end(bytes);
        } catch { failure(502, 'Cannot start the direct Groq connection.'); }
      });
    },
    close() { for (const cancel of [...active]) cancel(true); agent.destroy(); }
  };
}
