#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function getApiKey() {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  const envPath = path.join(ROOT, ".env");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    const match = content.match(/^\s*OPENAI_API_KEY\s*=\s*(.*?)\s*$/m);
    if (match) return match[1].replace(/^['\"]|['\"]$/g, "").trim();
  }
  return "";
}

const TOOLS = [
  {
    name: "consult_gpt",
    description: "Query an OpenAI model (such as gpt-6, gpt-4o, gpt-4o-mini, o1) for guidance, code suggestions, translations, or analysis.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The prompt, question, or text to send to the model."
        },
        model: {
          type: "string",
          description: "The OpenAI model name to use (e.g. 'gpt-6', 'gpt-4o', 'gpt-4o-mini', 'o1'). Defaults to 'gpt-4o-mini'.",
          default: "gpt-4o-mini"
        },
        system: {
          type: "string",
          description: "Optional system instructions."
        }
      },
      required: ["prompt"]
    }
  }
];

async function callOpenAI(model, prompt, system) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured in .env or environment variables.");
  }

  const targetModel = model || "gpt-4o-mini";
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  let response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: targetModel,
      messages,
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    // If gpt-6 is not yet deployed by OpenAI, gracefully fallback to gpt-4o with an informative note
    if (targetModel === "gpt-6" && (response.status === 404 || errorText.includes("model_not_found"))) {
      console.error("[mcp-openai] 'gpt-6' not yet available on OpenAI API, falling back to gpt-4o...");
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages,
          temperature: 0.2
        })
      });
      if (response.ok) {
        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || "";
        return `[Note: 'gpt-6' is not yet available on the OpenAI API. Response generated via gpt-4o flagship]:\n\n${reply}`;
      }
    }
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (err) {
    console.error("[mcp-openai] Invalid JSON received:", err.message);
    return;
  }

  const { id, method, params } = request;

  if (method === "initialize") {
    sendResponse({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "openai-mcp",
          version: "1.0.0"
        }
      }
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    sendResponse({
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS
      }
    });
    return;
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    if (name === "consult_gpt") {
      try {
        const text = await callOpenAI(args?.model, args?.prompt, args?.system);
        sendResponse({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text
              }
            ]
          }
        });
      } catch (error) {
        sendResponse({
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error calling OpenAI: ${error.message}`
              }
            ]
          }
        });
      }
      return;
    }

    sendResponse({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Tool not found: ${name}`
      }
    });
    return;
  }

  if (method === "ping") {
    sendResponse({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (id !== undefined) {
    sendResponse({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not supported: ${method}`
      }
    });
  }
});

function sendResponse(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
