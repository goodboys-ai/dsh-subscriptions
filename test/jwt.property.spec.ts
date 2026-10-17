/**
 * Property tests for decodeJwtPayload. Its contract: a well-formed compact
 * JWT with a JSON object payload decodes to that object, and anything else —
 * truncated, non-base64url, non-JSON, or a non-object payload — yields
 * `undefined` rather than throwing, because the caller reads claims off
 * provider-issued tokens it does not control.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { decodeJwtPayload } from '../src/auth/jwt.js'

/** Any JSON object payload, as an id_token claim set. */
const payload = fc.dictionary(
  fc.string({ maxLength: 12 }),
  fc.jsonValue({ maxDepth: 3 }),
  { maxKeys: 8 },
)

/** A base64url segment, with or without `=` padding (both encodings occur). */
function base64url(text: string, padded: boolean): string {
  const buffer = Buffer.from(text, 'utf8')
  return padded
    ? buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_')
    : buffer.toString('base64url')
}

const jwtFor = (claims: string): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.boolean(),
      fc.boolean(),
      fc.string({
        unit: fc.constantFrom('a', 'B', '0', '-', '_'),
        maxLength: 12,
      }),
    )
    .map(([padded, withSignature, signature]) => {
      const head = base64url('{"alg":"none"}', padded)
      const body = base64url(claims, padded)
      return withSignature ? `${head}.${body}.${signature}` : `${head}.${body}`
    })

test('decodeJwtPayload: object payloads round-trip through base64url, padded or not', () => {
  fc.assert(
    fc.property(
      payload.chain((claims) =>
        fc.tuple(fc.constant(claims), jwtFor(JSON.stringify(claims))),
      ),
      ([claims, token]) => {
        // fc.dictionary keys live on a null-prototype object; the JSON round
        // trip is the equal footing the decode shares with JSON.parse.
        assert.deepEqual(
          decodeJwtPayload(token),
          JSON.parse(JSON.stringify(claims)),
        )
      },
    ),
    { numRuns: 200 },
  )
})

test('decodeJwtPayload: non-object payloads are rejected', () => {
  const nonObject = fc.oneof(
    fc.array(fc.jsonValue({ maxDepth: 2 }), { maxLength: 4 }),
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
  )
  fc.assert(
    fc.property(
      nonObject.chain((value) => jwtFor(JSON.stringify(value))),
      (token) => {
        assert.equal(decodeJwtPayload(token), undefined)
      },
    ),
    { numRuns: 200 },
  )
})

test('decodeJwtPayload: arbitrary strings never throw and never return a non-object', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 300 }), (token) => {
      const decoded = decodeJwtPayload(token)
      assert.ok(
        decoded === undefined ||
          (typeof decoded === 'object' &&
            decoded !== null &&
            !Array.isArray(decoded)),
        'malformed tokens must decode to undefined, never crash or return a non-object',
      )
    }),
    { numRuns: 200 },
  )
})
