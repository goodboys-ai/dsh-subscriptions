// Values the host E2E preload serves and the driver expects back. Both sides
// import this module, so a changed fixture cannot drift from its assertion.
// The preload itself is never imported by the driver: it patches fetch and
// net for whichever process loads it.

/** Text of the canned Codex SSE reply; the driver waits for it in the transcript. */
export const CODEX_REPLY = 'Hello from the Codex fixture.'

/** Model the driver selects; the canned stream answers only this model. */
export const CODEX_MODEL = { id: 'gpt-6-astra', name: 'GPT-6-Astra' }

/**
 * Used percent each usage source reports, and the name the badge dialog
 * prints for it. Every value is distinct, so a row showing another
 * provider's number is caught. Antigravity reports 56% remaining, which
 * the plugin shows as 44% used.
 */
export const USAGE_PERCENT = {
  codex: { name: 'Codex', percent: 11 },
  claude: { name: 'Claude', percent: 22 },
  grok: { name: 'Grok', percent: 33 },
  antigravity: { name: 'Antigravity', percent: 44 },
  'cursor-subscription': { name: 'Cursor', percent: 55 },
  'opencode-go': { name: 'OpenCode Go', percent: 66 },
  'kimi-coding': { name: 'Kimi Code', percent: 77 },
}

/** The collapsed pill for the selected Codex model: the default account's 5-hour window. */
export const CODEX_PILL = 'Codex '

/** The fixture Cursor access token; its `sub` is `auth0|user_bar`. */
const CURSOR_ACCESS = 'fake.eyJzdWIiOiJhdXRoMHx1c2VyX2JhciIsImV4cCI6NDEwMjQ0NDgwMH0.sig'

/**
 * Every provider request the preload answers, keyed by `<METHOD> <URL>`.
 * Matching is exact, so a request with another path, query, or method is
 * refused and fails the run. `credential` is the header the request must
 * carry, compared whole; a request without it gets 401, which proves the
 * plugin read the fixture profile. `null` marks an anonymous request (the
 * npm registry lookups). `body` is the canned JSON reply; the Codex model
 * request streams CODEX_REPLY instead. `required` requests must appear in
 * the preload's log by the end of the run.
 */
// The same epoch can be supplied to baseline and candidate screenshot runs.
const fixtureNow = Number(process.env.HOST_E2E_FIXTURE_NOW ?? Date.now())
const periodStart = new Date(fixtureNow - 6 * 60 * 60_000).toISOString()
const periodEnd = new Date(fixtureNow + 18 * 60 * 60_000).toISOString()

/**
 * General has percentage-only quota with zero totals, including an unused
 * five-hour window. Video has legacy remaining counts. All four windows are
 * current at fixtureNow and must stay separate in RPC, badge, and settings.
 */
export const MINIMAX_WINDOWS = [
  { kind: 'session', scope: 'general', usedPercent: 0, startsAt: fixtureNow - 60 * 60_000, resetsAt: fixtureNow + 4 * 60 * 60_000 },
  { kind: 'weekly', scope: 'general', usedPercent: 2, startsAt: fixtureNow - 24 * 60 * 60_000, resetsAt: fixtureNow + 6 * 24 * 60 * 60_000 },
  { kind: 'other', scope: 'video', usedPercent: 88, startsAt: fixtureNow - 6 * 60 * 60_000, resetsAt: fixtureNow + 18 * 60 * 60_000 },
  { kind: 'weekly', scope: 'video', usedPercent: 99, startsAt: fixtureNow - 2 * 24 * 60 * 60_000, resetsAt: fixtureNow + 5 * 24 * 60 * 60_000 },
]

export const FIXTURE_REQUESTS = {
  'POST https://chatgpt.com/backend-api/codex/responses': {
    credential: ['authorization', 'Bearer fake-codex-access'],
    stream: true,
    required: true,
  },
  'GET https://chatgpt.com/backend-api/wham/usage': {
    credential: ['authorization', 'Bearer fake-codex-access'],
    body: {
      plan_type: 'plus',
      rate_limit: { primary_window: { used_percent: USAGE_PERCENT.codex.percent, limit_window_seconds: 18_000, reset_at: Math.floor((fixtureNow + 4 * 60 * 60_000) / 1000) } },
    },
    required: true,
  },
  'GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits': {
    credential: ['authorization', 'Bearer fake-codex-access'],
    body: {
      credits: [
        { id: 'fake-reset', reset_type: 'codex_rate_limits', status: 'available', expires_at: new Date(fixtureNow + 5 * 86_400_000).toISOString() },
      ],
    },
    required: true,
  },
  // The adapter asks for the banked-reset block on the same call, so this exact
  // URL is what the plugin requests; the plain one stays for the fallback path.
  'GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1': {
    credential: ['authorization', 'Bearer fake-claude-access'],
    body: {
      five_hour: { utilization: USAGE_PERCENT.claude.percent, resets_at: new Date(fixtureNow + 4 * 60 * 60_000).toISOString() },
      cedar_ember: {
        eligible: true,
        next_grant_id: 'grant-now',
        cooldown_until: null,
        grants: [
          { id: 'grant-now', resets_total: 2, resets_left: 2, ends_at: new Date(fixtureNow + 3 * 86_400_000).toISOString(), usable_now: true, paused: false },
          { id: 'grant-later', resets_total: 1, resets_left: 1, ends_at: new Date(fixtureNow + 9 * 86_400_000).toISOString(), usable_now: false, paused: false },
        ],
      },
    },
    required: true,
  },
  'GET https://api.anthropic.com/api/oauth/usage': {
    credential: ['authorization', 'Bearer fake-claude-access'],
    body: { five_hour: { utilization: USAGE_PERCENT.claude.percent, resets_at: new Date(fixtureNow + 4 * 60 * 60_000).toISOString() } },
    required: false,
  },
  'GET https://cli-chat-proxy.grok.com/v1/billing?format=credits': {
    credential: ['authorization', 'Bearer fake-grok-access'],
    body: { config: { creditUsagePercent: USAGE_PERCENT.grok.percent, subscriptionTier: 'SuperGrok',
      currentPeriod: { start: periodStart, end: periodEnd } } },
    required: true,
  },
  'POST https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels': {
    credential: ['authorization', 'Bearer fake-antigravity-access'],
    body: { models: { 'gemini-bar': { quotaInfo: { remainingFraction: (100 - USAGE_PERCENT.antigravity.percent) / 100 } } } },
    required: true,
  },
  'POST https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist': {
    credential: ['authorization', 'Bearer fake-antigravity-access'],
    body: { paidTier: { name: 'Pro' } },
    required: false,
  },
  'GET https://cursor.com/api/usage-summary': {
    credential: ['cookie', `WorkosCursorSessionToken=user_bar::${CURSOR_ACCESS}`],
    body: { membershipType: 'pro', billingCycleStart: periodStart, billingCycleEnd: periodEnd,
      individualUsage: { plan: { totalPercentUsed: USAGE_PERCENT['cursor-subscription'].percent } } },
    required: true,
  },
  'GET https://cursor.com/api/usage?user=user_bar': {
    credential: ['cookie', `WorkosCursorSessionToken=user_bar::${CURSOR_ACCESS}`],
    body: { 'gpt-4': { numRequests: 0 } },
    required: false,
  },
  'GET https://opencode.ai/zen/go/v1/usage': {
    credential: ['authorization', 'Bearer fake-opencode-key'],
    body: { usage: { rolling: { percent: USAGE_PERCENT['opencode-go'].percent, resetsAt: new Date(fixtureNow + 4 * 60 * 60_000).toISOString() } } },
    required: true,
  },
  'GET https://api.kimi.com/coding/v1/usages': {
    credential: ['authorization', 'Bearer fake-kimi-key'],
    body: { usages: { limit_5h: { used_ratio: USAGE_PERCENT['kimi-coding'].percent / 100 } } },
    required: true,
  },
  'GET https://www.minimax.io/v1/token_plan/remains': {
    credential: ['authorization', 'Bearer fake-minimax-key'],
    body: { base_resp: { status_code: 0 }, model_remains: [
      { model_name: 'general',
        start_time: MINIMAX_WINDOWS[0].startsAt, end_time: MINIMAX_WINDOWS[0].resetsAt,
        weekly_start_time: MINIMAX_WINDOWS[1].startsAt, weekly_end_time: MINIMAX_WINDOWS[1].resetsAt,
        current_interval_total_count: 0, current_interval_usage_count: 0, current_interval_remaining_percent: 100, current_interval_status: 1,
        current_weekly_total_count: 0, current_weekly_usage_count: 0, current_weekly_remaining_percent: 98, current_weekly_status: 1 },
      { model_name: 'video',
        start_time: MINIMAX_WINDOWS[2].startsAt, end_time: MINIMAX_WINDOWS[2].resetsAt,
        weekly_start_time: MINIMAX_WINDOWS[3].startsAt, weekly_end_time: MINIMAX_WINDOWS[3].resetsAt,
        current_interval_total_count: 100, current_interval_usage_count: 12,
        current_weekly_total_count: 100, current_weekly_usage_count: 1 },
    ] },
    required: true,
  },
  'GET https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest': {
    credential: null,
    body: { version: '9.9.9' },
    required: false,
  },
  'GET https://registry.npmjs.org/@openai%2fcodex/latest': {
    credential: null,
    body: { version: '9.9.9' },
    required: false,
  },
}

/**
 * Provider requests the preload refuses on purpose. They are model catalog
 * discovery and the client-version lookups behind it. The plugin must
 * survive them offline, with the picker still built from its static model
 * list, and the driver asserts that by finding GPT-6-Astra there. A
 * refusal of anything not listed here fails the E2E. Entries ending in `:443`
 * are raw TLS hosts (the Cursor transport does not go through fetch); the
 * rest are URL prefixes.
 */
export const EXPECTED_REFUSALS = [
  'https://chatgpt.com/backend-api/codex/models',
  'https://api.anthropic.com/v1/models',
  'https://api.githubcopilot.com/models',
  'https://update.code.visualstudio.com/api/releases/stable',
  'https://api.x.ai/v1/models',
  'https://cli-chat-proxy.grok.com/v1/models',
  'api2.cursor.sh:443',
]
