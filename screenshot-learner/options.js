const fields = {
  endpoint: document.getElementById("endpoint"),
  model: document.getElementById("model"),
  apiKey: document.getElementById("apiKey")
};

document.addEventListener("DOMContentLoaded", async () => {
  const settings = await chrome.storage.local.get({
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
    model: "qwen2.5vl:7b",
    apiKey: ""
  });
  Object.keys(fields).forEach((key) => { fields[key].value = settings[key]; });
});

document.getElementById("save").addEventListener("click", async () => {
  const endpoint = fields.endpoint.value.trim();
  const model = fields.model.value.trim();
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error();
    if (!model) throw new Error();
  } catch {
    document.getElementById("status").textContent = "Use a localhost endpoint and enter a model name.";
    return;
  }
  await chrome.storage.local.set({ endpoint, model, apiKey: fields.apiKey.value.trim() });
  document.getElementById("status").textContent = "Settings saved.";
});
