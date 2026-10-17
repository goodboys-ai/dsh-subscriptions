/**
 * Property tests for toAnthropicMessages tool pairing and markMessageCache.
 *
 * The wire invariants under test are the ones whose violation Anthropic
 * answers with a 400: every `tool_use` must be answered by a `tool_result`
 * with the same id leading the very next (user) message, `tool_use` may only
 * appear in assistant messages, roles must alternate, and at most four
 * cache_control breakpoints may be marked across system and messages. The
 * generators build conversations whose results always answer their calls, so
 * any mismatch in the output is the translator's doing, not the fixture's.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import {
  CACHE_BLOCK_STRIDE,
  MESSAGE_CACHE_BREAKPOINTS,
  markMessageCache,
  toAnthropicMessages,
  toAnthropicSystem,
  type AnthropicMessage,
} from '../src/translate/anthropic.js'
import type {
  TranslatableBlock,
  TranslatableMessage,
} from '../src/translate/resolved.js'
import { ToolCallId } from '../src/compat.js'

const textBlock = fc
  .string({ maxLength: 40 })
  .map((text): TranslatableBlock => ({ type: 'text', text }))

/** One tool call an assistant turn makes; ids are assigned at materialization. */
interface CallSpec {
  name: string
  args: string
}

const callSpec: fc.Arbitrary<CallSpec> = fc.record({
  name: fc.string({
    unit: fc.constantFrom('a', 'b', 'c', 'r', 'w', '_'),
    minLength: 1,
    maxLength: 8,
  }),
  args: fc.oneof(
    fc.jsonValue({ maxDepth: 2 }).map((value) => JSON.stringify(value ?? {})),
    // Malformed model JSON must degrade to `{}`, never crash the pairing.
    fc.constant('{bad'),
  ),
})

/**
 * A conversation turn. `splice` parks a plain user text message inside the
 * tool-result batch — the harness merges everything queued for one user turn,
 * so context can land between two results of one batch; the translator must
 * still emit the results as one leading run.
 */
type Turn =
  | { kind: 'user'; blocks: TranslatableBlock[] }
  | { kind: 'system'; blocks: TranslatableBlock[] }
  | {
      kind: 'agent'
      blocks: TranslatableBlock[]
      calls: CallSpec[]
      splice: boolean
    }

const turn: fc.Arbitrary<Turn> = fc.oneof(
  fc
    .array(textBlock, { minLength: 1, maxLength: 2 })
    .map((blocks): Turn => ({ kind: 'user', blocks })),
  fc
    .array(textBlock, { minLength: 1, maxLength: 2 })
    .map((blocks): Turn => ({ kind: 'system', blocks })),
  fc
    .record({
      blocks: fc.array(textBlock, { maxLength: 2 }),
      calls: fc.array(callSpec, { maxLength: 3 }),
      splice: fc.boolean(),
    })
    .map((turnSpec): Turn => ({ kind: 'agent', ...turnSpec })),
)

interface Materialized {
  messages: TranslatableMessage[]
  /** Ids of every tool call the conversation makes, in order. */
  callIds: string[]
}

/** Build harness messages from turns, pairing every call with its result. */
function materialize(turns: readonly Turn[]): Materialized {
  const messages: TranslatableMessage[] = []
  const callIds: string[] = []
  let callNumber = 0
  for (const turnSpec of turns) {
    if (turnSpec.kind === 'agent') {
      const ids = turnSpec.calls.map(() => `call_${callNumber++}`)
      callIds.push(...ids)
      const blocks: TranslatableBlock[] = [
        ...turnSpec.blocks,
        ...turnSpec.calls.map((call, index): TranslatableBlock => ({
          type: 'tool-call',
          id: ToolCallId(ids[index]),
          name: call.name,
          arguments: call.args,
        })),
      ]
      if (blocks.length === 0) continue
      messages.push({ role: 'assistant', content: blocks })
      if (ids.length === 0) continue
      const results: TranslatableMessage[] = ids.map((id) => ({
        role: 'tool',
        toolCallId: id,
        content: [{ type: 'text', text: `result for ${id}` }],
      }))
      if (turnSpec.splice) {
        const at = results.length > 1 ? 1 : 0
        results.splice(at, 0, {
          role: 'user',
          content: [{ type: 'text', text: 'spliced context' }],
        })
      }
      messages.push(...results)
    } else {
      messages.push({ role: turnSpec.kind, content: turnSpec.blocks })
    }
  }
  return { messages, callIds }
}

function toolUseIds(message: AnthropicMessage): string[] {
  return message.content
    .filter((block) => block.type === 'tool_use')
    .map((block) => String(block['id']))
}

function toolResultIds(message: AnthropicMessage): string[] {
  return message.content
    .filter((block) => block.type === 'tool_result')
    .map((block) => String(block['tool_use_id']))
}

/** Multiset equality of two id lists. */
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join('') === [...right].sort().join('')
}

test('toAnthropicMessages: every tool_use is answered and no tool_result is orphaned', () => {
  fc.assert(
    fc.property(fc.array(turn, { maxLength: 8 }), (turns) => {
      const { messages, callIds } = materialize(turns)
      const out = toAnthropicMessages(messages)

      // Merging guarantees strict role alternation, which the API requires.
      for (let index = 1; index < out.length; index++) {
        assert.notEqual(
          out[index].role,
          out[index - 1].role,
          `adjacent ${out[index].role} messages at ${index}`,
        )
      }

      const allUseIds: string[] = []
      const allResultIds: string[] = []
      for (const [index, message] of out.entries()) {
        if (message.role === 'user') {
          // A replayed tool call rides as text; `tool_use` is assistant-only.
          assert.ok(!message.content.some((block) => block.type === 'tool_use'))
          // Results lead the message in one run: a non-result block may never
          // sit before or between them (the #22 400 shape).
          const firstOther = message.content.findIndex(
            (block) => block.type !== 'tool_result',
          )
          assert.ok(
            firstOther === -1 ||
              !message.content
                .slice(firstOther)
                .some((block) => block.type === 'tool_result'),
            'tool_result blocks must form one leading run',
          )
          const resultIds = toolResultIds(message)
          allResultIds.push(...resultIds)
          if (resultIds.length > 0) {
            // Every result answers a call of the immediately preceding
            // assistant message — never an older one and never a stranger.
            const previous = out[index - 1]
            assert.ok(
              previous !== undefined,
              'tool results must follow an assistant message',
            )
            assert.equal(
              previous.role,
              'assistant',
              'tool results must follow an assistant message',
            )
            assert.ok(
              sameIds(resultIds, toolUseIds(previous)),
              'result ids must match the preceding calls',
            )
          }
        } else {
          const useIds = toolUseIds(message)
          allUseIds.push(...useIds)
          if (useIds.length > 0) {
            const next = out[index + 1]
            assert.ok(
              next !== undefined,
              'calls must be answered by the next message',
            )
            assert.equal(
              next.role,
              'user',
              'calls must be answered by the next message',
            )
            assert.ok(
              sameIds(useIds, toolResultIds(next)),
              'every call must be answered exactly once',
            )
          }
        }
      }

      // Nothing lost and nothing invented across the whole conversation.
      assert.ok(
        sameIds(allUseIds, callIds),
        'every generated call reaches the wire once',
      )
      assert.ok(sameIds(allResultIds, callIds), 'every call is answered once')
    }),
    { numRuns: 200 },
  )
})

test('markMessageCache + toAnthropicSystem: breakpoints never exceed the Anthropic limit of 4', () => {
  fc.assert(
    fc.property(
      // Alternating one-block messages give a flat block sequence of known
      // length, so the expected mark positions are exact.
      fc.integer({ min: 0, max: 130 }),
      (blockCount) => {
        const messages: TranslatableMessage[] = Array.from(
          { length: blockCount },
          (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: [{ type: 'text', text: `block ${index}` }],
          }),
        )
        const out = toAnthropicMessages(messages)
        markMessageCache(out)

        const flat = out.flatMap((message) => message.content)
        const marked = flat.flatMap((block, index) =>
          block['cache_control'] === undefined ? [] : [index],
        )
        const expected = Array.from(
          { length: MESSAGE_CACHE_BREAKPOINTS },
          (_, mark) => flat.length - 1 - mark * CACHE_BLOCK_STRIDE,
        )
          .filter((at) => at >= 0)
          .sort((left, right) => left - right)
        assert.deepEqual(
          marked,
          expected,
          'marks sit at the last block, then one stride back each',
        )

        const system = toAnthropicSystem(undefined, messages)
        const systemMarks = system.filter(
          (block) => block['cache_control'] !== undefined,
        )
        assert.equal(
          systemMarks.length,
          1,
          'the system tier marks exactly its last block',
        )
        assert.ok(
          marked.length + systemMarks.length <= 4,
          'system plus message breakpoints must stay within the Anthropic limit of 4',
        )
      },
    ),
    { numRuns: 200 },
  )
})
