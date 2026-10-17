/**
 * Virtual Antigravity provider for integration tests (see docs/testing.md).
 *
 * Fetch-level router simulating Google's OAuth + the Cloud Code Companion
 * API surface so the *real* plugin code — OAuthFlowManager,
 * antigravityFlow, exchangeAntigravityCode, refreshAntigravity,
 * discoverAntigravityAccount, fetchAntigravityModels, fetchAntigravityUsage,
 * AntigravityAdapter.stream — runs end to end without credentials, a
 * browser, or network access:
 *
 * - `GET <ANTIGRAVITY_AUTHORIZE_URL>` behaves like a user approving the
 *   login: it 302-redirects to the attempt's own `redirect_uri` (the real
 *   loopback callback server owned by OAuthFlowManager) with
 *   `?code=…&state=…`.
 * - `POST <ANTIGRAVITY_TOKEN_URL>` takes the form-encoded Google grants.
 *   The refresh deliberately omits `refresh_token` to exercise retention
 *   from the stored session.
 * - `POST <base>/v1internal:loadCodeAssist` returns a project on the first
 *   call (no onboarding loop); `fetchAvailableModels` returns one model with
 *   both quota shapes the usage parser reads (`remainingFraction` →
 *   usedPercent, weekly variant → weekly window).
 * - `POST <base>/v1internal:streamGenerateContent?alt=sse` streams
 *   Gemini-shaped SSE through the real translator (text parts, then a
 *   `finishReason` event — the stream must terminate or the translator
 *   throws STREAM_CLOSED).
 *
 * Requests to loopback (`localhost`/`127.0.0.1`/`[::1]`) pass through to the
 * real fetch so the OAuth callback server under test is genuine.
 *
 * What this proves: our side of the contract (Google grant shape, project
 * discovery, quota parsing, SSE translation). What it cannot prove: that
 * Google still honors the contract — that is the manual pre-release canary.
 *
 * Provenance:
 * Source: the Antigravity desktop client's OAuth scopes and Cloud Code
 * Companion v1internal envelope, mirrored in src/providers/antigravity.ts;
 * the OAuth client identity and mapping come from pi-antigravity.
 * Shapes as of: 1891a32 (2026-09-28). Not compared with the live provider
 * since; update this line when a canary run confirms or corrects them.
 * Drift signal: the manual pre-release canary's login plus one model request.
 */
import type { TestContext } from 'node:test'
/**
 * Endpoint URLs as independent literals — deliberately NOT imported from
 * src/providers/antigravity.js. This fake is a fixture of the provider's HTTP
 * surface: routing on the code's own constants would let an accidental URL
 * change stay green on both sides. If a literal below drifts from the real
 * constant, requests miss the router and fail loudly with 404.
 */
const ANTIGRAVITY_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const ANTIGRAVITY_DEFAULT_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com'
const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const ANTIGRAVITY_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

export const FAKE_ANTIGRAVITY_IDENTITY = {
  email: 'virtual-antigravity@example.invalid',
  projectId: 'proj-virtual-1',
  plan: 'Free',
} as const

/** One observed request, for assertions. */
export interface FakeAntigravityCall {
  url: string
  method: string
  headers: Record<string, string>
  bodyText: string
}

export interface FakeAntigravity {
  /** Every request the router handled (in order). */
  calls: FakeAntigravityCall[]
  /** Codes issued by the fake authorize endpoint, for cross-checking. */
  issuedCodes: Set<string>
}

const LOOPBACK_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/

function geminiSseBody(): string {
  const events = [
    {
      response: {
        candidates: [
          { content: { role: 'model', parts: [{ text: 'Hello, ' }] } },
        ],
      },
    },
    {
      response: {
        candidates: [
          { content: { role: 'model', parts: [{ text: 'world!' }] } },
        ],
      },
    },
    {
      response: {
        candidates: [
          { finishReason: 'STOP', content: { role: 'model', parts: [] } },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      },
    },
  ]
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
}

/**
 * Install the virtual Antigravity provider for one test.
 * @param t - the node:test context (the mock is auto-restored when the test ends).
 * @returns the fake handle (observed calls, issued codes).
 */
export function installFakeAntigravity(t: TestContext): FakeAntigravity {
  const fake: FakeAntigravity = { calls: [], issuedCodes: new Set() }
  const realFetch = globalThis.fetch.bind(globalThis)
  let tokenSerial = 0
  const loadCodeAssistURL = `${ANTIGRAVITY_DEFAULT_BASE_URL}/v1internal:loadCodeAssist`
  const fetchModelsURL = `${ANTIGRAVITY_DEFAULT_BASE_URL}/v1internal:fetchAvailableModels`
  const streamURL = `${ANTIGRAVITY_DEFAULT_BASE_URL}/v1internal:streamGenerateContent?alt=sse`

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

    // --- Google authorize: simulate the user approving in the browser. ---
    if (url.startsWith(ANTIGRAVITY_AUTHORIZE_URL) && method === 'GET') {
      const params = new URL(url).searchParams
      const redirectUri = params.get('redirect_uri')
      const state = params.get('state')
      if (redirectUri === null || state === null) {
        return new Response('missing redirect_uri or state', { status: 400 })
      }
      const code = `fake-antigravity-code-${fake.issuedCodes.size + 1}`
      fake.issuedCodes.add(code)
      const target = new URL(redirectUri)
      target.searchParams.set('code', code)
      target.searchParams.set('state', state)
      return Response.redirect(target.toString(), 302)
    }

    // --- Google token endpoint: form-encoded grants. ---
    if (url === ANTIGRAVITY_TOKEN_URL && method === 'POST') {
      const form = new URLSearchParams(bodyText)
      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code') ?? ''
        if (!fake.issuedCodes.has(code)) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        fake.issuedCodes.delete(code)
        tokenSerial += 1
        return Response.json({
          access_token: `fake-antigravity-access-${tokenSerial}`,
          refresh_token: `fake-antigravity-refresh-${tokenSerial}`,
          expires_in: 3600,
          token_type: 'Bearer',
        })
      }
      if (form.get('grant_type') === 'refresh_token') {
        const refreshToken = form.get('refresh_token') ?? ''
        if (!refreshToken.startsWith('fake-antigravity-refresh-')) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        tokenSerial += 1
        // Deliberately omit refresh_token: exercises retention from storage.
        return Response.json({
          access_token: `fake-antigravity-access-${tokenSerial}`,
          expires_in: 3600,
          token_type: 'Bearer',
        })
      }
      return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
    }

    if (url === loadCodeAssistURL && method === 'POST') {
      return Response.json({
        cloudaicompanionProject: {
          id: FAKE_ANTIGRAVITY_IDENTITY.projectId,
          name: 'Virtual project',
        },
        currentTier: { id: 'free-tier', name: FAKE_ANTIGRAVITY_IDENTITY.plan },
      })
    }

    if (url === ANTIGRAVITY_USERINFO_URL && method === 'GET') {
      return Response.json({ email: FAKE_ANTIGRAVITY_IDENTITY.email })
    }

    if (url === fetchModelsURL && method === 'POST') {
      const now = Date.now()
      return Response.json({
        models: {
          'gemini-3-pro': {
            displayName: 'Gemini 3 Pro',
            description: 'Virtual flagship for integration tests.',
            inputTokenLimit: 1_048_576,
            maxOutputTokens: 65_536,
            quotaInfo: {
              remainingFraction: 0.6,
              resetTime: new Date(now + 3_600_000).toISOString(),
            },
            weeklyQuotaInfo: {
              remainingFraction: 0.8,
              resetTime: new Date(now + 86_400_000).toISOString(),
            },
          },
        },
      })
    }

    if (url === streamURL && method === 'POST') {
      return new Response(geminiSseBody(), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response(
      `virtual antigravity provider has no route for ${method} ${url}`,
      { status: 404 },
    )
  }

  t.mock.method(globalThis, 'fetch', router)
  return fake
}
