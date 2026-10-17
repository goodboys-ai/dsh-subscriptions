/**
 * Virtual Cursor provider for integration tests (see docs/testing.md).
 *
 * Fetch-level router simulating Cursor's HTTP surface so the *real* plugin
 * code — CursorAuth (browser-login poll + refresh), fetchCursorUsage,
 * fetchUsableModels — runs end to end without credentials, a browser, or
 * network access:
 *
 * - `GET https://api2.cursor.sh/auth/poll?uuid=…&verifier=…` answers 404
 *   twice (login not yet approved), then 200 with an access/refresh token
 *   pair — the simulated user approving at the login URL. The access token
 *   is a real-shaped JWT whose `sub` carries the WorkOS user id
 *   (`auth0|user_virtual_1`), which the usage reader parses back out.
 * - `POST https://api2.cursor.sh/auth/exchange_user_api_key` rotates the
 *   pair for a Bearer <redacted>
 * - `GET https://cursor.com/api/usage-summary` returns the dashboard quota
 *   payload (`individualUsage.plan` percentages + `membershipType`).
 * - `POST https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels`
 *   returns a hand-encoded protobuf (field 1 → ModelDetails{model_id=1,
 *   display_name=4}) exercising the real decoder.
 *
 * Deliberate boundary: model *streaming* is not covered. The Cursor
 * transport speaks ConnectRPC over a raw `node:http2` session
 * (`/agent.v1.AgentService/Run`), which a fetch-level mock cannot
 * intercept — faking it would mean reimplementing the framing protocol
 * instead of testing our code. Auth, refresh, usage, and catalog discovery
 * are the fetch-level contract and are fully covered.
 *
 * Provenance:
 * Source: Cursor's undocumented Agent protocol and dashboard endpoints from
 * orrinzeng/dsh-cursor-subscription (docs/cursor-origin.md).
 * Shapes as of: 1891a32 (2026-09-28). Not compared with the live provider
 * since; update this line when a canary run confirms or corrects them.
 * Drift signal: the manual pre-release canary's login plus one model request,
 * the only check covering the HTTP/2 generation this fake cannot reach.
 */
import type { TestContext } from 'node:test'
import { mintFakeJwt } from './fake-codex.js'

const POLL_URL = 'https://api2.cursor.sh/auth/poll'
const REFRESH_URL = 'https://api2.cursor.sh/auth/exchange_user_api_key'
const MODELS_URL =
  'https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels'
const USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary'
const USAGE_URL = 'https://cursor.com/api/usage'

export const FAKE_CURSOR_IDENTITY = {
  userId: 'user_virtual_1',
  membershipType: 'pro',
} as const

function fakeAccessToken(suffix: string): string {
  return mintFakeJwt({
    sub: `auth0|${FAKE_CURSOR_IDENTITY.userId}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: suffix,
  })
}

/** One observed request, for assertions. */
export interface FakeCursorCall {
  url: string
  method: string
  headers: Record<string, string>
  bodyText: string
}

export interface FakeCursor {
  /** Every request the router handled (in order). */
  calls: FakeCursorCall[]
}

/** Minimal protobuf writer: enough for the ModelDetails schema the decoder reads. */
function varint(value: number): number[] {
  const out: number[] = []
  let rest = value
  do {
    const bits = rest & 0x7f
    rest >>>= 7
    out.push(rest === 0 ? bits : bits | 0x80)
  } while (rest !== 0)
  return out
}

function protoField(field: number, payload: Uint8Array): number[] {
  return [...varint((field << 3) | 2), ...varint(payload.length), ...payload]
}

function protoString(field: number, value: string): number[] {
  return protoField(field, new TextEncoder().encode(value))
}

/** Encode one ModelDetails message: model_id=1, display_name=4. */
function encodeModel(id: string, name: string): Uint8Array {
  return Uint8Array.from([...protoString(1, id), ...protoString(4, name)])
}

/** Encode the GetUsableModels response: repeated field 1 → ModelDetails. */
function encodeModels(models: { id: string; name: string }[]): Uint8Array {
  const out: number[] = []
  for (const model of models)
    out.push(...protoField(1, encodeModel(model.id, model.name)))
  return Uint8Array.from(out)
}

/**
 * Install the virtual Cursor provider for one test.
 * @param t - the node:test context (the mock is auto-restored when the test ends).
 * @returns the fake handle (observed calls).
 */
export function installFakeCursor(t: TestContext): FakeCursor {
  const fake: FakeCursor = { calls: [] }
  let pollsBeforeApproval = 2
  let tokenSerial = 0

  const router = async (
    input: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
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

    // --- Login poll: 404 until the "user" approves in the browser. ---
    if (url.startsWith(POLL_URL) && method === 'GET') {
      if (pollsBeforeApproval > 0) {
        pollsBeforeApproval -= 1
        return new Response('not yet approved', { status: 404 })
      }
      tokenSerial += 1
      return Response.json({
        accessToken: fakeAccessToken(`login-${tokenSerial}`),
        refreshToken: `fake-cursor-refresh-${tokenSerial}`,
      })
    }

    // --- Refresh: Bearer <redacted> rotates the pair. ---
    if (url === REFRESH_URL && method === 'POST') {
      const presented = (headers['authorization'] ?? '').replace(/^Bearer /, '')
      if (!presented.startsWith('fake-cursor-refresh-')) {
        return Response.json(
          { error: 'invalid refresh token' },
          { status: 401 },
        )
      }
      tokenSerial += 1
      return Response.json({
        accessToken: fakeAccessToken(`refresh-${tokenSerial}`),
        refreshToken: `fake-cursor-refresh-${tokenSerial}`,
      })
    }

    if (url === USAGE_SUMMARY_URL && method === 'GET') {
      return Response.json({
        individualUsage: {
          plan: {
            totalPercentUsed: 25,
            autoPercentUsed: 10,
            apiPercentUsed: 5,
          },
        },
        billingCycleEnd: new Date(Date.now() + 20 * 86_400_000).toISOString(),
        membershipType: FAKE_CURSOR_IDENTITY.membershipType,
      })
    }

    if (url.startsWith(USAGE_URL) && method === 'GET') {
      // No quota buckets: the summary payload above carries the windows.
      return Response.json({})
    }

    if (url === MODELS_URL && method === 'POST') {
      const bytes = encodeModels([
        { id: 'composer-1', name: 'Composer 1' },
        { id: 'gpt-5.3', name: 'GPT-5.3' },
      ])
      // ArrayBuffer.slice to detach from the shared pool before transfer.
      return new Response(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
        {
          headers: { 'content-type': 'application/proto' },
        },
      )
    }
    return new Response(
      `virtual cursor provider has no route for ${method} ${url}`,
      { status: 404 },
    )
  }

  t.mock.method(globalThis, 'fetch', router)
  return fake
}
