# Changelog

## v0.1.5 — 2026-10-09

The release date is set when the tag is cut.

### What is fixed

- OAuth callbacks validate `state` before they act on an `error` parameter. An
  uncorrelated request to the loopback port can no longer cancel a login in
  progress. This defect is not new in v0.1.4: the callback handler had this
  ordering in v0.1.0 (`src/auth/oauth-flow.ts`, commit `0103c53`), and every
  release since carried it.
- Provider response text no longer reaches these failure paths: the OAuth
  callback page and error, the device-code and token-poll failures, the
  video-generation tool's failure and unexpected-status errors, every JSON
  parse failure on a provider response, the Grok OIDC discovery rejection, the
  Cursor stream's provider-derived failures (with the exceptions listed under
  "What is not fixed"), and the `Codex Web Search` invalid-JSON error. A
  provider can echo a credential, and matching known token shapes cannot be
  relied on to catch every form, so the text is dropped rather than filtered.
- The Grok OIDC discovery check rejects a non-`x.ai` endpoint with
  `grok OIDC discovery returned a non-x.ai <field>`, naming the field
  (`authorization_endpoint` or `token_endpoint`) and not the discovered URL.
  The URL came from the provider's discovery document. This was one of the
  paths the v0.1.4 notes said the next patch would address.
- JSON parse failures on provider responses go through one reader,
  `parseProviderJson`. Node's `Unexpected token` message quotes about ten
  characters of the input, so a body that began with a credential leaked those
  characters. The reader throws a `SyntaxError` that names the local endpoint
  and says the body was omitted, with no `cause`. `Codex Web Search` parses
  its own bounded text and no longer attaches the original error as `cause`,
  because the host prints causes recursively and that only moved the excerpt.
- Cursor receives no provider text on any failure. Most local failures now
  keep their own text and code, and the ones that are still relabelled as
  omitted provider text are listed under "What is not fixed" — that labelling
  is wrong, but it drops text rather than leaking it.
- The release is checked against the version it names: `package.json` is now
  `0.1.5`, and `scripts/check-compat-docs.mjs` fails when
  `docs/compatibility.md` states another plugin version.

### What is not fixed

- Provider-controlled text is still displayed on the successful paths. The
  image tool shows the provider's `revised_prompt` in its result text and
  value. The video tool shows the temporary provider URL (`Temporary provider
  URL`). Both are content the user asked for, and neither is filtered.
- **The v0.1.4 promise on the Cursor stream is only partly kept.** The v0.1.4
  release notes ended: "The next patch is planned to address the OAuth
  state-ordering defect above and the remaining provider-text paths listed in
  this section." That list named the video tool, the device-code and OAuth
  login failures, the Cursor stream, JSON parse failures and the Grok OIDC
  discovery URL. This release delivers the OAuth ordering fix and all of those
  paths except the Cursor stream, which it delivers in part: Cursor failures
  whose message can quote provider text are replaced, and the rest of the
  Cursor path is not fixed as described in the next item. This release does
  not meet the promise for Cursor, and nothing here should be read as saying
  it does.
- Cursor: some failures that are probably local are still shown as `<code>
  [provider response text omitted]`, although no provider text was involved.
  - A transport failure that carries no operating-system network code. TLS and
    certificate failures (measured: a self-signed certificate on the endpoint
    gives `CURSOR_ERROR [provider response text omitted]`) and HTTP/2
    protocol errors are in this class. The vendor derives its `TRANSPORT` code
    from words in the message text (`network`, `connection`, `socket`,
    `fetch`, `ECONN`, `http2`), and a provider's end-stream message or
    `grpc-message` can contain any of them, so the code alone cannot say the
    failure is local, and this release does not trust it alone. It keeps a
    transport failure only when the thrown error, or its `cause`, carries a
    socket-layer code: `ECONNREFUSED`, `ECONNRESET`, `ECONNABORTED`,
    `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `ENETUNREACH`, `ENETDOWN`,
    `EHOSTUNREACH`, `EHOSTDOWN` or `EPIPE`. Extending that check to TLS and
    HTTP/2 error codes is possible and was not done or verified.
  - Any other plain error the vendor raises whose message is not one of the
    literals listed under "What you may notice". A new vendor message would
    be replaced until it is added to the list.
  - A network error whose code is not in the list above.
- The video request id is displayed in failure messages. It must match
  `[A-Za-z0-9_-]{1,128}`, which rules out prose and message excerpts, but a
  credential-shaped string matches it. It is a bounded provider value shown
  for support correlation, not an absence of provider text.
- "No provider text" means no provider-controlled free text in the failure
  paths audited here. It does not mean no secret exists anywhere in the
  process, and model output, tool output and stream content are out of scope.
- Parse sites that still call `.json()` or `JSON.parse` directly and are not
  covered by these tests: the best-effort Antigravity, Copilot and Claude
  profile lookups, the VS Code release feed, the npm version lookup (all
  swallow the failure and show nothing), and the local files the plugin reads
  (auth, catalog, settings and model-defaults stores). The local-file sites
  were not part of this audit.

### What you may notice

- Video failures no longer show the provider's reason. A failed or expired
  generation reports `generation failed (request <id>): [provider response
  body omitted]`.
- Login failures no longer show the provider's description. An OAuth error
  callback shows `authorization failed (<category>): [provider message
  omitted]`, where the category is one of the RFC 6749 error codes. A device
  login failure shows its HTTP status and the same omission marker.
- An OAuth error callback that carries no `state`, or the wrong one, no longer
  fails the login at once. It is answered with `state mismatch` and the login
  waits for its timeout (180 seconds by default). RFC 6749 requires a provider
  to echo `state` on an error redirect; whether every provider here does was
  not checked against a live account.
- A video submit response whose `request_id` is outside the shape above now
  fails with `no usable request_id`. The submission has already been sent
  by then, so the generation may continue on the provider without being tracked.
- A malformed provider response is reported as `<endpoint>: invalid JSON:
  [provider response body omitted]` in Settings and in errors, instead of
  Node's message.
- Cursor: a failure that can quote provider text is shown as `<code>
  [provider response text omitted]`, for example `RATE_LIMIT [provider
  response text omitted]`: a response with an unexpected content type, a
  `grpc-message` trailer, an end-stream error, a frame-reader error not listed
  below, and a transport-coded failure without a socket-layer code. The code
  and retry behavior are unchanged. These failures keep their own text and
  code, because the message is a local literal or an operating-system error:
  - the auth service: not signed in, sign-in needs to be renewed, token-refresh
    status;
  - the vendor's request validation: an unsupported option or content, and the
    tool-round limit (`TOOL_LIMIT`);
  - the vendor's fixed messages, matched exactly: `Cursor agent returned HTTP
    <status>` (so `HTTP 429` and `HTTP 401` read as such),
    `Cursor HTTP response timeout`, `Cursor HTTP stream closed before
    response`, `Cursor agent bridge closed before accepting the request`,
    `Cursor tool continuation bridge closed before accepting the result`,
    `Cursor sent an unreadable compressed frame`, `Cursor stream idle timeout`,
    `Cursor stream progress timeout: no content for <n>ms`, and an invalid
    Cursor setting (`cursor-subscription: retryCount must be ...`). A provider
    that echoed one of these sentences would only make you read a local
    literal;
  - a failure to read an image from the host attachment store;
  - a network error from the operating system, such as `connect ECONNREFUSED`
    when there is no network or `getaddrinfo ENOTFOUND` when DNS fails. These
    are local, and reading them as if Cursor had replied was the most
    misleading case. The match is on the thrown error's own code or its cause's,
    which a
    provider cannot set; the vendor's `TRANSPORT` code is not used for it.
  A message that only contains one of these sentences, or extends it, is not
  matched and stays replaced.
- Cursor classification: the vendor derives a stream failure's code from the
  message text. A corrupt stored credential used to be classified from the
  body excerpt in Node's parse message, so one beginning with `quota` came out
  as `RATE_LIMIT`. It now fails with the local parse message and the code
  `CURSOR_ERROR`.

### Test coverage

- Guarded: every one of the 34 `parseProviderJson` call sites, plus the
  `Codex Web Search` `cause`. Each call was reverted to the bare `.json()` (the
  stored Cursor credential, which parses a string, to `JSON.parse`) one at a
  time, and the suite failed on every one of the 34. The sites with no guard
  before this release were the device-code request, the device token poll,
  Cursor usage, external (OpenCode Go and Kimi Code) usage, image generation,
  video submit and `x_search`.
- Two guards are narrower than they look. Cursor usage reads two dashboard
  endpoints and swallows one failing alone, so the test fails both. The
  `Codex Web Search` test asserts the absence of `cause`, not the host's
  rendering of it.
- Cursor failure classes were measured against the real vendored `AgentRun`
  on a loopback HTTP/2 server or a closed loopback port, not only against
  fakes: HTTP 429 and 401, the response timeout, a stream closed before a
  response, the idle and progress timeouts, and a refused connection. The
  closed-bridge, compressed-frame, settings and attachment-read failures, and
  the `TOOL_LIMIT` pass-through, use fakes because no loopback server produces
  them. A DNS failure (`ENOTFOUND`) and a TLS failure were measured by hand
  against the real vendor and are not in the suite; the suite covers the
  `ENOTFOUND` code with a synthetic error.
- Not covered: the sites listed under "What is not fixed"; and any vendor
  plain-error message not listed under "What you may notice".
- No live provider was used. The Cursor stream was exercised against fakes and
  loopback servers, never the real Cursor service; the OAuth callback and the
  device login were exercised only against injected fakes.

### Maintenance

- Removed uncalled code: `deriveModelDefaultsView`, `shouldFetchModelDefaults`,
  `modelDefaultsSignature` and the filter threshold from
  `src/client/SubscriptionsSection.tsx`, and `antigravityGenerateURL` from
  `src/providers/antigravity.ts`. None was reachable through the package's
  exports. The model-defaults tests now drive the editor that runs.
- The per-PR CI step runs `check-upstream-ports.mjs --local-only`. A new
  scheduled and manually dispatched workflow, `upstream-audit.yml`, fetches
  upstream and enumerates its commits with `--require-upstream`.
- That workflow has never run, and its first run is expected to fail. As of
  2026-10-09 upstream `main` is five commits past the ledger's reviewed point
  (`85e6c6c9`), including its v0.9.9 release, and none of them is classified in
  `docs/upstream-ports.json`. Each will be reported as an unclassified
  upstream commit until it is ported or declined. A failure to fetch upstream
  is reported separately as a setup failure.

## v0.1.4 — 2026-10-08

- Codex accounts can spend a banked usage-limit reset from the account card,
  and the card shows how many are left. The reset is confirmed before it is
  sent, and an ambiguous response parks the account until you check it, so a
  retry cannot spend a second credit.
- Claude accounts show their banked limit resets, with the remaining count and
  when each one lapses. This is display only: the shape comes from an
  independent implementation rather than a published contract, and spending a
  credit is irreversible, so no control is offered.
- A Claude request whose images exceed the provider limit now hands them to the
  host's compaction image offload instead of failing the turn. This fixes
  oversized-image requests that previously failed with an HTTP error.
- The model catalog no longer loses one account's models when two accounts
  save at the same time. Each save now merges onto the latest on-disk state.
- A failed account-pool member reports its own failure instead of a synthetic
  rate limit, so a revoked credential or a provider outage no longer reads as
  quota exhaustion. Genuine quota exhaustion keeps its existing message,
  recovery hint and retry behavior.
- Antigravity tool results keep their error flag on every path. A failed tool
  call whose output was JSON previously reached the model looking successful.
- Provider response text is no longer placed in user-visible error messages.
  Errors keep their local classification, HTTP status and recovery hint, and
  say that the provider's response body was omitted. This is deliberate: a
  provider can echo back a credential, and matching known token shapes cannot
  be relied on to catch every form.
- A mid-session account switch no longer reuses the previous account's signed
  replay, and an abandoned SSE stream now cancels its body instead of leaving
  it unread.
- Settings and the usage dialog follow the host's native controls and theme,
  including dark mode. Prompt-cache TTL is configurable, and the status-bar
  quota display can pin one provider or rotate through them.
- The repository now carries a checked ledger of what was taken from upstream,
  what was declined and why. CI fails if the ledger drifts from the tree, and a
  decline that rests on a host capability is re-verified against the published
  package, which is the specific mistake that produced this ledger.
- Live-provider gaps, not verified by this release: no live account was used to
  exercise the Codex reset endpoint or Claude's banked-reset block, so what
  those endpoints actually return remains unconfirmed. Native confirmation
  dialog focus, Escape and cancel handling, and the always-show rotation timer
  were not checked in a running browser. The Settings panel and the Claude
  reset row were checked by eye in the light and dark themes.

### Corrections to this entry, added after the release

These are corrections to what the entry above claimed, not changes to what the
tag contains. The fixes themselves are in v0.1.5.

- Retracted: "Provider response text is no longer placed in user-visible error
  messages." It was wider than the code. The tag removed provider text from the
  shared HTTP and OAuth converters, the rate-limit warning, the two translate
  failure helpers and the four malformed-SSE handlers. It still showed provider
  text from the video-generation tool, the device-code login failure, the OAuth
  callback page, the Cursor stream, every `Response.json()` parse failure, and
  the Grok OIDC discovery URL.
- Retracted: "A mid-session account switch no longer reuses the previous
  account's signed replay." Replay captured by v0.1.4 is wrapped with concrete
  provider, account and model identity. Legacy unwrapped replay, including
  histories captured before upgrading, carries no account identity, so as
  upstream does it is still passed through when its provider and model match
  the concrete route: a same-provider, same-model account switch can reuse it.
  See [the port report](docs/replay-sse-port-verification.md).
- Clarified: the ambiguous-response block on a Codex reset is process-local,
  not a durable limit. Restarting the host clears it, and a lost success may
  already have spent a credit, so check the account in Codex before retrying.
  The entry said the account stays parked "until you check it".
- Clarified: CI at the tag checked only the upstream ledger's local half (fork
  ancestry, evidence paths, the prose summary, host-capability claims). It did
  not enumerate upstream commits, and "CI fails if the ledger drifts from the
  tree" overstated that.
- Two defects shipped in v0.1.4: the OAuth callback handled `error` before
  validating `state`, and the provider-text paths named in the first
  retraction. The OAuth defect is older than v0.1.4; see v0.1.5.

## v0.1.3 — 2026-10-08

- Usage bars keep their elapsed-time cursor whenever the provider's timing
  places the current window, including at 0% used, after a failed refresh, and
  for stale or unobserved readings. Only a current reading drives the pace
  warning; an ended, future-starting, or reset-only window still shows no
  cursor, and an unusable percentage still shows no fill.
- MiniMax standard (non-video) quotas that report a remaining percentage
  beside zero counts appear again next to the count-backed video quotas.
  Settings rows and the badge keep the model name, and a status-2 row without
  a usable reading does not imply an exhausted bar.
- Settings → Subscriptions → Status-bar quota display gains **Always show**,
  which rotates through the providers that report usage every 10 seconds while
  the current model has no quota source, so the pill never disappears.
- README screenshots show the current pill and dialog.

## v0.1.2 — 2026-10-02

- Usage meters show elapsed-time markers and Standard, Relaxed, or Remaining
  coloring presets. Provider timing and MiniMax usage handling were fixed.
- Built-in Codex and Copilot fallback catalogs include GPT-6-era models;
  live provider discovery remains authoritative.
- The subscription usage dialog uses the host's backdrop blur alongside its
  translucent menu fill, keeping the transcript behind it from showing sharply.
- The Plugin Manager card and the Settings plugin inventory now show a
  localized title and description (`DSH Subscriptions` / `订阅中心`) instead
  of falling back to the English package description, and the plugin card
  shows a dedicated icon.
- Live-provider canaries are optional rather than a stable-release gate;
  remaining live-provider gaps must be disclosed in release notes.

## v0.1.1 — 2026-10-01

- Settings shows the CLI version Codex and Claude present, with its source (npm
  latest / local CLI / built-in / configured), ported from upstream `f6e1b3f` so
  a failed npm lookup no longer reads as a plan limit.
- Renamed the npm package from `@goodboys-ai/dsh-subscription-hub` to
  `dsh-subscriptions`. Install with
  `dsh plugin --profile web add dsh-subscriptions`; if the old scoped package is
  installed, remove it first — installing both registers the same adapters twice
  and breaks plugin load. The GitHub repository moved to
  `goodboys-ai/dsh-subscriptions` (the old slug redirects); the scoped package
  was deprecated with a pointer to the new name.

## v0.1.0 — 2026-09-30

- First release. DSH support window and bounded peer range: see docs/compatibility.md.
- Published to npm as `@goodboys-ai/dsh-subscription-hub` (trusted publishing;
  prereleases on the alpha dist-tag).
