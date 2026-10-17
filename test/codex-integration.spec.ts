/**
 * Virtual-provider integration test: Codex (see docs/testing.md).
 *
 * The whole Codex route runs against {@link installFakeCodex}'s virtual
 * backend — no credentials, no browser, no network. What is REAL in every
 * test below: the OAuthFlowManager (loopback callback server, state/PKCE
 * handling), the codexFlow authorize-URL builder, the token exchange and
 * refresh grants, the usage-window classifier, the catalog discovery parser,
 * and CodexAdapter.stream() through the SSE translator.
 *
 * Honest boundary: green here proves OUR side of the provider contract. It
 * cannot detect the provider changing their site — that is the manual
 * pre-release canary (see docs/testing.md).
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { MessageId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { OAuthFlowManager, type OAuthAttempt } from '../src/auth/oauth-flow.js'
import type { CodexSession } from '../src/auth/store.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import {
  CODEX_API_URL,
  CODEX_MODELS_URL,
  CODEX_TOKEN_URL,
  CodexAdapter,
  codexFlow,
  exchangeCodexCode,
  fetchCodexModels,
  fetchCodexUsage,
  refreshCodex,
} from '../src/providers/codex.js'
import {
  FAKE_CODEX_IDENTITY,
  installFakeCodex,
  type FakeCodex,
} from './fakes/fake-codex.js'

interface VirtualLogin {
  fake: FakeCodex
  session: CodexSession
  attempt: OAuthAttempt
}

/**
 * Complete a full login against the virtual provider: real authorize URL,
 * simulated browser approval (manual 302 follow), real loopback callback,
 * real code exchange.
 */
async function virtualLogin(t: TestContext): Promise<VirtualLogin> {
  const fake = installFakeCodex(t)
  const flows = new OAuthFlowManager()
  const attempt = await flows.start('codex', codexFlow)
  assert.ok(
    attempt.authorizeUrl.startsWith('https://auth.openai.com/oauth/authorize?'),
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
  const session = await exchangeCodexCode(
    code,
    attempt.pkce.verifier,
    attempt.redirectUri,
  )
  return { fake, session, attempt }
}

test('codex: full OAuth login flow against the virtual provider', async (t) => {
  const { fake, session, attempt } = await virtualLogin(t)
  assert.ok(
    fake.issuedCodes.size <= 1,
    'the issued code was consumed by the exchange',
  )
  assert.equal(session.accountId, FAKE_CODEX_IDENTITY.accountId)
  assert.equal(session.emailAddress, FAKE_CODEX_IDENTITY.email)
  assert.equal(session.planType, FAKE_CODEX_IDENTITY.planType)
  assert.ok(session.accessToken.length > 0)
  assert.match(session.refreshToken, /^fake-refresh-/)
  assert.ok(session.expiresAt > Date.now())

  // The exchange used the real form-encoded grant against the real token URL.
  const tokenCall = fake.calls.find((call) => call.url === CODEX_TOKEN_URL)
  assert.ok(tokenCall !== undefined)
  assert.equal(tokenCall.method, 'POST')
  assert.match(
    tokenCall.headers['content-type'] ?? '',
    /application\/x-www-form-urlencoded/,
  )
  const form = new URLSearchParams(tokenCall.bodyText)
  assert.equal(form.get('grant_type'), 'authorization_code')
  assert.equal(form.get('code_verifier'), attempt.pkce.verifier)
  assert.equal(form.get('redirect_uri'), attempt.redirectUri)
})

test('codex: forged callback state is rejected by the real callback server', async (t) => {
  installFakeCodex(t)
  const flows = new OAuthFlowManager()
  const attempt = await flows.start('codex', codexFlow)
  const forged = new URL(attempt.redirectUri)
  forged.searchParams.set('code', 'attacker-code')
  forged.searchParams.set('state', 'wrong-state')
  const response = await fetch(forged.toString())
  assert.equal(response.status, 400)
  // The stray redirect must not settle — or kill — the real attempt.
  assert.ok(flows.isBusy('codex'))
  attempt.cancel()
  await assert.rejects(attempt.waitCode(), /login cancelled/)
})

test('codex: refresh rotates tokens and keeps identity claims', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const refreshed = await refreshCodex(session)
  assert.notEqual(refreshed.accessToken, session.accessToken)
  assert.match(refreshed.refreshToken, /^fake-refresh-/)
  assert.notEqual(refreshed.refreshToken, session.refreshToken)
  // The virtual refresh omits id_token: identity must survive from storage.
  assert.equal(refreshed.accountId, FAKE_CODEX_IDENTITY.accountId)
  assert.equal(refreshed.emailAddress, FAKE_CODEX_IDENTITY.email)

  const refreshCall = fake.calls.find(
    (call) =>
      call.url === CODEX_TOKEN_URL &&
      call.headers['content-type']?.includes('application/json'),
  )
  assert.ok(refreshCall !== undefined)
  const body = JSON.parse(refreshCall.bodyText) as Record<string, unknown>
  assert.equal(body.grant_type, 'refresh_token')
  assert.equal(body.refresh_token, session.refreshToken)
})

test('codex: usage windows are classified by duration', async (t) => {
  const { session } = await virtualLogin(t)
  const usage = await fetchCodexUsage(session)
  assert.equal(usage.supported, true)
  assert.equal(usage.plan, FAKE_CODEX_IDENTITY.planType)
  assert.ok(usage.windows !== undefined)
  assert.deepEqual(
    usage.windows.map((w) => w.kind),
    ['session', 'weekly'],
  )
  assert.equal(usage.windows[0].usedPercent, 42.5)
  assert.equal(usage.windows[1].usedPercent, 10)
  assert.ok((usage.windows[1].resetsAt ?? 0) > Date.now())
})

test('codex: catalog discovery parses, filters, and sorts', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const models = await fetchCodexModels(
    session,
    undefined,
    undefined,
    '0.153.4',
  )
  assert.deepEqual(
    models.map((m) => m.id),
    ['gpt-5.3-codex', 'gpt-5.3'],
  )
  assert.equal(models[0].fastTier, true)
  assert.equal(models[0].reasoning?.efforts.length, 1)

  const modelsCall = fake.calls.find((call) =>
    call.url.startsWith(CODEX_MODELS_URL),
  )
  assert.ok(modelsCall !== undefined)
  assert.match(modelsCall.url, /client_version=0\.153\.4/)
  assert.equal(
    modelsCall.headers['authorization'],
    `Bearer ${session.accessToken}`,
  )
  assert.equal(
    modelsCall.headers['chatgpt-account-id'],
    FAKE_CODEX_IDENTITY.accountId,
  )
})

test('codex: a model run streams text through the real adapter', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const tokens = new AccountTokenManager({
    provider: 'codex',
    displayName: 'Virtual Codex',
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
  const adapter = new CodexAdapter({
    models: [{ id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' }],
    tokens,
    discovery: false,
    streamIdleTimeoutMs: 5000,
  })
  const options: GenerateOptions = {
    provider: 'codex',
    model: 'gpt-5.3-codex',
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

  const apiCall = fake.calls.find((call) => call.url === CODEX_API_URL)
  assert.ok(apiCall !== undefined)
  assert.equal(apiCall.method, 'POST')
  assert.equal(
    apiCall.headers['authorization'],
    `Bearer ${session.accessToken}`,
  )
  assert.equal(
    apiCall.headers['chatgpt-account-id'],
    FAKE_CODEX_IDENTITY.accountId,
  )
  const body = JSON.parse(apiCall.bodyText) as Record<string, unknown>
  assert.equal(body.model, 'gpt-5.3-codex')
  assert.equal(body.stream, true)
})
