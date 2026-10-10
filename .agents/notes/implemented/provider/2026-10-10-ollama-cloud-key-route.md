# Agent Note: Ollama Cloud as a key-based route

Status: implemented

## Problem

Ollama Cloud speaks OpenAI-compatible chat, but it has no OAuth
login: access is a bearer API key, and the model listing, usage, and
web capabilities live on Ollama-native endpoints (`/api/tags`,
`/api/show`, `/usage`, `/api/web_search`, `/api/web_fetch`). The
five OAuth providers in `PROVIDER_IDS` all assume a refreshable
session in `auth.json`, and the key-based sources (`opencode-go`,
`kimi-code`, `minimax`) have no chat route at all. Neither shape
fits a key-based provider that must also appear in the model picker.

## Decision

Ollama Cloud ships as a fourth shape: a key-based independent route
named `ollama-cloud`, following the cursor precedent (own route id,
credentials-service key, outside `PROVIDER_IDS`, no `auth.json`
entry). Chat posts to the configured native baseURL's `/v1` sibling
with `max_tokens`, `reasoning_effort`, and
`stream_options.include_usage`; discovery and web calls ride the
native baseURL unchanged. Only catalogued models are served: an
unlisted id fails with `UNKNOWN_MODEL` before provider I/O, and a
missing key hides the picker entry and fails requests with
`MISSING_CREDENTIAL`. The static catalog carries the three Cloud
models (deepseek-v4.1-flash, glm-5.3, glm-5.3-flash, all 1M
context); live discovery enriches capabilities and falls back to
it. Usage joins the external-usage controller (`GET {base}/usage`,
404 means unsupported), and search/fetch register under the same
route id on the web seam. The vendor publishes no per-model output
ceiling, so the adapter sets no request-level cap of its own beyond
the catalog row's default.

## Alternatives considered

- **Delegating chat to the pi-ai multi-provider adapter, the way
  the standalone ollama plugin does.** Lost: this package keeps
  zero runtime dependencies and already owns an OpenAI-completions
  translator, so a second chat stack would add a dependency for no
  new capability.
- **Stuffing the provider into `PROVIDER_IDS` as a sixth OAuth
  member with a degenerate session.** Lost: every consumer of that
  union (pooling, multi-account UI, token refresh, `auth.json`
  typing) assumes expiring sessions; a key would rot through those
  paths as a fake permanent session.
- **Usage-only membership beside opencode-go, leaving chat on the
  hand-written `llm-pi-ai` route.** Lost: it splits one provider
  across two configuration surfaces and two route ids, and the
  picker could then offer a model whose quota card lives
  elsewhere.

## Consequences

One provider now owns chat, discovery, usage, and web search/fetch
behind a single route id and credential ref, at the cost of a new
provider-specific adapter file plus its specs that future endpoint
changes must update. The `deepseek-v4.1-flash` effort set (`off`,
`low`, `high`, `max`, default `high`) mirrors the vendor's
`/api/show` thinking values; `off` rides the wire as `none`,
matching the standalone plugin's level map. No `medium`: the vendor
lists none.

## Evidence and what it does not show

Sources are the standalone plugin's
[ADR 0001](https://github.com/NOirBRight/dsh-llm-ollama/blob/main/docs/adr/0001-separate-chat-protocol-from-ollama-capabilities.md)
(chat over `/v1/chat/completions`, native endpoints for the rest),
the [Ollama OpenAI
compatibility](https://docs.ollama.com/api/openai-compatibility)
page (Cloud base `https://ollama.com/v1`), and the registry pages
for
[deepseek-v4.1-flash](https://registry.ollama.com/library/deepseek-v4.1-flash),
[glm-5.3](https://registry.ollama.com/library/glm-5.3), and
[glm-5.3-flash](https://registry.ollama.com/library/glm-5.3-flash)
(1M context, vision flags, GLM effort levels).

Verification is unit-level only: `pnpm build`, `tsc -p
tsconfig.test.json`, and `pnpm test` (all mocked, hermetic). No
check here calls the live Cloud endpoints, and the host E2E
fixtures cover usage plus planned discovery refusals, not a real
chat round trip. That gap belongs to the manual pre-release canary.
