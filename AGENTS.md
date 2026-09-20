# Agent Instructions & Model Routing

## GPT-6 & OpenAI Assistance in Antigravity
When the user asks to "use GPT-6", "consult GPT-6", or asks for GPT-6 / OpenAI's perspective:
- Use the MCP tool `consult_gpt` configured in `.agents/mcp_config.json` with parameter `model: "gpt-6"`.
- The MCP server will query the OpenAI API (with automatic fallback to `gpt-4o` if OpenAI has not yet activated `gpt-6`).
- Synthesize or present the response directly to the user.

## Japanese Shadowing Project Architecture
- The Shadowing project itself runs 100% on **Groq**:
  - Transcription: Groq Whisper (`whisper-large-v3-turbo`)
  - Japanese furigana breakdown, translations, notes, and speech evaluations: Groq (`openai/gpt-oss-120b`).
