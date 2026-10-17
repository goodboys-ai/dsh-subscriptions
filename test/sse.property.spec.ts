/**
 * Property tests for parseSse framing. The parser's contract is that events
 * depend only on the byte stream, never on how the transport split it into
 * reads — a proxy, TLS record boundary, or backpressure pause may cut a chunk
 * anywhere, including inside a multi-byte UTF-8 sequence or between `\r` and
 * `\n`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { parseSse, type SseEvent } from '../src/translate/sse.js'

/** Payload characters, weighted with multi-byte UTF-8 so read splits land mid-sequence. */
const payloadChar = fc.constantFrom(
  'a',
  'Z',
  '0',
  ' ',
  '{',
  '}',
  '"',
  ':',
  '\\',
  '/',
  'é',
  'ß',
  '中',
  '文',
  '🙂',
  '\t',
  '-',
  '_',
  '=',
)

/**
 * One `data:` payload line. The parser strips one space after `data:` and
 * frames on LF/CRLF, so the model keeps lines free of leading spaces and line
 * breaks instead of re-encoding those two rules into the expectation; the
 * strip rule itself is pinned by the dedicated test below.
 */
const dataLine = fc
  .string({ unit: payloadChar, maxLength: 24 })
  .map((line) => (line.startsWith(' ') ? `x${line}` : line))

/** An `event:` name, under the same framing constraints as a data line. */
const eventName = fc
  .string({ unit: payloadChar, minLength: 1, maxLength: 12 })
  .map((name) => (name.startsWith(' ') ? `x${name}` : name))

/** One generated SSE event: an optional name plus at least one data line. */
interface ModelEvent {
  name: string | undefined
  data: string[]
}

const modelEvent: fc.Arbitrary<ModelEvent> = fc.record({
  name: fc.option(eventName, { nil: undefined }),
  data: fc.array(dataLine, { minLength: 1, maxLength: 4 }),
})

/**
 * Noise the parser must skip: comment lines and non-data fields. These may sit
 * between an event's own lines without changing the event it produces.
 */
const noiseLine = fc.oneof(
  fc.string({ unit: payloadChar, maxLength: 16 }).map((text) => `: ${text}`),
  fc
    .string({ unit: payloadChar, minLength: 1, maxLength: 8 })
    .map((name) => `${name.replace(/:/g, 'x')}: ignored`),
)

interface StreamSpec {
  events: ModelEvent[]
  /** Noise line positions: before event i (indexes 0..events.length). */
  noise: string[][]
  /** Per emitted physical line: CRLF when true, LF otherwise. */
  crlf: boolean[]
  /** Append a `data:` line with no blank-line terminator; EOF must drop it. */
  orphanTail: boolean
}

const streamSpec: fc.Arbitrary<StreamSpec> = fc
  .tuple(
    fc.array(modelEvent, { maxLength: 6 }),
    fc.array(fc.array(noiseLine, { maxLength: 2 }), {
      minLength: 7,
      maxLength: 7,
    }),
    fc.array(fc.boolean(), { minLength: 80, maxLength: 80 }),
    fc.boolean(),
  )
  .map(([events, noise, crlf, orphanTail]) => ({
    events,
    noise,
    crlf,
    orphanTail,
  }))

/** Serialize a spec to SSE text, exercising both line endings and skipped lines. */
function serialize(spec: StreamSpec): string {
  let lineIndex = 0
  const eol = (): string =>
    spec.crlf[lineIndex++ % spec.crlf.length] ? '\r\n' : '\n'
  let text = ''
  spec.events.forEach((event, index) => {
    for (const noise of spec.noise[index] ?? []) text += `${noise}${eol()}`
    if (event.name !== undefined) text += `event: ${event.name}${eol()}`
    for (const line of event.data) text += `data:${line}${eol()}`
    text += eol()
  })
  for (const noise of spec.noise[spec.events.length] ?? [])
    text += `${noise}${eol()}`
  if (spec.orphanTail) text += 'data: orphan'
  return text
}

/** The events the spec must produce, per parseSse's join and skip rules. */
function expectedEvents(spec: StreamSpec): SseEvent[] {
  return spec.events.map((event) => ({
    data: event.data.join('\n'),
    ...(event.name === undefined ? {} : { event: event.name }),
  }))
}

/** Split bytes into reads of the given sizes; leftover bytes form a final read. */
function chunkBytes(bytes: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const chunks: Uint8Array[] = []
  let offset = 0
  for (const size of sizes) {
    chunks.push(bytes.slice(offset, offset + size))
    offset += size
  }
  if (offset < bytes.length) chunks.push(bytes.slice(offset))
  return chunks
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

async function collect(chunks: readonly Uint8Array[]): Promise<SseEvent[]> {
  const events: SseEvent[] = []
  for await (const event of parseSse(streamOf(chunks))) events.push(event)
  return events
}

test('parseSse: exactly one leading space after `data:` is stripped', async () => {
  // WHATWG SSE removes a single U+0020 after the colon and keeps the rest
  // verbatim, so a second space — or a tab — is payload. The round-trip
  // property above never exercises this rule because its generator excludes
  // leading spaces.
  const parseLine = async (line: string): Promise<SseEvent[]> =>
    collect([new TextEncoder().encode(`${line}\n\n`)])
  assert.deepEqual(await parseLine('data: x'), [{ data: 'x' }])
  assert.deepEqual(await parseLine('data:  x'), [{ data: ' x' }])
  assert.deepEqual(await parseLine('data:x'), [{ data: 'x' }])
  assert.deepEqual(await parseLine('data:\tx'), [{ data: '\tx' }])
})

test('parseSse: arbitrary read splits yield the same events as the unsplit stream', async () => {
  await fc.assert(
    fc.asyncProperty(
      streamSpec,
      fc.array(fc.nat({ max: 5 }), { maxLength: 600 }),
      async (spec, sizes) => {
        const bytes = new TextEncoder().encode(serialize(spec))
        const whole = await collect([bytes])
        const split = await collect(chunkBytes(bytes, sizes))
        // The split read sequence must not change the event sequence...
        assert.deepEqual(split, whole)
        // ...and the unsplit parse must match the generated events exactly,
        // so the invariance above is anchored to the framing rules rather
        // than to a self-consistent misread.
        assert.deepEqual(whole, expectedEvents(spec))
      },
    ),
    { numRuns: 200 },
  )
})
