import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { CursorAdapter } from 'dsh-subscriptions/cursor-transport'
import { CURSOR_CREDENTIAL_REF, CursorAuth } from '../src/providers/cursor-auth.js'
import type { CursorCredentialService } from '../src/providers/cursor-auth.js'

const omission = '[provider response body omitted]'
const invalidBodies = ['{"error":{"message":"customer-input SHORT_SECRET!"}', 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']

test('Cursor corrupt stored credentials retain SyntaxError without exposing credential prefixes', async () => {
  for (const raw of invalidBodies) {
    const auth = new CursorAuth(memoryStore(raw), async () => assert.fail('corrupt credentials must not start refresh'))
    for (const call of [() => auth.status(), () => auth.accessToken()]) {
      await assert.rejects(call(), (error: unknown) => {
        assert.ok(error instanceof SyntaxError)
        assert.equal(error.cause, undefined)
        assert.doesNotMatch(error.message, /SHORT_SECRET|customer-input|sk-live|\{"error/)
        assert.equal(error.message, `Cursor stored credential: invalid JSON: ${omission}`)
        return true
      })
    }
  }
})

test('Cursor login poll stores only the safe parse message in Settings and stops polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const raw of invalidBodies) {
    let calls = 0
    const store = memoryStore()
    const auth = new CursorAuth(store, async () => { calls++; return new Response(raw) })
    await auth.login()
    t.mock.timers.tick(1000)
    // Drain body parsing and the login catch/finally without real-time polling.
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
    assert.deepEqual(await auth.status(), { authenticated: false, busy: false, error: `Cursor login poll: invalid JSON: ${omission}` })
    assert.equal(calls, 1)
    assert.equal(store.value, undefined)
  }
})

test('Cursor login poll accepts credential-looking valid JSON without changing storage', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const access = 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const store = memoryStore()
  const auth = new CursorAuth(store, async () => Response.json({ accessToken: access, refreshToken: 'refresh' }), () => 1000)
  await auth.login()
  t.mock.timers.tick(1000)
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  assert.deepEqual(JSON.parse(store.value!), { type: 'oauth', access, refresh: 'refresh', expires: 1000 + 24 * 60 * 60_000 })
  assert.deepEqual(await auth.status(), { authenticated: true, busy: false, expiresAt: 1000 + 24 * 60 * 60_000 })
})

function jwt(exp: number): string {
  return `header.${Buffer.from(JSON.stringify({ sub: 'user_123', exp })).toString('base64url')}.signature`
}

function memoryStore(initial?: string): CursorCredentialService & { value: string | undefined } {
  return {
    value: initial,
    async resolve(ref) { assert.equal(ref, CURSOR_CREDENTIAL_REF); return this.value === undefined ? undefined : { value: this.value } },
    async set(ref, value) { assert.equal(ref, CURSOR_CREDENTIAL_REF); this.value = value },
    async unset(ref) { assert.equal(ref, CURSOR_CREDENTIAL_REF); this.value = undefined },
  }
}

test('Cursor auth refreshes an expiring session once and never returns stored tokens in status', async () => {
  const store = memoryStore(JSON.stringify({ type: 'oauth', access: jwt(1001), refresh: 'refresh-secret', expires: 1001_000 }))
  let requests = 0
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    requests++
    assert.equal(url, 'https://api2.cursor.sh/auth/exchange_user_api_key')
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer refresh-secret')
    return Response.json({ accessToken: jwt(2000), refreshToken: 'next-refresh' })
  }) as typeof fetch
  const auth = new CursorAuth(store, http, () => 1000_000)
  assert.deepEqual(await Promise.all([auth.accessToken(), auth.accessToken()]), [jwt(2000), jwt(2000)])
  assert.equal(requests, 1)
  const status = await auth.status()
  assert.deepEqual(status, { authenticated: true, busy: false, expiresAt: 2000_000 })
  assert.ok(!JSON.stringify(status).includes('refresh-secret'))
  await auth.logout()
  assert.deepEqual(await auth.status(), { authenticated: false, busy: false })
})

test('Cursor browser login creates only a cursor.com URL and can be cancelled', async () => {
  const store = memoryStore()
  const auth = new CursorAuth(store, (async () => { throw new Error('poll should not run before cancellation') }) as typeof fetch)
  const { authorizeUrl } = await auth.login()
  const url = new URL(authorizeUrl)
  assert.equal(url.origin, 'https://cursor.com')
  assert.equal(url.pathname, '/loginDeepControl')
  assert.equal(url.searchParams.get('mode'), 'login')
  assert.ok(url.searchParams.has('challenge'))
  assert.equal((await auth.status()).busy, true)
  await auth.cancel()
  assert.equal((await auth.status()).busy, false)
  assert.equal(store.value, undefined)
})

test('an in-flight refresh cannot return a token after sign-out', async () => {
  const store = memoryStore(JSON.stringify({ type: 'oauth', access: jwt(1001), refresh: 'old-refresh', expires: 1001_000 }))
  let answer: ((response: Response) => void) | undefined
  const http = (async () => new Promise<Response>(resolve => { answer = resolve })) as typeof fetch
  const auth = new CursorAuth(store, http, () => 1000_000)
  const pending = auth.accessToken()
  await new Promise(resolve => setTimeout(resolve, 0))
  await auth.logout()
  assert.ok(answer)
  answer(Response.json({ accessToken: jwt(2000), refreshToken: 'new-refresh' }))
  await assert.rejects(pending, /signed out during token refresh/)
  assert.equal(store.value, undefined)
})

test('a stored credential that starts with "quota" is not classified as a rate limit', async () => {
  // V8's parse error quotes the first ten characters of the input, so the raw
  // JSON.parse message for this body is `Unexpected token 'q', "quota exce"...`.
  // The vendor derives a stream failure's code from that message text and
  // matched `quota` as RATE_LIMIT. This drives the real vendor stream and
  // asserts the code, which is the only place the old mechanism was observable.
  const auth = new CursorAuth(memoryStore('quota exceeded: not json'), async () => assert.fail('corrupt credentials must not start refresh'))
  const chunks: StreamChunk[] = []
  for await (const chunk of new CursorAdapter({ auth, createAgentRun: () => assert.fail('no run may start') }).stream({
    provider: 'cursor-subscription', model: 'composer-2.5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })) chunks.push(chunk)
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error')
  assert.equal(finish.reason.failure.code, 'CURSOR_ERROR')
  assert.equal(finish.reason.failure.message, `Cursor stored credential: invalid JSON: ${omission}`)
})
