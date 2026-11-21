import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subscriptionError } from '../src/llm-error.js'
import {
  ACCOUNT_SUSPENDED_CODE,
  httpLlmError,
} from '../src/providers/common.js'
import {
  AUTH_COOLDOWN_MS,
  classifyPoolFailure,
} from '../src/providers/pool-health.js'

test('a structured ToS violation gets a stable code without exposing provider text', async () => {
  const error = await httpLlmError(
    Response.json(
      {
        error: {
          message:
            'customer-input SHORT_SECRET! contact https://example.invalid/appeal',
        },
        details: [{ reason: 'TOS_VIOLATION' }],
      },
      { status: 403 },
    ),
    'antigravity API',
  )
  assert.equal(error.code, ACCOUNT_SUSPENDED_CODE)
  assert.match(error.message, /ACCOUNT_SUSPENDED/)
  assert.doesNotMatch(
    error.message,
    /SHORT_SECRET|example\.invalid|TOS_VIOLATION/,
  )
  assert.deepEqual(classifyPoolFailure(error, 'antigravity'), {
    action: 'switch',
    cooldownMs: AUTH_COOLDOWN_MS,
    reason: ACCOUNT_SUSPENDED_CODE,
    scope: 'account',
  })
})

test('ordinary and malformed 403 responses, plus 401, remain authentication failures', async () => {
  for (const [status, body] of [
    [403, JSON.stringify({ details: [{ reason: 'OTHER' }] })],
    [403, 'not-json-SHORT_SECRET!'],
    [401, JSON.stringify({ details: [{ reason: 'TOS_VIOLATION' }] })],
  ] as const) {
    const error = await httpLlmError(
      new Response(body, { status }),
      'antigravity API',
    )
    assert.equal(error.code, 'AUTH')
    assert.doesNotMatch(error.message, /SHORT_SECRET/)
  }
})

test('pool classification does not mistake suspension for a model-scoped quota window', () => {
  const error = subscriptionError('account suspended', ACCOUNT_SUSPENDED_CODE)
  const action = classifyPoolFailure(error, 'antigravity')
  assert.equal('scope' in action ? action.scope : undefined, 'account')
  assert.equal(
    'cooldownMs' in action ? action.cooldownMs : undefined,
    AUTH_COOLDOWN_MS,
  )
})
