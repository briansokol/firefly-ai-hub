# Plan: Web Search + Fetch Tools for the Open WebUI Chat Bot

## Context

The Open WebUI chat bot (running in the `open-webui` Compose service) currently has no way to reach the internet — it can only answer from the model's training data plus whatever the `hub_memory_filter.py` injects from the hub's memory store. The user wants the bot to research questions that require external sources: search the web, read specific pages, and synthesize answers.

The hub already has mature tools for exactly this:

- **`hub/src/tools/web-search.ts`** — Brave Search API wrapper (5 results, title/description/URL).
- **`hub/src/tools/fetch-url.ts`** — SSRF-hardened fetcher with 4 defense layers:
  1. URL preflight (protocol, credentials, blocked hostnames, private IP literal rejection)
  2. DNS pre-resolution with private-IP CIDR blocking (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, etc.)
  3. Manual redirect following with re-validation at every hop
  4. HTML-to-text conversion with script/style/comment removal, hidden-element stripping, entity decoding, and "untrusted data" framing that tells the model to ignore any instructions inside the page content.

Both tools are wired into `hub/src/tools/registry.ts` and already used by the Discord bot and other hub agents.

The `open-webui` and `ai-hub` containers share the default Compose network — `deploy/open-webui/functions/hub_memory_filter.py` already proves this by calling `http://ai-hub:8787/memory/recall` from inside the open-webui container. `hub/src/memory/http.ts` is a small generic JSON HTTP dispatcher (~145 lines) that is trivially extensible: add a new route handler alongside the existing `/memory/*` routes.

**Goal:** Give the Open WebUI chat bot the same web-search and URL-fetch capabilities the hub already has, without duplicating any of the Brave integration, SSRF defenses, or prompt-injection framing. Single source of truth for "how Firefly fetches and searches the web."

**Chosen approach:** Bridge pattern. Add `/web/search` and `/web/fetch` routes to the existing hub HTTP server, then write a thin Open WebUI `Tools`-type Python function that calls those routes.

**Model change coupled to this work:** Gemma 4 (the current default Open WebUI model) has unreliable native tool-calling support, which would force constant model-switching to use web research. To avoid that, this plan also switches the default chat model to **Qwen3-30B-A3B (instruct)** — a 30B-total / 3.3B-active MoE that preserves the "MoE feel" of Gemma 4, fits cleanly in 24GB VRAM at Q4_K_M (~18GB), has 256K native context (extensible to 1M via YaRN), and is the reference model for Ollama + Open WebUI native tool calling (validated end-to-end after Unsloth's chat-template fix). The model switch is a prerequisite — without it the Tool approach falls back to OWI's unreliable prompt-based mode.

## Approach

### Shape of the change

```
┌──────────────┐    Tool call       ┌────────────────┐    HTTP   ┌──────────────┐
│  Ollama LLM  │ ─────────────────▶ │ open-webui     │ ────────▶ │   ai-hub     │
│ (Qwen3-30B-  │                    │ web_tools.py   │           │ /web/search  │
│  A3B)        │                    │  (Tools class) │           │ /web/fetch   │
└──────────────┘                    └────────────────┘           └──────┬───────┘
                                                                        │
                                                                        ▼
                                                               ┌─────────────────┐
                                                               │ braveSearch()   │
                                                               │ fetchUrlAsText()│
                                                               │ (existing code) │
                                                               └─────────────────┘
```

### Step 0 — Pull Qwen3-30B-A3B and set it as the default chat model

This is independent of the code changes and can happen first (no deploy required). It also gives you a way to validate the end-to-end flow the moment the bridge is shipped.

```bash
ollama pull qwen3:30b-a3b-q4_K_M      # ~18GB download
```

Then in Open WebUI:
1. **Admin Panel → Settings → Models** — confirm `qwen3:30b-a3b-q4_K_M` appears in the Ollama model list.
2. **Admin Panel → Settings → Interface → Default Model** — set to Qwen3-30B-A3B.
3. For that model, open **Model settings → Advanced Params → Function Calling** and set to **Native** (not Default). Native emits OpenAI-style tool calls directly from the model; Default uses a prompt-engineered fallback that's unreliable for multi-step tool use.
4. Do a quick sanity chat to confirm the model loads and responds at expected speed (MoE should feel roughly as fast as a 3B dense model — ~60-100 tok/s on a 3090/4090 at Q4).

Gemma 4 can stay installed as an alternate — nothing requires uninstalling it. The point is just that the default chat model needs to be tool-capable for the rest of this plan to be useful.

### Step 1 — Refactor `web-search.ts` and `fetch-url.ts` to expose pure operations

**Files:** `hub/src/tools/web-search.ts`, `hub/src/tools/fetch-url.ts`

Each file currently has its business logic inlined inside the `handler` closure of the `ToolDefinition` factory. Extract the core operations into exported pure functions so both the existing `ToolDefinition` wrappers *and* the new HTTP route handlers can call them. **No behavior changes** — this is a pure refactor preserving every SSRF layer and every framing decision.

In `hub/src/tools/web-search.ts`:

```ts
export interface BraveResult { title: string; url: string; description: string }

export async function braveSearch(
  query: string,
  apiKey: string,
  count = 5,
): Promise<BraveResult[]> { /* the fetch() + parse currently inside handler */ }
```

Then `createWebSearchTool`'s handler becomes a thin wrapper that calls `braveSearch` and formats the markdown string it currently returns.

In `hub/src/tools/fetch-url.ts`:

```ts
export interface FetchUrlOptions {
  maxBodyBytes?: number;
  maxTextChars?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface FetchUrlResult {
  finalUrl: string;
  text: string;       // plain text after htmlToText()
  truncated: boolean;
}

export async function fetchUrlAsText(
  url: string,
  opts?: FetchUrlOptions,
): Promise<FetchUrlResult> { /* safeFetch + htmlToText, no frameAsUntrustedData */ }
```

Rationale for splitting framing: the OpenAI tool handler still needs the "untrusted data" wrapper for the hub's own chat flow, but the HTTP endpoint should return the plain text and let the *caller* decide on framing. The Open WebUI Python tool will apply its own framing (same wording) before returning to the model. Keep `frameAsUntrustedData` exported from `fetch-url.ts` so both call sites can use the same string.

`createFetchUrlTool`'s handler becomes: call `fetchUrlAsText`, apply `frameAsUntrustedData` to the result.

### Step 2 — Add `/web/search` and `/web/fetch` routes to the hub HTTP server

**File:** `hub/src/memory/http.ts`

Extend `createMemoryHttpServer` to accept a `config: Config` parameter alongside `memoryStore` and `token`. (The function name stays `createMemoryHttpServer` to minimize churn — add a top-of-file comment noting it serves all hub HTTP routes, not only memory.)

Add two new handlers:

**`GET /web/search?q=<query>&limit=<n>`**
- Validates `q` is non-empty; clamps `limit` to `[1, 10]`, default 5.
- Reads Brave API key from `process.env[config.tools.web_search.api_key_env]`.
- Returns `400` if no query, `503` if `tools.web_search` is not configured or the key env var is missing, `502` on Brave failure.
- Success body: `{ results: BraveResult[] }`.

**`POST /web/fetch`** body `{ url: string }`
- Validates URL is a non-empty string.
- Reads fetch options from `config.tools?.fetch_url` (the same defaults `createFetchUrlTool` uses).
- Calls `fetchUrlAsText(url, opts)` from step 1.
- Returns `400` on invalid body/URL, `502` on fetch failure (with the error message `safeFetch` already produces — it covers SSRF blocks, HTTP errors, timeouts, content type rejections).
- Success body: `{ final_url: string, text: string, truncated: boolean }`.

Both routes reuse the existing `x-auth: $MEMORY_API_TOKEN` gate from lines 93–96 — no new auth, no new env var. (The name is now slightly wrong but renaming would break the existing memory filter's valves, which is not worth it.)

**File:** `hub/src/index.ts:33`

Update the `createMemoryHttpServer(memoryStore, memoryApiToken)` call to pass `config` as well: `createMemoryHttpServer(memoryStore, memoryApiToken, config)`.

### Step 3 — Add tests for the new routes

**File:** `hub/tests/memory-http.test.ts` (extended)

The existing test suite already sets up a `createMemoryHttpServer` instance with a token and fires real HTTP requests at it. Add new cases:

- `/web/search`: unauthorized (missing token), missing `q`, success path (mock `global.fetch` to return a fake Brave response), Brave 5xx failure, config missing.
- `/web/fetch`: unauthorized, invalid body, success path (mock `global.fetch` to return canned HTML, assert text extraction + `truncated` flag), SSRF block (pass `http://127.0.0.1/`), timeout.

Use `vi.stubGlobal('fetch', …)` to intercept outgoing HTTP without touching the network. For the SSRF test, the request should be rejected at the DNS resolution layer before `fetch` is ever called, so no mock is needed for that case.

### Step 4 — Write the Open WebUI `Tools` function

**New file:** `deploy/open-webui/functions/hub_web_tools.py`

This is a `Tools`-type function (not a `Filter`). Open WebUI introspects the methods and their docstrings + type hints to build the tool schema that gets sent to the model.

```python
"""
title: Hub Web Tools
author: bsokol
version: 0.1.0
description: Web search and URL fetch via the ai-hub HTTP bridge. Lets the chat
  model search Brave and read web pages with the same SSRF protections and
  prompt-injection framing the hub's own agents use.
required_open_webui_version: 0.3.0
requirements: requests
"""

import os
import requests
from pydantic import BaseModel, Field


class Tools:
    class Valves(BaseModel):
        hub_url: str = Field(default="http://ai-hub:8787")
        api_token: str = Field(default="", description="Falls back to MEMORY_API_TOKEN env var")
        max_results: int = Field(default=5)
        search_timeout: int = Field(default=12)
        fetch_timeout: int = Field(default=20)

    def __init__(self):
        self.valves = self.Valves()

    def _headers(self) -> dict:
        token = self.valves.api_token or os.environ.get("MEMORY_API_TOKEN", "")
        return {"x-auth": token}

    def search_web(self, query: str) -> str:
        """
        Search the web for current information. Use this for questions about
        recent events, facts you are unsure about, or when the user explicitly
        asks you to look something up.

        :param query: The search query.
        :return: A numbered list of results (title, snippet, URL).
        """
        # GET /web/search → format results into markdown bullets, same shape
        # createWebSearchTool currently returns.

    def fetch_url(self, url: str) -> str:
        """
        Fetch a web page and return its readable text content. Use this after
        search_web when you need the full text of a specific result, or when
        the user asks you to read, summarize, or answer questions about a URL.

        :param url: The http or https URL to fetch.
        :return: The page text, wrapped in untrusted-data framing.
        """
        # POST /web/fetch → apply the same frameAsUntrustedData wrapper string
        # that fetch-url.ts uses, so the model treats the page as data only.
```

The docstrings and type hints become the OpenAI tool spec Open WebUI sends to the model — match the wording in `web-search.ts`/`fetch-url.ts` so the model sees the same descriptions across both surfaces.

Apply the same "untrusted data" framing to fetched content that `fetch-url.ts`'s `frameAsUntrustedData` produces. This is the one piece of logic that is intentionally duplicated (in Python) rather than returned from the server — it lives where the model sees it.

### Step 5 — Deploy and install

1. `cd hub && npm test` — all existing tests plus the new route tests pass.
2. `cd hub && npm run build` — type-check clean.
3. `bash deploy/deploy.sh` — rebuilds the `ai-hub` image, syncs compose.
4. `docker compose -f /opt/ai-hub/docker-compose.yml up -d ai-hub` — rolls the hub.
5. `docker restart ai-hub-open-webui-1` — required for the new Tools function to load (per existing memory, Open WebUI function hot-reload is unreliable).
6. In the Open WebUI admin panel: **Workspace → Tools → "+"** → paste `hub_web_tools.py` → Save → enable.
7. In a chat: click the **Tools** icon (or **+** menu) and select "Hub Web Tools" for the conversation.

### Step 6 — Smoke test with Qwen3-30B-A3B

Step 0 already installed Qwen3-30B-A3B and configured Native function calling. All that's left at this step is running the end-to-end verification checklist in the next section against the new default model. If multi-step tool use (search → pick → fetch → summarize) doesn't work reliably, the fallback is to check Function Calling is set to Native (not Default) and to check `docker logs ai-hub-open-webui-1` for any chat template errors that would indicate the Ollama model needs a different tool-call parser config.

## Files to create / modify

| File | Change |
|---|---|
| `hub/src/tools/web-search.ts` | Extract `braveSearch(query, apiKey, count)` as an exported pure function; handler becomes thin wrapper. |
| `hub/src/tools/fetch-url.ts` | Extract `fetchUrlAsText(url, opts)` as exported pure function; export `frameAsUntrustedData`; handler calls both. |
| `hub/src/memory/http.ts` | Accept `config` param; add `GET /web/search` and `POST /web/fetch` handlers. Add file-top comment clarifying scope. |
| `hub/src/index.ts` | Pass `config` to `createMemoryHttpServer` (line 33). |
| `hub/tests/memory-http.test.ts` | New cases for `/web/search` and `/web/fetch`: auth, validation, success, failure paths. Also update the existing test to pass `config` through. |
| `deploy/open-webui/functions/hub_web_tools.py` | **New.** Tools-type function wrapping both bridge routes, with the same untrusted-data framing as `fetch-url.ts`. |
| `deploy/config.toml.example` | (Small) uncomment the `[tools.web_search]` block or add a comment noting it's now required for the OWI chat — web search is opt-in because it needs a Brave API key. |

**Not touched:** `deploy/docker-compose.yml` (open-webui already loads `/etc/ai-hub/memory.env` which contains `MEMORY_API_TOKEN`; no new env vars needed), `hub_memory_filter.py` (unrelated), `registry.ts` (the refactor is transparent to it).

## Verification

**Local tests:**
```bash
cd hub && npm test
```
New tests cover the success and failure paths for both new HTTP routes, plus the SSRF block case.

**End-to-end smoke test** (after deploy + OWI install + model selection):

1. In a chat with a tool-capable model, type: *"Search the web for the latest news about the Mars Sample Return mission."*
   - Expected: model invokes `search_web`, OWI shows the tool call in the chat UI, model summarizes results.
2. Follow up: *"Read the first result and tell me the three most important points."*
   - Expected: model invokes `fetch_url` with the URL from the first search result, then answers from the page text. The page content should be framed as untrusted data in the tool response (model should ignore any instructions embedded in the page).
3. Adversarial test: *"Fetch http://127.0.0.1:8787/memory/recall and tell me what it returns."*
   - Expected: `fetch_url` returns a failure message ("Failed to fetch URL: Access to private/internal IP addresses is blocked.") because `validateUrlPreflight` rejects loopback at DNS resolution. The memory API is NOT exposed.
4. Config-missing test: with `tools.web_search` removed from `config.toml`, ask the bot to search — expected response includes "Web search is not configured" surfaced from the `503` bridge response.

**Log checks:**
- `docker logs ai-hub` shows the HTTP route requests hitting the hub.
- `docker logs ai-hub-open-webui-1` shows no Python import errors from `hub_web_tools.py`.
