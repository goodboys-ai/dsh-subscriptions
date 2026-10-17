/**
 * Virtual Codex provider for integration tests (see docs/testing.md).
 *
 * This is a fetch-level router that simulates the ChatGPT backend's HTTP
 * surface so the *real* plugin code — OAuthFlowManager, exchangeCodexCode,
 * refreshCodex, fetchCodexUsage, fetchCodexModels, CodexAdapter.stream —
 * runs end to end without credentials, a browser, or network access:
 *
 * - `GET <CODEX_AUTHORIZE_URL>` behaves like a user approving the login:
 *   it 302-redirects to the attempt's own `redirect_uri` (the real loopback
 *   callback server owned by OAuthFlowManager) with `?code=…&state=…`.
 * - `POST <CODEX_TOKEN_URL>` exchanges codes and refresh tokens for fake
 *   sessions; the id token is a real-shaped JWT carrying the namespaced
 *   claims the session parser reads.
 * - Usage / models / responses endpoints return canned payloads that
 *   exercise the real parsing: window classification by duration, catalog
 *   visibility filtering and sorting, SSE stream translation.
 *
 * Requests to loopback (`localhost`/`127.0.0.1`/`[::1]`) pass through to the
 * real fetch so the OAuth callback server under test is genuine.
 *
 * What this proves: our side of the contract (form encoding, claim paths,
 * refresh grants, SSE translation). What it cannot prove: that the real
 * provider still honors the contract — that is the manual pre-release
 * canary (see docs/testing.md).
 *
 * To add a virtual provider for another route, copy this file's structure:
 * a router keyed on that provider's endpoint URLs as independent literals
 * (never imported from src — see the note above) plus helpers minting
 * whatever credentials its session parser requires.
 *
 * Provenance:
 * Source: the Codex CLI's ChatGPT backend wire (OAuth client id, Responses
 * `service_tier` fast mode, `wham/usage` windows), mirrored in
 * src/providers/codex.ts, whose fast-tier check names codex-rs.
 * Shapes as of: 1891a32 (2026-09-28). Not compared with the live provider
 * since; update this line when a canary run confirms or corrects them.
 * Drift signal: the manual pre-release canary's login plus one model request.
 */
import type { TestContext } from 'node:test'
/**
 * Endpoint URLs as independent literals — deliberately NOT imported from
 * src/providers/codex.js. This fake is a fixture of the provider's HTTP
 * surface: routing on the code's own constants would let an accidental URL
 * change stay green on both sides. If a literal below drifts from the real
 * constant, requests miss the router and fail loudly with 404.
 */
const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses'
const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

/** Mint an unsigned JWT with the given payload (signature never verified). */
export function mintFakeJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.fake-signature`
}

export const FAKE_CODEX_IDENTITY = {
  email: 'virtual-tester@example.invalid',
  accountId: 'acc_virtual_123',
  planType: 'plus',
} as const

function fakeIdToken(): string {
  return mintFakeJwt({
    email: FAKE_CODEX_IDENTITY.email,
    'https://api.openai.com/profile': { email: FAKE_CODEX_IDENTITY.email },
    'https://api.openai.com/auth': {
      chatgpt_account_id: FAKE_CODEX_IDENTITY.accountId,
      chatgpt_plan_type: FAKE_CODEX_IDENTITY.planType,
    },
  })
}

function fakeAccessToken(suffix: string): string {
  return mintFakeJwt({
    sub: 'virtual-user',
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: suffix,
  })
}

/** One observed request, for assertions. */
export interface FakeCodexCall {
  url: string
  method: string
  headers: Record<string, string>
  bodyText: string
}

export interface FakeCodex {
  /** Every request the router handled (in order). */
  calls: FakeCodexCall[]
  /** Codes issued by the fake authorize endpoint, for cross-checking. */
  issuedCodes: Set<string>
}

const LOOPBACK_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/

function sseBody(): string {
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

function usagePayload(): Record<string, unknown> {
  return {
    plan_type: FAKE_CODEX_IDENTITY.planType,
    rate_limit: {
      primary_window: {
        used_percent: 42.5,
        limit_window_seconds: 18_000,
        reset_after_seconds: 3600,
      },
      secondary_window: {
        used_percent: 10,
        limit_window_seconds: 604_800,
        reset_at: Math.floor(Date.now() / 1000) + 86_400,
      },
    },
  }
}

function modelsPayload(): Record<string, unknown> {
  return {
    models: [
      {
        slug: 'gpt-5.3-codex',
        display_name: 'GPT-5.3 Codex',
        description: 'Virtual flagship for integration tests.',
        context_window: 400_000,
        max_context_window: 400_000,
        priority: 1,
        visibility: 'list',
        supported_reasoning_levels: [
          { effort: 'medium', description: 'Balanced.' },
        ],
        default_reasoning_level: 'medium',
        service_tiers: [{ id: 'priority', name: 'Priority' }],
      },
      {
        slug: 'gpt-5.3',
        display_name: 'GPT-5.3',
        priority: 2,
        visibility: 'list',
      },
      // Exercises the visibility filter: must never surface in discovery.
      {
        slug: 'secret-model',
        display_name: 'Secret',
        priority: 0,
        visibility: 'hide',
      },
    ],
  }
}

/**
 * Install the virtual Codex provider for one test.
 * @param t - the node:test context (the mock is auto-restored when the test ends).
 * @returns the fake handle (observed calls, issued codes).
 */
export function installFakeCodex(t: TestContext): FakeCodex {
  const fake: FakeCodex = { calls: [], issuedCodes: new Set() }
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

    // --- OAuth authorize: simulate the user approving in the browser. ---
    if (url.startsWith(CODEX_AUTHORIZE_URL) && method === 'GET') {
      const params = new URL(url).searchParams
      const redirectUri = params.get('redirect_uri')
      const state = params.get('state')
      if (redirectUri === null || state === null) {
        return new Response('missing redirect_uri or state', { status: 400 })
      }
      const code = `fake-code-${fake.issuedCodes.size + 1}`
      fake.issuedCodes.add(code)
      const target = new URL(redirectUri)
      target.searchParams.set('code', code)
      target.searchParams.set('state', state)
      return Response.redirect(target.toString(), 302)
    }

    // --- Token endpoint: code exchange (form) and refresh (JSON). ---
    if (url === CODEX_TOKEN_URL && method === 'POST') {
      const contentType = headers['content-type'] ?? ''
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const form = new URLSearchParams(bodyText)
        if (form.get('grant_type') !== 'authorization_code') {
          return Response.json(
            { error: 'unsupported_grant_type' },
            { status: 400 },
          )
        }
        const code = form.get('code') ?? ''
        if (!fake.issuedCodes.has(code)) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        fake.issuedCodes.delete(code)
        tokenSerial += 1
        return Response.json({
          access_token: fakeAccessToken(`exchange-${tokenSerial}`),
          refresh_token: `fake-refresh-${tokenSerial}`,
          expires_in: 3600,
          id_token: fakeIdToken(),
        })
      }
      if (contentType.includes('application/json')) {
        const body = JSON.parse(bodyText) as {
          grant_type?: string
          refresh_token?: string
        }
        if (
          body.grant_type !== 'refresh_token' ||
          typeof body.refresh_token !== 'string' ||
          !body.refresh_token.startsWith('fake-refresh-')
        ) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        tokenSerial += 1
        // Deliberately omit id_token: exercises claim retention from the
        // stored session on refresh.
        return Response.json({
          access_token: fakeAccessToken(`refresh-${tokenSerial}`),
          refresh_token: `fake-refresh-${tokenSerial}`,
          expires_in: 3600,
        })
      }
      return new Response('unexpected content type', { status: 400 })
    }

    if (url.startsWith(CODEX_USAGE_URL) && method === 'GET') {
      return Response.json(usagePayload())
    }
    if (url.startsWith(CODEX_MODELS_URL) && method === 'GET') {
      return Response.json(modelsPayload())
    }
    if (url === CODEX_API_URL && method === 'POST') {
      return new Response(sseBody(), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response(
      `virtual codex provider has no route for ${method} ${url}`,
      { status: 404 },
    )
  }

  t.mock.method(globalThis, 'fetch', router)
  return fake
}
