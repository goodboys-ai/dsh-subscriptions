/**
 * Virtual-provider integration test: Grok (see docs/testing.md).
 *
 * The whole Grok route runs against {@link installFakeGrok}'s virtual
 * backend — no credentials, no browser, no network. What is REAL in every
 * test below: the OIDC discovery fetch, the grokFlow authorize-URL builder,
 * the OAuthFlowManager (loopback callback server, state/PKCE handling), the
 * form-encoded token exchange (with xAI's PKCE-challenge echo) and refresh
 * grants, the billing-window classifier, the catalog discovery parser with
 * its CLI-catalog reasoning merge, and GrokAdapter.stream() through the
 * Responses SSE translator.
 *
 * Honest boundary: green here proves OUR side of the provider contract. It
 * cannot detect xAI changing their site — that is the manual pre-release
 * canary.
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { MessageId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { OAuthFlowManager, type OAuthAttempt } from '../src/auth/oauth-flow.js'
import type { GrokSession } from '../src/auth/store.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import {
  GROK_API_URL,
  GROK_BILLING_URL,
  GROK_DISCOVERY_URL,
  GROK_MODELS_URL,
  GrokAdapter,
  exchangeGrokCode,
  fetchGrokModels,
  fetchGrokUsage,
  grokDiscovery,
  grokFlow,
  grokTierName,
  refreshGrok,
  resetGrokDiscoveryForTests,
} from '../src/providers/grok.js'
import {
  FAKE_GROK_AUTHORIZE_URL,
  FAKE_GROK_IDENTITY,
  FAKE_GROK_TOKEN_URL,
  installFakeGrok,
  type FakeGrok,
} from './fakes/fake-grok.js'

interface VirtualLogin {
  fake: FakeGrok
  session: GrokSession
  attempt: OAuthAttempt
}

/**
 * Complete a full login against the virtual provider: OIDC discovery, real
 * authorize URL, simulated browser approval (manual 302 follow), real
 * loopback callback, real code exchange.
 */
async function virtualLogin(t: TestContext): Promise<VirtualLogin> {
  const fake = installFakeGrok(t)
  const discovery = await grokDiscovery()
  assert.equal(discovery.authorizationEndpoint, FAKE_GROK_AUTHORIZE_URL)
  assert.equal(discovery.tokenEndpoint, FAKE_GROK_TOKEN_URL)
  const flows = new OAuthFlowManager()
  const attempt = await flows.start('grok', await grokFlow())
  assert.ok(
    attempt.authorizeUrl.startsWith(`${FAKE_GROK_AUTHORIZE_URL}?`),
    'the real flow spec targets the discovered authorize endpoint',
  )
  // Simulate the browser: follow the provider's 302 manually so the test —
  // not the fetch engine — observes the redirect target.
  const approval = await fetch(attempt.authorizeUrl, { redirect: 'manual' })
  assert.equal(approval.status, 302)
  const callbackUrl = approval.headers.get('location')
  assert.ok(callbackUrl !== null && /^http:\/\/127\.0\.0\.1:/.test(callbackUrl))
  // The REAL loopback callback server validates state and serves the page.
  const callback = await fetch(callbackUrl)
  assert.equal(callback.status, 200)
  assert.match(await callback.text(), /Login successful/)
  const code = await attempt.waitCode()
  const session = await exchangeGrokCode(
    code,
    attempt.pkce.verifier,
    attempt.redirectUri,
    attempt.pkce.challenge,
  )
  return { fake, session, attempt }
}

test('grok: full OAuth login flow against the virtual provider', async (t) => {
  // grokDiscovery() caches at module level; start empty so this test sees
  // the discovery fetch in any test order.
  resetGrokDiscoveryForTests()
  const { fake, session, attempt } = await virtualLogin(t)
  assert.ok(
    fake.issuedCodes.size <= 1,
    'the issued code was consumed by the exchange',
  )
  assert.ok(
    fake.calls.some((call) => call.url === GROK_DISCOVERY_URL),
    'the login fetched the OIDC discovery document',
  )
  assert.equal(session.account, FAKE_GROK_IDENTITY.email)
  assert.equal(grokTierName(session.accessToken), FAKE_GROK_IDENTITY.tierName)
  assert.ok(session.accessToken.length > 0)
  assert.match(session.refreshToken, /^fake-grok-refresh-/)
  assert.ok(session.expiresAt > Date.now())

  // The exchange used the real form-encoded grant against the DISCOVERED
  // token URL, echoing the PKCE challenge per the xAI flow.
  const tokenCall = fake.calls.find((call) => call.url === FAKE_GROK_TOKEN_URL)
  assert.ok(tokenCall !== undefined)
  assert.equal(tokenCall.method, 'POST')
  assert.match(
    tokenCall.headers['content-type'] ?? '',
    /application\/x-www-form-urlencoded/,
  )
  const form = new URLSearchParams(tokenCall.bodyText)
  assert.equal(form.get('grant_type'), 'authorization_code')
  assert.equal(form.get('code_verifier'), attempt.pkce.verifier)
  assert.equal(form.get('code_challenge'), attempt.pkce.challenge)
  assert.equal(form.get('redirect_uri'), attempt.redirectUri)
})

test('grok: forged callback state is rejected by the real callback server', async (t) => {
  installFakeGrok(t)
  const flows = new OAuthFlowManager()
  const attempt = await flows.start('grok', await grokFlow())
  const forged = new URL(attempt.redirectUri)
  forged.searchParams.set('code', 'attacker-code')
  forged.searchParams.set('state', 'wrong-state')
  const response = await fetch(forged.toString())
  assert.equal(response.status, 400)
  // The stray redirect must not settle — or kill — the real attempt.
  assert.ok(flows.isBusy('grok'))
  attempt.cancel()
  await assert.rejects(attempt.waitCode(), /login cancelled/)
})

test('grok: refresh rotates tokens and keeps identity', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const refreshed = await refreshGrok(session)
  assert.notEqual(refreshed.accessToken, session.accessToken)
  assert.notEqual(refreshed.refreshToken, session.refreshToken)
  // The virtual refresh omits id_token: the account display must survive
  // from the stored session.
  assert.equal(refreshed.account, FAKE_GROK_IDENTITY.email)
  assert.equal(grokTierName(refreshed.accessToken), FAKE_GROK_IDENTITY.tierName)

  const refreshCall = fake.calls.find(
    (call) =>
      call.url === FAKE_GROK_TOKEN_URL &&
      new URLSearchParams(call.bodyText).get('grant_type') === 'refresh_token',
  )
  assert.ok(refreshCall !== undefined)
  const form = new URLSearchParams(refreshCall.bodyText)
  assert.equal(form.get('refresh_token'), session.refreshToken)
})

test('grok: billing credits config becomes a weekly window', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const usage = await fetchGrokUsage(session)
  assert.equal(usage.supported, true)
  assert.equal(usage.plan, FAKE_GROK_IDENTITY.tierName)
  const windows = usage.windows ?? []
  assert.deepEqual(
    windows.map((w) => w.kind),
    ['weekly'],
  )
  assert.equal(windows[0].usedPercent, 30)
  assert.ok((windows[0].resetsAt ?? 0) > Date.now())

  const billingCall = fake.calls.find((call) => call.url === GROK_BILLING_URL)
  assert.ok(billingCall !== undefined)
  assert.equal(
    billingCall.headers['authorization'],
    `Bearer ${session.accessToken}`,
  )
  assert.equal(billingCall.headers['x-xai-token-auth'], 'xai-grok-cli')
})

test('grok: catalog discovery merges the CLI reasoning catalog', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const models = await fetchGrokModels(session)
  assert.deepEqual(
    models.map((m) => m.id),
    ['grok-4-1'],
  )
  assert.equal(models[0].name, 'Grok 4.1')
  assert.deepEqual(
    models[0].reasoning?.efforts.map((e) => e.id),
    ['low', 'high'],
  )
  assert.equal(models[0].reasoning?.defaultEffort, 'low')

  const modelsCall = fake.calls.find((call) => call.url === GROK_MODELS_URL)
  assert.ok(modelsCall !== undefined)
  assert.equal(
    modelsCall.headers['authorization'],
    `Bearer ${session.accessToken}`,
  )
})

test('grok: a model run streams text through the real adapter', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const tokens = new AccountTokenManager({
    provider: 'grok',
    displayName: 'Virtual Grok',
    makeOptions: () => ({
      preemptMs: 0,
      refresh: async () => session,
      isPermanent: () => false,
    }),
    io: {
      list: async () => [{ key: 'acct', session }],
      get: async () => session,
      save: async () => {},
      remove: async () => {},
    },
  })
  const adapter = new GrokAdapter({
    models: [{ id: 'grok-4-1', name: 'Grok 4.1' }],
    tokens,
    discovery: false,
    streamIdleTimeoutMs: 5000,
  })
  const options: GenerateOptions = {
    provider: 'grok',
    model: 'grok-4-1',
    sessionId: 'virtual-run' as NonNullable<GenerateOptions['sessionId']>,
    messages: [
      {
        id: MessageId('user'),
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'hello' }],
      },
    ],
  }
  let text = ''
  let finish: unknown
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason
  }
  assert.equal(text, 'Hello, world!')
  assert.deepEqual(finish, { kind: 'stop' })

  const apiCall = fake.calls.find((call) => call.url === GROK_API_URL)
  assert.ok(apiCall !== undefined)
  assert.equal(apiCall.method, 'POST')
  assert.equal(
    apiCall.headers['authorization'],
    `Bearer ${session.accessToken}`,
  )
  const body = JSON.parse(apiCall.bodyText) as Record<string, unknown>
  assert.equal(body.model, 'grok-4-1')
  assert.equal(body.stream, true)
})
