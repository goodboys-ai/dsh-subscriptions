/**
 * Virtual-provider integration test: Antigravity (see docs/testing.md).
 *
 * The whole Antigravity route runs against {@link installFakeAntigravity}'s
 * virtual backend — no credentials, no browser, no network. What is REAL in
 * every test below: the OAuthFlowManager (loopback callback server,
 * state/PKCE handling), the antigravityFlow Google authorize-URL builder,
 * the form-encoded token exchange and refresh grants, project discovery via
 * `loadCodeAssist`, the model catalog parser, the quota-window classifier,
 * and AntigravityAdapter.stream() through the Gemini SSE translator.
 *
 * Honest boundary: green here proves OUR side of the provider contract. It
 * cannot detect Google changing their site — that is the manual
 * pre-release canary.
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { MessageId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { OAuthFlowManager, type OAuthAttempt } from '../src/auth/oauth-flow.js'
import type { AntigravitySession } from '../src/auth/store.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import {
  ANTIGRAVITY_AUTHORIZE_URL,
  ANTIGRAVITY_DEFAULT_BASE_URL,
  ANTIGRAVITY_TOKEN_URL,
  AntigravityAdapter,
  antigravityFlow,
  exchangeAntigravityCode,
  fetchAntigravityModels,
  fetchAntigravityUsage,
  refreshAntigravity,
  resolveAntigravityOAuthConfig,
} from '../src/providers/antigravity.js'
import {
  FAKE_ANTIGRAVITY_IDENTITY,
  installFakeAntigravity,
  type FakeAntigravity,
} from './fakes/fake-antigravity.js'

const STREAM_URL = `${ANTIGRAVITY_DEFAULT_BASE_URL}/v1internal:streamGenerateContent?alt=sse`

interface VirtualLogin {
  fake: FakeAntigravity
  session: AntigravitySession
  attempt: OAuthAttempt
}

/**
 * Complete a full login against the virtual provider: real Google authorize
 * URL, simulated browser approval (manual 302 follow), real loopback
 * callback, real code exchange + project discovery.
 */
async function virtualLogin(t: TestContext): Promise<VirtualLogin> {
  const fake = installFakeAntigravity(t)
  const oauth = resolveAntigravityOAuthConfig()
  const flows = new OAuthFlowManager()
  const attempt = await flows.start('antigravity', antigravityFlow(oauth))
  assert.ok(
    attempt.authorizeUrl.startsWith(`${ANTIGRAVITY_AUTHORIZE_URL}?`),
    'the real flow spec targets the Google authorize host',
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
  const session = await exchangeAntigravityCode(
    code,
    attempt.pkce.verifier,
    attempt.redirectUri,
    oauth,
  )
  return { fake, session, attempt }
}

test('antigravity: full OAuth login flow against the virtual provider', async (t) => {
  const { fake, session, attempt } = await virtualLogin(t)
  assert.ok(
    fake.issuedCodes.size <= 1,
    'the issued code was consumed by the exchange',
  )
  assert.equal(session.account, FAKE_ANTIGRAVITY_IDENTITY.email)
  assert.equal(session.projectId, FAKE_ANTIGRAVITY_IDENTITY.projectId)
  assert.equal(session.plan, FAKE_ANTIGRAVITY_IDENTITY.plan)
  assert.ok(session.accessToken.length > 0)
  assert.match(session.refreshToken, /^fake-antigravity-refresh-/)
  assert.ok(session.expiresAt > Date.now())

  // The exchange used the real form-encoded Google grant.
  const tokenCall = fake.calls.find(
    (call) => call.url === ANTIGRAVITY_TOKEN_URL,
  )
  assert.ok(tokenCall !== undefined)
  assert.equal(tokenCall.method, 'POST')
  const form = new URLSearchParams(tokenCall.bodyText)
  assert.equal(form.get('grant_type'), 'authorization_code')
  assert.equal(form.get('code_verifier'), attempt.pkce.verifier)
  assert.equal(form.get('redirect_uri'), attempt.redirectUri)

  // Project discovery ran against the default API base.
  const loadCall = fake.calls.find(
    (call) =>
      call.url === `${ANTIGRAVITY_DEFAULT_BASE_URL}/v1internal:loadCodeAssist`,
  )
  assert.ok(loadCall !== undefined)
  assert.equal(
    loadCall.headers['authorization'],
    `Bearer ${session.accessToken}`,
  )
})

test('antigravity: forged callback state is rejected by the real callback server', async (t) => {
  installFakeAntigravity(t)
  const flows = new OAuthFlowManager()
  const attempt = await flows.start(
    'antigravity',
    antigravityFlow(resolveAntigravityOAuthConfig()),
  )
  const forged = new URL(attempt.redirectUri)
  forged.searchParams.set('code', 'attacker-code')
  forged.searchParams.set('state', 'wrong-state')
  const response = await fetch(forged.toString())
  assert.equal(response.status, 400)
  // The stray redirect must not settle — or kill — the real attempt.
  assert.ok(flows.isBusy('antigravity'))
  attempt.cancel()
  await assert.rejects(attempt.waitCode(), /login cancelled/)
})

test('antigravity: refresh rotates tokens and keeps project metadata', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const oauth = resolveAntigravityOAuthConfig()
  const refreshed = await refreshAntigravity(session, oauth)
  assert.notEqual(refreshed.accessToken, session.accessToken)
  // The virtual refresh omits refresh_token: the stored one must survive.
  assert.equal(refreshed.refreshToken, session.refreshToken)
  assert.equal(refreshed.projectId, FAKE_ANTIGRAVITY_IDENTITY.projectId)
  assert.equal(refreshed.account, FAKE_ANTIGRAVITY_IDENTITY.email)

  const refreshCall = fake.calls.find(
    (call) =>
      call.url === ANTIGRAVITY_TOKEN_URL &&
      new URLSearchParams(call.bodyText).get('grant_type') === 'refresh_token',
  )
  assert.ok(refreshCall !== undefined)
  const form = new URLSearchParams(refreshCall.bodyText)
  assert.equal(form.get('refresh_token'), session.refreshToken)
})

test('antigravity: catalog discovery parses the models object', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const models = await fetchAntigravityModels(session)
  assert.deepEqual(
    models.map((m) => m.id),
    ['gemini-3-pro'],
  )
  assert.equal(models[0].name, 'Gemini 3 Pro')
  assert.equal(models[0].contextWindow, 1_048_576)
  assert.equal(models[0].maxOutputTokens, 65_536)

  const modelsCall = fake.calls.find(
    (call) =>
      call.url ===
      `${ANTIGRAVITY_DEFAULT_BASE_URL}/v1internal:fetchAvailableModels`,
  )
  assert.ok(modelsCall !== undefined)
  const body = JSON.parse(modelsCall.bodyText) as Record<string, unknown>
  assert.equal(body.project, FAKE_ANTIGRAVITY_IDENTITY.projectId)
})

test('antigravity: quota fractions become used-percent windows', async (t) => {
  const { session } = await virtualLogin(t)
  const usage = await fetchAntigravityUsage(session)
  assert.equal(usage.supported, true)
  assert.equal(usage.plan, FAKE_ANTIGRAVITY_IDENTITY.plan)
  const windows = usage.windows ?? []
  const kinds = windows.map((w) => `${w.kind}:${w.scope}`)
  assert.deepEqual(kinds, ['other:gemini-3-pro', 'weekly:gemini-3-pro'])
  // remainingFraction 0.6 → 40% used; weekly 0.8 → 20% used.
  assert.equal(windows[0].usedPercent, 40)
  assert.ok(Math.abs(windows[1].usedPercent - 20) < 1e-9)
  assert.ok((windows[0].resetsAt ?? 0) > Date.now())
})

test('antigravity: a model run streams text through the real adapter', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const tokens = new AccountTokenManager({
    provider: 'antigravity',
    displayName: 'Virtual Antigravity',
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
  const adapter = new AntigravityAdapter({
    models: [{ id: 'gemini-3-pro', name: 'Gemini 3 Pro' }],
    tokens,
    discovery: false,
    streamIdleTimeoutMs: 5000,
  })
  const options: GenerateOptions = {
    provider: 'antigravity',
    model: 'gemini-3-pro',
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

  const apiCall = fake.calls.find((call) => call.url === STREAM_URL)
  assert.ok(apiCall !== undefined)
  assert.equal(apiCall.method, 'POST')
  assert.equal(
    apiCall.headers['authorization'],
    `Bearer ${session.accessToken}`,
  )
  const body = JSON.parse(apiCall.bodyText) as Record<string, unknown>
  assert.ok(
    typeof body.model === 'string' &&
      (body.model as string).includes('gemini-3-pro'),
  )
})
