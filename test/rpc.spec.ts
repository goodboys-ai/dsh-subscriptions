/**
 * Unit tests for the `/subscriptions-auth` `image` endpoint: payload
 * validation, the base64 round trip through a fake attachment store, and the
 * no-service / read-failure error results. Drives the real plugin wiring with
 * a fake host connection; DSH_HOME is redirected to a temp dir. Also covers
 * the `status` endpoint degrading per provider when one store entry is corrupt.
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { RpcResult } from '../src/compat.js'
import { createFakeConnection } from './fake-connection.js'
import type { FakeConnectionHandler } from './fake-connection.js'

const home = mkdtempSync(join(tmpdir(), 'router-rpc-test-'))
// Suite-level hook: the mkdtemp is top-level, so there is no test context to hang t.after on.
after(() => { rmSync(home, { recursive: true, force: true }) })
process.env.DSH_HOME = home
/** The auth store every mount in this file shares; a test that writes it removes it again. */
const authFile = join(process.env.DSH_HOME, 'plugins', 'subscriptions', 'auth.json')

// Imports after the env override so the store path resolves under the temp home.
const plugin = await import('../src/index.js')

interface FakeStore {
  readImage(ref: unknown, signal?: AbortSignal): Promise<{ ref: unknown; data: Uint8Array }>
}

/** Mount the plugin with fake llm/connection (and optional attachments); return the RPC handler. */
async function mount(attachments?: FakeStore, credentials?: Pick<CredentialProvider, 'resolve'>): Promise<FakeConnectionHandler> {
  const ctx = new Context()
  ctx.provide('llm', { registerAdapter: () => Object.assign(() => {}, { replace: () => {} }) })
  const fake = createFakeConnection()
  ctx.provide('connection', fake.connection)
  if (attachments !== undefined) ctx.provide('attachments', attachments)
  if (credentials !== undefined) ctx.provide('credentials', credentials as CredentialProvider)
  // codexClientVersion pins the presented version so `status` never reaches
  // for the npm registry (the hermetic run blocks it); the config branch is
  // the deterministic one for a mounted-plugin test.
  ctx.plugin(plugin, { providers: ['codex'], codexClientVersion: '0.153.4' })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(fake.registered(), 'the subscriptions-auth routes were registered')
  return fake.handler
}

test('usage-only RPC reports key presence and rejects unknown sources without exposing secrets', async () => {
  const handler = await mount(undefined, {
    resolve: async ref => ref === 'OPENCODE_GO_API_KEY' ? { value: 'go-secret', source: 'env' } : undefined,
  })
  const signal = new AbortController().signal
  const status = await handler('externalStatus', {}, signal)
  assert.deepEqual(status, { ok: true, value: {
    'opencode-go': { configured: true },
    'kimi-code': { configured: false },
    minimax: { configured: false },
    'minimax-cn': { configured: false },
    'ollama-cloud': { configured: false },
  } })
  assert.ok(!JSON.stringify(status).includes('go-secret'))
  const unknown = await handler('externalUsage', { source: 'not-a-source' }, signal)
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.equal(unknown.error.code, 'bad-request')
  const missing = await handler('externalUsage', { source: 'kimi-code' }, signal)
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.error.message, /not configured/)
})

test('Cursor RPC exposes browser login and status without returning OAuth tokens', async () => {
  const handler = await mount(undefined, { resolve: async () => undefined })
  const signal = new AbortController().signal
  assert.deepEqual(await handler('cursorStatus', {}, signal), {
    ok: true, value: { authenticated: false, busy: false },
  })
  const login = await handler('cursorLogin', {}, signal)
  assert.equal(login.ok, true)
  if (login.ok) {
    const url = new URL((login.value as { authorizeUrl: string }).authorizeUrl)
    assert.equal(url.origin, 'https://cursor.com')
  }
  const busy = await handler('cursorStatus', {}, signal)
  assert.equal(busy.ok && (busy.value as { busy: boolean }).busy, true)
  await handler('cursorCancel', {}, signal)
  const cancelled = await handler('cursorStatus', {}, signal)
  assert.equal(cancelled.ok && (cancelled.value as { busy: boolean }).busy, false)
  const missing = await handler('cursorUsage', {}, signal)
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.error.message, /not signed in/)
  const models = await handler('cursorModels', {}, signal)
  assert.equal(models.ok, false)
  if (!models.ok) assert.match(models.error.message, /not signed in/)
  const catalog = await handler('cursorSettings', {}, signal)
  assert.equal(catalog.ok, true)
  if (catalog.ok) assert.deepEqual((catalog.value as { accounts: unknown[]; models: unknown[] }).accounts, [])
  assert.deepEqual(await handler('cursorSetSettings', { settings: { visibleModels: ['composer-2.5'] } }, signal),
    { ok: true, value: { ok: true } })
  const updated = await handler('cursorSettings', {}, signal)
  if (updated.ok) assert.deepEqual((updated.value as { settings: unknown }).settings,
    { visibleModels: ['composer-2.5'] })
  const invalid = await handler('cursorSetSettings', { settings: { visibleModels: 'all' } }, signal)
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.error.code, 'bad-request')
  for (const endpoint of ['proxyGet', 'proxySet', 'proxyTest']) {
    await assert.rejects(handler(endpoint, {}, signal), /no route registered/)
  }
})

const REF = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 2, width: 1, height: 1 }

async function call(
  handler: FakeConnectionHandler,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  return handler('image', payload, new AbortController().signal)
}

test('image endpoint: base64 round trip through the attachment store', async () => {
  const seen: unknown[] = []
  const handler = await mount({
    readImage: (ref) => {
      seen.push(ref)
      return Promise.resolve({ ref, data: new Uint8Array([104, 105]) })
    },
  })
  const result = await call(handler, REF)
  assert.deepEqual(result, { ok: true, value: { mediaType: 'image/png', dataBase64: 'aGk=' } })
  assert.deepEqual(seen, [REF], 'the full validated reference reaches readImage')
})

test('image endpoint: no attachment service → internal error result', async () => {
  const handler = await mount()
  const result = await call(handler, REF)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'internal')
    assert.match(result.error.message, /no attachment service/)
  }
})

test('image endpoint: read failure → internal error result with the message', async () => {
  const handler = await mount({
    readImage: () => Promise.reject(new Error('digest mismatch')),
  })
  const result = await call(handler, REF)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'internal')
    assert.match(result.error.message, /digest mismatch/)
  }
})

test('image endpoint: payload validation', async () => {
  const handler = await mount({ readImage: () => Promise.reject(new Error('unused')) })
  const bad = [
    [{}, /attachmentId/],
    [{ ...REF, attachmentId: '' }, /attachmentId/],
    [{ ...REF, mediaType: 'image/tiff' }, /mediaType/],
    [{ ...REF, bytes: 0 }, /bytes/],
    [{ ...REF, width: 1.5 }, /width/],
    [{ ...REF, name: 7 }, /name/],
    ['nope', /object/],
  ] as const
  for (const [payload, pattern] of bad) {
    const result = await call(handler, payload)
    assert.equal(result.ok, false, JSON.stringify(payload))
    if (!result.ok) {
      assert.equal(result.error.code, 'bad-request')
      assert.match(result.error.message, pattern)
    }
  }
})

test('video endpoint: base64 round trip from the videos directory', async () => {
  const videosDir = join(process.env.DSH_HOME as string, 'plugins', 'subscriptions', 'videos')
  mkdirSync(videosDir, { recursive: true })
  writeFileSync(join(videosDir, 'clip.mp4'), Buffer.from('hi'))
  const handler = await mount()
  const result = await handler('video', { name: 'clip.mp4' }, new AbortController().signal)
  assert.deepEqual(result, { ok: true, value: { mediaType: 'video/mp4', dataBase64: 'aGk=' } })
})

test('video endpoint: name validation and missing file', async () => {
  const handler = await mount()
  const bad = [
    {},
    { name: '' },
    { name: 'clip.webm' },
    { name: '../escape.mp4' },
    { name: 'a/b.mp4' },
    'nope',
  ]
  for (const payload of bad) {
    const result = await handler('video', payload, new AbortController().signal)
    assert.equal(result.ok, false, JSON.stringify(payload))
    if (!result.ok) assert.equal(result.error.code, 'bad-request')
  }
  const missing = await handler('video', { name: 'absent.mp4' }, new AbortController().signal)
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.error.code, 'internal')
})

test('speed endpoints: per-session tier round trip and payload validation', async () => {
  // Logged in, `speed` would fetch the real Codex catalog for its fast models.
  assert.equal(existsSync(authFile), false, 'another test left a signed-in auth store behind')
  const handler = await mount()
  const signal = new AbortController().signal
  // Logged out and undiscovered: standard tier, no fast-capable models.
  assert.deepEqual(await handler('speed', { sessionId: 's1' }, signal), {
    ok: true,
    value: { tier: 'standard', fastModels: [] },
  })
  assert.deepEqual(await handler('setSpeed', { sessionId: 's1', tier: 'fast' }, signal), {
    ok: true,
    value: { ok: true },
  })
  assert.deepEqual(await handler('speed', { sessionId: 's1' }, signal), {
    ok: true,
    value: { tier: 'fast', fastModels: [] },
  })
  // Another session is unaffected; setting standard clears the entry.
  assert.deepEqual(await handler('speed', { sessionId: 's2' }, signal), {
    ok: true,
    value: { tier: 'standard', fastModels: [] },
  })
  await handler('setSpeed', { sessionId: 's1', tier: 'standard' }, signal)
  assert.deepEqual(await handler('speed', { sessionId: 's1' }, signal), {
    ok: true,
    value: { tier: 'standard', fastModels: [] },
  })

  const bad = [
    ['speed', {}, /sessionId/],
    ['speed', 'nope', /object/],
    ['setSpeed', { sessionId: 's1' }, /tier/],
    ['setSpeed', { sessionId: 's1', tier: 'ludicrous' }, /tier/],
  ] as const
  for (const [endpoint, payload, pattern] of bad) {
    const result = await handler(endpoint, payload, signal)
    assert.equal(result.ok, false, JSON.stringify(payload))
    if (!result.ok) {
      assert.equal(result.error.code, 'bad-request')
      assert.match(result.error.message, pattern)
    }
  }
})

test('status endpoint: one corrupt provider entry degrades alone, others still report', async (t) => {
  // The exact corruption seen in the wild: empty tokens under a claude key.
  // Before the fix this rejected the WHOLE status call and the UI sat on
  // "Checking…" forever with every provider blind.
  mkdirSync(join(authFile, '..'), { recursive: true })
  t.after(() => { rmSync(authFile, { force: true }) })
  writeFileSync(authFile, JSON.stringify({
    codex: { default: 'acct-1', accounts: { 'acct-1': {
      accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, accountId: 'acct-1',
    } } },
    claude: { default: 'corrupt', accounts: { corrupt: { accessToken: '', refreshToken: '', expiresAt: 0 } } },
  }), { mode: 0o600 })
  const handler = await mount()
  const result = await handler('status', {}, new AbortController().signal)
  assert.ok(result.ok, 'the status call itself must succeed')
  if (!result.ok) return
  const providers = (result.value as { providers: Record<string, { accounts: unknown[]; detail?: string }> }).providers
  assert.equal(providers.codex.accounts.length, 1, 'codex still reports its account')
  assert.equal(providers.claude.accounts.length, 0, 'the corrupt claude entry is skipped')
})
