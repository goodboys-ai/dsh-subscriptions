/** Claude wire ids for calls imported from providers with different id grammars. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '../src/compat.js'
import { toAnthropicMessages } from '../src/translate/anthropic.js'
import type { AnthropicMessage } from '../src/translate/anthropic.js'
import type {
  TranslatableBlock,
  TranslatableMessage,
} from '../src/translate/resolved.js'
import { claudeRequestBody } from '../src/providers/claude.js'

const ACCEPTED_ID = /^[a-zA-Z0-9_-]+$/
const MODEL = 'claude-opus-5-5'
const TOOLS: ToolSchema[] = [
  {
    name: 'bash',
    description: 'run a command',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
  },
]
const CODEX = {
  kind: 'model' as const,
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
}

function codexCallId(n: number): string {
  return `call_${`Ab${n}`.padEnd(32, 'x')}|fc_${`68ac${n}`.padEnd(50, '0')}`
}
function user(text: string): TranslatableMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}
function codexTurn(content: TranslatableBlock[]): TranslatableMessage {
  return { role: 'assistant', content, source: CODEX }
}
function call(id: string, args = '{"cmd":"ls"}'): TranslatableBlock {
  return {
    type: 'tool-call',
    id: ToolCallId(id),
    name: 'bash',
    arguments: args,
  }
}
function toolMessage(id: string, text: string): TranslatableMessage {
  return {
    role: 'tool',
    toolCallId: id,
    content: [{ type: 'text', text }],
    source: { kind: 'tool', callId: ToolCallId(id) },
  }
}
function claude(
  messages: readonly TranslatableMessage[],
): Record<string, unknown> {
  const options: GenerateOptions = {
    provider: 'claude',
    model: MODEL,
    messages: messages as unknown as Message[],
    system: 'You are a coding agent.',
    tools: TOOLS,
  }
  return claudeRequestBody(options, messages, 32_000, {
    type: 'adaptive',
    display: 'summarized',
  })
}
function wire(body: Record<string, unknown>): AnthropicMessage[] {
  return body.messages as AnthropicMessage[]
}
function toolIds(messages: readonly AnthropicMessage[]): {
  uses: string[]
  results: string[]
} {
  const uses: string[] = []
  const results: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') uses.push(String(block.id))
      if (block.type === 'tool_result') results.push(String(block.tool_use_id))
    }
  }
  return { uses, results }
}
function assertAccepted(messages: readonly AnthropicMessage[]): void {
  const { uses, results } = toolIds(messages)
  for (const id of [...uses, ...results]) {
    assert.match(id, ACCEPTED_ID)
    assert.ok(id.length <= 64, `${id} is longer than 64 characters`)
  }
}
function assertPaired(messages: readonly AnthropicMessage[]): void {
  for (const [index, message] of messages.entries()) {
    const answered = message.content
      .filter((block) => block.type === 'tool_result')
      .map((block) => String(block.tool_use_id))
    if (answered.length === 0) continue
    const previous = messages[index - 1]
    assert.equal(previous?.role, 'assistant')
    const calls = previous.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => String(block.id))
    for (const id of answered) assert.ok(calls.includes(id))
  }
}
function withoutCacheMarks(
  messages: readonly AnthropicMessage[],
): AnthropicMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map(({ cache_control: _mark, ...block }) => block),
  }))
}

test('a Codex tool-call id is normalized on the Claude wire and remains paired', () => {
  const id = codexCallId(1)
  const history = [
    user('list files'),
    codexTurn([{ type: 'text', text: 'running ls' }, call(id)]),
    toolMessage(id, 'a\nb'),
    codexTurn([{ type: 'text', text: 'two files' }]),
    user('continue with Claude'),
  ]
  const stored = structuredClone(history)
  const messages = wire(claude(history))
  const use = messages[1]!.content[1]!
  assert.equal(use.type, 'tool_use')
  assert.equal(
    use.id,
    'call_Ab1xxxxxxxxxxxxxxxxxxxxxxxxxxxxx_fc_68ac10_cWHdAeHUGHonL-O0',
  )
  assert.deepEqual(withoutCacheMarks(messages)[2]!.content[0], {
    type: 'tool_result',
    tool_use_id: use.id,
    content: 'a\nb',
  })
  assertAccepted(messages)
  assertPaired(messages)
  assert.deepEqual(history, stored, 'only the request changes')
  assert.deepEqual(claude(history), claude(history), 'the mapping is stable')
})

test('every tool-result history shape answers its normalized tool_use', () => {
  const ids = [1, 2, 3, 4, 5].map(codexCallId)
  const history: TranslatableMessage[] = [
    user('go'),
    codexTurn([call(ids[0]!), call(ids[1]!)]),
    toolMessage(ids[0]!, 'first'),
    {
      role: 'tool',
      tool_call_id: ids[1],
      content: [{ type: 'text', text: 'second' }],
    },
    codexTurn([call(ids[2]!)]),
    {
      role: 'tool',
      content: [{ type: 'text', text: 'third' }],
      source: { kind: 'tool', callId: ToolCallId(ids[2]!) },
    },
    codexTurn([call(ids[3]!)]),
    {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: ToolCallId(ids[3]!),
          content: [{ type: 'text', text: 'fourth' }],
          isError: true,
        },
      ],
      source: { kind: 'tool', callId: ToolCallId(ids[3]!) },
    },
    codexTurn([call(ids[4]!)]),
    toolMessage(ids[4]!, 'fifth'),
    user('summarize'),
  ]
  const messages = withoutCacheMarks(wire(claude(history)))
  assertAccepted(messages)
  assertPaired(messages)
  const { uses, results } = toolIds(messages)
  assert.equal(new Set(uses).size, ids.length)
  assert.deepEqual(results, uses)
  const answers = new Map(
    messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool_result')
      .map((block) => [String(block.tool_use_id), block.content]),
  )
  assert.deepEqual(
    uses.map((id) => answers.get(id)),
    ['first', 'second', 'third', 'fourth', 'fifth'],
  )
  assert.equal(
    messages
      .flatMap((message) => message.content)
      .find((block) => block.content === 'fourth')?.is_error,
    true,
  )
})

test('accepted ids stay verbatim next to normalized ids', () => {
  const plain = 'call_abc-123_DEF'
  const foreign = codexCallId(7)
  const claudeId = 'toolu_01A09q90qw90lq917835lq9'
  const messages = toAnthropicMessages([
    codexTurn([call(plain), call(foreign)]),
    toolMessage(plain, 'one'),
    toolMessage(foreign, 'two'),
    {
      role: 'assistant',
      content: [call(claudeId)],
      source: { kind: 'model', provider: 'claude', model: MODEL },
    },
    toolMessage(claudeId, 'three'),
  ])
  const { uses, results } = toolIds(messages)
  assert.equal(uses[0], plain)
  assert.equal(uses[2], claudeId)
  assert.notEqual(uses[1], foreign)
  assert.deepEqual(results, uses)
  assertAccepted(messages)
  assertPaired(messages)
})

test('normalization never takes an accepted id already present in the request', () => {
  const foreign = 'call_x|fc_y'
  const [alone] = toolIds(
    toAnthropicMessages([
      codexTurn([call(foreign)]),
      toolMessage(foreign, 'r'),
    ]),
  ).uses
  assert.equal(alone, 'call_x_fc_y_GBNlpy9_LWOX42zM')
  const messages = toAnthropicMessages([
    codexTurn([call(alone!), call(foreign)]),
    toolMessage(alone!, 'genuine'),
    toolMessage(foreign, 'foreign'),
  ])
  const { uses } = toolIds(messages)
  assert.equal(uses[0], alone)
  assert.equal(uses[1], 'call_x_fc_y_0qg745CdcD-FHQCU')
  assert.deepEqual(
    messages[1]!.content.map((block) => [block.tool_use_id, block.content]),
    [
      [alone, 'genuine'],
      [uses[1], 'foreign'],
    ],
  )
  assertAccepted(messages)
  assertPaired(messages)
})

test('ids differing only in refused characters or past the cut stay distinct', () => {
  const ids = [
    'a|b',
    'a.b',
    'a b',
    'a_b',
    '|',
    '',
    `${'x'.repeat(100)}|1`,
    `${'x'.repeat(100)}|2`,
  ]
  const messages = toAnthropicMessages([
    codexTurn(ids.map((id) => call(id))),
    ...ids.map((id, index) => toolMessage(id, `result ${index}`)),
  ])
  const { uses, results } = toolIds(messages)
  assert.equal(new Set(uses).size, ids.length)
  assert.equal(uses[3], 'a_b')
  assert.deepEqual(results, uses)
  assertAccepted(messages)
  assertPaired(messages)
})

test('normalized ids keep earlier request bytes stable across later turns', () => {
  const id = codexCallId(9)
  const history = [
    user('list files'),
    codexTurn([{ type: 'text', text: 'running ls' }, call(id)]),
    toolMessage(id, 'a\nb'),
    user('continue with Claude'),
  ]
  const first = withoutCacheMarks(wire(claude(history)))
  const next = [
    ...history,
    {
      role: 'assistant',
      content: [call('toolu_01NextCall', '{"cmd":"pwd"}')],
      source: { kind: 'model', provider: 'claude', model: MODEL },
    } satisfies TranslatableMessage,
    toolMessage('toolu_01NextCall', '/tmp'),
  ]
  const second = withoutCacheMarks(wire(claude(next)))
  assert.deepEqual(second.slice(0, first.length), first)
  assertAccepted(second)
  assertPaired(second)
})
