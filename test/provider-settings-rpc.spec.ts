import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import type { AccountAwareAdapter } from '../src/providers/accounts.js'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

type Agent = NonNullable<ToolRunContext['agent']>
import { CodexAdapter } from '../src/providers/codex.js'
import {
  ClaudeAdapter,
  CLAUDE_API_URL,
  CLAUDE_TOKEN_URL,
} from '../src/providers/claude.js'
import { CLAUDE_CLI_VERSION_URL } from '../src/providers/claude-cli-version.js'
import { CODEX_VERSION_URL } from '../src/providers/codex-client-version.js'
import { saveAccountSession } from '../src/auth/store.js'
import * as plugin from '../src/index.js'
import { createFakeConnection } from './fake-connection.js'

test('provider settings RPC edits picker visibility without losing the editor catalog or existing sessions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'settings-rpc-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const adapters = new Map<string, AccountAwareAdapter>()
  const tools = new Set<string>()
  ctx.provide('llm', {
    registerAdapter: (routes: string[], adapter: AccountAwareAdapter) => {
      adapters.set(routes[0], adapter)
      return Object.assign(() => {}, { replace: () => {} })
    },
  })
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  ctx.provide('tools', {
    register: (definition: { name: string }) => {
      tools.add(definition.name)
      return () => {}
    },
  })
  const originalResolve = CodexAdapter.prototype.resolveOwnModel
  let unavailable = false
  CodexAdapter.prototype.resolveOwnModel = async (provider, model) => {
    if (unavailable && model === 'm2')
      throw new Error('capabilities unavailable')
    return {
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] },
    }
  }
  // The status RPC reads the presented CLI version; keep its public npm lookup
  // inside the fixture instead of letting this new assertion use the network.
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === CODEX_VERSION_URL)
      return new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 })
    throw new Error(`unexpected outbound request to ${url}`)
  }) as typeof globalThis.fetch
  const runtime = ctx.plugin(plugin, {
    providers: ['codex', 'grok'],
    pool: { enabled: false },
    models: {
      codex: [
        { id: 'm1', name: 'Model 1', inputModalities: ['text'] },
        { id: 'm2', name: 'Model 2', inputModalities: ['text'] },
      ],
    },
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (!connection.registered()) await runtime
    assert.ok(connection.registered())
    await saveAccountSession('codex', 'account', {
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3600_000,
      accountId: 'account',
      idToken: '',
    })
    const call = (endpoint: string, payload: unknown) =>
      connection.handler(endpoint, payload, new AbortController().signal)
    assert.equal(
      (
        await call('setProviderSettings', {
          provider: 'codex',
          settings: {
            visibleModels: ['m1'],
            tools: { image_generate: false, web_search: false },
          },
        })
      ).ok,
      true,
    )
    assert.deepEqual(
      (await adapters.get('codex')!.listModels('codex')).map(
        (model) => model.id,
      ),
      ['m1'],
    )
    assert.equal(
      (await adapters.get('codex')!.resolveModel('codex', 'm2')).id,
      'm2',
    )
    const status = await call('status', {})
    assert.ok(status.ok)
    const providers = (
      status.value as {
        providers: Record<string, { visibleModels?: string[] }>
      }
    ).providers
    assert.deepEqual(providers.codex.visibleModels, ['m1'])
    assert.equal(providers.grok.visibleModels, undefined)
    unavailable = true
    const catalog = await call('providerSettings', {
      provider: 'codex',
      force: true,
    })
    assert.ok(catalog.ok)
    assert.deepEqual(
      (catalog.value as { models: { id: string }[] }).models.map(
        (model) => model.id,
      ),
      ['m1', 'm2'],
    )
    const rows = (
      catalog.value as {
        models: { id: string; efforts: { id: string }[]; configured?: string }[]
      }
    ).models
    assert.deepEqual(
      rows[0].efforts.map((effort) => effort.id),
      ['high'],
    )
    assert.deepEqual(rows[1].efforts, [])
    assert.equal(
      (
        await call('setModelDefault', {
          provider: 'codex',
          model: 'm1',
          effort: 'high',
        })
      ).ok,
      true,
    )
    const updated = await call('providerSettings', { provider: 'codex' })
    assert.ok(updated.ok)
    assert.equal(
      (updated.value as { models: { configured?: string }[] }).models[0]
        .configured,
      'high',
    )
    assert.equal(
      (await call('providerSettings', { provider: 'codex', force: 'yes' })).ok,
      false,
    )
    assert.equal(
      (
        await call('setProviderSettings', {
          provider: 'codex',
          settings: { contextWindows: { m1: 0 } },
        })
      ).ok,
      false,
    )
    assert.equal(
      (await call('setProviderSettings', { provider: 'claude', settings: {} }))
        .ok,
      false,
    )

    const create = (at: number) => {
      const denied: string[] = []
      const agent = {
        session: { header: { createdAt: at } },
        ctx: {
          tools: {
            restrict: ({ deny }: { deny: string[] }) => {
              denied.push(...deny)
            },
          },
        },
      }
      ctx.emit('agent/created', {
        agent: agent as unknown as Agent,
        source: 'startup',
      })
      return denied
    }
    const old = create(Date.now() - 1000)
    assert.deepEqual(old, [])
    // Grok still supplies image_generate while only Codex is disabled, and a
    // disabled Codex web_search withdraws this plugin's search provider rather
    // than denying the host's own web_search tool to every other provider.
    assert.deepEqual(create(Date.now() + 1000), [])
    assert.equal(
      (
        await call('setProviderSettings', {
          provider: 'grok',
          settings: { tools: { image_generate: false, video_generate: false } },
        })
      ).ok,
      true,
    )
    assert.deepEqual(old, [])
    assert.deepEqual(create(Date.now() + 1000).sort(), [
      'image_generate',
      'video_generate',
    ])
    assert.deepEqual([...tools].sort(), [
      'image_generate',
      'video_generate',
      'x_search',
    ])
    assert.equal(
      (await call('setProviderSettings', { provider: 'codex', settings: {} }))
        .ok,
      true,
    )
    assert.equal((await adapters.get('codex')!.listModels('codex')).length, 2)
  } finally {
    globalThis.fetch = originalFetch
    await runtime.dispose()
    CodexAdapter.prototype.resolveOwnModel = originalResolve
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('the Claude route serves the saved prompt-cache TTL override without a restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-ttl-rpc-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const adapters = new Map<string, AccountAwareAdapter>()
  ctx.provide('llm', {
    registerAdapter: (routes: string[], adapter: AccountAwareAdapter) => {
      adapters.set(routes[0], adapter)
      return Object.assign(() => {}, { replace: () => {} })
    },
  })
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  // The catalog behind providerSettings lists models from api.anthropic.com and
  // the CLI version cache checks npm, so the stub goes in before the first RPC
  // call; it records only the messages POST.
  const original = globalThis.fetch
  let body = ''
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === CLAUDE_API_URL) {
      body = String(init?.body)
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'stop here' },
        }),
        { status: 400 },
      )
    }
    if (url === CLAUDE_TOKEN_URL) {
      return new Response(
        JSON.stringify({
          access_token: 'at',
          expires_in: 3_600_000,
          scope: 'scope',
        }),
        { status: 200 },
      )
    }
    if (url === CLAUDE_CLI_VERSION_URL) {
      return new Response(JSON.stringify({ version: '2.1.999' }), {
        status: 200,
      })
    }
    if (url.startsWith('https://api.anthropic.com/v1/models')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'claude-opus-5',
              display_name: 'Claude Opus 5',
              max_input_tokens: 200_000,
            },
          ],
        }),
        { status: 200 },
      )
    }
    throw new Error(`unexpected outbound request to ${url}`)
  }) as typeof globalThis.fetch
  const runtime = ctx.plugin(plugin, {
    providers: ['claude'],
    pool: { enabled: false },
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (!connection.registered()) await runtime
    assert.ok(connection.registered())
    await saveAccountSession('claude', 'acct', {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3_600_000,
      scopes: 'scope',
    })
    const call = (endpoint: string, payload: unknown) =>
      connection.handler(endpoint, payload, new AbortController().signal)
    assert.equal(
      (
        await call('setProviderSettings', {
          provider: 'claude',
          settings: { promptCacheTtl: '30m' },
        })
      ).ok,
      false,
    )
    assert.equal(
      (
        await call('setProviderSettings', {
          provider: 'claude',
          settings: { promptCacheTtl: '1h' },
        })
      ).ok,
      true,
    )
    const catalog = await call('providerSettings', { provider: 'claude' })
    assert.ok(catalog.ok)
    assert.equal(
      (catalog.value as { settings: { promptCacheTtl?: string } }).settings
        .promptCacheTtl,
      '1h',
    )
    // The adapter reads the store per request, so the saved value reaches the
    // next wire body without reconstructing the adapter.
    const adapter = adapters.get('claude') as ClaudeAdapter
    await assert.rejects(async () => {
      for await (const _chunk of adapter.stream({
        provider: 'claude',
        model: 'claude-opus-5',
        system: 'be brief',
        messages: [
          {
            id: MessageId('m'),
            role: 'user',
            content: [{ type: 'text', text: 'hi' }],
            source: { kind: 'user' },
          },
        ],
        maxTokens: 1_000,
      })) {
        /* drain */
      }
    }, 'the fixture answers with an error status')
    const sent = JSON.parse(body) as {
      system: { cache_control?: { ttl?: string } }[]
    }
    assert.deepEqual(
      sent.system
        .filter((block) => block.cache_control !== undefined)
        .map((block) => block.cache_control),
      [{ type: 'ephemeral', ttl: '1h' }],
      'the saved override is on the wire for the next request',
    )
    assert.equal(
      (await call('setProviderSettings', { provider: 'claude', settings: {} }))
        .ok,
      true,
    )
    const cleared = await call('providerSettings', { provider: 'claude' })
    assert.ok(cleared.ok)
    assert.equal(
      (cleared.value as { settings: { promptCacheTtl?: string } }).settings
        .promptCacheTtl,
      undefined,
    )
  } finally {
    globalThis.fetch = original
    await runtime.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('Antigravity registers the real multi-account adapter with provider settings', async () => {
  const { saveAccountSession, authFilePath, accountKeyOf, listAccounts } =
    await import('../src/auth/store.js')
  const home = await mkdtemp(join(tmpdir(), 'antigravity-rpc-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const adapters = new Map<string, AccountAwareAdapter>()
  ctx.provide('llm', {
    registerAdapter: (routes: string[], adapter: AccountAwareAdapter) => {
      adapters.set(routes[0], adapter)
      return Object.assign(() => {}, { replace: () => {} })
    },
  })
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  const runtime = ctx.plugin(plugin, {
    providers: ['antigravity'],
    pool: { enabled: false },
    models: {
      antigravity: [
        { id: 'm1', inputModalities: ['text', 'image'] },
        { id: 'm2', inputModalities: ['text'] },
      ],
    },
    antigravity: {
      clientId: 'configured-client.example.invalid',
      onboard: false,
    },
  })
  try {
    assert.ok(authFilePath().startsWith(home))
    for (const account of ['alice', 'bob']) {
      const session = {
        accessToken: account,
        refreshToken: account,
        expiresAt: Date.now() + 3600_000,
        projectId: `project-${account}`,
        account,
      }
      await saveAccountSession(
        'antigravity',
        accountKeyOf('antigravity', session),
        session,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(
      connection.registered(),
      'the subscriptions-auth Fetch routes were registered',
    )
    assert.deepEqual(
      (await listAccounts('antigravity')).map((entry) => entry.key),
      ['alice', 'bob'],
    )
    const adapter = adapters.get('antigravity')!
    assert.deepEqual(
      (await adapter.listModels('antigravity')).map((model) => model.id),
      ['m1', 'm2'],
    )
    const call = (endpoint: string, payload: unknown) =>
      connection.handler(endpoint, payload, new AbortController().signal)
    const catalog = await call('providerSettings', {
      provider: 'antigravity',
      force: true,
    })
    assert.ok(catalog.ok)
    assert.deepEqual(
      (catalog.value as { models: { id: string }[] }).models.map(
        (model) => model.id,
      ),
      ['m1', 'm2'],
    )
    assert.deepEqual((catalog.value as { tools: string[] }).tools, [])
    assert.deepEqual(
      (catalog.value as { accounts: unknown[] }).accounts,
      ['alice', 'bob'].map((key) => ({
        key,
        label: key,
        models: [
          { id: 'm1', name: 'm1' },
          { id: 'm2', name: 'm2' },
        ],
      })),
    )
    assert.equal(
      (
        await call('setProviderSettings', {
          provider: 'antigravity',
          settings: { visibleModels: ['m2'] },
        })
      ).ok,
      true,
    )
    assert.deepEqual(
      (await adapter.listModels('antigravity')).map((model) => model.id),
      ['m2'],
    )
    assert.equal(
      (
        await call('setProviderSettings', {
          provider: 'antigravity',
          settings: { tools: { image_generate: true } },
        })
      ).ok,
      false,
    )
  } finally {
    await runtime.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
