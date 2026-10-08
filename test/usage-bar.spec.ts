/**
 * One signed-in profile, one fetch router, the real plugin.
 *
 * The usage bar is a single roster: OAuth sessions, the Cursor credential,
 * and the OpenCode Go and Kimi keys are read together, then each account's
 * usage endpoint is called. This file stands all of those up at once and
 * checks the bar helpers. It does not start DSH and does not render the
 * composer. The rendered bar is `scripts/host-e2e.sh`, which opens a real
 * `dsh web` with `test/fixtures/host-e2e-profile/`. Copilot is signed in
 * too, and stays off the bar, because the plugin has no Copilot usage fetcher.
 *
 * The usage URLs below are literals. They are not imported from `src/`, so
 * a renamed production constant that the fetcher no longer calls fails here.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, mock, test } from 'node:test'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ProviderId } from '../src/auth/store.js'
import type { UsageWindow } from '../src/client/SubscriptionsSection.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-usage-bar-'))
// Suite-level hook: the mkdtemp is top-level, so there is no test context to hang t.after on.
after(() => { rmSync(home, { recursive: true, force: true }) })
process.env.DSH_HOME = home

const FAR = Date.now() + 24 * 60 * 60_000

/** Distinct percents so a swapped endpoint fails the pill text. */
const USED = {
  codex: 11,
  claude: 22,
  grok: 33,
  antigravity: 44,
  cursor: 55,
  opencode: 66,
  kimi: 77,
} as const

const CODEX_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CLAUDE_URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1'
const GROK_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const ANTIGRAVITY_MODELS_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
const ANTIGRAVITY_TIER_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
const CURSOR_SUMMARY_URL = 'https://cursor.com/api/usage-summary'
const OPENCODE_URL = 'https://opencode.ai/zen/go/v1/usage'
const KIMI_URL = 'https://api.kimi.com/coding/v1/usages'

interface SeenCall {
  url: string
  authorization: string | null
}

test('every signed-in usage account shows up in the bar', async (t) => {
  const seen: SeenCall[] = []
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const authorization = new Headers(init?.headers).get('authorization')
    seen.push({ url, authorization })
    const body = fixtureFor(url)
    if (body === undefined) return new Response('not a usage fixture', { status: 404 })
    return Response.json(body)
  })
  t.after(() => { mock.restoreAll() })

  const { saveAccountSession } = await import('../src/auth/store.js')
  await saveAccountSession('codex', 'codex-acct', {
    accessToken: 'codex-access',
    refreshToken: 'refresh',
    expiresAt: FAR,
    accountId: 'codex-acct',
  })
  await saveAccountSession('claude', 'claude@example.invalid', {
    accessToken: 'claude-access',
    refreshToken: 'refresh',
    expiresAt: FAR,
    scopes: 'user:inference',
    emailAddress: 'claude@example.invalid',
  })
  await saveAccountSession('grok', 'grok@example.invalid', {
    accessToken: 'grok-access',
    refreshToken: 'refresh',
    expiresAt: FAR,
    tokenEndpoint: 'https://auth.grok.example/token',
    account: 'grok@example.invalid',
  })
  await saveAccountSession('antigravity', 'anti@example.invalid', {
    accessToken: 'antigravity-access',
    refreshToken: 'refresh',
    expiresAt: FAR,
    projectId: 'project-bar',
    account: 'anti@example.invalid',
  })
  await saveAccountSession('copilot', 'copilot-user', {
    accessToken: 'copilot-access',
    refreshToken: 'refresh',
    expiresAt: FAR,
    account: 'copilot-user',
  })

  const plugin = await import('../src/index.js')
  const { Context } = await import('@deepseek-ai/cordis')
  const { createFakeConnection } = await import('./fake-connection.js')
  const ctx = new Context()
  // Disposal must be armed before the first assertion that can throw below:
  // the plugin mounts ref'd timers (the Claude keychain sync interval in
  // src/index.ts), and an undisposed Context keeps the event loop alive, so
  // `node --test` would hang until the CI timeout instead of reporting the
  // failure.
  t.after(() => ctx.fiber.dispose())
  const fake = createFakeConnection()
  // The bar never calls the model; rpc.spec.ts mounts the same way.
  ctx.provide('llm', { registerAdapter: () => Object.assign(() => {}, { replace: () => {} }) })
  ctx.provide('connection', fake.connection)
  const credentials: Pick<CredentialProvider, 'resolve'> = {
    resolve: async (ref) => {
      if (ref === 'OPENCODE_GO_API_KEY') return { value: 'go-secret', source: 'file' }
      if (ref === 'KIMI_CODING_API_KEY') return { value: 'kimi-secret', source: 'file' }
      if (ref === 'CURSOR_SUBSCRIPTION_OAUTH') return { value: cursorCredential(), source: 'file' }
      return undefined
    },
  }
  ctx.provide('credentials', credentials as CredentialProvider)
  ctx.plugin(plugin, {
    providers: ['codex', 'claude', 'grok', 'copilot', 'antigravity'] satisfies ProviderId[],
  })
  await new Promise((resolve) => { setTimeout(resolve, 50) })
  assert.ok(fake.registered(), 'the subscriptions-auth routes were registered')

  // The badge module imports host UI primitives that pull browser-only
  // packages. This test only uses the roster and pill helpers.
  const primitivesStub = `data:text/javascript,${encodeURIComponent(`
    export const IconDataOutlineRegular = () => null
    export const useAnchoredPosition = () => ({})
    export const useDismissOnOutsidePointer = () => {}
  `)}`
  const { registerHooks } = await import('node:module')
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === '@deepseek-ai/dsh-client-ui-primitives'
        ? { url: primitivesStub, shortCircuit: true }
        : nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      return url.endsWith('.css')
        ? { format: 'module', source: 'export default {}', shortCircuit: true }
        : nextLoad(url, context)
    },
  })
  t.after(() => { hooks.deregister() })

  const {
    collapsedDisplays,
    compactSegment,
    expandedDisplays,
    groupUsageDisplays,
    loadBadgeRoster,
    usageOf,
  } = await import('../src/client/SubscriptionUsageBadge.js')
  const rpc = {
    call: async (_channel: string, method: string, payload: unknown) => (
      fake.handler(method.replace(/^subscriptions-auth\./, ''), payload, new AbortController().signal)
    ),
  } satisfies Pick<ClientConnectionRpc, 'call'> as ClientConnectionRpc
  const { roster, refreshed } = await loadBadgeRoster(rpc)
  assert.deepEqual([...refreshed].sort(), [
    'antigravity',
    'claude',
    'codex',
    'copilot',
    'cursor-subscription',
    'grok',
    'kimi-coding',
    'minimax',
    'minimax-cn',
    'opencode-go',
  ])
  assert.deepEqual(roster.map((entry) => entry.provider), [
    'codex',
    'claude',
    'grok',
    'copilot',
    'antigravity',
    'cursor-subscription',
    'opencode-go',
    'kimi-coding',
  ])

  // The component's poll: each account's usage, keyed as the badge keys it,
  // then the badge's own grouping into provider rows.
  const windowsOf = new Map<string, UsageWindow[]>()
  const plans = new Map<string, string>()
  for (const entry of roster) {
    const usage = await usageOf(rpc, entry)
    const key = `${entry.provider}:${entry.account.key}`
    if (usage.plan !== undefined) plans.set(key, usage.plan)
    if (usage.supported && usage.windows !== undefined && usage.windows.length > 0) windowsOf.set(key, usage.windows)
  }
  const displays = groupUsageDisplays(roster, windowsOf, plans)

  assert.deepEqual(displays.map((row) => row.provider), [
    'codex',
    'claude',
    'grok',
    'antigravity',
    'cursor-subscription',
    'opencode-go',
    'kimi-coding',
  ])
  assert.equal(displays.some((row) => row.provider === 'copilot'), false)
  assert.deepEqual(displays.map((row) => Math.round(row.accounts[0]?.windows[0]?.usedPercent ?? NaN)), [
    USED.codex,
    USED.claude,
    USED.grok,
    USED.antigravity,
    USED.cursor,
    USED.opencode,
    USED.kimi,
  ])

  assert.deepEqual(collapsedDisplays(displays, 'claude').map((row) => row.provider), ['claude'])
  assert.deepEqual(expandedDisplays(displays, 'claude').map((row) => row.provider), [
    'claude',
    'codex',
    'grok',
    'antigravity',
    'cursor-subscription',
    'opencode-go',
    'kimi-coding',
  ])
  assert.deepEqual(displays.map((row) => compactSegment(
    row,
    row.provider === 'antigravity' ? 'gemini-bar' : undefined,
  )), [
    `Codex 5h ${USED.codex}%`,
    `Claude 5h ${USED.claude}%`,
    `Grok W ${USED.grok}%`,
    `Antigravity Window ${USED.antigravity}%`,
    `Cursor Included ${USED.cursor}%`,
    `OpenCode Go 5h ${USED.opencode}%`,
    `Kimi Code 5h ${USED.kimi}%`,
  ])

  const rendered = JSON.stringify(displays)
  for (const secret of ['codex-access', 'claude-access', 'grok-access', 'antigravity-access', 'copilot-access', 'go-secret', 'kimi-secret', 'cursor-access']) {
    assert.equal(rendered.includes(secret), false, secret)
  }
  assert.equal(authorizationFor(seen, CODEX_URL), 'Bearer codex-access')
  assert.equal(authorizationFor(seen, CLAUDE_URL), 'Bearer claude-access')
  assert.equal(authorizationFor(seen, GROK_URL), 'Bearer grok-access')
  assert.equal(authorizationFor(seen, ANTIGRAVITY_MODELS_URL), 'Bearer antigravity-access')
  assert.equal(authorizationFor(seen, OPENCODE_URL), 'Bearer go-secret')
  assert.equal(authorizationFor(seen, KIMI_URL), 'Bearer kimi-secret')
  assert.equal(seen.some((call) => call.url === ANTIGRAVITY_TIER_URL), true)
  assert.equal(seen.some((call) => call.url.startsWith(CURSOR_SUMMARY_URL)), true)
  assert.equal(seen.some((call) => call.url.includes('githubcopilot.com')), false)
})

/** Cursor's credential is a JWT whose `sub` is the dashboard user id. */
function cursorCredential(): string {
  const payload = Buffer.from(JSON.stringify({ sub: 'auth0|user_bar' })).toString('base64url')
  return JSON.stringify({
    type: 'oauth',
    access: `header.${payload}.cursor-access`,
    refresh: 'cursor-refresh',
    expires: FAR,
  })
}

/**
 * Canned usage body for one fixture URL.
 * @param url - the request URL the plugin asked for.
 * @returns the JSON body, or undefined when this URL is not a usage fixture.
 */
function fixtureFor(url: string): unknown {
  if (url === CODEX_URL) {
    return {
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: USED.codex, limit_window_seconds: 18_000 },
      },
    }
  }
  if (url === CLAUDE_URL) {
    return { five_hour: { utilization: USED.claude } }
  }
  if (url === GROK_URL) {
    return { config: { creditUsagePercent: USED.grok, subscriptionTier: 'SuperGrok' } }
  }
  if (url === ANTIGRAVITY_MODELS_URL) {
    return {
      models: {
        'gemini-bar': { quotaInfo: { remainingFraction: 1 - USED.antigravity / 100 } },
      },
    }
  }
  if (url === ANTIGRAVITY_TIER_URL) return { paidTier: { name: 'Pro' } }
  if (url.startsWith(CURSOR_SUMMARY_URL)) {
    return {
      membershipType: 'pro',
      individualUsage: { plan: { totalPercentUsed: USED.cursor } },
    }
  }
  if (url.startsWith('https://cursor.com/api/usage')) return { 'gpt-4': { numRequests: 0 } }
  if (url === OPENCODE_URL) return { usage: { rolling: { percent: USED.opencode } } }
  if (url === KIMI_URL) return { usages: { limit_5h: { used_ratio: USED.kimi / 100 } } }
  return undefined
}

/**
 * The bearer token sent to one usage URL.
 * @param seen - recorded fetch calls.
 * @param url - the fixture URL.
 * @returns the Authorization header, which is absent only when the call never happened.
 */
function authorizationFor(seen: SeenCall[], url: string): string | null {
  const call = seen.find((entry) => entry.url === url)
  assert.ok(call, url)
  return call.authorization
}
