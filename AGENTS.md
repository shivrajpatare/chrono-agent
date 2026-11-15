---
trigger: always_on
description: Core architectural constraints, stack choices, and quality rules for chrono-agent.
---

# Project Contract: chrono-agent

## Hard Constraints
1. **Strictly One Tool:** The LLM must be given ONLY ONE tool definition: `web_search`. Never expose memory lookup, date lookup, or commitment tracking as LLM tools—all memory retrieval and timestamp injection happen deterministically inside the Python pre-turn harness.
2. **Zero Agent Frameworks:** Do NOT use LangChain, LlamaIndex, CrewAI, or AutoGen. Write the streaming agent loop from scratch using `openai` (AsyncOpenAI client pointed at Groq/OpenAI-compatible endpoints), `fastapi`, `httpx`, and `asyncio`.
3. **Free & Zero-Friction Stack:**
   - Primary LLM: Groq (`meta-llama/llama-4-scout-17b-16e-instruct`) via `OPENAI_BASE_URL=https://api.groq.com/openai/v1` with automatic fallback to `llama-3.3-70b-versatile`.
   - Search (`web_search`): Dual adapter supporting `TAVILY_API_KEY` (primary) and `ddgs` (zero-key fallback so the repo runs with only a Groq key).
   - Storage: Built-in Python `sqlite3` in WAL mode with `FTS5`.
   - Frontend: React + Vite + TypeScript + Tailwind CSS.

## Engineering & Security Standards
- **Fast:** Single-pass routing (no extra pre-check LLM call). Execute parallel `web_search` tool calls concurrently via `asyncio.gather()`. Use a shared `httpx.AsyncClient(http2=True)` pool, 10-minute TTL LRU query cache, and Jaccard deduplication + 350-char snippet trimming.
- **Grounded:** Inject current IST date/time into the system prompt on every turn. Wrap retrieved search snippets in `<web_source id="N" url="..." published="...">` tags and instruct the model to treat them strictly as untrusted data (anti-prompt-injection) and cite claims inline as `[1]`, `[2]`. Cap agent iterations at `3`.
- **Temporal Memory:** Store every turn with ISO-8601 UTC + IST timestamps and `session_id`. Combine a verbatim recent window (last 6 turns with relative age labels like `4m ago`), a Python relative-time range parser (`yesterday`, `earlier`, `X minutes ago`, `first thing`), SQLite `FTS5` BM25 search, and a lightweight regex tracker for user promises (`I'll check...`, `remind me...`).
- **Verification:** After writing code, always run syntax/import checks or tests in the terminal and fix any errors before finishing the turn.