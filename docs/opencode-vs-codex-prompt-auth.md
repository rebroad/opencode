# OpenCode vs Codex: prompts, tools, caching, and auth

This note compares the current `opencode` implementation with `codex` in the areas you asked about:

- prompt construction
- tool wiring
- backend input caching
- prompt capture
- OAuth/auth credential storage
- directory-backed credential storage

## Prompt construction

### OpenCode

OpenCode builds the model-visible request in `packages/opencode/src/session/llm.ts`.

The main prompt stack is assembled as:

- the agent prompt, if the selected agent defines one
- the provider prompt from `packages/opencode/src/session/system.ts`
- `input.system` passed in by the caller
- the current user message's `system` field, if present

Those pieces are joined into a single system string, then fed to the model request. For OpenAI OAuth sessions, OpenCode uses `options.instructions = system.join("\n")` instead of sending the system content as separate `system` messages.

OpenCode also rewrites or augments messages in `packages/opencode/src/provider/transform.ts` to satisfy provider-specific constraints:

- it sanitizes strings and tool payloads
- it reorders message shapes Anthropic rejects
- it normalizes Mistral and DeepSeek quirks
- it injects cache hints for supported providers

### Codex

Codex builds its prompt in the session pipeline, primarily from:

- base instructions
- environment context
- user instructions and project rules
- skills
- turn metadata and state

The prompt assembly is more layered and is explicitly surfaced through the `build_prompt(...)` path in `codex-rs/core/src/codex.rs` and the session loop in `codex-rs/core/src/codex.rs` / `codex-rs/core/src/client.rs`.

## Tools

### OpenCode

OpenCode resolves tools in `packages/opencode/src/session/llm.ts` and `packages/opencode/src/provider/transform.ts`.

The important behaviors are:

- `resolveTools(...)` filters tools by agent permissions and user/tool toggles
- provider-specific tools are converted to AI SDK tool objects
- a synthetic no-op tool may be injected for provider compatibility
- OpenAI Responses tool variants are prepared in `packages/opencode/src/provider/sdk/copilot/responses/openai-responses-prepare-tools.ts`

So OpenCode is largely "AI SDK tools first", with provider compatibility handled in the transformer and per-provider adapters.

### Codex

Codex constructs tools through its own router and registry:

- `built_tools(...)` in `codex-rs/core/src/codex.rs`
- `ToolRouter` and tool handlers in `codex-rs/core/src/tools/*`
- dynamic tools, MCP tools, app tools, and connector discovery are all folded into one router

This gives Codex a more centralized tool graph than OpenCode's AI SDK-first model.

## Input caching

### OpenCode

OpenCode does make use of backend caching, but only as a provider-side hint and only for supported providers.

The cache behavior lives in `packages/opencode/src/provider/transform.ts`:

- it selects the first two `system` messages
- it selects the last two non-system messages
- it marks those messages or their last content block with provider-specific cache-control fields

The supported cache flags are provider-specific:

- Anthropic: `cacheControl: { type: "ephemeral" }`
- OpenRouter: `cacheControl: { type: "ephemeral" }`
- Bedrock: `cachePoint: { type: "default" }`
- OpenAI-compatible: `cache_control: { type: "ephemeral" }`
- Copilot: `copilot_cache_control: { type: "ephemeral" }`
- Alibaba: `cacheControl: { type: "ephemeral" }`

On the read path, OpenCode maps usage from OpenAI Responses `input_tokens_details.cached_tokens` into its internal usage counters. That means it can observe cache reads when the backend reports them, but it does not currently maintain a Codex-style account usage pipeline for cached input.

### Codex

Codex is more explicit about cache accounting:

- `cached_input_tokens` is part of the protocol usage model
- cached input is folded into session and account usage tracking
- prompt-debug captures also surface request/response payloads that make cache behavior easier to inspect

## Prompt capture

### OpenCode

OpenCode previously did not have a Codex-style backend prompt capture pipeline.

I added a lightweight capture hook in the existing direct trace path:

- enable `OPENCODE_DIRECT_TRACE=1`
- OpenCode now writes a `llm.request` event with the model-visible request payload

This is useful for prompt inspection, but it is not yet the same as Codex's full backend capture directory with request, output, and reasoning NDJSON files.

OpenCode also now captures turn usage on the session finish path:

- input tokens
- cached input tokens
- output tokens
- derived USD cost
- derived credits at Codex's 25 credits per USD conversion

That data is persisted per provider and OAuth account email in `usage.json`, with automatic reset behavior when the backend `used_percent` drops across a turn boundary.

### Codex

Codex already has first-class prompt capture:

- `[prompt_debug_http]` in `config.toml`
- `CODEX_BACKEND_CAPTURE*` environment overrides
- per-query NDJSON files for input, output, reasoning, and full traffic
- `scripts/render_prompt_captures.sh` to render captures into readable markdown

## OAuth and auth credential storage

### OpenCode

OpenCode currently stores provider credentials in JSON files under the global data directory.

The main stores are:

- `packages/opencode/src/auth/index.ts` -> `auth.json`
- `packages/opencode/src/v2/auth.ts` -> `auth-v2.json`
- `packages/opencode/src/mcp/auth.ts` -> `mcp-auth.json`

The credential payloads are plain JSON records, written with `0600` permissions. There was no keyring-backed credential store before this change.

I retrofitted a directory mirror at `auth.json.d` so credentials can also be stored one-file-per-provider, which is closer to Codex's profile-directory pattern.
OAuth credentials also persist the account email when it is available, which lets the status command identify the active account more clearly and lets usage accounting key off the account identity instead of only the provider ID.

### Status

OpenCode now has a one-shot status command at `packages/opencode/src/cli/cmd/status.ts`.

It reports:

- the provider being inspected
- the account email or account ID
- backend `used_percent`
- usage credits
- cumulative usage in USD
- token totals for input, cached input, and output

It also supports `--reset` to clear the stored usage snapshot for the current provider/account pair.

### Codex

Codex has a more layered auth story:

- CLI auth uses `auth.json` plus an `auth.json.d` profile directory
- MCP OAuth credentials prefer the OS keyring through `keyring`
- if the keyring is unavailable, Codex falls back to a file store

Codex's keyring-backed MCP storage lives in:

- `codex-rs/rmcp-client/src/oauth.rs`
- `codex-rs/keyring-store/src/lib.rs`
- `codex-rs/login/src/auth/storage.rs`

## Bottom line

- OpenCode and Codex both support prompt engineering and cache hints, but Codex exposes prompt capture and auth storage more explicitly.
- OpenCode now has:
  - a direct-trace prompt request capture event
  - an `auth.json.d` mirror for provider credentials
  - usage tracking for input, cached input, output, and USD
  - a `status` command for account and backend usage visibility
- OpenCode still differs from Codex in that it does not yet have:
  - Codex-style backend capture NDJSON files
  - a full keyring-backed credential store
  - Codex's centralized tool router and usage accounting model

## Files touched

- [`packages/opencode/src/auth/index.ts`](../packages/opencode/src/auth/index.ts)
- [`packages/opencode/src/cli/cmd/providers.ts`](../packages/opencode/src/cli/cmd/providers.ts)
- [`packages/opencode/src/session/llm.ts`](../packages/opencode/src/session/llm.ts)
- [`packages/opencode/src/status/usage.ts`](../packages/opencode/src/status/usage.ts)
- [`packages/opencode/src/cli/cmd/status.ts`](../packages/opencode/src/cli/cmd/status.ts)
