import { test } from 'node:test'
import assert from 'node:assert/strict'
import { httpLlmError, oauthEndpointError } from '../src/providers/common.js'

// Synthetic secrets only. These fixtures must not reach any displayed text,
// including arbitrary customer input that no credential-shape filter recognizes.
const secret = 'SHORT_SECRET!'
const body = '{"error":{"message":"customer-input SHORT_SECRET!"}}'
const marker = '[provider response body omitted]'
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
