import test from 'node:test'
import assert from 'node:assert/strict'
import {
  QUOTA_EXCEEDED_CODE,
  CONTEXT_WINDOW_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import {
  responsesFailure,
  ResponsesStreamTranslator,
} from '../src/translate/responses.js'

test('responsesFailure preserves valid provider retry hints without provider text', () => {
  assert.equal(
    responsesFailure('server_is_overloaded', 'busy', {
      'retry-after-ms': '314000',
    }).failure.providerRetryAfterMs,
    314000,
  )
  assert.equal(
    responsesFailure('server_is_overloaded', 'busy', { 'retry-after': '120' })
      .failure.providerRetryAfterMs,
    120000,
  )
  const error = responsesFailure('busy_SECRET', 'message_SECRET', {
    'retry-after': '1',
    'retry-after-ms': '250000',
  })
  assert.equal(error.failure.providerRetryAfterMs, 250000)
  assert.ok(!error.message.includes('SECRET'))
})

test('responsesFailure ignores unusable hints and preserves classifications', () => {
  for (const headers of [
    { 'retry-after': 'not-a-number' },
    { 'retry-after': '0' },
    { 'retry-after': '-5' },
    'nope',
    null,
  ]) {
    assert.equal(
      responsesFailure('server_is_overloaded', 'busy', headers).failure
        .providerRetryAfterMs,
      undefined,
    )
  }
  assert.equal(
    responsesFailure('context_window_exceeded', 'too long').code,
    CONTEXT_WINDOW_EXCEEDED_CODE,
  )
  assert.equal(
    responsesFailure('insufficient_quota', 'no quota').code,
    QUOTA_EXCEEDED_CODE,
  )
})

test('error events read nested retry metadata and retain flat gateway support', () => {
  assert.throws(
    () =>
      new ResponsesStreamTranslator().push({
        type: 'error',
        error: {
          code: 'server_is_overloaded',
          message: 'provider_SECRET',
          headers: { 'retry-after': '314', 'retry-after-ms': '314000' },
        },
      }),
    (error: unknown) => {
      const failure = error as {
        message: string
        code: string
        failure: { providerRetryAfterMs?: number }
      }
      assert.equal(failure.code, 'SERVER')
      assert.equal(failure.failure.providerRetryAfterMs, 314000)
      assert.ok(!failure.message.includes('SECRET'))
      return true
    },
  )
  assert.throws(
    () =>
      new ResponsesStreamTranslator().push({
        type: 'error',
        code: 'server_error',
        message: 'upstream_SECRET',
      }),
    /provider response body omitted/,
  )
})

test('malformed millisecond hints fall back to valid seconds without changing units', () => {
  for (const ms of [null, '', 'junk', -1, false, [], {}, '9e99']) {
    assert.equal(
      responsesFailure('busy', 'busy', {
        'retry-after-ms': ms,
        'retry-after': '120',
      }).failure.providerRetryAfterMs,
      120000,
    )
  }
})
