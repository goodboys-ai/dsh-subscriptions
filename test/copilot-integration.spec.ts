/**
 * Virtual-provider integration test: Copilot (see docs/testing.md).
 *
 * The whole Copilot route runs against {@link installFakeCopilot}'s virtual
 * backend — no credentials, no browser, no network. What is REAL in every
 * test below: the DeviceFlowManager (device-code request, poll loop with
 * RFC 8628 backoff), the two-step login (device flow → Copilot API token
 * exchange → GitHub profile), the refresh path (GitHub token re-exchange),
 * the catalog discovery parser (wire selection, vision flags), and
 * CopilotAdapter.stream() through the chat-completions SSE translator.
 *
 * Honest boundary: green here proves OUR side of the provider contract. It
 * cannot detect GitHub changing their site — that is the manual
 * pre-release canary.
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { MessageId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { DeviceFlowManager } from '../src/auth/device-flow.js'
import type { CopilotSession } from '../src/auth/store.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import {
  COPILOT_API_URL,
  COPILOT_DEVICE_CODE_URL,
  COPILOT_DEVICE_TOKEN_URL,
  COPILOT_MODELS_URL,
  COPILOT_TOKEN_URL,
  CopilotAdapter,
  completeCopilotLogin,
  copilotDeviceFlow,
  fetchCopilotModels,
  refreshCopilot,
} from '../src/providers/copilot.js'
import {
  FAKE_COPILOT_IDENTITY,
  installFakeCopilot,
  type FakeCopilot,
} from './fakes/fake-copilot.js'

interface VirtualLogin {
  fake: FakeCopilot
  session: CopilotSession
  githubToken: string
}

/**
 * Complete a full device-flow login against the virtual provider: real
 * device-code request, simulated user approval (the fake releases the token
 * after one pending poll), real GitHub-token → Copilot-token exchange.
 */
async function virtualLogin(t: TestContext): Promise<VirtualLogin> {
  const fake = installFakeCopilot(t)
  const flows = new DeviceFlowManager()
  const attempt = await flows.start('copilot', copilotDeviceFlow())
  assert.equal(attempt.verificationUrl, 'https://github.com/login/device')
  assert.equal(attempt.userCode, 'ABCD-1234')
  const githubToken = await attempt.waitToken()
  assert.equal(githubToken, 'fake-github-token')
  const session = await completeCopilotLogin(githubToken)
  return { fake, session, githubToken }
}

test('copilot: full device-flow login against the virtual provider', async (t) => {
  const { fake, session, githubToken } = await virtualLogin(t)
  assert.equal(session.account, FAKE_COPILOT_IDENTITY.login)
  assert.match(session.accessToken, /^fake-copilot-token-/)
  assert.equal(session.refreshToken, githubToken)
  assert.ok(session.expiresAt > Date.now())

  // The device-code request used the real client id and scope.
  const codeCall = fake.calls.find(
    (call) => call.url === COPILOT_DEVICE_CODE_URL,
  )
  assert.ok(codeCall !== undefined)
  const codeForm = new URLSearchParams(codeCall.bodyText)
  assert.equal(codeForm.get('client_id'), 'Iv1.b507a08c87ecfe98')
  assert.equal(codeForm.get('scope'), 'read:user')

  // The poll used the RFC 8628 device_code grant…
  const pollCall = fake.calls.find(
    (call) => call.url === COPILOT_DEVICE_TOKEN_URL,
  )
  assert.ok(pollCall !== undefined)
  const pollForm = new URLSearchParams(pollCall.bodyText)
  assert.equal(
    pollForm.get('grant_type'),
    'urn:ietf:params:oauth:grant-type:device_code',
  )
  assert.ok(fake.issuedDeviceCodes.has(pollForm.get('device_code') ?? ''))

  // …and the Copilot token exchange presented the GitHub token as Bearer.
  const exchangeCall = fake.calls.find((call) => call.url === COPILOT_TOKEN_URL)
  assert.ok(exchangeCall !== undefined)
  assert.equal(exchangeCall.headers['authorization'], `Bearer ${githubToken}`)
  assert.match(
    exchangeCall.headers['editor-version'] ?? '',
    /^vscode\/1\.107\.0$/,
  )
})

test('copilot: refresh re-exchanges the GitHub token and keeps identity', async (t) => {
  const { fake, session, githubToken } = await virtualLogin(t)
  const refreshed = await refreshCopilot(session)
  assert.notEqual(refreshed.accessToken, session.accessToken)
  assert.equal(refreshed.refreshToken, githubToken)
  assert.equal(refreshed.account, FAKE_COPILOT_IDENTITY.login)

  const exchangeCalls = fake.calls.filter(
    (call) => call.url === COPILOT_TOKEN_URL,
  )
  assert.equal(exchangeCalls.length, 2)
  assert.equal(
    exchangeCalls[1].headers['authorization'],
    `Bearer ${githubToken}`,
  )
})

test('copilot: revoked GitHub token fails the exchange loudly', async (t) => {
  installFakeCopilot(t)
  await assert.rejects(
    completeCopilotLogin('revoked-token'),
    /Bad credentials|401/,
  )
})

test('copilot: catalog discovery filters and classifies models', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const models = await fetchCopilotModels(session)
  assert.deepEqual(
    models.map((m) => m.id),
    ['gpt-5.3', 'gpt-5.3-mini'],
  )
  assert.equal(models[0].contextWindow, 400_000)
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  assert.equal(models[0].copilotWire, 'chat-completions')
  assert.equal(models[1].copilotWire, 'responses')

  const modelsCall = fake.calls.find((call) => call.url === COPILOT_MODELS_URL)
  assert.ok(modelsCall !== undefined)
  assert.equal(
    modelsCall.headers['authorization'],
    `Bearer ${session.accessToken}`,
  )
})

test('copilot: a model run streams text through the real adapter', async (t) => {
  const { fake, session } = await virtualLogin(t)
  const tokens = new AccountTokenManager({
    provider: 'copilot',
    displayName: 'Virtual Copilot',
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
  const adapter = new CopilotAdapter({
    models: [{ id: 'gpt-5.3', name: 'GPT-5.3' }],
    tokens,
    discovery: false,
    streamIdleTimeoutMs: 5000,
  })
  const options: GenerateOptions = {
    provider: 'copilot',
    model: 'gpt-5.3',
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

  const apiCall = fake.calls.find((call) => call.url === COPILOT_API_URL)
  assert.ok(apiCall !== undefined)
  assert.equal(apiCall.method, 'POST')
  assert.equal(
    apiCall.headers['authorization'],
    `Bearer ${session.accessToken}`,
  )
  const body = JSON.parse(apiCall.bodyText) as Record<string, unknown>
  assert.equal(body.model, 'gpt-5.3')
  assert.equal(body.stream, true)
})
