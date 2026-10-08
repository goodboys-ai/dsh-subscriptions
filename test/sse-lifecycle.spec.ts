import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSse } from '../src/translate/sse.js'
import { streamResponses } from '../src/translate/responses.js'

const stops = ['consumer-return', 'provider-finish', 'malformed'] as const
for (const stop of stops) {
  test(`SSE ${stop} cancels the unread response body`, async () => {
    let cancelled = 0
    const frame = stop === 'provider-finish'
      ? 'data: {"type":"response.completed","response":{}}\n\n'
      : stop === 'malformed' ? 'data: invalid-json\n\n' : 'data: first\n\n'
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(frame)) },
      cancel() { cancelled++ },
    })
    if (stop === 'consumer-return') {
      const iterator = parseSse(body)
      await iterator.next()
      await iterator.return(undefined)
    } else if (stop === 'malformed') {
      await assert.rejects(async () => {
        for await (const chunk of streamResponses(body)) void chunk
      }, /malformed SSE/)
    } else {
      for await (const chunk of streamResponses(body)) void chunk
    }
    assert.equal(cancelled, 1)
    assert.equal(body.locked, false)
  })
}

test('SSE cleanup never masks the original decode failure', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: bad-json\n\n'))
    },
    cancel() { throw new Error('cleanup failed') },
  })
  await assert.rejects(async () => {
    for await (const chunk of streamResponses(body)) void chunk
  }, /malformed SSE/)
  assert.equal(body.locked, false)
})
