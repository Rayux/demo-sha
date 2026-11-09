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
      const text = `「${request.sentence}」\n\n### 整句意思\n這是 **串流回答** 的測試。\n\n### 文法與語氣\n- **ですね**：確認對方的感受。\n- 使用 *柔和的語氣*，自然地開啟對話。\n\n1. 先理解整句意思。\n2. 再練習重要文法。`;
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
