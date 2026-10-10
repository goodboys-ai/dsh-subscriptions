import { test } from 'node:test'
import assert from 'node:assert/strict'
import http2 from 'node:http2'
import type { AddressInfo } from 'node:net'
import { LlmError, MessageId, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { CursorAdapter } from 'dsh-subscriptions/cursor-transport'
import { CursorCompatAdapter, projectCursorMessages } from '../src/providers/cursor-adapter.js'
import { CURSOR_CREDENTIAL_REF, CursorAuth } from '../src/providers/cursor-auth.js'

test('Cursor adapter projects DSH 0.1.7 tool messages for the imported transport', () => {
  const callId = ToolCallId('call-1')
  const message = {
    id: MessageId('message-1'), role: 'tool' as const, toolCallId: callId,
    source: { kind: 'tool' as const, callId }, isError: false,
    content: [{ type: 'text' as const, text: 'done' }],
  }
  assert.deepEqual(projectCursorMessages([message]), [{
    ...message, role: 'user', content: [{
      type: 'tool-result', toolCallId: callId, isError: false,
      content: [{ type: 'text', text: 'done' }],
    }],
  }])
  assert.equal(message.role, 'tool', 'the request message remains unchanged')
})

test('imported Cursor transport registers a provider and discovers models with DSH 0.1.7', async () => {
  const adapter = new CursorCompatAdapter({
    auth: { accessToken: async () => 'fake-token' },
    fetchModels: async () => [{ id: 'composer-2.5', name: 'Composer 2.5' }],
  })
  assert.deepEqual(adapter.providerInfo('cursor-subscription'), {
    id: 'cursor-subscription', name: 'Cursor subscription',
  })
  const models = await adapter.listModels('cursor-subscription')
  assert.deepEqual(models.map(model => model.id), ['composer-2.5'])
  const resolved = await adapter.resolveModel('cursor-subscription', 'composer-2.5')
  assert.equal(resolved.provider, 'cursor-subscription')
  assert.equal(resolved.id, 'composer-2.5')
})

test('Cursor discovery does not cache or advertise a default list before login', async () => {
  let signedIn = false
  const adapter = new CursorCompatAdapter({
    auth: { accessToken: async () => {
      if (!signedIn) throw new Error('Cursor is not signed in')
      return 'fake-token'
    } },
    fetchModels: async () => [{ id: 'composer-2.5', name: 'Composer 2.5' }],
  })
  await assert.rejects(adapter.listModels('cursor-subscription'), /not signed in/)
  signedIn = true
  assert.deepEqual((await adapter.listModels('cursor-subscription')).map(model => model.id), ['composer-2.5'])
  adapter.invalidateModels()
  assert.deepEqual((await adapter.listModelsForRpc({ force: true })).map(model => model.id), ['composer-2.5'])
})

test('Cursor visibility changes the picker but preserves discovery and existing model resolution', async () => {
  let visible: string[] | undefined = ['composer-2.5']
  const adapter = new CursorCompatAdapter({
    auth: { accessToken: async () => 'fake-token' },
    fetchModels: async () => [
      { id: 'composer-2.5', name: 'Composer 2.5' },
      { id: 'grok-code', name: 'Grok Code' },
    ],
    visibleModels: () => visible,
  })
  assert.deepEqual((await adapter.listModels('cursor-subscription')).map(model => model.id), ['composer-2.5'])
  assert.equal((await adapter.listModelsForRpc()).length, 2, 'Manage can restore a hidden model')
  assert.equal((await adapter.resolveModel('cursor-subscription', 'grok-code')).id, 'grok-code')
  visible = undefined
  assert.equal((await adapter.listModels('cursor-subscription')).length, 2, 'automatic mode shows new models')
  visible = []
  assert.deepEqual(await adapter.listModels('cursor-subscription'), [])
})

test('Cursor transport accepts a DSH 0.1.7 request and completes a mocked run', async () => {
  class FakeRun {
    finished = false
    stream = { destroyed: false }
    responseContentType = 'application/connect+proto'
    frames = {
      next: async () => this.taken++ === 0
        ? { flags: 0b00000010, payload: Buffer.from('{}') }
        : undefined,
    }
    private taken = 0
    async start() {}
    writeMessage() { return true }
    async waitForResponse() { return 200 }
    startHeartbeat() {}
    abort() { this.close() }
    close() { this.finished = true; this.stream.destroyed = true }
  }
  const auth = new CursorAuth({
    async resolve(ref) {
      assert.equal(ref, CURSOR_CREDENTIAL_REF)
      return { value: JSON.stringify({ type: 'oauth', access: 'fake-token', refresh: 'refresh-token', expires: Date.now() + 3_600_000 }) }
    },
    async set() { throw new Error('unexpected credential write') },
    async unset() { throw new Error('unexpected credential removal') },
  })
  const adapter = new CursorCompatAdapter({
    auth,
    createAgentRun: () => new FakeRun(),
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'cursor-subscription', model: 'composer-2',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    signal: new AbortController().signal,
  })) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

// ---------------------------------------------------------------------------
// Cursor generation: canned createAgentRun injection.
//
// The fake run below yields real agent.v1 server frames — protobuf-encoded
// with a minimal test-local writer whose field numbers are literals read
// from the vendored decoders. A wrong number decodes to "unknown" and the
// test fails, so the wire format is pinned independently of the transport.
// What is NOT covered stays honest: HTTP/2 framing, TLS, and the real
// Cursor server remain the manual pre-release canary's job
// (see docs/testing.md).
// ---------------------------------------------------------------------------

/** Minimal protobuf writer: enough for the server-message shapes faked here. */
function pbVarint(value: number): number[] {
  const out: number[] = []
  while (value > 0x7f) { out.push((value & 0x7f) | 0x80); value >>>= 7 }
  out.push(value)
  return out
}
/** Length-delimited field. */
function pbField(fieldNo: number, payload: Uint8Array): number[] {
  return [...pbVarint((fieldNo << 3) | 2), ...pbVarint(payload.length), ...payload]
}
/** Varint field. */
function pbVarintField(fieldNo: number, value: number): number[] {
  return [...pbVarint((fieldNo << 3) | 0), ...pbVarint(value)]
}
const pbBytes = (...fields: number[][]): Uint8Array => new Uint8Array(fields.flat())
const pbText = (text: string): Uint8Array => new TextEncoder().encode(text)

/**
 * Field numbers from the vendored decoders in vendor/cursor/index.js:
 * AgentServerMessage.interaction_update = 1;
 * InteractionUpdate.text_delta = 1, token_delta = 8, turn_ended = 14;
 * TextDeltaUpdate.text = 1; TokenDeltaUpdate.tokens = 1.
 */
const interactionTextDelta = (text: string): Uint8Array =>
  pbBytes(pbField(1, pbBytes(pbField(1, pbBytes(pbField(1, pbText(text)))))))
const interactionTokenDelta = (tokens: number): Uint8Array =>
  pbBytes(pbField(1, pbBytes(pbField(8, pbBytes(pbVarintField(1, tokens))))))
const interactionTurnEnded = (): Uint8Array =>
  pbBytes(pbField(1, pbBytes(pbField(14, new Uint8Array(0)))))

interface CannedFrame { flags: number; payload: Uint8Array }
const dataFrame = (payload: Uint8Array): CannedFrame => ({ flags: 0, payload })

/** Top-level length-delimited fields of one protobuf message. */
function pbMessageFields(bytes: Uint8Array): Map<number, Uint8Array[]> {
  const fields = new Map<number, Uint8Array[]>()
  let pos = 0
  const readVarint = (): number => {
    let value = 0
    let shift = 0
    for (;;) {
      const byte = bytes[pos++]
      value |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return value
      shift += 7
    }
  }
  while (pos < bytes.length) {
    const tag = readVarint()
    const fieldNo = tag >>> 3
    const wireType = tag & 7
    if (wireType === 0) { readVarint(); continue }
    if (wireType === 2) {
      const length = readVarint()
      const value = bytes.slice(pos, pos + length)
      pos += length
      const list = fields.get(fieldNo) ?? []
      list.push(value)
      fields.set(fieldNo, list)
      continue
    }
    if (wireType === 1) { pos += 8; continue }
    if (wireType === 5) { pos += 4; continue }
    throw new Error(`unexpected wire type ${wireType} in test decoder`)
  }
  return fields
}

/**
 * Extract the model id from a captured request payload:
 * AgentClientMessage.run_request = 1, RunRequest.model_details = 3,
 * ModelDetails.model_id = 1 (field numbers from the vendored builders).
 */
function requestModelId(payload: Uint8Array): string {
  const runRequest = pbMessageFields(payload).get(1)?.[0]
  assert.ok(runRequest, 'the request carries a run_request')
  const modelDetails = pbMessageFields(runRequest).get(3)?.[0]
  assert.ok(modelDetails, 'the run_request carries model_details')
  const modelId = pbMessageFields(modelDetails).get(1)?.[0]
  assert.ok(modelId, 'the model_details carry a model id')
  return new TextDecoder().decode(modelId)
}

interface CannedRunState {
  started: boolean
  written: Uint8Array[]
  closed: boolean
  aborts: unknown[]
}

/** A fake AgentRun: the real adapter drives it, but no socket ever exists. */
function cannedRun(frames: CannedFrame[], options: {
  status?: number
  contentType?: string
  trailers?: Record<string, string>
  frameError?: unknown
} = {}) {
  const state: CannedRunState = { started: false, written: [], closed: false, aborts: [] }
  const queue = [...frames]
  const run = {
    responseContentType: options.contentType ?? 'application/connect+proto',
    trailers: options.trailers,
    finished: false,
    frames: {
      next: async (): Promise<CannedFrame | undefined> => {
        if (queue.length === 0 && options.frameError !== undefined) throw options.frameError
        return queue.shift()
      },
      pause() {},
      finish() {},
      resume() {},
    },
    async start() { state.started = true },
    writeMessage(bytes: Uint8Array) { state.written.push(bytes); return true },
    async waitForResponse() { return options.status ?? 200 },
    startHeartbeat() {},
    close() { state.closed = true },
    abort(error: unknown) { state.aborts.push(error) },
  }
  return { run, state }
}

const fakeCursorAuth = () => new CursorAuth({
  async resolve(ref) {
    assert.equal(ref, CURSOR_CREDENTIAL_REF)
    return { value: JSON.stringify({ type: 'oauth', access: 'fake-token', refresh: 'refresh-token', expires: Date.now() + 3_600_000 }) }
  },
  async set() { throw new Error('unexpected credential write') },
  async unset() { throw new Error('unexpected credential removal') },
})

test('Cursor generation translates server frames into DSH chunks', async () => {
  const { run, state } = cannedRun([
    dataFrame(interactionTextDelta('Hello, ')),
    dataFrame(interactionTextDelta('world!')),
    dataFrame(interactionTokenDelta(5)),
    dataFrame(interactionTurnEnded()),
  ])
  const adapter = new CursorCompatAdapter({
    auth: fakeCursorAuth(),
    createAgentRun: () => run,
  })
  const chunks: Array<{ type: string }> = []
  for await (const chunk of adapter.stream({
    provider: 'cursor-subscription', model: 'composer-2',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hi' }] }],
  })) chunks.push(chunk as { type: string })

  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === 'text-delta'),
    [
      { type: 'text-delta', index: 0, text: 'Hello, ' },
      { type: 'text-delta', index: 0, text: 'world!' },
    ],
  )
  assert.deepEqual(
    chunks.find((chunk) => chunk.type === 'usage'),
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 5 } },
  )
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  // The retired composer-2 selection is remapped before the request is built.
  assert.equal(state.written.length, 1, 'exactly one request was written to the run')
  assert.equal(requestModelId(state.written[0]), 'composer-2.5')
  assert.ok(state.started, 'the run was started')
  assert.ok(state.closed, 'the run is closed after the stream ends')
})

test('Cursor generation sends the projected tool messages, not the raw DSH ones', async () => {
  const { run, state } = cannedRun([
    dataFrame(interactionTextDelta('done')),
    dataFrame(interactionTurnEnded()),
  ])
  const adapter = new CursorCompatAdapter({
    auth: fakeCursorAuth(),
    createAgentRun: () => run,
  })
  const callId = ToolCallId('call-9')
  const chunks: Array<{ type: string }> = []
  for await (const chunk of adapter.stream({
    provider: 'cursor-subscription', model: 'composer-2.5',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'run it' }] },
      {
        id: MessageId('message-9'), role: 'tool', toolCallId: callId,
        source: { kind: 'tool', callId }, isError: false,
        content: [{ type: 'text', text: 'exit 0' }],
      },
    ],
  })) chunks.push(chunk as { type: string })

  // coldStartLabel() tags a message "TOOL RESULT" only when its content holds
  // a tool-result block, which is what projectCursorMessages() rewrites the
  // DSH tool message into; an unprojected tool-role message would be labeled
  // "USER" instead. Assert the bracketed label, not the bare substring: the
  // cold-start preamble always mentions TOOL RESULT ("...TOOL RESULT entries
  // provide context only"), so the bare substring would pass even with the
  // projection removed.
  const wire = Buffer.from(state.written[0]).toString('utf8')
  assert.ok(wire.includes('[TOOL RESULT]'), 'the projected tool-result label reached the request')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

function comparableRunState(state: CannedRunState) {
  // Each cold start generates fresh UUIDs; normalize only those ASCII bytes
  // so all other request bytes and lifecycle effects remain comparable.
  return { ...state, written: state.written.map(bytes => Buffer.from(bytes).toString('latin1')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')) }
}

const providerText = 'customer-input SHORT_SECRET!'
const providerContentType = 'text/customer-content-type-SECRET!'
const providerTrailer = `connection customer-trailer TRAILER_SECRET! ${providerText}`
const omissionMarker = '[provider response text omitted]'
const endErrorFrame = (error: unknown): CannedFrame => ({
  flags: 0b00000010, payload: pbText(JSON.stringify({ error })),
})

async function collectCursorChunks(adapter: CursorAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'cursor-subscription', model: 'composer-2.5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })) chunks.push(chunk)
  return chunks
}

function errorFailure(chunks: StreamChunk[]) {
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error')
  return finish.reason.failure
}

const failureCases = [
  {
    name: 'terminal debug title and detail', code: 'AUTH', sequence: ['text-delta', 'finish'],
    // AUTH comes from raw debug.error, not the displayed title/detail. The
    // content-type parameter and trailer remain raw inside the fake run.
    makeRun: () => cannedRun([
      dataFrame(interactionTextDelta('partial answer')),
      endErrorFrame({ code: 'resource_exhausted', message: providerText, details: [{ debug: {
        error: 'invalid token', details: { title: providerText, detail: 'customer-detail DETAIL_SECRET!' },
      } }] }),
    ], { contentType: `application/connect+proto; ${providerContentType}`, trailers: {
      'grpc-status': '13', 'grpc-message': providerTrailer,
    } }),
    rawMessage: `${providerText} customer-detail DETAIL_SECRET!`,
  },
  {
    name: 'terminal error.message fallback', code: 'RATE_LIMIT', sequence: ['finish'],
    makeRun: () => cannedRun([endErrorFrame({ code: 'resource_exhausted', message: providerText })]),
    rawMessage: `Cursor agent error resource_exhausted: ${providerText}`,
  },
  {
    name: 'terminal debug.error fallback', code: 'TIMEOUT', sequence: ['finish'],
    makeRun: () => cannedRun([endErrorFrame({ code: 'unknown', details: [{ debug: { error: `timeout ${providerText}` } }] })]),
    rawMessage: `Cursor: timeout ${providerText}`,
  },
  {
    name: 'terminal error.code fallback', code: 'SERVER', sequence: ['finish'],
    makeRun: () => cannedRun([endErrorFrame({ code: `internal ${providerText}` })]),
    rawMessage: `Cursor agent error internal ${providerText}`,
  },
  {
    name: 'HTTP 200 with unexpected content type', code: 'CURSOR_PROTOCOL', sequence: ['finish'],
    makeRun: () => cannedRun([], { contentType: providerContentType }),
    rawMessage: `Cursor agent returned an unexpected content type: ${providerContentType}`,
  },
  {
    name: 'gRPC message trailer', code: 'TRANSPORT', sequence: ['usage', 'finish'],
    makeRun: () => cannedRun([], { trailers: { 'grpc-status': '13', 'grpc-message': providerTrailer } }),
    rawMessage: providerTrailer,
  },
  {
    name: 'frame reader Error.message', code: 'INVALID_REQUEST', sequence: ['text-delta', 'finish'],
    makeRun: () => cannedRun([dataFrame(interactionTextDelta('partial answer'))], {
      frameError: new Error(`invalid request ${providerText}`),
    }),
    rawMessage: `invalid request ${providerText}`,
  },
  {
    name: 'caught LlmError.message', code: 'CURSOR_PROTOCOL', sequence: ['finish'],
    makeRun: () => cannedRun([], { frameError: new LlmError(providerText, 'CURSOR_PROTOCOL') }),
    rawMessage: providerText,
  },
  {
    name: 'caught non-Error text', code: 'CURSOR_ERROR', sequence: ['finish'],
    makeRun: () => cannedRun([], { frameError: providerText }),
    rawMessage: providerText,
  },
]

for (const scenario of failureCases) {
  test(`Cursor failure boundary omits ${scenario.name} without changing classification or events`, async () => {
    const rawRun = scenario.makeRun()
    const safeRun = scenario.makeRun()
    const rawChunks = await collectCursorChunks(new CursorAdapter({
      auth: fakeCursorAuth(), createAgentRun: () => rawRun.run,
    }))
    const safeChunks = await collectCursorChunks(new CursorCompatAdapter({
      auth: fakeCursorAuth(), createAgentRun: () => safeRun.run,
    }))
    const rawFailure = errorFailure(rawChunks)
    const safeFailure = errorFailure(safeChunks)
    assert.equal(rawFailure.message, scenario.rawMessage, 'the fixture exercises the actual vendored error path')
    assert.equal(rawFailure.code, scenario.code)
    assert.equal(safeFailure.code, rawFailure.code, 'classification must still use the raw provider values')
    assert.deepEqual(safeChunks.map(chunk => chunk.type), scenario.sequence)
    assert.deepEqual(comparableRunState(safeRun.state), comparableRunState(rawRun.state), 'run lifecycle and request framing stay unchanged')
    for (const text of [providerText, providerContentType, providerTrailer, 'DETAIL_SECRET!']) {
      assert.ok(!safeFailure.message.includes(text), `caller received provider text: ${safeFailure.message}`)
    }
    assert.equal(safeFailure.message, `${scenario.code} ${omissionMarker}`)
    // Compare every event and field, permitting only failure.message to differ.
    assert.deepEqual(safeChunks, rawChunks.map(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error'
      ? { ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure, message: safeFailure.message } } }
      : chunk))
  })
}

test('Cursor failure boundary preserves HTTP retries and successful completion', async () => {
  async function exercise(Adapter: typeof CursorAdapter) {
    const runs = [
      cannedRun([], { status: 503, contentType: providerContentType }),
      cannedRun([dataFrame(interactionTextDelta('recovered')), dataFrame(interactionTurnEnded())]),
    ]
    let attempts = 0
    const sleeps: number[] = []
    const adapter = new Adapter({ auth: fakeCursorAuth(), createAgentRun: () => runs[attempts++].run })
    // Runtime injection already supported by the bundle; its .d.ts omits settings.
    Object.assign(adapter, {
      settings: () => ({ retryCount: 1, retryIntervalMs: 7, retryHttpStatusCodes: [503] }),
      sleep: async (ms: number) => { sleeps.push(ms) },
    })
    return { chunks: await collectCursorChunks(adapter), attempts, sleeps, states: runs.map(run => comparableRunState(run.state)) }
  }
  const raw = await exercise(CursorAdapter)
  const safe = await exercise(CursorCompatAdapter)
  assert.equal(safe.attempts, 2)
  assert.deepEqual(safe.sleeps, [7])
  assert.deepEqual(safe.chunks.map(chunk => chunk.type), ['text-delta', 'usage', 'finish'])
  assert.deepEqual(safe.chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.deepEqual(safe, raw)
})

test('Cursor failure boundary preserves caller aborts', async () => {
  async function exercise(Adapter: typeof CursorAdapter) {
    const { run, state } = cannedRun([])
    const controller = new AbortController()
    controller.abort(new Error(providerText))
    const chunks: StreamChunk[] = []
    const adapter = new Adapter({ auth: fakeCursorAuth(), createAgentRun: () => run })
    for await (const chunk of adapter.stream({
      provider: 'cursor-subscription', model: 'composer-2.5', messages: [],
      signal: controller.signal, stop: ['unsupported'],
    })) chunks.push(chunk)
    return { chunks, state }
  }
  const raw = await exercise(CursorAdapter)
  const safe = await exercise(CursorCompatAdapter)
  assert.deepEqual(safe.chunks, [{
    type: 'finish', reason: { kind: 'aborted', failure: { message: 'Cursor request aborted by caller', code: 'ABORTED' } },
  }])
  assert.deepEqual(safe, raw)
})

// ---------------------------------------------------------------------------
// Local failures keep their own text.
//
// Every case above makes the *vendor stream* fail, so none of them would notice
// the boundary rewriting a failure that never touched provider text. These drive
// the real CursorAuth and the real vendor validation through
// CursorCompatAdapter.stream and compare against the unwrapped CursorAdapter.
// What stays untested: a vendor-raised plain Error (idle timeout, closed
// bridge) is replaced by design, because it cannot be told from a
// provider-derived one at this boundary.
// ---------------------------------------------------------------------------

function authWith(value: string | undefined) {
  return new CursorAuth({
    async resolve() { return value === undefined ? undefined : { value } },
    async set() { throw new Error('unexpected credential write') },
    async unset() { throw new Error('unexpected credential removal') },
  })
}

const credential = (overrides: Record<string, unknown>) => JSON.stringify({
  type: 'oauth', access: 'fake-token', refresh: 'refresh-token', expires: Date.now() + 3_600_000, ...overrides,
})

const localFailureCases = [
  {
    name: 'not signed in', message: 'Cursor is not signed in',
    makeAuth: () => authWith(undefined), extra: {},
  },
  {
    name: 'sign-in expired', message: 'Cursor sign-in needs to be renewed',
    makeAuth: () => authWith(credential({ expires: 0, refresh: '' })), extra: {},
  },
  {
    name: 'a malformed stored credential', message: 'Cursor stored credential: invalid JSON: [provider response body omitted]',
    makeAuth: () => authWith('not json'), extra: {},
  },
  {
    name: 'an unsupported option', message: 'cursor-subscription does not support GenerateOptions.stop',
    makeAuth: () => fakeCursorAuth(), extra: { stop: ['x'] },
  },
]

for (const scenario of localFailureCases) {
  test(`Cursor local failure keeps its own message and code: ${scenario.name}`, async () => {
    async function exercise(Adapter: typeof CursorAdapter) {
      const { run, state } = cannedRun([])
      const adapter = new Adapter({ auth: scenario.makeAuth(), createAgentRun: () => run })
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: 'cursor-subscription', model: 'composer-2.5',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        ...scenario.extra,
      })) chunks.push(chunk)
      return { chunks, state }
    }
    const raw = await exercise(CursorAdapter)
    const wrapped = await exercise(CursorCompatAdapter)
    const failure = errorFailure(wrapped.chunks)
    assert.equal(failure.message, scenario.message)
    assert.ok(!failure.message.includes(omissionMarker), 'no provider text was omitted, so none may be claimed')
    assert.deepEqual(wrapped, raw, 'a local failure passes through the boundary byte for byte')
  })
}

test('Cursor token-refresh failure keeps its status text', async () => {
  const auth = new CursorAuth({
    async resolve() { return { value: credential({ expires: Date.now() + 1_000 }) } },
    async set() { throw new Error('unexpected credential write') },
    async unset() { throw new Error('unexpected credential removal') },
  }, async () => new Response(providerText, { status: 503 }))
  const adapter = new CursorCompatAdapter({ auth, createAgentRun: () => cannedRun([]).run })
  const failure = errorFailure(await collectCursorChunks(adapter))
  assert.equal(failure.message, 'Cursor token refresh failed (HTTP 503)')
})

test('Cursor local-failure carve-out does not leak to a later vendor failure on the same adapter', async () => {
  // The carve-out remembers local messages per adapter. A vendor-stream failure
  // that follows a local one must still be replaced, or the memory would become
  // a bypass.
  let signedIn = false
  const auth = { async accessToken() {
    if (!signedIn) { signedIn = true; throw new Error('Cursor is not signed in') }
    return 'fake-token'
  } }
  const adapter = new CursorCompatAdapter({
    auth, createAgentRun: () => cannedRun([endErrorFrame({ code: 'resource_exhausted', message: providerText })]).run,
  })
  assert.equal(errorFailure(await collectCursorChunks(adapter)).message, 'Cursor is not signed in')
  const vendor = errorFailure(await collectCursorChunks(adapter))
  assert.equal(vendor.message, `${vendor.code} ${omissionMarker}`)
  assert.ok(!vendor.message.includes(providerText))
})

test('Cursor unsupported image input keeps its own message and code', async () => {
  const adapter = new CursorCompatAdapter({ auth: fakeCursorAuth(), createAgentRun: () => cannedRun([]).run })
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'cursor-subscription', model: 'composer-2.5',
    messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] }],
  } as never)) chunks.push(chunk)
  const failure = errorFailure(chunks)
  assert.equal(failure.code, 'UNSUPPORTED_CONTENT')
  assert.equal(failure.message, 'Cursor image input requires the durable attachment service')
})

// ---------------------------------------------------------------------------
// Vendor-raised local failures keep their text.
//
// The vendor raises these as plain errors with fixed literals, or as socket-layer
// errors; none quotes response text. Each case below runs the REAL vendored
// AgentRun against a loopback HTTP/2 server (or a closed loopback port) where
// the failure can be produced that way, and otherwise a fake run, and first
// asserts that the unwrapped CursorAdapter produces exactly the expected
// message, so the fixture exercises the vendor's own path.
// ---------------------------------------------------------------------------

type VendorModule = { AgentRun: new (access: string, options?: { baseUrl?: string }) => unknown }
const loadVendor = async (): Promise<VendorModule> => await import('dsh-subscriptions/cursor-transport') as unknown as VendorModule

async function withH2Server<T>(
  onStream: ((stream: http2.ServerHttp2Stream) => void) | undefined,
  use: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http2.createServer()
  const sessions = new Set<http2.ServerHttp2Session>()
  server.on('session', session => { sessions.add(session); session.on('error', () => {}) })
  server.on('stream', stream => { stream.on('error', () => {}); onStream?.(stream) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    return await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    for (const session of sessions) session.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}

const connectHeaders = { ':status': 200, 'content-type': 'application/connect+proto' }

/** Run one request through the unwrapped and the wrapped adapter against fresh runs. */
async function bothAdapters(
  makeOptions: () => Partial<ConstructorParameters<typeof CursorAdapter>[0]> & Record<string, unknown>,
) {
  const raw = errorFailure(await collectCursorChunks(new CursorAdapter({ auth: fakeCursorAuth(), ...makeOptions() } as never)))
  const wrapped = errorFailure(await collectCursorChunks(new CursorCompatAdapter({ auth: fakeCursorAuth(), ...makeOptions() } as never)))
  return { raw, wrapped }
}

interface LocalVendorCase {
  name: string
  code: string
  message: string
  handler?: (stream: http2.ServerHttp2Stream) => void
  options?: Record<string, unknown>
}
const localVendorCases: LocalVendorCase[] = [
  {
    name: 'HTTP 429 status', code: 'RATE_LIMIT', message: 'Cursor agent returned HTTP 429',
    handler: stream => { stream.respond({ ':status': 429 }); stream.end(providerText) },
  },
  {
    name: 'HTTP 401 status', code: 'AUTH', message: 'Cursor agent returned HTTP 401',
    handler: stream => { stream.respond({ ':status': 401, 'content-type': 'text/plain' }); stream.end(providerText) },
  },
  {
    name: 'HTTP response timeout', code: 'TIMEOUT', message: 'Cursor HTTP response timeout',
    handler: () => {}, options: { idleTimeoutMs: 50 },
  },
  {
    name: 'stream closed before response', code: 'CURSOR_ERROR', message: 'Cursor HTTP stream closed before response',
    handler: stream => { stream.session?.destroy() },
  },
  {
    name: 'stream idle timeout', code: 'TIMEOUT', message: 'Cursor stream idle timeout',
    handler: stream => { stream.respond(connectHeaders) },
    options: { idleTimeoutMs: 60, idleCheckIntervalMs: 10, hangTracePath: '/dev/null' },
  },
  {
    name: 'stream progress timeout', code: 'TIMEOUT', message: 'Cursor stream progress timeout: no content for 60ms',
    handler: stream => { stream.respond(connectHeaders) },
    options: { idleTimeoutMs: 600_000, progressTimeoutMs: 60, idleCheckIntervalMs: 10, hangTracePath: '/dev/null' },
  },
]

for (const scenario of localVendorCases) {
  test(`Cursor vendor-local failure keeps its own message and code: ${scenario.name}`, async () => {
    const { raw, wrapped } = await withH2Server(scenario.handler, async baseUrl => {
      // createAgentRun must return synchronously, so load the class first.
      const VendorRun = (await loadVendor()).AgentRun
      return bothAdapters(() => ({ ...scenario.options, createAgentRun: (access: string) => new VendorRun(access, { baseUrl }) }))
    })
    assert.equal(raw.message, scenario.message, 'the fixture exercises the actual vendored error path')
    assert.equal(raw.code, scenario.code)
    assert.deepEqual(wrapped, raw, 'a local failure passes through the boundary byte for byte')
    assert.ok(!wrapped.message.includes(omissionMarker))
  })
}

test('Cursor vendor-local failure keeps its own message and code: bridge closed before the request', async () => {
  const make = () => ({ createAgentRun: () => {
    const { run } = cannedRun([])
    run.writeMessage = () => false
    return run
  } })
  const { raw, wrapped } = await bothAdapters(make)
  assert.equal(raw.message, 'Cursor agent bridge closed before accepting the request')
  assert.deepEqual(wrapped, raw)
})

test('Cursor vendor-local failure keeps its own message and code: unreadable compressed frame', async () => {
  const make = () => ({ createAgentRun: () => cannedRun([], {
    frameError: new Error('Cursor sent an unreadable compressed frame', { cause: new Error(providerText) }),
  }).run })
  const { raw, wrapped } = await bothAdapters(make)
  assert.equal(raw.message, 'Cursor sent an unreadable compressed frame')
  assert.deepEqual(wrapped, raw)
})

test('Cursor vendor-local failure keeps its own message and code: bridge closed before the tool result', async () => {
  const { run } = toolBridgeRun()
  const adapter = new CursorCompatAdapter({ auth: fakeCursorAuth(), createAgentRun: () => run })
  await collectToolStep(adapter, [])
  run.writeMessage = () => false
  const failure = errorFailure(await collectToolStep(adapter, [toolResultMessage]))
  assert.equal(failure.message, 'Cursor tool continuation bridge closed before accepting the result')
  assert.ok(!failure.message.includes(omissionMarker))
})

test('Cursor transport failure keeps its message when the socket layer refused the connection', async () => {
  // Port 1 on loopback refuses the connection; the hermetic guard allows
  // loopback. This is the offline / daemon-down case, measured through the real
  // vendored AgentRun and Node's http2 client.
  const VendorRun = (await loadVendor()).AgentRun
  const { raw, wrapped } = await bothAdapters(() => ({
    createAgentRun: (access: string) => new VendorRun(access, { baseUrl: 'http://127.0.0.1:1' }),
  }))
  assert.match(raw.message, /ECONNREFUSED/, 'the fixture is a real refused connection')
  assert.equal(raw.code, 'TRANSPORT')
  assert.deepEqual(wrapped, raw)
  assert.ok(!wrapped.message.includes(omissionMarker))
})

test('Cursor transport failure keeps its message for other socket-layer errnos, on the error or its cause', async () => {
  for (const [code, makeError] of [
    ['ENOTFOUND', () => Object.assign(new Error('getaddrinfo ENOTFOUND api2.cursor.sh'), { code: 'ENOTFOUND' })],
    ['ECONNRESET on the cause', () => new Error('The pending stream has been canceled (caused by: read ECONNRESET)', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    })],
  ] as const) {
    const { run } = cannedRun([], { frameError: makeError() })
    const failure = errorFailure(await collectCursorChunks(new CursorCompatAdapter({ auth: fakeCursorAuth(), createAgentRun: () => run })))
    assert.ok(!failure.message.includes(omissionMarker), `${code} was relabelled: ${failure.message}`)
  }
})

test('Cursor TRANSPORT code alone does not keep a message: provider text and errno-less errors are still replaced', async () => {
  // The vendor derives TRANSPORT from message text, so provider text can carry
  // it. An error that merely looks like a network failure, with no errno from
  // the socket layer, must still be replaced.
  for (const frameError of [
    new Error(`connection reset by ${providerText}`),
    Object.assign(new Error(`socket hang up ${providerText}`), { code: 'ERR_HTTP2_ERROR' }),
    Object.assign(new Error(`fetch failed ${providerText}`), { code: providerText }),
  ]) {
    const { run } = cannedRun([], { frameError })
    const failure = errorFailure(await collectCursorChunks(new CursorCompatAdapter({ auth: fakeCursorAuth(), createAgentRun: () => run })))
    assert.equal(failure.code, 'TRANSPORT')
    assert.equal(failure.message, `TRANSPORT ${omissionMarker}`)
  }
})

test('Cursor errno on a non-Error value is not trusted', async () => {
  // The vendor displays String(value) for a thrown non-Error, so give it a value
  // that stringifies to provider text and carries a socket-looking code.
  const thrown = { code: 'ECONNREFUSED', toString: () => providerText }
  const { run } = cannedRun([], { frameError: thrown })
  const raw = errorFailure(await collectCursorChunks(new CursorAdapter({ auth: fakeCursorAuth(), createAgentRun: () => cannedRun([], { frameError: thrown }).run })))
  assert.equal(raw.message, providerText, 'the fixture shows provider text when unwrapped')
  const failure = errorFailure(await collectCursorChunks(new CursorCompatAdapter({ auth: fakeCursorAuth(), createAgentRun: () => run })))
  assert.ok(!failure.message.includes(providerText))
  assert.equal(failure.message, `${failure.code} ${omissionMarker}`)
})

test('Cursor vendor-local literal match is exact: a provider message that only contains one is replaced', async () => {
  for (const message of [
    `Cursor agent returned HTTP 429 ${providerText}`,
    `${providerText} Cursor HTTP response timeout`,
    'Cursor agent returned HTTP 4xx',
    'Cursor stream progress timeout: no content for 60ms and more',
  ]) {
    const { run } = cannedRun([], { frameError: new Error(message) })
    const failure = errorFailure(await collectCursorChunks(new CursorCompatAdapter({ auth: fakeCursorAuth(), createAgentRun: () => run })))
    assert.equal(failure.message, `${failure.code} ${omissionMarker}`, message)
  }
})

test('Cursor host attachment read failure keeps its own message', async () => {
  const readError = 'attachment a1 is no longer on disk'
  const resolveAttachments = () => ({ readImage: async () => { throw new Error(readError) } })
  const make = () => ({ resolveAttachments, createAgentRun: () => cannedRun([]).run })
  async function exercise(Adapter: typeof CursorAdapter) {
    const chunks: StreamChunk[] = []
    for await (const chunk of new Adapter({ auth: fakeCursorAuth(), ...make() } as never).stream({
      provider: 'cursor-subscription', model: 'composer-2.5',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] }],
    } as never)) chunks.push(chunk)
    return errorFailure(chunks)
  }
  const raw = await exercise(CursorAdapter)
  const wrapped = await exercise(CursorCompatAdapter)
  assert.equal(raw.message, readError)
  assert.deepEqual(wrapped, raw)
})

test('Cursor attachment wrapper hands the vendor a store whose reads still work', async () => {
  // The real store reads through `this`; the wrapper must keep that binding.
  const store = {
    root: 'mem',
    async readImage(this: { root: string }, ref: { attachmentId: string }) {
      assert.equal(this.root, 'mem', 'readImage was called on the store')
      return { ref: { ...ref, mediaType: 'image/png' }, data: new Uint8Array([1, 2, 3]) }
    },
  }
  const resolveAttachments = () => store
  const { run, state } = cannedRun([dataFrame(interactionTurnEnded())])
  const chunks: StreamChunk[] = []
  for await (const chunk of new CursorCompatAdapter({ auth: fakeCursorAuth(), resolveAttachments, createAgentRun: () => run }).stream({
    provider: 'cursor-subscription', model: 'composer-2.5',
    messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] }],
  } as never)) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.equal(state.written.length, 1)
})

// --- TOOL_LIMIT -------------------------------------------------------------

const toolCallId = ToolCallId('call-limit')
const bashTool = { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: {} } }
// The vendor's own input form (a user message with a tool-result block), which
// the unwrapped CursorAdapter also understands, so both can resume the bridge.
const toolResultMessage = {
  role: 'user' as const,
  content: [{ type: 'tool-result' as const, toolCallId, isError: false, content: [{ type: 'text' as const, text: 'ok' }] }],
}

/** ExecServerMessage { id=1, exec_id=15, mcp_args=11 { name=1, tool_call_id=3, tool_name=5 } } inside AgentServerMessage.exec_server_message=2. */
const mcpExecFrame = (): CannedFrame => dataFrame(pbBytes(pbField(2, pbBytes(
  pbVarintField(1, 1),
  pbField(15, pbText('exec-1')),
  pbField(11, pbBytes(pbField(1, pbText('bash')), pbField(3, pbText(toolCallId)), pbField(5, pbText('bash')))),
))))

/** A run whose frame queue the test refills between DSH steps, as a live bridge does. */
function toolBridgeRun() {
  const queue: CannedFrame[] = [mcpExecFrame()]
  const { run, state } = cannedRun([])
  run.frames.next = async () => queue.shift()
  return { run, state, queue }
}

async function collectToolStep(adapter: CursorAdapter, extra: unknown[]): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'cursor-subscription', model: 'composer-2.5', sessionId: 'tool-limit-session',
    tools: [bashTool],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }, ...extra],
  } as never)) chunks.push(chunk)
  return chunks
}

test('Cursor TOOL_LIMIT failure keeps its own message and code', async () => {
  async function exercise(Adapter: typeof CursorAdapter) {
    const { run, queue } = toolBridgeRun()
    const adapter = new Adapter({ auth: fakeCursorAuth(), createAgentRun: () => run } as never)
    Object.assign(adapter, { settings: () => ({ maxToolRounds: 1 }) })
    const first = await collectToolStep(adapter, [])
    assert.deepEqual(first.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } }, 'round 1 is within the limit')
    queue.push(mcpExecFrame())
    return errorFailure(await collectToolStep(adapter, [toolResultMessage]))
  }
  const raw = await exercise(CursorAdapter)
  const wrapped = await exercise(CursorCompatAdapter)
  assert.equal(raw.code, 'TOOL_LIMIT')
  assert.match(raw.message, /^Cursor tool-call safety limit reached after 1 rounds\./)
  assert.deepEqual(wrapped, raw, 'the limit message is a local literal and must not be relabelled')
})

test('Cursor HTTP status failure keeps its literal even when the response carries provider content type and trailers', async () => {
  // Formerly asserted as "replaced". The message is `Cursor agent returned HTTP
  // <status>`: the content type and trailers feed no part of it, so there is no
  // provider text to omit, and omitting it hid a local fact (rate limit, auth).
  const make = () => ({ createAgentRun: () => cannedRun([], { status: 429, contentType: providerContentType, trailers: {
    'grpc-status': '13', 'grpc-message': providerTrailer,
  } }).run })
  const { raw, wrapped } = await bothAdapters(make)
  assert.equal(raw.message, 'Cursor agent returned HTTP 429')
  assert.equal(raw.code, 'RATE_LIMIT')
  assert.deepEqual(wrapped, raw)
  for (const text of [providerText, providerContentType, providerTrailer]) assert.ok(!wrapped.message.includes(text))
})

test('Cursor vendor-local failure keeps its own message and code: invalid Cursor setting', async () => {
  async function exercise(Adapter: typeof CursorAdapter) {
    const adapter = new Adapter({ auth: fakeCursorAuth(), createAgentRun: () => cannedRun([]).run } as never)
    Object.assign(adapter, { settings: () => ({ retryCount: 99 }) })
    return errorFailure(await collectCursorChunks(adapter))
  }
  const raw = await exercise(CursorAdapter)
  assert.equal(raw.message, 'cursor-subscription: retryCount must be an integer between 0 and 10')
  assert.deepEqual(await exercise(CursorCompatAdapter), raw)
})
