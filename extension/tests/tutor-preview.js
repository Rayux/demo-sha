// Browser fixture only: simulate the same streaming port used by the extension.
window.fixtureTutorConnect = () => {
  const messages = [], disconnects = [];
  let closed = false;
  return {
    onMessage: { addListener: fn => messages.push(fn) },
    onDisconnect: { addListener: fn => disconnects.push(fn) },
    disconnect() { if (!closed) { closed = true; disconnects.forEach(fn => fn()); } },
    postMessage(request) {
      window.fixtureCalls?.push(request);
      const text = `「${request.sentence}」\n\n這是串流回答的測試。整句意思會先顯示，接著解釋重要文法與語氣。你可以隨時輸入問題，打斷這段自動解釋。`;
      let length = 0;
      function next() {
        if (closed) return;
        length += 4;
        messages.forEach(fn => fn({ type: length >= text.length ? 'done' : 'delta', answer: text.slice(0, length) }));
        if (length < text.length) setTimeout(next, 100);
      }
      setTimeout(next, 200);
    }
  };
};
