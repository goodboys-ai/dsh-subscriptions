/**
 * Virtual Grok provider for integration tests (see docs/testing.md).
 *
 * Fetch-level router simulating xAI's HTTP surface so the *real* plugin
 * code — grokDiscovery, grokFlow, exchangeGrokCode, refreshGrok,
 * fetchGrokUsage, fetchGrokModels, GrokAdapter.stream — runs end to end
 * without credentials, a browser, or network access:
 *
 * - `GET <GROK_DISCOVERY_URL>` serves the OIDC discovery document. The
 *   endpoints it advertises live on x.ai (the real code rejects anything
 *   else as hostile), and the router serves those same endpoints — so the
 *   test proves the login actually follows discovery instead of hardcoding.
 * - `GET <discovered authorize>` 302-redirects to the attempt's own
 *   `redirect_uri` (the real loopback callback server owned by
 *   OAuthFlowManager) with `?code=…&state=…`.
 * - `POST <discovered token>` takes the form-encoded xAI grants, which echo
 *   the PKCE *challenge* as well as the verifier. The access token is a
 *   real-shaped JWT carrying the numeric `tier` claim the plan display
 *   reads (1 = SuperGrok); the id token carries the email claim.
 * - Billing / models / responses endpoints return canned payloads
 *   exercising the real parsing: credits-config windows, the CLI catalog's
 *   reasoning-effort merge, Responses SSE translation.
 *
 * Requests to loopback (`localhost`/`127.0.0.1`/`[::1]`) pass through to the
 * real fetch so the OAuth callback server under test is genuine.
 *
 * What this proves: our side of the contract (discovery use, form encoding
 * with the challenge echo, tier-claim reading, SSE translation). What it
 * cannot prove: that xAI still honors the contract — that is the manual
 * pre-release canary.
 *
 * Provenance:
 * Source: the Grok CLI's OIDC client identity, the cli-chat-proxy billing
 * and model-catalog endpoints, and the xAI Responses-style API, mirrored in
 * src/providers/grok.ts (tier names mirror grok-build's jwt_tier_claim).
 * Shapes as of: 1891a32 (2026-09-28). Not compared with the live provider
 * since; update this line when a canary run confirms or corrects them.
 * Drift signal: the manual pre-release canary's login plus one model request.
 */
import type { TestContext } from 'node:test'
/**
 * Endpoint URLs as independent literals — deliberately NOT imported from
 * src/providers/grok.js. This fake is a fixture of the provider's HTTP
 * surface: routing on the code's own constants would let an accidental URL
 * change stay green on both sides. If a literal below drifts from the real
 * constant, requests miss the router and fail loudly with 404.
 */
const GROK_API_URL = 'https://api.x.ai/v1/responses'
const GROK_BILLING_URL =
  'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const GROK_CLI_MODELS_URL = 'https://cli-chat-proxy.grok.com/v1/models'
const GROK_DISCOVERY_URL = 'https://auth.x.ai/.well-known/openid-configuration'
const GROK_MODELS_URL = 'https://api.x.ai/v1/models'
import { mintFakeJwt } from './fake-codex.js'

/** Endpoints the fake discovery document advertises (x.ai, as the real code requires). */
export const FAKE_GROK_AUTHORIZE_URL = 'https://auth.x.ai/o/oauth/authorize'
export const FAKE_GROK_TOKEN_URL = 'https://auth.x.ai/o/oauth/token'

export const FAKE_GROK_IDENTITY = {
  email: 'virtual-grok@example.invalid',
  tier: 1,
  tierName: 'SuperGrok',
} as const

function fakeAccessToken(suffix: string): string {
  return mintFakeJwt({
    sub: 'virtual-grok-user',
    tier: FAKE_GROK_IDENTITY.tier,
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: suffix,
  })
}

function fakeIdToken(): string {
  return mintFakeJwt({
    sub: 'virtual-grok-user',
    email: FAKE_GROK_IDENTITY.email,
  })
}

/** One observed request, for assertions. */
export interface FakeGrokCall {
  url: string
  method: string
  headers: Record<string, string>
  bodyText: string
}

export interface FakeGrok {
  /** Every request the router handled (in order). */
  calls: FakeGrokCall[]
  /** Codes issued by the fake authorize endpoint, for cross-checking. */
  issuedCodes: Set<string>
}

const LOOPBACK_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/

function responsesSseBody(): string {
  const events = [
    {
      type: 'response.output_text.delta',
      delta: 'Hello, ',
      item_id: 'msg_1',
      content_index: 0,
    },
    {
      type: 'response.output_text.delta',
      delta: 'world!',
      item_id: 'msg_1',
      content_index: 0,
    },
    {
      type: 'response.completed',
      response: { usage: { input_tokens: 10, output_tokens: 5 } },
    },
  ]
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
}

/**
 * Install the virtual Grok provider for one test.
 * @param t - the node:test context (the mock is auto-restored when the test ends).
 * @returns the fake handle (observed calls, issued codes).
 */
export function installFakeGrok(t: TestContext): FakeGrok {
  const fake: FakeGrok = { calls: [], issuedCodes: new Set() }
  const realFetch = globalThis.fetch.bind(globalThis)
  let tokenSerial = 0

  const router = async (
    input: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    if (LOOPBACK_RE.test(url)) return realFetch(input as RequestInfo, init)

    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase()
    const headers: Record<string, string> = {}
    const rawHeaders = init?.headers
    if (rawHeaders !== undefined) {
      new Headers(rawHeaders).forEach((v, k) => {
        headers[k.toLowerCase()] = v
      })
    }
    let bodyText = ''
    if (init?.body !== undefined) {
      bodyText = typeof init.body === 'string' ? init.body : '[non-string body]'
    }
    fake.calls.push({ url, method, headers, bodyText })

    // --- OIDC discovery: the login must follow this document. ---
    if (url === GROK_DISCOVERY_URL && method === 'GET') {
      return Response.json({
        issuer: 'https://auth.x.ai',
        authorization_endpoint: FAKE_GROK_AUTHORIZE_URL,
        token_endpoint: FAKE_GROK_TOKEN_URL,
      })
    }

    // --- OAuth authorize: simulate the user approving in the browser. ---
    if (url.startsWith(FAKE_GROK_AUTHORIZE_URL) && method === 'GET') {
      const params = new URL(url).searchParams
      const redirectUri = params.get('redirect_uri')
      const state = params.get('state')
      if (redirectUri === null || state === null) {
        return new Response('missing redirect_uri or state', { status: 400 })
      }
      const code = `fake-grok-code-${fake.issuedCodes.size + 1}`
      fake.issuedCodes.add(code)
      const target = new URL(redirectUri)
      target.searchParams.set('code', code)
      target.searchParams.set('state', state)
      return Response.redirect(target.toString(), 302)
    }

    // --- Token endpoint: form-encoded xAI grants (challenge echoed). ---
    if (url === FAKE_GROK_TOKEN_URL && method === 'POST') {
      const form = new URLSearchParams(bodyText)
      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code') ?? ''
        if (!fake.issuedCodes.has(code)) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        if (!form.get('code_challenge')) {
          return Response.json(
            {
              error: 'invalid_request',
              error_description: 'missing code_challenge',
            },
            { status: 400 },
          )
        }
        fake.issuedCodes.delete(code)
        tokenSerial += 1
        return Response.json({
          access_token: fakeAccessToken(`exchange-${tokenSerial}`),
          refresh_token: `fake-grok-refresh-${tokenSerial}`,
          expires_in: 3600,
          id_token: fakeIdToken(),
        })
      }
      if (form.get('grant_type') === 'refresh_token') {
        const refreshToken = form.get('refresh_token') ?? ''
        if (!refreshToken.startsWith('fake-grok-refresh-')) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        tokenSerial += 1
        // Deliberately omit id_token: the account display must survive
        // from the stored session on refresh.
        return Response.json({
          access_token: fakeAccessToken(`refresh-${tokenSerial}`),
          refresh_token: `fake-grok-refresh-${tokenSerial}`,
          expires_in: 3600,
        })
      }
      return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
    }

    if (url === GROK_BILLING_URL && method === 'GET') {
      return Response.json({
        config: {
          creditUsagePercent: 30,
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            end: new Date(Date.now() + 3 * 86_400_000).toISOString(),
          },
        },
        subscriptionTier: FAKE_GROK_IDENTITY.tierName,
      })
    }

    if (url === GROK_MODELS_URL && method === 'GET') {
      return Response.json({ data: [{ id: 'grok-4-1' }] })
    }

    if (url === GROK_CLI_MODELS_URL && method === 'GET') {
      return Response.json({
        data: [
          {
            id: 'grok-4-1',
            name: 'Grok 4.1',
            supports_reasoning_effort: true,
            reasoning_efforts: [
              { value: 'low', label: 'Low', description: 'Fast.' },
              { value: 'high', label: 'High', description: 'Thorough.' },
            ],
            reasoning_effort: 'low',
          },
        ],
      })
    }

    if (url === GROK_API_URL && method === 'POST') {
      return new Response(responsesSseBody(), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response(
      `virtual grok provider has no route for ${method} ${url}`,
      { status: 404 },
    )
  }

  t.mock.method(globalThis, 'fetch', router)
  return fake
}
