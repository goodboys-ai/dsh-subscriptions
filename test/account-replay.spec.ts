import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, MessageId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, Message, ReplayEnvelope, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  AccountPreferencesAdapter, accountModelId,
} from '../src/providers/account-preferences.js'
import { ProviderSettingsStore } from '../src/provider-settings.js'
import {
  AntigravityStreamTranslator, toAntigravityContents,
} from '../src/translate/antigravity.js'
import { PoolAdapter } from '../src/providers/pool.js'
import { PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import { poolKey } from '../src/providers/pool-family.js'
import { streamAccountWithReplay } from '../src/providers/replay.js'

test('legacy direct replay keeps upstream provider/model matching behavior',
  async () => {
    let received: GenerateOptions | undefined
    class Raw extends LlmAdapter {
      listOwnModels = async () => []
      resolveOwnModel = async (provider: string, id: string) =>
        ({ provider, id, name: id })
      clearAccountCatalog() {}
      async *stream(): AsyncIterable<StreamChunk> {
        throw new Error('use account seam')
      }
      async *streamAccount(options: GenerateOptions) {
        received = options
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
      }
    }
    const replayState = {
      response: { kind: 'antigravity', version: 1 },
      blocks: [{ thoughtSignature: 'legacy-signature' }],
    }
    const history: Message[] = [{
      id: MessageId('legacy'), role: 'assistant', content: [],
      source: {
        kind: 'model', provider: 'antigravity', model: 'gemini-3-test',
        replayState,
      },
    }]
    const saved = structuredClone(history)
    const raw = new Raw()
    for (const [provider, model, retainsReplay] of [
      ['antigravity', 'gemini-3-test', true],
      ['antigravity', 'gemini-3-other', false],
      ['copilot', 'gemini-3-test', false],
      ['antigravity', 'tier', false],
    ] as const) {
      for await (const chunk of streamAccountWithReplay(raw, {
        provider, model, messages: history,
      }, 'another-account')) void chunk
      const source = received?.messages[0].source
      assert.equal(source?.kind === 'model'
        && source.replayState !== undefined, retainsReplay,
        'legacy replay depends on provider/model, not account')
    }
    assert.deepEqual(history, saved, 'durable legacy history stays unchanged')
  })

for (const mode of ['independent', 'pool', 'direct'] as const) {
  test(`${mode} routes retain signed replay only for the originating account `
    + 'and model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'account-replay-'))
    const model = 'gemini-3-test'
    const otherModel = 'gemini-3-other'
    let wire: ReturnType<typeof toAntigravityContents> = []
    class Raw extends LlmAdapter {
      listOwnModels = async (provider: string) =>
        [model, otherModel].map(id => ({ provider, id, name: id }))
      resolveOwnModel = async (provider: string, id: string) =>
        ({ provider, id, name: id })
      clearAccountCatalog() {}
      async *stream(): AsyncIterable<StreamChunk> {
        throw new Error('use account seam')
      }
      async *streamAccount(
        options: GenerateOptions, account: string,
      ): AsyncIterable<StreamChunk> {
        wire = toAntigravityContents(options.messages, options.model)
        const translator = new AntigravityStreamTranslator()
        yield* translator.push({ response: { candidates: [{ content: { parts: [
          {
            thought: true, text: 'signed reasoning',
            thoughtSignature: `signature-${account}`,
          },
          { text: 'OK' },
        ] }, finishReason: 'STOP' }] } })
      }
    }
    const raw = new Raw()
    const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
    await settings.set('antigravity', { accounts: {
      a: { independentEntry: true }, b: { independentEntry: true },
    } })
    let member = 'a'
    let concreteModel = model
    const pool = new PoolAdapter({
      adapters: { antigravity: raw }, health: new PoolHealthRegistry(),
      usage: new PoolUsageTracker(() => undefined), strategy: 'priority',
      switchMargin: 2, defaultAccount: async () => 'a',
      families: async () => new Map([[poolKey('antigravity', 'tier'), {
        members: [{
          provider: 'antigravity', account: member, model: concreteModel,
        }],
      }]]),
      tiers: {}, onWarn: () => {},
    })
    const route = new AccountPreferencesAdapter({
      provider: 'antigravity', adapter: raw, settings,
      accounts: async () => [member, member === 'a' ? 'b' : 'a']
        .map(key => ({ key, label: key })),
      pool: () => mode === 'pool' ? pool : undefined,
    })
    const llm = new LlmRuntime(new Context())
    const dispose = llm.registerAdapter(['antigravity'], route)
    const selected = mode === 'pool' ? 'tier'
      : mode === 'direct' ? model : accountModelId('a', model)
    const history: Message[] = []
    const hasOriginalSignature = () => wire.some(message =>
      message.parts.some(part => part.thoughtSignature === 'signature-a'))
    const drain = async (id: string, messages: Message[]) => {
      for await (const chunk of llm.stream({
        provider: 'antigravity', model: id, messages,
      })) void chunk
    }
    try {
      const content: Message['content'][number][] = []
      let replayState
      for await (const chunk of llm.stream({
        provider: 'antigravity', model: selected, messages: [],
      })) {
        if (chunk.type === 'block-end') content.push(chunk.block)
        if (chunk.type === 'finish') replayState = chunk.replayState
      }
      assert.ok(replayState)
      history.push({
        role: 'assistant', id: MessageId('signed'),
        source: {
          kind: 'model', provider: 'antigravity', model: selected, replayState,
        },
        content,
      })
      const saved = structuredClone(history)
      await drain(selected, history)
      assert.ok(hasOriginalSignature(),
        'same route must preserve signed thinking')
      member = 'b'
      pool.invalidate()
      const next = mode === 'pool' ? 'tier'
        : mode === 'direct' ? model : accountModelId('b', model)
      await drain(next, history)
      assert.equal(hasOriginalSignature(), false,
        'different account must not inherit private replay')
      member = 'a'
      concreteModel = otherModel
      pool.invalidate()
      const nextModel = mode === 'pool' ? 'tier'
        : mode === 'direct' ? otherModel : accountModelId('a', otherModel)
      await drain(nextModel, history)
      assert.equal(hasOriginalSignature(), false,
        'different model must not inherit private replay')
      concreteModel = model
      pool.invalidate()
      const unsupported = structuredClone(history)
      const envelope = unsupported[0].source?.kind === 'model'
        ? unsupported[0].source.replayState as ReplayEnvelope : undefined
      const response = envelope?.response
      assert.ok(response !== null && typeof response === 'object')
      Object.assign(response, { version: 2 })
      await drain(selected, unsupported)
      assert.equal(hasOriginalSignature(), false,
        'unsupported scope versions must not inherit private replay')
      await drain(selected, history)
      assert.ok(hasOriginalSignature(),
        'returning to the originating account and model retains replay')
      assert.deepEqual(history, saved, 'durable history stays unchanged')
    } finally {
      dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
}
