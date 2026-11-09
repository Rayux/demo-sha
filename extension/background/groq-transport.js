// Optional Groq routing through the existing loopback helper. The key remains
// in browser settings and is forwarded in memory only for the current request.
(() => {
  const BASE = 'http://127.0.0.1:8766';
  let token = '';
  async function health(signal) {
    let response, data;
    try {
      response = await fetch(BASE + '/health', { signal, redirect: 'error', credentials: 'omit' });
      data = await response.json();
    } catch {
      signal?.throwIfAborted();
      throw new Error('Cannot reach the local helper for Groq. Start the helper or select Browser connection in Kage Settings.');
    }
    if (!response.ok || !data.capabilities?.groqRelay || !/^[a-f0-9]{64}$/.test(data.token || ''))
      throw new Error('Update and restart the local helper to enable the Groq connection, or select Browser connection in Kage Settings.');
    token = data.token;
  }
  globalThis.KageGroqTransport = {
    async fetch(payload, apiKey, signal) {
      if (!token) await health(signal);
      const send = () => fetch(BASE + '/groq/chat/completions', { method: 'POST', redirect: 'error', credentials: 'omit', signal,
        headers: { 'Content-Type': 'application/json', 'X-Kage-Token': token },
        body: JSON.stringify({ ...payload, stream: payload.stream === true, apiKey }) });
      try {
        let response = await send();
        if (response.status === 401) {
          const data = await response.clone().json().catch(() => ({}));
          if (data.error === 'Local service token is missing or expired. Reconnect and retry.') {
            await health(signal); response = await send();
          }
        }
        return response;
      } catch (error) {
        signal?.throwIfAborted();
        if (/^(Update and restart|Cannot reach the local helper)/.test(error.message)) throw error;
        throw new Error('The local Groq connection failed. Check that the helper is running.');
      }
    }
  };
})();
