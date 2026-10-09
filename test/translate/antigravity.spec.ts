import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { ToolCallId } from '../../src/compat.js'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { streamAntigravity, toAntigravityContents } from '../../src/translate/antigravity.js'
import type { TranslatableBlock, TranslatableMessage } from '../../src/translate/resolved.js'

test('Antigravity SSE: malformed body is omitted without changing the error type', async () => {
  const marker = 'customer-input SHORT_SECRET!'
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: {"error":{"message":"${marker}"}} trailing\n\n`))
      controller.close()
    },
  })
  await assert.rejects(async () => {
    for await (const chunk of streamAntigravity(body)) void chunk
  }, (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'MALFORMED_RESPONSE')
    assert.ok(!error.message.includes(marker), `provider text leaked: ${error.message}`)
    assert.ok(error.message.includes('[provider response body omitted]'))
    assert.ok(error.message.includes('MALFORMED_RESPONSE'))
    return true
  })
})

const MODEL = 'gemini-3.8-flash-tiered'

type Messages = Parameters<typeof toAntigravityContents>[0]

function contentsFor(content: readonly TranslatableBlock[], isError?: boolean, role: 'user' | 'tool' = 'user') {
  const flag = isError === undefined ? {} : { isError }
  const result: TranslatableMessage = role === 'tool'
    ? { role, toolCallId: 'c1', content, ...flag }
    : { role, content: [{ type: 'tool-result', toolCallId: 'c1', content, ...flag }] }
  return toAntigravityContents([
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'tool', arguments: '{}' }],
    },
    result,
  ], MODEL)
}

function responseFrom(contents: ReturnType<typeof toAntigravityContents>): Record<string, unknown> {
  const response = contents.flatMap(entry => entry.parts).find(part => part.functionResponse)?.functionResponse?.response
  assert.notEqual(response, undefined, 'tool result must have a function response')
  return response!
}

function responseFor(text: string, isError?: boolean, role: 'user' | 'tool' = 'user'): Record<string, unknown> {
  return responseFrom(contentsFor([{ type: 'text', text }], isError, role))
}

/** Antigravity maps this field to a singular protobuf Struct. */
function assertStructCompatible(value: unknown): void {
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
}

test('a JSON object tool result is preserved verbatim', () => {
  assert.deepEqual(responseFor('{"a":1}'), { a: 1 })
  assert.deepEqual(responseFor('{"a":{"b":[1,2]}}'), { a: { b: [1, 2] } })
})

test('an array tool result is wrapped in an object', () => {
  assertStructCompatible(responseFor('[{"a":1},{"b":2}]'))
  assert.deepEqual(responseFor('[{"a":1},{"b":2}]'), { output: [{ a: 1 }, { b: 2 }] })
  assert.deepEqual(responseFor('["a","b"]'), { output: ['a', 'b'] })
})

test('empty and nested arrays are wrapped', () => {
  assert.deepEqual(responseFor('[]'), { output: [] })
  assert.deepEqual(responseFor('[[1,2]]'), { output: [[1, 2]] })
})

test('scalar JSON tool results are wrapped', () => {
  assert.deepEqual(responseFor('"hello"'), { output: 'hello' })
  assert.deepEqual(responseFor('42'), { output: 42 })
  assert.deepEqual(responseFor('true'), { output: true })
  assert.deepEqual(responseFor('null'), { output: null })
})

test('non-JSON tool results keep their existing envelope', () => {
  assert.deepEqual(responseFor('plain output'), { output: 'plain output' })
  assert.deepEqual(responseFor('boom', true), { output: 'boom', isError: true })
})

test('failed JSON object tool results carry the error flag', () => {
  assert.deepEqual(responseFor('{"message":"denied"}', true), { message: 'denied', isError: true })
  assert.deepEqual(responseFor('{"isError":false,"message":"denied"}', true), { isError: true, message: 'denied' })
})

test('failed JSON arrays and scalars carry the error flag in a Struct compatible envelope', () => {
  for (const text of ['null', '42', 'true', 'false', '"denied"', '[]', '[1,{"a":2}]']) {
    const response = responseFor(text, true)
    assertStructCompatible(response)
    assert.deepEqual(response, { output: JSON.parse(text) as unknown, isError: true })
  }
})

test('successful JSON results preserve their serialized bytes with absent or false error flags', () => {
  for (const [text, expected] of [
    ['{ "z":1,"a":{"b":[2,3]} }', '{"z":1,"a":{"b":[2,3]}}'],
    ['{"output":"value","isError":false}', '{"output":"value","isError":false}'],
    ['null', '{"output":null}'],
    ['42', '{"output":42}'],
    ['true', '{"output":true}'],
    ['"value"', '{"output":"value"}'],
    ['[1,2]', '{"output":[1,2]}'],
  ]) {
    for (const role of ['user', 'tool'] as const) {
      for (const flag of [undefined, false]) assert.equal(JSON.stringify(responseFor(text, flag, role)), expected)
    }
  }
})

test('successful text results preserve their serialized bytes', () => {
  for (const role of ['user', 'tool'] as const) {
    for (const flag of [undefined, false]) {
      assert.equal(JSON.stringify(responseFor('plain output', flag, role)), '{"output":"plain output"}')
    }
  }
})

test('errored JSON tool-role messages carry the error flag', () => {
  assert.deepEqual(responseFor('{"message":"denied"}', true, 'tool'), { message: 'denied', isError: true })
})

test('errored plain-text tool-role messages carry the error flag', () => {
  assert.deepEqual(responseFor('denied', true, 'tool'), { output: 'denied', isError: true })
})

test('empty tool-result content keeps its output envelope and error flag', () => {
  for (const role of ['user', 'tool'] as const) {
    assert.equal(JSON.stringify(responseFrom(contentsFor([], undefined, role))), '{"output":""}')
    assert.deepEqual(responseFrom(contentsFor([], true, role)), { output: '', isError: true })
  }
})

test('mixed tool-result content joins text and retains images after the function response', () => {
  const image: TranslatableBlock = { type: 'image', mediaType: 'image/png', dataBase64: 'aW1hZ2U=' }
  for (const role of ['user', 'tool'] as const) {
    for (const [text, expected] of [
      ['{"message":"denied"}', { message: 'denied' }],
      ['plain output', { output: 'plain output' }],
    ] as const) {
      const content: TranslatableBlock[] = [
        { type: 'text', text: text.slice(0, 5) },
        image,
        { type: 'reasoning', text: 'not tool output' },
        { type: 'text', text: text.slice(5) },
      ]
      for (const flag of [undefined, true]) {
        const contents = contentsFor(content, flag, role)
        assert.deepEqual(responseFrom(contents), { ...expected, ...flag === true ? { isError: true } : {} })
        const parts = contents.flatMap(entry => entry.parts)
        const responseIndex = parts.findIndex(part => part.functionResponse)
        const imageIndex = parts.findIndex(part => part.inlineData)
        assert.ok(imageIndex > responseIndex)
        assert.deepEqual(parts[imageIndex].inlineData, { mimeType: 'image/png', data: 'aW1hZ2U=' })
      }
    }
  }
})

test('multiple tool results in one turn stay Struct compatible', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', id: 'c1', name: 'first', arguments: '{}' },
        { type: 'tool-call', id: 'c2', name: 'second', arguments: '{}' },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '{"ok":1}' }] },
        { type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: '[1,2,3]' }] },
      ],
    },
  ] as unknown as Messages
  const responses: unknown[] = []
  for (const entry of toAntigravityContents(messages, MODEL)) {
    for (const part of entry.parts) {
      if (part.functionResponse !== undefined) responses.push(part.functionResponse.response)
    }
  }
  assert.equal(responses.length, 2)
  assert.deepEqual(responses[0], { ok: 1 })
  assert.deepEqual(responses[1], { output: [1, 2, 3] })
})

test('every JSON payload shape yields a Struct compatible response', () => {
  const payloads = ['{"a":1}', '[1]', '[]', '"s"', '7', 'false', 'null', '[[[]]]', 'plain text']
  for (const payload of payloads) assertStructCompatible(responseFor(payload))
})
