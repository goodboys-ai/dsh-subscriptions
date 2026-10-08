/**
 * Virtual Claude provider for integration tests (see docs/testing.md).
 *
 * Fetch-level router simulating Anthropic's HTTP surface so the *real*
 * plugin code — OAuthFlowManager, claudeFlow, exchangeClaudeCode,
 * refreshClaude, fetchClaudeUsage, fetchClaudeModels, ClaudeAdapter.stream —
 * runs end to end without credentials, a browser, or network access:
 *
 * - `GET <CLAUDE_AUTHORIZE_URL>` behaves like a user approving the login:
 *   it 302-redirects to the attempt's own `redirect_uri` (the real loopback
 *   callback server owned by OAuthFlowManager) with `?code=…&state=…`.
 * - `POST <CLAUDE_TOKEN_URL>` takes the JSON grants the real code sends
 *   (authorization_code with PKCE verifier + state; refresh_token echoing
 *   the issued scope). The refresh deliberately omits `refresh_token` to
 *   exercise retention from the stored session.
 * - Profile / usage / models endpoints return canned payloads exercising the
 *   real parsing: profile field fallbacks, the modern `limits` usage array,
 *   capability-driven reasoning-effort mapping, context-window ceilings.
 * - `POST <CLAUDE_API_URL>` streams Anthropic SSE (`content_block_delta`
 *   text deltas) through the real translator.
 *
 * Requests to loopback (`localhost`/`127.0.0.1`/`[::1]`) pass through to the
 * real fetch so the OAuth callback server under test is genuine.
 *
 * What this proves: our side of the contract (JSON grant shape, claim paths,
 * refresh grants, SSE translation). What it cannot prove: that Anthropic
 * still honors the contract — that is the manual pre-release canary.
 *
 * Provenance:
 * Source: the Claude Code CLI's OAuth client identity plus Anthropic's
 * Messages API (request assembly and SSE in src/translate/anthropic.ts);
 * usage and profile payloads mirror src/providers/claude.ts.
 * Shapes as of: 1891a32 (2026-09-28). Not compared with the live provider
 * since; update this line when a canary run confirms or corrects them.
 * Drift signal: the manual pre-release canary's login plus one model request.
 */
import type { TestContext } from 'node:test'
/**
 * Endpoint URLs as independent literals — deliberately NOT imported from
 * src/providers/claude.js. This fake is a fixture of the provider's HTTP
 * surface: routing on the code's own constants would let an accidental URL
 * change stay green on both sides. If a literal below drifts from the real
 * constant, requests miss the router and fail loudly with 404.
 */
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages?beta=true'
const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const CLAUDE_MODELS_URL = 'https://api.anthropic.com/v1/models?beta=true'
const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const CLAUDE_TOKEN_URL = 'https://claude.ai/v1/oauth/token'
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
import { mintFakeJwt } from './fake-codex.js'

export const FAKE_CLAUDE_IDENTITY = {
  email: 'virtual-claude@example.invalid',
  subscriptionType: 'max',
} as const

function fakeAccessToken(suffix: string): string {
  return mintFakeJwt({ sub: 'virtual-claude-user', exp: Math.floor(Date.now() / 1000) + 3600, jti: suffix })
}

/** One observed request, for assertions. */
export interface FakeClaudeCall {
  url: string
  method: string
  headers: Record<string, string>
  bodyText: string
}

export interface FakeClaude {
  /** Every request the router handled (in order). */
  calls: FakeClaudeCall[]
  /** Codes issued by the fake authorize endpoint, for cross-checking. */
  issuedCodes: Set<string>
}

const LOOPBACK_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/

function anthropicSseBody(): string {
  const events: [string, Record<string, unknown>][] = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 8, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello, ' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world!' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

/**
 * Install the virtual Claude provider for one test.
 * @param t - the node:test context (the mock is auto-restored when the test ends).
 * @returns the fake handle (observed calls, issued codes).
 */
export function installFakeClaude(t: TestContext): FakeClaude {
  const fake: FakeClaude = { calls: [], issuedCodes: new Set() }
  const realFetch = globalThis.fetch.bind(globalThis)
  let tokenSerial = 0

  const router = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    if (LOOPBACK_RE.test(url)) return realFetch(input as RequestInfo, init)

    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const headers: Record<string, string> = {}
    const rawHeaders = init?.headers
    if (rawHeaders !== undefined) {
      new Headers(rawHeaders).forEach((v, k) => { headers[k.toLowerCase()] = v })
    }
    let bodyText = ''
    if (init?.body !== undefined) {
      bodyText = typeof init.body === 'string' ? init.body : '[non-string body]'
    }
    fake.calls.push({ url, method, headers, bodyText })

    // --- OAuth authorize: simulate the user approving in the browser. ---
    if (url.startsWith(CLAUDE_AUTHORIZE_URL) && method === 'GET') {
      const params = new URL(url).searchParams
      const redirectUri = params.get('redirect_uri')
      const state = params.get('state')
      if (redirectUri === null || state === null) {
        return new Response('missing redirect_uri or state', { status: 400 })
      }
      const code = `fake-claude-code-${fake.issuedCodes.size + 1}`
      fake.issuedCodes.add(code)
      const target = new URL(redirectUri)
      target.searchParams.set('code', code)
      target.searchParams.set('state', state)
      return Response.redirect(target.toString(), 302)
    }

    // --- Token endpoint: JSON grants for exchange and refresh. ---
    if (url === CLAUDE_TOKEN_URL && method === 'POST') {
      const body = JSON.parse(bodyText) as Record<string, unknown>
      if (body.grant_type === 'authorization_code') {
        const code = typeof body.code === 'string' ? body.code : ''
        if (!fake.issuedCodes.has(code)) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        fake.issuedCodes.delete(code)
        tokenSerial += 1
        return Response.json({
          access_token: fakeAccessToken(`exchange-${tokenSerial}`),
          refresh_token: `fake-claude-refresh-${tokenSerial}`,
          expires_in: 3600,
          scope: 'user:inference',
        })
      }
      if (body.grant_type === 'refresh_token') {
        const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : ''
        if (!refreshToken.startsWith('fake-claude-refresh-')) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        tokenSerial += 1
        // Deliberately omit refresh_token: exercises retention from storage.
        return Response.json({
          access_token: fakeAccessToken(`refresh-${tokenSerial}`),
          expires_in: 3600,
        })
      }
      return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
    }

    if (url === CLAUDE_PROFILE_URL && method === 'GET') {
      return Response.json({
        emailAddress: FAKE_CLAUDE_IDENTITY.email,
        subscriptionType: FAKE_CLAUDE_IDENTITY.subscriptionType,
      })
    }

    if ((url === CLAUDE_USAGE_URL || url === `${CLAUDE_USAGE_URL}?cedar_ember=1`) && method === 'GET') {
      const now = Date.now()
      return Response.json({
        limits: [
          {
            kind: 'session',
            percent: 35,
            resets_at: new Date(now + 3_600_000).toISOString(),
          },
          {
            kind: 'weekly_all',
            percent: 12,
            resets_at: new Date(now + 86_400_000).toISOString(),
          },
        ],
      })
    }

    if (url.startsWith(CLAUDE_MODELS_URL) && method === 'GET') {
      return Response.json({
        data: [
          {
            id: 'claude-opus-4-6',
            display_name: 'Claude Opus 4.6',
            capabilities: {
              thinking: { types: { enabled: { supported: true } } },
              effort: {
                supported: true,
                low: { supported: false },
                medium: { supported: true },
                high: { supported: true },
              },
            },
            max_input_tokens: 200_000,
            max_tokens: 32_000,
          },
          {
            id: 'claude-sonnet-4-6',
            display_name: 'Claude Sonnet 4.6',
            max_input_tokens: 200_000,
          },
        ],
      })
    }

    if (url === CLAUDE_API_URL && method === 'POST') {
      return new Response(anthropicSseBody(), { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response(`virtual claude provider has no route for ${method} ${url}`, { status: 404 })
  }

  t.mock.method(globalThis, 'fetch', router)
  return fake
}
