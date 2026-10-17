/**
 * Virtual Copilot provider for integration tests (see docs/testing.md).
 *
 * Fetch-level router simulating GitHub's HTTP surface so the *real* plugin
 * code — DeviceFlowManager, copilotDeviceFlow, completeCopilotLogin,
 * exchangeCopilotToken, refreshCopilot, fetchCopilotModels,
 * CopilotAdapter.stream — runs end to end without credentials, a browser,
 * or network access:
 *
 * - `POST <COPILOT_DEVICE_CODE_URL>` issues a device code with a 1-second
 *   poll interval (keeps the test fast; the real flow polls for minutes).
 * - `POST <COPILOT_DEVICE_TOKEN_URL>` answers `authorization_pending` once,
 *   then releases a fake GitHub OAuth token — the simulated user typing the
 *   code at the verification URL.
 * - `GET <COPILOT_TOKEN_URL>` exchanges the GitHub token for a short-lived
 *   Copilot API token (Bearer <redacted> the GitHub token, as the real code
 *   does); `GET <GITHUB_USER_URL>` supplies the login name.
 * - Models / chat endpoints return canned payloads exercising the real
 *   parsing: endpoint-based wire selection, vision capability flags,
 *   chat-completions SSE translation.
 * - `GET <VSCODE_RELEASES_URL>` serves a version feed so the editor-version
 *   header path is exercised instead of the offline fallback.
 *
 * What this proves: our side of the contract (device-flow polling, the
 * two-step token exchange, wire selection, SSE translation). What it cannot
 * prove: that GitHub still honors the contract — that is the manual
 * pre-release canary.
 *
 * Provenance:
 * Source: the VS Code Copilot Chat client identity (shared with pi-mono and
 * copilot2api-go), GitHub's device flow and copilot_internal token exchange,
 * and the editor-version feed, mirrored in src/providers/copilot.ts.
 * Shapes as of: 1891a32 (2026-09-28). Not compared with the live provider
 * since; update this line when a canary run confirms or corrects them.
 * Drift signal: the manual pre-release canary's login plus one model request.
 */
import type { TestContext } from 'node:test'
/**
 * Endpoint URLs as independent literals — deliberately NOT imported from
 * src/providers/copilot.js. This fake is a fixture of the provider's HTTP
 * surface: routing on the code's own constants would let an accidental URL
 * change stay green on both sides. If a literal below drifts from the real
 * constant, requests miss the router and fail loudly with 404.
 */
const COPILOT_API_URL = 'https://api.githubcopilot.com/chat/completions'
const COPILOT_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const COPILOT_DEVICE_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const COPILOT_MODELS_URL = 'https://api.githubcopilot.com/models'
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'
const GITHUB_USER_URL = 'https://api.github.com/user'
const VSCODE_RELEASES_URL =
  'https://update.code.visualstudio.com/api/releases/stable'

export const FAKE_COPILOT_IDENTITY = {
  login: 'virtual-tester',
} as const

/** One observed request, for assertions. */
export interface FakeCopilotCall {
  url: string
  method: string
  headers: Record<string, string>
  bodyText: string
}

export interface FakeCopilot {
  /** Every request the router handled (in order). */
  calls: FakeCopilotCall[]
  /** Device codes issued, for cross-checking the poll grant. */
  issuedDeviceCodes: Set<string>
}

function chatSseBody(): string {
  const events = [
    {
      id: 'chatcmpl-1',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'Hello, ' },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl-1',
      choices: [
        { index: 0, delta: { content: 'world!' }, finish_reason: null },
      ],
    },
    {
      id: 'chatcmpl-1',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]
  return (
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
    'data: [DONE]\n\n'
  )
}

/**
 * Install the virtual Copilot provider for one test.
 * @param t - the node:test context (the mock is auto-restored when the test ends).
 * @returns the fake handle (observed calls, issued device codes).
 */
export function installFakeCopilot(t: TestContext): FakeCopilot {
  const fake: FakeCopilot = { calls: [], issuedDeviceCodes: new Set() }
  let pollsBeforeApproval = 1
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

    // --- Device authorization: issue a code the "user" will approve. ---
    if (url === COPILOT_DEVICE_CODE_URL && method === 'POST') {
      const deviceCode = `fake-device-${fake.issuedDeviceCodes.size + 1}`
      fake.issuedDeviceCodes.add(deviceCode)
      pollsBeforeApproval = 1
      return Response.json({
        device_code: deviceCode,
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        // 1s keeps the poll loop fast; the manager sleeps before each poll.
        interval: 1,
        expires_in: 900,
      })
    }

    // --- Device token poll: pending once, then the user "approves". ---
    if (url === COPILOT_DEVICE_TOKEN_URL && method === 'POST') {
      const form = new URLSearchParams(bodyText)
      const deviceCode = form.get('device_code') ?? ''
      if (!fake.issuedDeviceCodes.has(deviceCode)) {
        return Response.json({ error: 'expired_token' }, { status: 400 })
      }
      if (pollsBeforeApproval > 0) {
        pollsBeforeApproval -= 1
        return Response.json({ error: 'authorization_pending' })
      }
      return Response.json({
        access_token: 'fake-github-token',
        token_type: 'bearer',
        scope: 'read:user',
      })
    }

    // --- Copilot API token exchange: Bearer <redacted> GitHub token. ---
    if (url === COPILOT_TOKEN_URL && method === 'GET') {
      if (headers['authorization'] !== 'Bearer fake-github-token') {
        return Response.json({ message: 'Bad credentials' }, { status: 401 })
      }
      tokenSerial += 1
      return Response.json({
        token: `fake-copilot-token-${tokenSerial}`,
        expires_at: Math.floor(Date.now() / 1000) + 1800,
      })
    }

    if (url === GITHUB_USER_URL && method === 'GET') {
      return Response.json({ login: FAKE_COPILOT_IDENTITY.login })
    }

    if (url === VSCODE_RELEASES_URL && method === 'GET') {
      return Response.json(['1.107.0'])
    }

    if (url === COPILOT_MODELS_URL && method === 'GET') {
      return Response.json({
        data: [
          {
            id: 'gpt-5.3',
            name: 'GPT-5.3',
            model_picker_enabled: true,
            supported_endpoints: ['/chat/completions'],
            capabilities: {
              limits: { max_context_window_tokens: 400_000 },
              supports: { vision: true },
            },
          },
          {
            id: 'gpt-5.3-mini',
            name: 'GPT-5.3 Mini',
            model_picker_enabled: true,
            supported_endpoints: ['/responses'],
            capabilities: {
              limits: { max_context_window_tokens: 200_000 },
              supports: { vision: false },
            },
          },
          // Exercises the picker filter: must never surface in discovery.
          { id: 'hidden-model', name: 'Hidden', model_picker_enabled: false },
        ],
      })
    }

    if (url === COPILOT_API_URL && method === 'POST') {
      return new Response(chatSseBody(), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response(
      `virtual copilot provider has no route for ${method} ${url}`,
      { status: 404 },
    )
  }

  t.mock.method(globalThis, 'fetch', router)
  return fake
}
