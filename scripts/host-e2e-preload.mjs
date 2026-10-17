// Network stand-in for the dsh web process in the host E2E. Loaded with
// `node --import` into that process only, never into npx or the plugin
// install.
//
// Loopback stays open, since the browser, the RPC routes, and the host's
// own services talk over it. Every other destination is either a fixture
// below or refused:
//
//   - fetch() whose method and URL exactly match FIXTURE_REQUESTS in
//     host-e2e-fixture.mjs gets canned JSON (usage endpoints, CLI version
//     lookups) or a canned Codex SSE stream (the model request). The request
//     must carry the exact fixture credential from
//     test/fixtures/host-e2e-profile, or it gets 401 and is logged with
//     fixtureAuth: false, which fails the run. A pass therefore proves the
//     plugin sent the credential it read from that profile.
//   - fetch() to any other non-loopback method or URL throws, the way an
//     offline fetch does.
//   - Any other outbound TCP connection (net.connect, node:http, node:https,
//     http2) is refused at net.Socket#connect.
//
// Every fixture hit and every refusal is appended to $HOST_E2E_SEEN as one
// JSON line. The driver asserts on that log, so a request the E2E did not
// plan for fails the run instead of silently reaching a real provider.
// Nothing in this file is a real provider credential.
import { appendFileSync } from 'node:fs'
import net from 'node:net'
import { CODEX_REPLY, FIXTURE_REQUESTS } from './host-e2e-fixture.mjs'

const seenPath = process.env.HOST_E2E_SEEN
const original = globalThis.fetch.bind(globalThis)

const LOOPBACK =
  /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\]|::ffff:127(?:\.\d{1,3}){3})$/

function record(entry) {
  if (seenPath === undefined || seenPath.length === 0) return
  appendFileSync(seenPath, `${JSON.stringify(entry)}\n`)
}

/** One Responses SSE stream that says CODEX_REPLY, in two deltas, then completes with token usage. */
function codexStream() {
  const [head, tail] = [CODEX_REPLY.slice(0, 11), CODEX_REPLY.slice(11)]
  const events = [
    {
      type: 'response.output_text.delta',
      delta: head,
      item_id: 'msg_e2e',
      content_index: 0,
    },
    {
      type: 'response.output_text.delta',
      delta: tail,
      item_id: 'msg_e2e',
      content_index: 0,
    },
    {
      type: 'response.completed',
      response: { usage: { input_tokens: 12, output_tokens: 7 } },
    },
  ]
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  )
}

/** Whether the request carries exactly the fixture credential, or none is expected. */
function fixtureAuth(fixture, headers) {
  if (fixture.credential === null) return true
  const [name, value] = fixture.credential
  return headers.get(name) === value
}

function isLoopbackUrl(url) {
  try {
    return LOOPBACK.test(new URL(url).hostname)
  } catch {
    return true // relative or data: URLs never leave the process
  }
}

/** The `model` field of a JSON request body, when there is one. */
function requestModel(init) {
  if (typeof init?.body !== 'string') return undefined
  try {
    return JSON.parse(init.body).model
  } catch {
    return undefined
  }
}

globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input)
  if (isLoopbackUrl(url)) return original(input, init)
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  )
  if (init?.headers !== undefined) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value)
    })
  }
  const method = (
    init?.method ?? (input instanceof Request ? input.method : 'GET')
  ).toUpperCase()
  const fixture = FIXTURE_REQUESTS[`${method} ${url}`]
  if (fixture !== undefined) {
    const ok = fixtureAuth(fixture, headers)
    record({
      url,
      method,
      fixtureAuth: ok,
      ...(fixture.stream ? { model: requestModel(init) } : {}),
    })
    if (!ok) return new Response('fixture credential required', { status: 401 })
    return fixture.stream ? codexStream() : Response.json(fixture.body)
  }
  record({ url, method, refused: true })
  throw new TypeError('fetch failed', {
    cause: Object.assign(new Error(`host E2E: no fixture for ${url}`), {
      code: 'EHERMETIC',
    }),
  })
}

/**
 * The connect options, however the caller passed them. net.connect() and
 * net.createConnection() hand the socket one array they already normalized,
 * which would read as an options object with no host.
 */
function connectOptions(args) {
  return Array.isArray(args[0]) ? args[0][0] : net._normalizeArgs(args)[0]
}

const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function hostE2eConnect(...args) {
  const options = connectOptions(args)
  if (options.path == null) {
    const host = options.host ?? 'localhost'
    if (!LOOPBACK.test(host)) {
      record({ host: `${host}:${options.port}`, refused: true })
      throw Object.assign(
        new Error(`host E2E: blocked connection to ${host}:${options.port}`),
        { code: 'EHERMETIC' },
      )
    }
  }
  return connect.apply(this, args)
}
