/**
 * Virtual-provider integration test: Claude (see docs/testing.md).
 *
 * The whole Claude route runs against {@link installFakeClaude}'s virtual
 * backend — no credentials, no browser, no network. What is REAL in every
 * test below: the OAuthFlowManager (loopback callback server, state/PKCE
 * handling), the claudeFlow authorize-URL builder, the JSON token exchange
 * and refresh grants, the usage-limits classifier, the catalog discovery
 * parser, and ClaudeAdapter.stream() through the Anthropic SSE translator.
 *
 * Honest boundary: green here proves OUR side of the provider contract. It
 * cannot detect Anthropic changing their site — that is the manual
 * pre-release canary.
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { MessageId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { OAuthFlowManager, type OAuthAttempt } from '../src/auth/oauth-flow.js'
import type { ClaudeSession } from '../src/auth/store.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import {
  CLAUDE_API_URL,
  CLAUDE_AUTHORIZE_URL,
  CLAUDE_CLI_FALLBACK_VERSION,
  CLAUDE_MODELS_URL,
  CLAUDE_TOKEN_URL,
  CLAUDE_USAGE_URL,
  ClaudeAdapter,
  claudeFlow,
  exchangeClaudeCode,
  fetchClaudeModels,
  fetchClaudeUsage,
  refreshClaude,
} from '../src/providers/claude.js'
import { FAKE_CLAUDE_IDENTITY, installFakeClaude, type FakeClaude } from './fakes/fake-claude.js'

const cliVersion = async (): Promise<string> => CLAUDE_CLI_FALLBACK_VERSION

interface VirtualLogin {
  fake: FakeClaude
  session: ClaudeSession
  attempt: OAuthAttempt
}

/**
 * Complete a full login against the virtual provider: real authorize URL,
 * simulated browser approval (manual 302 follow), real loopback callback,
 * real code exchange.
 */
async function virtualLogin(t: TestContext): Promise<VirtualLogin> {
  const fake = installFakeClaude(t)
  const flows = new OAuthFlowManager()
  const attempt = await flows.start('claude', claudeFlow)
  assert.ok(
    attempt.authorizeUrl.startsWith(`${CLAUDE_AUTHORIZE_URL}?`),
    'the real flow spec targets the real authorize host',
  )
  // Simulate the browser: follow the provider's 302 manually so the test —
  // not the fetch engine — observes the redirect target.
  const approval = await fetch(attempt.authorizeUrl, { redirect: 'manual' })
  assert.equal(approval.status, 302)
  const callbackUrl = approval.headers.get('location')
  assert.ok(callbackUrl !== null && /^http:\/\/localhost:/.test(callbackUrl))
  // The REAL loopback callback server validates state and serves the page.
  const callback = await fetch(callbackUrl)
  assert.equal(callback.status, 200)
  assert.match(await callback.text(), /Login successful/)
  const code = await attempt.waitCode()
  const session = await exchangeClaudeCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.state)
  return { fake, session, attempt }
}

test('claude: full OAuth login flow against the virtual provider', async (t) => {
  const { fake, session, attempt } = await virtualLogin(t)
  assert.ok(fake.issuedCodes.size <= 1, 'the issued code was consumed by the exchange')
  assert.equal(session.emailAddress, FAKE_CLAUDE_IDENTITY.email)
  assert.equal(session.subscriptionType, FAKE_CLAUDE_IDENTITY.subscriptionType)
  assert.ok(session.accessToken.length > 0)
  assert.match(session.refreshToken, /^fake-claude-refresh-/)
  assert.ok(session.expiresAt > Date.now())

  // The exchange used the real JSON grant against the real token URL.
  const tokenCall = fake.calls.find(call => call.url === CLAUDE_TOKEN_URL)
  assert.ok(tokenCall !== undefined)
  assert.equal(tokenCall.method, 'POST')
  assert.match(tokenCall.headers['content-type'] ?? '', /application\/json/)
  const body = JSON.parse(tokenCall.bodyText) as Record<string, unknown>
  assert.equal(body.grant_type, 'authorization_code')
  assert.equal(body.code_verifier, attempt.pkce.verifier)
  assert.equal(body.redirect_uri, attempt.redirectUri)
  assert.equal(body.state, attempt.state)
})

test('claude: forged callback state is rejected by the real callback server', async (t) => {
  installFakeClaude(t)
  const flows = new OAuthFlowManager()
  const attempt = await flows.start('claude', claudeFlow)
  const forged = new URL(attempt.redirectUri)
  forged.searchParams.set('code', 'attacker-code')
  forged.searchParams.set('state', 'wrong-state')
  const response = await fetch(forged.toString())
  assert.equal(response.status, 400)
  // The stray redirect must not settle — or kill — the real attempt.
  assert.ok(flows.isBusy('claude'))
  attempt.cancel()
  await assert.rejects(attempt.waitCode(), /login cancelled/)
})

test('claude: refresh rotates tokens and keeps identity', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const refreshed = await refreshClaude(session)
  assert.notEqual(refreshed.accessToken, session.accessToken)
  // The virtual refresh omits refresh_token: the stored one must survive.
  assert.equal(refreshed.refreshToken, session.refreshToken)
  assert.equal(refreshed.emailAddress, FAKE_CLAUDE_IDENTITY.email)
  assert.equal(refreshed.subscriptionType, FAKE_CLAUDE_IDENTITY.subscriptionType)

  const refreshCall = fake.calls.find(call =>
    call.url === CLAUDE_TOKEN_URL && JSON.parse(call.bodyText).grant_type === 'refresh_token')
  assert.ok(refreshCall !== undefined)
  const body = JSON.parse(refreshCall.bodyText) as Record<string, unknown>
  assert.equal(body.refresh_token, session.refreshToken)
  assert.equal(body.scope, session.scopes)
})

test('claude: usage limits array is classified into windows', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const usage = await fetchClaudeUsage(session, undefined, undefined, cliVersion)
  assert.equal(usage.supported, true)
  const windows = usage.windows ?? []
  assert.deepEqual(windows.map(w => w.kind), ['session', 'weekly'])
  assert.equal(windows[0].usedPercent, 35)
  assert.equal(windows[1].usedPercent, 12)
  assert.ok((windows[1].resetsAt ?? 0) > Date.now())

  const usageCall = fake.calls.find(call => call.url === `${CLAUDE_USAGE_URL}?cedar_ember=1`)
  assert.ok(usageCall !== undefined)
  assert.equal(usageCall.headers['authorization'], `Bearer ${session.accessToken}`)
  assert.match(usageCall.headers['user-agent'] ?? '', /claude/)
})

test('claude: catalog discovery parses capabilities and ceilings', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const models = await fetchClaudeModels(session, undefined, undefined, cliVersion)
  assert.deepEqual(models.map(m => m.id), ['claude-opus-4-6', 'claude-sonnet-4-6'])
  assert.equal(models[0].name, 'Claude Opus 4.6')
  assert.equal(models[0].contextWindow, 200_000)
  assert.equal(models[0].maxOutputTokens, 32_000)
  assert.equal(models[0].thinkingType, 'enabled')
  assert.deepEqual(models[0].reasoning?.efforts.map(e => e.id), ['medium', 'high'])

  const modelsCall = fake.calls.find(call => call.url.startsWith(CLAUDE_MODELS_URL))
  assert.ok(modelsCall !== undefined)
  assert.equal(modelsCall.headers['authorization'], `Bearer ${session.accessToken}`)
})

test('claude: a model run streams text through the real adapter', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const tokens = new AccountTokenManager({
    provider: 'claude',
    displayName: 'Virtual Claude',
    makeOptions: () => ({ preemptMs: 0, refresh: async () => session, isPermanent: () => false }),
    io: {
      list: async () => [{ key: 'acct', session }],
      get: async () => session,
      save: async () => {},
      remove: async () => {},
    },
  })
  const adapter = new ClaudeAdapter({
    models: [{ id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }],
    tokens,
    discovery: false,
    streamIdleTimeoutMs: 5000,
  })
  const options: GenerateOptions = {
    provider: 'claude',
    model: 'claude-opus-4-6',
    sessionId: 'virtual-run' as NonNullable<GenerateOptions['sessionId']>,
    messages: [{
      id: MessageId('user'),
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    }],
  }
  let text = ''
  let finish: unknown
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason
  }
  assert.equal(text, 'Hello, world!')
  assert.deepEqual(finish, { kind: 'stop' })

  const apiCall = fake.calls.find(call => call.url === CLAUDE_API_URL)
  assert.ok(apiCall !== undefined)
  assert.equal(apiCall.method, 'POST')
  assert.equal(apiCall.headers['authorization'], `Bearer ${session.accessToken}`)
  const body = JSON.parse(apiCall.bodyText) as Record<string, unknown>
  assert.equal(body.model, 'claude-opus-4-6')
  assert.equal(body.stream, true)
})
