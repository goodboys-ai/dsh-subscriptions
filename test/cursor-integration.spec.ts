/**
 * Virtual-provider integration test: Cursor (see docs/testing.md).
 *
 * The fetch-level Cursor route runs against {@link installFakeCursor}'s
 * virtual backend — no credentials, no browser, no network. What is REAL in
 * every test below: the CursorAuth login lifecycle (browser-login URL,
 * background 404-tolerant poll, JWT expiry check), the refresh-token
 * rotation via the exchange endpoint, the usage reader (cookie auth,
 * dashboard quota → windows), and the usable-models discovery through the
 * REAL vendored protobuf decoder.
 *
 * Deliberate boundary: model *streaming* is not covered. Cursor's
 * generation transport speaks ConnectRPC over a raw `node:http2` session
 * (`/agent.v1.AgentService/Run`), which a fetch-level mock cannot
 * intercept — faking it would mean reimplementing the framing protocol
 * instead of testing our code. Auth, refresh, usage, and catalog discovery
 * are the fetch-level contract and are fully covered.
 *
 * Honest boundary: green here proves OUR side of the provider contract. It
 * cannot detect Cursor changing their site — that is the manual
 * pre-release canary.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProviderUsage } from '../src/providers/common.js'

// The vendored transport exposes model discovery at runtime, but the shipped
// .d.ts only declares the adapter class. Augment it with the narrow surface
// this test exercises — the real fetchUsableModels, not a reimplementation.
declare module 'dsh-subscriptions/cursor-transport' {
  export function fetchUsableModels(
    accessToken: string,
    options?: { fetch?: typeof fetch; signal?: AbortSignal },
  ): Promise<{ id: string; name: string }[]>
}
import { fetchUsableModels } from 'dsh-subscriptions/cursor-transport'
import {
  CURSOR_CREDENTIAL_REF,
  CursorAuth,
  type CursorCredentialService,
} from '../src/providers/cursor-auth.js'
import { fetchCursorUsage } from '../src/providers/cursor-usage.js'
import { FAKE_CURSOR_IDENTITY, installFakeCursor } from './fakes/fake-cursor.js'

/** The real CursorAuth wired to an in-memory credential store. */
function virtualAuth(): {
  auth: CursorAuth
  credentials: CursorCredentialService
} {
  const store = new Map<unknown, string>()
  const credentials: CursorCredentialService = {
    resolve: async (ref) => {
      const value = store.get(ref)
      return value === undefined ? undefined : { value }
    },
    set: async (ref, value) => {
      store.set(ref, value)
    },
    unset: async (ref) => {
      store.delete(ref)
    },
  }
  const auth = new CursorAuth(credentials, globalThis.fetch)
  return { auth, credentials }
}

/** Poll the real status() until the background login poll lands. */
async function awaitAuthenticated(auth: CursorAuth): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await auth.status()).authenticated) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('virtual Cursor login never completed')
}

test('cursor: browser login polls to approval and yields a JWT', async (t) => {
  const fake = installFakeCursor(t)
  const { auth } = virtualAuth()
  assert.equal((await auth.status()).authenticated, false)
  const { authorizeUrl } = await auth.login()
  assert.ok(
    authorizeUrl.startsWith('https://cursor.com/loginDeepControl?'),
    'the real login URL goes to cursor.com',
  )

  // The virtual provider answers 404 twice before the simulated user
  // approves; the real poll loop rides through them.
  await awaitAuthenticated(auth)
  assert.equal((await auth.status()).busy, false)

  const access = await auth.accessToken()
  const payload = JSON.parse(
    Buffer.from(access.split('.')[1], 'base64url').toString('utf8'),
  ) as Record<string, unknown>
  assert.equal(payload.sub, `auth0|${FAKE_CURSOR_IDENTITY.userId}`)
  assert.ok(typeof payload.exp === 'number' && payload.exp * 1000 > Date.now())

  // The poll went to the real poll URL with the PKCE verifier in the query.
  const pollCall = fake.calls.find((call) =>
    call.url.startsWith('https://api2.cursor.sh/auth/poll'),
  )
  assert.ok(pollCall !== undefined)
  const pollUrl = new URL(pollCall.url)
  assert.ok(pollUrl.searchParams.get('uuid') !== null)
  assert.ok(pollUrl.searchParams.get('verifier') !== null)
})

test('cursor: expired access token triggers refresh through the exchange endpoint', async (t) => {
  const fake = installFakeCursor(t)
  const { auth, credentials } = virtualAuth()
  await auth.login()
  await awaitAuthenticated(auth)

  const stored = await credentials.resolve(CURSOR_CREDENTIAL_REF)
  assert.ok(stored !== undefined)
  const credential = JSON.parse(stored.value) as {
    access: string
    refresh: string
    expires: number
  }
  assert.equal(credential.refresh, 'fake-cursor-refresh-1')

  // Backdate the stored expiry: the real accessToken() decodes, notices the
  // expiry, and rotates via the exchange endpoint.
  await credentials.set(
    CURSOR_CREDENTIAL_REF,
    JSON.stringify({ ...credential, expires: Date.now() - 1_000 }),
  )
  const rotated = await auth.accessToken()
  assert.notEqual(rotated, credential.access)
  const payload = JSON.parse(
    Buffer.from(rotated.split('.')[1], 'base64url').toString('utf8'),
  ) as Record<string, unknown>
  assert.equal(payload.sub, `auth0|${FAKE_CURSOR_IDENTITY.userId}`)

  const refreshCall = fake.calls.find(
    (call) => call.url === 'https://api2.cursor.sh/auth/exchange_user_api_key',
  )
  assert.ok(refreshCall !== undefined)
  assert.equal(refreshCall.method, 'POST')
  assert.equal(
    refreshCall.headers['authorization'],
    `Bearer ${credential.refresh}`,
  )

  // The rotated pair is persisted for the next call.
  const next = JSON.parse(
    (await credentials.resolve(CURSOR_CREDENTIAL_REF))!.value,
  ) as { access: string }
  assert.equal(next.access, rotated)
})

test('cursor: usage reader converts the dashboard quota to windows', async (t) => {
  const fake = installFakeCursor(t)
  const { auth } = virtualAuth()
  await auth.login()
  await awaitAuthenticated(auth)
  const access = await auth.accessToken()
  const usage: ProviderUsage = await fetchCursorUsage(access, globalThis.fetch)
  assert.equal(usage.supported, true)
  assert.equal(usage.plan, FAKE_CURSOR_IDENTITY.membershipType)
  const windows = usage.windows ?? []
  // The dashboard percentages all surface as kind 'other', distinguished by
  // scope; the legacy /api/usage endpoint returns no buckets in the fake.
  assert.deepEqual(
    windows.map((w) => w.scope),
    ['Included', 'Cursor Models', 'Other Models'],
  )
  assert.equal(windows[0].usedPercent, 25)
  assert.equal(windows[1].usedPercent, 10)
  assert.equal(windows[2].usedPercent, 5)
  assert.ok((windows[0].resetsAt ?? 0) > Date.now())

  // The usage reader authenticates with the WorkOS session cookie derived
  // from the JWT — never an Authorization header.
  const summaryCall = fake.calls.find(
    (call) => call.url === 'https://cursor.com/api/usage-summary',
  )
  assert.ok(summaryCall !== undefined)
  const cookie = summaryCall.headers['cookie'] ?? ''
  assert.equal(
    cookie,
    `WorkosCursorSessionToken=${FAKE_CURSOR_IDENTITY.userId}::${access}`,
  )
  assert.equal(summaryCall.headers['authorization'], undefined)
  assert.equal(summaryCall.headers['origin'], 'https://cursor.com')
})

test('cursor: usable-models discovery decodes the protobuf catalog', async (t) => {
  const fake = installFakeCursor(t)
  const { auth } = virtualAuth()
  await auth.login()
  await awaitAuthenticated(auth)
  const access = await auth.accessToken()
  const models = await fetchUsableModels(access, { fetch: globalThis.fetch })
  assert.deepEqual(
    models.map((m) => m.id),
    ['composer-1', 'gpt-5.3'],
  )
  assert.deepEqual(
    models.map((m) => m.name),
    ['Composer 1', 'GPT-5.3'],
  )

  const modelsCall = fake.calls.find(
    (call) =>
      call.url ===
      'https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels',
  )
  assert.ok(modelsCall !== undefined)
  assert.equal(modelsCall.method, 'POST')
  assert.equal(modelsCall.headers['authorization'], `Bearer ${access}`)
})
