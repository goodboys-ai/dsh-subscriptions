/**
 * Property test for toChatMessages tool pairing. The OpenAI-compatible wire
 * contract mirrors Anthropic's: an assistant message's `tool_calls` must be
 * answered by `tool` messages carrying the same `tool_call_id`s immediately
 * after it, and no `tool` message may reference a call nobody made. The
 * generator pairs every call with its result, so a mismatch is the
 * translator's doing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { toChatMessages } from '../src/translate/chat-completions.js'
import type {
  TranslatableBlock,
  TranslatableMessage,
} from '../src/translate/resolved.js'
import { ToolCallId } from '../src/compat.js'

const textBlock = fc
  .string({ maxLength: 40 })
  .map((text): TranslatableBlock => ({ type: 'text', text }))

const callName = fc.string({
  unit: fc.constantFrom('a', 'b', 'c', 'r', 'w', '_'),
  minLength: 1,
  maxLength: 8,
})

/** A turn: user text, or an assistant message whose calls are all answered. */
type Turn =
  | { kind: 'user'; blocks: TranslatableBlock[] }
  | { kind: 'agent'; blocks: TranslatableBlock[]; calls: string[] }

const turn: fc.Arbitrary<Turn> = fc.oneof(
  fc
    .array(textBlock, { minLength: 1, maxLength: 2 })
    .map((blocks): Turn => ({ kind: 'user', blocks })),
  fc
    .record({
      blocks: fc.array(textBlock, { maxLength: 2 }),
      calls: fc.array(callName, { maxLength: 3 }),
    })
    .map((turnSpec): Turn => ({ kind: 'agent', ...turnSpec })),
)

interface Materialized {
  messages: TranslatableMessage[]
  callIds: string[]
}

/** Build harness messages, emitting one tool-result message per call. */
function materialize(turns: readonly Turn[]): Materialized {
  const messages: TranslatableMessage[] = []
  const callIds: string[] = []
  let callNumber = 0
  for (const turnSpec of turns) {
    if (turnSpec.kind === 'user') {
      messages.push({ role: 'user', content: turnSpec.blocks })
      continue
    }
    const ids = turnSpec.calls.map(() => `call_${callNumber++}`)
    callIds.push(...ids)
    const blocks: TranslatableBlock[] = [
      ...turnSpec.blocks,
      ...turnSpec.calls.map((name, index): TranslatableBlock => ({
        type: 'tool-call',
        id: ToolCallId(ids[index]),
        name,
        arguments: '{}',
      })),
    ]
    if (blocks.length === 0) continue
    messages.push({ role: 'assistant', content: blocks })
    for (const id of ids) {
      messages.push({
        role: 'tool',
        toolCallId: id,
        content: [{ type: 'text', text: `result for ${id}` }],
      })
    }
  }
  return { messages, callIds }
}

function assistantCallIds(message: Record<string, unknown>): string[] {
  if (!Array.isArray(message['tool_calls'])) return []
  return (message['tool_calls'] as Record<string, unknown>[]).map((call) =>
    String(call['id']),
  )
}

test('toChatMessages: tool_calls are answered in place and no tool message is orphaned', () => {
  fc.assert(
    fc.property(fc.array(turn, { maxLength: 8 }), (turns) => {
      const { messages, callIds } = materialize(turns)
      const out = toChatMessages(messages)

      const allWireCallIds: string[] = []
      const allWireResultIds: string[] = []
      for (const [index, message] of out.entries()) {
        if (message['role'] === 'assistant') {
          const ids = assistantCallIds(message)
          allWireCallIds.push(...ids)
          if (ids.length === 0) continue
          // The answers must be the next |ids| messages, as `tool` messages
          // carrying exactly these ids — anything in between breaks the API's
          // call/answer adjacency.
          const answers = out.slice(index + 1, index + 1 + ids.length)
          assert.equal(
            answers.length,
            ids.length,
            'every call must be answered',
          )
          assert.ok(
            answers.every((answer) => answer['role'] === 'tool'),
            'answers must be tool messages',
          )
          assert.deepEqual(
            answers.map((answer) => String(answer['tool_call_id'])),
            ids,
            'answers must arrive in call order',
          )
        }
        if (message['role'] === 'tool') {
          allWireResultIds.push(String(message['tool_call_id']))
          // No tool message may point at a call the wire never made.
          const priorCalls = out.slice(0, index).flatMap(assistantCallIds)
          assert.ok(
            priorCalls.includes(String(message['tool_call_id'])),
            'tool message without its call',
          )
        }
      }

      // The conversation's calls all reach the wire, each answered once.
      assert.deepEqual([...allWireCallIds].sort(), [...callIds].sort())
      assert.deepEqual([...allWireResultIds].sort(), [...callIds].sort())
    }),
    { numRuns: 200 },
  )
})
