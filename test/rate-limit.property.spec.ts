/**
 * Property tests for the shared rate-limit parsing primitives. These decide
 * how long a turn parks on a 429, so the invariants under test are the ones a
 * bad parse would break: a disclosed delay must become the exact reset
 * instant, both RFC 7231 `retry-after` forms must be honored, a non-positive
 * or unrecognized disclosure must be ignored rather than scheduled, and the
 * earliest disclosed reset must win no matter how the provider ordered or
 * nested its fields.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import {
  durationMs,
  resetFromFields,
  resetInstantFromNumber,
  retryAfterInstant,
  waitFromReset,
} from '../src/providers/rate-limit.js'

/** A fixed clock, so every expectation is an exact number rather than a window. */
const NOW = 1_800_000_000_000

/** A 429 carrying the given `retry-after` header value. */
function withRetryAfter(value: string): Response {
  return new Response('', { status: 429, headers: { 'retry-after': value } })
}

test('retryAfterInstant: a positive delay in seconds becomes the exact reset instant', () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0.001, max: 1_000_000, noNaN: true }),
      (seconds) => {
        assert.equal(
          retryAfterInstant(withRetryAfter(String(seconds)), NOW),
          NOW + seconds * 1_000,
        )
      },
    ),
    { numRuns: 200 },
  )
})

test('retryAfterInstant: the HTTP-date form parses to its instant', () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 4_000_000_000_000 }), (instant) => {
      const instantSeconds = Math.floor(instant / 1_000) * 1_000
      assert.equal(
        retryAfterInstant(withRetryAfter(new Date(instant).toUTCString()), NOW),
        instantSeconds,
      )
    }),
    { numRuns: 200 },
  )
})

test('retryAfterInstant: a non-positive delay is no disclosure at all', () => {
  fc.assert(
    fc.property(
      fc.double({ min: -1_000_000, max: 0, noNaN: true }),
      (seconds) => {
        // Zero and negative delays are not a reopening time; scheduling a wait
        // of `now` would burn the retry budget against a still-closed window.
        assert.equal(
          retryAfterInstant(withRetryAfter(String(seconds)), NOW),
          undefined,
        )
      },
    ),
    { numRuns: 200 },
  )
})

test('retryAfterInstant: arbitrary header values never throw and never yield NaN', () => {
  // Header values are byte strings, so the fuzz alphabet stays ASCII.
  const headerJunk = fc.string({
    unit: fc.constantFrom(
      '0',
      '1',
      '9',
      '.',
      '-',
      '+',
      ' ',
      's',
      'm',
      'h',
      'x',
      'GMT',
      'Jan',
      ':',
      ',',
      'e',
    ),
    maxLength: 40,
  })
  fc.assert(
    fc.property(headerJunk, (value) => {
      const instant = retryAfterInstant(withRetryAfter(value), NOW)
      assert.ok(
        instant === undefined || Number.isFinite(instant),
        'a bad header must be ignored, not parsed to NaN',
      )
    }),
    { numRuns: 200 },
  )
})

test('resetInstantFromNumber: each protocol meaning maps to its instant', () => {
  // The magnitude heuristic works because the three meanings occupy disjoint
  // ranges: a delay a provider would send is at most hours of seconds, an
  // epoch-seconds stamp is ~1.8e9 today, and an epoch-milliseconds one is a
  // thousand times that. Each generator below produces a plausible real
  // value of one meaning, and the expectation is that meaning applied — the
  // generated date, timestamp, or delay — so a regressed threshold fails the
  // class it misreads instead of passing against a copy of its own branches.
  /** A real instant in epoch milliseconds, 2001-09-09 through 2100. */
  const epochMs = fc.integer({
    min: 1_000_000_000_000,
    max: Date.UTC(2100, 0, 1),
  })
  /** The same timeline in epoch seconds, whole or fractional. */
  const epochSeconds = fc.oneof(
    fc.integer({ min: 1_000_000_000, max: Date.UTC(2100, 0, 1) / 1_000 }),
    fc.double({
      min: 1_000_000_000,
      max: Date.UTC(2100, 0, 1) / 1_000,
      noNaN: true,
    }),
  )
  /** A delay in seconds within a year, weighted to include tiny sub-second and whole-second values. */
  const delaySeconds = fc.oneof(
    { weight: 2, arbitrary: fc.integer({ min: 1, max: 31_536_000 }) },
    { weight: 1, arbitrary: fc.double({ min: 0.001, max: 1, noNaN: true }) },
    {
      weight: 1,
      arbitrary: fc.double({ min: 1, max: 31_536_000, noNaN: true }),
    },
  )
  /** A value no meaning attaches to: non-positive or non-finite. */
  const unusable = fc.oneof(
    fc.double({ min: -1e15, max: 0, noNaN: true }),
    fc.constant(Number.NaN),
    fc.constant(Number.POSITIVE_INFINITY),
    fc.constant(Number.NEGATIVE_INFINITY),
  )
  fc.assert(
    fc.property(
      fc.oneof(
        epochMs.map((value) => ({ value, expected: value })),
        epochSeconds.map((value) => ({ value, expected: value * 1_000 })),
        delaySeconds.map((value) => ({ value, expected: NOW + value * 1_000 })),
        unusable.map((value) => ({
          value,
          expected: undefined as number | undefined,
        })),
      ),
      ({ value, expected }) => {
        assert.equal(resetInstantFromNumber(value, NOW), expected)
      },
    ),
    { numRuns: 400 },
  )
})

test('resetInstantFromNumber: boundary magnitudes are read by their protocol meaning', () => {
  // A delay a provider sends is far smaller than an epoch-seconds stamp,
  // which is far smaller than an epoch-milliseconds one, so magnitude alone
  // separates the shapes for any plausible value. These are the seams.
  // The first epoch-seconds value of 2001-09-09 — ten digits — is seconds.
  assert.equal(resetInstantFromNumber(1_000_000_000, NOW), 1_000_000_000_000)
  // One second less is ~31.7 years: plausible as a delay, not as a date.
  assert.equal(resetInstantFromNumber(999_999_999, NOW), NOW + 999_999_999_000)
  // The same instant written in milliseconds is already milliseconds.
  assert.equal(
    resetInstantFromNumber(1_000_000_000_000, NOW),
    1_000_000_000_000,
  )
})

/** The reset keys this reader searches for, plus noise keys it must ignore. */
const RESET_KEYS = [
  'reset_at',
  'retry_after',
  'resets',
  'reset',
  'window_reset',
] as const
const NOISE_KEYS = ['note', 'detail', 'info', 'meta'] as const

interface FieldEntry {
  key: string
  matching: boolean
  /** Delay in seconds, small enough to take the delay-seconds path. */
  delay: number
  /** Wrap the delay one level down under `reset_at`, as nested payloads do. */
  nested: boolean
}

const fieldEntries: fc.Arbitrary<FieldEntry[]> = fc
  .uniqueArray(fc.constantFrom(...RESET_KEYS, ...NOISE_KEYS), {
    minLength: 1,
    maxLength: 9,
  })
  .chain((keys) =>
    fc
      .array(
        fc.record({
          delay: fc.double({ min: 0.5, max: 100_000, noNaN: true }),
          nested: fc.boolean(),
        }),
        { minLength: keys.length, maxLength: keys.length },
      )
      .map((specs) =>
        keys.map((key, index) => ({
          key,
          matching: (RESET_KEYS as readonly string[]).includes(key),
          delay: specs[index].delay,
          nested: specs[index].nested,
        })),
      ),
  )

/** The body one entry ordering produces; a matching key holds its value flat. */
function bodyFrom(entries: readonly FieldEntry[]): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const entry of entries) {
    body[entry.key] = entry.nested ? { reset_at: entry.delay } : entry.delay
  }
  return body
}

/**
 * The earliest instant the entries disclose, known by construction. The
 * contract of `resetFromFields` (its JSDoc) is that the value found under a
 * matching key is the reset instant itself: a matching key holding a flat
 * delay is a disclosure, while a matching key holding an object is not one —
 * the object is the field's value, not a container to search. A noise key's
 * value is searched deeper, so its `{ reset_at: v }` discloses one level down.
 */
function expectedReset(entries: readonly FieldEntry[]): number | undefined {
  const candidates = entries
    .filter(
      (entry) =>
        (entry.matching && !entry.nested) || (!entry.matching && entry.nested),
    )
    .map((entry) => NOW + entry.delay * 1_000)
  return candidates.length > 0 ? Math.min(...candidates) : undefined
}

test('resetFromFields: the earliest disclosed reset wins, independent of field order', () => {
  fc.assert(
    fc.property(fieldEntries, (entries) => {
      const instant = resetFromFields(bodyFrom(entries), RESET_KEYS, NOW)
      assert.equal(instant, expectedReset(entries))

      // Providers move fields between containers and reorder them across
      // versions; the answer must not depend on object key order.
      const shuffled = [...entries].reverse()
      assert.equal(
        resetFromFields(bodyFrom(shuffled), RESET_KEYS, NOW),
        instant,
      )
    }),
    { numRuns: 200 },
  )
})

test('durationMs: a well-formed Go duration sums its components', () => {
  const component = fc.option(fc.integer({ min: 1, max: 999 }), {
    nil: undefined,
  })
  fc.assert(
    fc.property(
      fc
        .record({ h: component, m: component, s: component, ms: component })
        .filter((parts) =>
          Object.values(parts).some((value) => value !== undefined),
        ),
      (parts) => {
        const text = [
          parts.h === undefined ? '' : `${parts.h}h`,
          parts.m === undefined ? '' : `${parts.m}m`,
          parts.s === undefined ? '' : `${parts.s}s`,
          parts.ms === undefined ? '' : `${parts.ms}ms`,
        ].join('')
        const expected =
          (parts.h ?? 0) * 3_600_000 +
          (parts.m ?? 0) * 60_000 +
          (parts.s ?? 0) * 1_000 +
          (parts.ms ?? 0)
        // A disclosed duration is positive by construction here; zero ("0s")
        // means an already-rolled bucket and is rejected by design.
        assert.equal(durationMs(text), expected)
      },
    ),
    { numRuns: 200 },
  )
})

test('waitFromReset: the reported wait is exact above the one-second floor', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 4_000_000_000_000 }),
      fc.integer({ min: 0, max: 4_000_000_000_000 }),
      (instant, now) => {
        const wait = waitFromReset(instant, now)
        // A reset at or behind the clock still waits the floor: a retry must
        // never land in the same instant as the 429 that disclosed it.
        assert.ok(wait >= 1_000)
        assert.equal(wait, Math.max(1_000, instant - now + 2_000))
      },
    ),
    { numRuns: 200 },
  )
})
