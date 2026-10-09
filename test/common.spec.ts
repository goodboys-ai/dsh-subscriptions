import { test } from 'node:test'
import assert from 'node:assert/strict'
import { httpLlmError, oauthEndpointError, OAuthEndpointError, TokenManager, parseProviderJson } from '../src/providers/common.js'
import { exchangeGrokCode, refreshGrok, grokDiscovery, resetGrokDiscoveryForTests, fetchGrokUsage, fetchGrokCliCatalog, fetchGrokModels, GROK_DISCOVERY_URL, GROK_CLI_MODELS_URL } from '../src/providers/grok.js'
import { exchangeCodexCode, refreshCodex, fetchCodexUsage, fetchCodexModels, fetchCodexResetCredits, consumeCodexResetCredit } from '../src/providers/codex.js'
import { exchangeClaudeCode, refreshClaude, fetchClaudeUsage, fetchClaudeModels, CLAUDE_PROFILE_URL } from '../src/providers/claude.js'
import { exchangeCopilotToken, fetchCopilotModels, resetVsCodeVersionCacheForTests, VSCODE_RELEASES_URL } from '../src/providers/copilot.js'
import { AntigravityAdapter, discoverAntigravityAccount, exchangeAntigravityCode, refreshAntigravity, fetchAntigravityModels, fetchAntigravityUsage, ANTIGRAVITY_USERINFO_URL } from '../src/providers/antigravity.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { CursorAuth } from '../src/providers/cursor-auth.js'
import { fetchMiniMaxUsage } from '../src/providers/minimax-usage.js'
import type { GrokSession, CodexSession, ClaudeSession, CopilotSession, AntigravitySession } from '../src/auth/store.js'

// Synthetic secrets only. These fixtures must not reach any displayed text,
// including arbitrary customer input that no credential-shape filter recognizes.
const secret = 'SHORT_SECRET!'
const body = '{"error":{"message":"customer-input SHORT_SECRET!"}}'
const marker = '[provider response body omitted]'

const timed = { accessToken: 'at', refreshToken: 'rt', expiresAt: 2_000_000_000_000 }
const grok: GrokSession = { ...timed, tokenEndpoint: 'https://auth.x.ai/token' }
const codex: CodexSession = { ...timed, accountId: 'acct' }
const claude: ClaudeSession = { ...timed, scopes: 'scope' }
const copilot: CopilotSession = { ...timed }
const antigravity: AntigravitySession = { ...timed, projectId: 'project' }
const oauth = { clientId: 'test-client' }
const runtime = { baseURL: 'https://antigravity.example.invalid', onboard: false }
const cliVersion = async () => '2.1.1'
const tokenPayload = { access_token: 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', refresh_token: 'rt', expires_in: 3600,
  id_token: `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } })).toString('base64url')}.signature` }

type ParseSite = { origin: string; payload: object; run: (http: typeof fetch) => Promise<unknown>; target?: (url: string) => boolean }
const parseSites: ParseSite[] = [
  { origin: 'grok OIDC discovery', payload: { authorization_endpoint: 'https://auth.x.ai/authorize', token_endpoint: grok.tokenEndpoint }, run: () => grokDiscovery() },
  { origin: 'grok token exchange', payload: tokenPayload, run: () => exchangeGrokCode('code', 'verifier', 'redirect', 'challenge'), target: url => url !== GROK_DISCOVERY_URL },
  { origin: 'grok token refresh', payload: tokenPayload, run: () => refreshGrok(grok) },
  { origin: 'grok billing', payload: { config: { creditUsagePercent: 25 } }, run: http => fetchGrokUsage(grok, http) },
  { origin: 'grok CLI catalog', payload: { data: [{ id: 'grok-4' }] }, run: http => fetchGrokCliCatalog(grok, http) },
  { origin: 'grok models', payload: { data: [{ id: 'grok-4' }] }, run: http => fetchGrokModels(grok, http), target: url => url !== GROK_CLI_MODELS_URL },
  { origin: 'codex token exchange', payload: tokenPayload, run: () => exchangeCodexCode('code', 'verifier', 'redirect') },
  { origin: 'codex token refresh', payload: tokenPayload, run: () => refreshCodex(codex) },
  { origin: 'codex reset credits', payload: { credits: [] }, run: http => fetchCodexResetCredits(codex, http) },
  { origin: 'codex consume reset', payload: { code: 'reset' }, run: http => consumeCodexResetCredit(codex, 'credit', 'request', http) },
  { origin: 'codex usage', payload: { rate_limit: {} }, run: http => fetchCodexUsage(codex, http) },
  { origin: 'codex models', payload: { models: [{ slug: 'gpt-5' }] }, run: http => fetchCodexModels(codex, http) },
  { origin: 'claude token exchange', payload: tokenPayload, run: () => exchangeClaudeCode('code', 'verifier', 'redirect', 'state') },
  { origin: 'claude token refresh', payload: tokenPayload, run: () => refreshClaude(claude) },
  { origin: 'claude usage', payload: {}, run: http => fetchClaudeUsage(claude, http, undefined, cliVersion) },
  { origin: 'claude models API', payload: { data: [{ id: 'claude-test' }] }, run: http => fetchClaudeModels(claude, http, undefined, cliVersion) },
  { origin: 'copilot token exchange', payload: { token: tokenPayload.access_token, expires_at: 2_000_000_000 }, run: http => exchangeCopilotToken('github-token', http) },
  { origin: 'copilot models', payload: { data: [{ id: 'gpt-5', model_picker_enabled: true }] }, run: http => fetchCopilotModels(copilot, http) },
  { origin: 'Antigravity token exchange', payload: tokenPayload, run: http => exchangeAntigravityCode('code', 'verifier', 'redirect', oauth, runtime, http) },
  { origin: 'Antigravity token refresh', payload: tokenPayload, run: http => refreshAntigravity(antigravity, oauth, http) },
  { origin: 'Antigravity loadCodeAssist', payload: { cloudaicompanionProject: 'project' }, run: http => discoverAntigravityAccount('at', runtime, http) },
  { origin: 'Antigravity onboardUser', payload: { done: true, response: { cloudaicompanionProject: 'project' } }, run: http => discoverAntigravityAccount('at', { ...runtime, onboard: true }, http), target: url => url.endsWith(':onboardUser') },
  { origin: 'Antigravity fetchAvailableModels', payload: { models: { 'gemini-test': {} } }, run: http => fetchAntigravityModels(antigravity, runtime, http) },
  { origin: 'Antigravity generateContent', payload: { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] } }, run: http => {
    const tokens = new AccountTokenManager<AntigravitySession>({ provider: 'antigravity', displayName: 'Test', makeOptions: () => ({ preemptMs: 0, refresh: async s => s, isPermanent: () => false }), io: { list: async () => [{ key: 'acct', session: antigravity }], get: async () => antigravity, save: async () => {}, remove: async () => {} } })
    return new AntigravityAdapter({ tokens, models: [], discovery: false, streamIdleTimeoutMs: 1000, runtime, fetchFn: http }).generate({ provider: 'antigravity', model: 'gemini-test', messages: [] })
  } },
  { origin: 'MiniMax usage', payload: { model_remains: [{ model_name: 'MiniMax', current_interval_remaining_percent: 50 }] }, run: http => fetchMiniMaxUsage('subscription-key', 'global', http) },
  { origin: 'Cursor token refresh', payload: { accessToken: tokenPayload.access_token, refreshToken: 'rt' }, run: http => {
    let value = JSON.stringify({ type: 'oauth', access: 'at', refresh: 'rt', expires: 0 })
    return new CursorAuth({ resolve: async () => ({ value }), set: async (_ref, next) => { value = next }, unset: async () => {} }, http).accessToken()
  } },
]

// Exercise real provider entry points; the only fake is the outbound transport.
for (const site of parseSites) {
  test(`JSON parse failure omits text and preserves SyntaxError: ${site.origin}`, async t => {
    const rawBodies = ['sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', body.slice(0, -1), body.slice(0, -4), '<html>token SHORT_SECRET!</html>']
    for (const raw of rawBodies) {
      resetGrokDiscoveryForTests()
      resetVsCodeVersionCacheForTests()
      let targetCalls = 0
      const http: typeof fetch = async input => {
        const url = String(input)
        if (url === VSCODE_RELEASES_URL) return Response.json(['1.107.0'])
        if (site.target !== undefined && !site.target(url)) {
          if (url === GROK_DISCOVERY_URL) return Response.json({ authorization_endpoint: 'https://auth.x.ai/authorize', token_endpoint: grok.tokenEndpoint })
          if (url.endsWith(':loadCodeAssist')) return Response.json({})
          return Response.json({ data: [] })
        }
        targetCalls++
        return new Response(raw)
      }
      t.mock.method(globalThis, 'fetch', http)
      await assert.rejects(site.run(http), (error: unknown) => {
        assert.ok(error instanceof SyntaxError)
        assert.equal(error.name, 'SyntaxError')
        assert.equal('code' in error, false)
        assert.equal(error.cause, undefined)
        assert.doesNotMatch(error.message, /SHORT_SECRET|customer-input|sk-live|\{"error|<html>/)
        assert.equal(error.message, `${site.origin}: invalid JSON: ${marker}`)
        return true
      })
      assert.equal(targetCalls, 1, 'parse failure must not retry the endpoint')
    }
  })
  // Field fidelity is asserted directly on the helper; what this per-site case
  // adds is that the site still parses when the body carries a credential-looking
  // field. The name says that, rather than claiming retention this loop only
  // checks for most sites.
  test(`JSON parse success is unaffected by credential-looking fields: ${site.origin}`, async t => {
    resetGrokDiscoveryForTests()
    resetVsCodeVersionCacheForTests()
    const http: typeof fetch = async input => {
      const url = String(input)
      if (url === VSCODE_RELEASES_URL) return Response.json(['1.107.0'])
      if (url === CLAUDE_PROFILE_URL || url === ANTIGRAVITY_USERINFO_URL) return Response.json({})
      if (site.target !== undefined && !site.target(url)) {
        if (url === GROK_DISCOVERY_URL) return Response.json({ authorization_endpoint: 'https://auth.x.ai/authorize', token_endpoint: grok.tokenEndpoint })
        if (url.endsWith(':loadCodeAssist')) return Response.json({})
        return Response.json({ data: [] })
      }
      if (url.endsWith(':loadCodeAssist') && site.origin === 'Antigravity token exchange') return Response.json({ cloudaicompanionProject: 'project' })
      return Response.json({ ...site.payload, credential: tokenPayload.access_token })
    }
    t.mock.method(globalThis, 'fetch', http)
    const result = await site.run(http)
    if (site.origin.includes('token exchange') || site.origin.includes('token refresh')) {
      assert.equal(typeof result === 'string' ? result : (result as { accessToken: string }).accessToken, tokenPayload.access_token)
    } else if (site.origin === 'codex consume reset') assert.equal(result, undefined)
    else assert.ok(result !== undefined)
  })
}

test('JSON parse refresh failure remains transient, with the same TokenManager AUTH classification', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
  try {
    let removed = false
    const manager = new TokenManager({ displayName: 'codex', preemptMs: 0, load: async () => ({ ...codex, expiresAt: 0 }), save: async () => {}, remove: async () => { removed = true }, refresh: refreshCodex, isPermanent: error => error instanceof OAuthEndpointError })
    await assert.rejects(manager.session(), (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error)
      assert.equal(error.code, 'AUTH')
      assert.ok(error.cause instanceof SyntaxError)
      assert.equal(error.cause.message, `codex token refresh: invalid JSON: ${marker}`)
      return true
    })
    assert.equal(removed, false)
  } finally { globalThis.fetch = original }
})
test('safe JSON helper preserves values and non-parse failures without retaining unsafe causes', async () => {
  const payload = { credential: tokenPayload.access_token, nested: [null, true, 2, 'text'] }
  for (const value of [payload, null, [payload], 42, 'sk-live-credential']) {
    const text = JSON.stringify(value)
    assert.deepEqual(await parseProviderJson(text, 'fixture JSON'), value)
    assert.deepEqual(await parseProviderJson(new Response(text), 'fixture JSON'), value)
  }
  for (const raw of ['sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', body.slice(0, -1), body.slice(0, -4), '<html>token SHORT_SECRET!</html>']) {
    for (const input of [raw, new Response(raw)]) {
      await assert.rejects(parseProviderJson(input, 'fixture JSON'), error => {
        assert.ok(error instanceof SyntaxError)
        assert.equal(error.message, `fixture JSON: invalid JSON: ${marker}`)
        assert.equal(error.cause, undefined)
        return true
      })
    }
  }
  const aborted = new DOMException('cancelled', 'AbortError')
  const readFailed = new TypeError('body read failed')
  for (const error of [aborted, readFailed]) {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(error) } }))
    await assert.rejects(parseProviderJson(response, 'fixture JSON'), actual => actual === error)
  }
  const consumed = new Response('{}')
  await consumed.json()
  await assert.rejects(parseProviderJson(consumed, 'fixture JSON'), TypeError)
})

const bodies = [
  body,
  '{"nested":{"password":"short"}}',
  '<html>customer-input SHORT_SECRET!</html>',
  '{malformed customer-input SHORT_SECRET!',
  'short opaque credential: abc123',
  'Bearer fixtureOAuthToken_AbCdEf0123456789; sk-fixtureKey0123456789',
  '{"error":"unrecognised_provider_code_SHORT_SECRET!"}',
  '{"message":"escaped \\u0053HORT_SECRET! and \\n newline"}',
  'customer-input\nSHORT_SECRET!\nnext line',
  `ordinary text ${'x'.repeat(600)} customer-input SHORT_SECRET!`,
  '{"error":{"message":"Invalid parameter: temperature"}}',
  'Your plan does not support this model. Upgrade your subscription.',
  'Model not found: claude-sonnet-4-6',
]

function assertNoProviderText(message: string): void {
  assert.doesNotMatch(message, /SHORT_SECRET|customer-input|abc123|fixtureOAuth|sk-fixture|unrecognised_provider_code|escaped|newline|ordinary text|Invalid parameter|Your plan|Model not found/)
}

test('HTTP regression: neither message nor failure.message contains arbitrary provider text', async () => {
  const error = await httpLlmError(new Response(body, { status: 401 }), 'fixture API')
  assert.equal(error.message, `fixture API error (HTTP 401, AUTH): ${marker}`)
  assert.equal(error.failure.message, error.message)
  assert.doesNotMatch(error.message, /SHORT_SECRET!|customer-input/)
  assert.doesNotMatch(error.failure.message, /SHORT_SECRET!|customer-input/)
  assert.equal(error.cause, undefined)
})

test('HTTP omits all non-empty bodies, including ordinary diagnostics and malformed text', async () => {
  for (const raw of bodies) {
    const error = await httpLlmError(new Response(raw, { status: 400 }), 'fixture API')
    assert.equal(error.message, `fixture API error (HTTP 400, HTTP_400): ${marker}`)
    assert.equal(error.failure.message, error.message)
    assertNoProviderText(error.message)
  }
  const empty = await httpLlmError(new Response('', { status: 400 }), 'fixture API')
  assert.equal(empty.message, 'fixture API error (HTTP 400, HTTP_400)')
})

test('HTTP classification, status and retry fields stay pinned while body text is omitted', async (t) => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000)
  const fixtures = [
    [401, 'invalid credential', 'AUTH', undefined],
    [403, 'plan restriction', 'AUTH', undefined],
    [429, 'Weekly usage limit exceeded', 'RATE_LIMIT', 32_000],
    [402, 'Weekly usage limit exceeded', 'QUOTA', undefined],
    [400, 'context window exceeded', 'CONTEXT_WINDOW_EXCEEDED', undefined],
    [408, 'timeout', 'TIMEOUT', undefined],
    [504, 'timeout', 'TIMEOUT', undefined],
    [503, 'server overloaded', 'SERVER', 32_000],
    [404, 'model not found', 'HTTP_404', undefined],
  ] as const
  for (const [status, diagnostic, code, wait] of fixtures) {
    const error = await httpLlmError(new Response(`${diagnostic}: ${secret}`, {
      status,
      headers: wait === undefined ? {} : { 'retry-after': '30' },
    }), 'fixture API')
    assert.equal(error.code, code)
    assert.deepEqual(error.failure, {
      message: error.message,
      code,
      status,
      ...wait === undefined ? {} : { providerRetryAfterMs: wait },
    })
  }
  // Classification still uses the old 500-character excerpt, not the full body.
  const beyond = await httpLlmError(new Response(`${'x'.repeat(501)} context window exceeded`, { status: 400 }), 'fixture API')
  assert.equal(beyond.code, 'HTTP_400')
})

test('reset readers retain the raw full body and provider-over-Google-over-header precedence', async (t) => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000)
  const raw = JSON.stringify({
    error: { message: secret },
    padding: 'x'.repeat(600),
    quotaResetDelay: '90s',
  })
  const response = () => new Response(raw, { status: 429, headers: { 'retry-after': '30' } })
  const received = response()
  const provider = await httpLlmError(received, 'fixture API', {
    rateLimitReset: (actual, original, now) => {
      assert.equal(actual, received)
      assert.equal(original, raw)
      return now + 45_000
    },
  })
  assert.equal(provider.failure.providerRetryAfterMs, 47_000)
  const google = await httpLlmError(response(), 'fixture API')
  assert.equal(google.failure.providerRetryAfterMs, 92_000)
  const header = await httpLlmError(new Response(body, {
    status: 429, headers: { 'retry-after': '30' },
  }), 'fixture API')
  assert.equal(header.failure.providerRetryAfterMs, 32_000)
  const server = await httpLlmError(new Response(raw, {
    status: 503, headers: { 'retry-after': '30' },
  }), 'fixture API', {
    rateLimitReset: () => assert.fail('non-429 must not consult the provider reset reader'),
  })
  assert.equal(server.failure.providerRetryAfterMs, 32_000)
  for (const error of [provider, google, header, server]) assertNoProviderText(error.message)
})

test('warning regression: neither response body nor arbitrary header values reach diagnostics', async () => {
  const warnings: string[] = []
  const error = await httpLlmError(new Response(body, {
    status: 429,
    headers: { 'x-ratelimit-reset': 'header-secret SHORT_SECRET!', 'x-codex-custom': 'customer-input' },
  }), 'fixture API', { onWarn: message => warnings.push(message) })
  assert.deepEqual(warnings, [
    `fixture API: 429 disclosed no reset time; [provider response headers omitted]: ${marker}`,
  ])
  assertNoProviderText(warnings[0])
  assert.doesNotMatch(warnings[0], /header-secret|x-ratelimit|x-codex/)
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(error.failure.status, 429)
  assert.equal(error.failure.providerRetryAfterMs, undefined)
})

test('OAuth regression: provider detail is omitted while structural classification fields survive', async () => {
  for (const envelope of [
    { error: 'invalid_grant', error_description: 'customer-input SHORT_SECRET!' },
    { error: { code: 'invalid_grant', message: 'customer-input SHORT_SECRET!' } },
  ]) {
    const error = await oauthEndpointError(new Response(JSON.stringify(envelope), {
      status: 401, headers: { 'retry-after': '30' },
    }), 'fixture')
    assert.equal(error.message, `fixture token endpoint error (HTTP 401): ${marker}`)
    assertNoProviderText(error.message)
    assert.equal(error.oauthCode, 'invalid_grant')
    assert.equal(error.status, 401)
    assert.equal(error.retryAfterMs, 30_000)
    assert.equal(error.name, 'OAuthEndpointError')
    assert.equal(error.cause, undefined)
  }
})

test('OAuth omits arbitrary codes, ordinary diagnostics and non-JSON bodies', async () => {
  for (const raw of bodies) {
    const error = await oauthEndpointError(new Response(raw, { status: 400 }), 'fixture')
    assert.equal(error.message, `fixture token endpoint error (HTTP 400): ${marker}`)
    assertNoProviderText(error.message)
    assert.equal(error.status, 400)
  }
  const unknown = await oauthEndpointError(new Response(JSON.stringify({
    error: 'unrecognised_provider_code_SHORT_SECRET!',
  }), { status: 400 }), 'fixture')
  assert.equal(unknown.oauthCode, 'unrecognised_provider_code_SHORT_SECRET!')
  assertNoProviderText(unknown.message)
  const empty = await oauthEndpointError(new Response('', { status: 400 }), 'fixture')
  assert.equal(empty.message, 'fixture token endpoint error (HTTP 400)')
  assert.equal(empty.oauthCode, undefined)
})
