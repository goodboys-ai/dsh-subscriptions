import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { displayUsedPercent, elapsedPercent, isUsageFresh, resetCountdownParts, usageColorState, USAGE_FRESHNESS_MS } from '../src/client/usage-pace.js'
import { UsageMeter } from '../src/client/UsageMeter.js'
import { en, zh } from '../src/client/locales.js'

const now = 2_000_000_000_000

test('elapsed time requires an explicit interval or verified fixed duration, never kind alone', () => {
  for (const kind of ['session', 'weekly', 'other'] as const) {
    assert.equal(elapsedPercent({ kind, usedPercent: 20, resetsAt: now + 100 }, now), undefined)
    assert.equal(elapsedPercent({ kind, usedPercent: 20, windowDurationMs: 200, resetsAt: now + 100 }, now), undefined)
  }
  assert.equal(elapsedPercent({ kind: 'other', usedPercent: 20, startsAt: now - 100, resetsAt: now + 300 }, now), 25)
  assert.equal(elapsedPercent({ kind: 'session', usedPercent: 20, fixedWindow: true, windowDurationMs: 1000, resetsAt: now + 250 }, now), 75)
})

test('missing, invalid and expired intervals omit the marker', () => {
  for (const timing of [{}, { resetsAt: NaN }, { resetsAt: now }, { resetsAt: now - 1 },
    { resetsAt: now + 100 }, { startsAt: now + 200, resetsAt: now + 100 },
    { startsAt: now + 50, resetsAt: now + 100 }, { startsAt: NaN, resetsAt: now + 100 },
    { resetsAt: now + 100, fixedWindow: true, windowDurationMs: -1 }]) {
    assert.equal(elapsedPercent({ kind: 'other', usedPercent: 20, ...timing }, now), undefined)
  }
})

test('three presets compare unrounded points; exhaustion takes precedence', () => {
  const color = (used: number, elapsed: number | undefined, preset: 'standard' | 'relaxed' | 'remaining' = 'standard') => usageColorState(used, elapsed, preset, true)
  assert.equal(color(40, 25), 'yellow')
  assert.equal(color(40, 35), 'green')
  assert.equal(color(30, 20), 'yellow')
  assert.equal(color(30, 20, 'relaxed'), 'green')
  assert.equal(color(35, 20, 'relaxed'), 'yellow')
  assert.equal(color(40, 20, 'remaining'), 'green')
  assert.equal(color(29.6, 20), 'green')
  assert.equal(color(89.6, 85), 'green')
  assert.equal(color(10, 0), 'yellow')
  assert.equal(color(0, 0), 'green')
  assert.equal(color(2, 1), 'green')
  for (const preset of ['standard', 'relaxed', 'remaining'] as const) {
    assert.equal(color(90, 95, preset), 'red')
    assert.equal(color(95, undefined, preset), 'red')
    assert.equal(usageColorState(95, 0, preset, false), 'red')
    for (const invalid of [NaN, Infinity, -1, 101]) assert.equal(color(invalid, 0, preset), 'neutral')
  }
  assert.equal(color(40, undefined), 'green')
  assert.equal(color(40, undefined, 'remaining'), 'green')
})

test('failed, aged, reset and invalid observations cannot imply current usage', () => {
  const quota = { kind: 'session' as const, usedPercent: 95 }
  assert.equal(isUsageFresh(quota, { observedAt: now }, now), true)
  assert.equal(isUsageFresh(quota, {}, now), false)
  assert.equal(isUsageFresh(quota, { observedAt: now, stale: true }, now), false)
  assert.equal(isUsageFresh(quota, { observedAt: now - USAGE_FRESHNESS_MS - 1 }, now), false)
  assert.equal(isUsageFresh(quota, { observedAt: now + 1 }, now), false)
  assert.equal(isUsageFresh({ ...quota, resetsAt: now }, { observedAt: now }, now), false)
  assert.equal(isUsageFresh({ ...quota, usedPercent: -1 }, { observedAt: now }, now), false)
})

test('display percentages round valid shares and refuse invalid ones instead of clamping', () => {
  assert.equal(displayUsedPercent(40.4), 40)
  assert.equal(displayUsedPercent(0), 0)
  assert.equal(displayUsedPercent(100), 100)
  for (const invalid of [NaN, Infinity, -Infinity, -1, 100.1]) {
    assert.equal(displayUsedPercent(invalid), undefined)
  }
})

test('reset countdown uses whole days/hours/minutes, rounded up, two largest units', () => {
  assert.deepEqual(resetCountdownParts(18 * 3_600_000), [{ unit: 'hour', count: 18 }])
  assert.deepEqual(resetCountdownParts(65 * 60_000), [{ unit: 'hour', count: 1 }, { unit: 'minute', count: 5 }])
  assert.deepEqual(resetCountdownParts(30_000), [{ unit: 'minute', count: 1 }])
  assert.deepEqual(resetCountdownParts(60_000), [{ unit: 'minute', count: 1 }])
  assert.deepEqual(resetCountdownParts(2 * 86_400_000 + 3 * 3_600_000 + 40 * 60_000), [{ unit: 'day', count: 2 }, { unit: 'hour', count: 3 }])
  assert.deepEqual(resetCountdownParts(2 * 86_400_000 + 30 * 60_000), [{ unit: 'day', count: 2 }, { unit: 'minute', count: 30 }])
  assert.equal(resetCountdownParts(0)[0]?.unit, 'minute')
})

test('localized meter labels distinguish fresh, unknown and stale readings', () => {
  const realNow = Date.now()
  for (const dictionary of [en, zh]) {
    const t = (key: keyof typeof en, params?: Record<string, unknown>) => dictionary[key]
      .replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
    const props = { t, observedAt: realNow, window: {
      kind: 'session' as const, usedPercent: 20, startsAt: realNow - 100_000, resetsAt: realNow + 100_000,
    } }
    const html = renderToStaticMarkup(createElement(UsageMeter, props))
    assert.match(html, /data-usage-time-marker/)
    assert.match(html, /role="img"/)
    assert.match(html, /50%/)
    assert.match(html, /data-usage-color="green"/)
    // A negative lead is behind pace, not a negative lead.
    assert.ok(html.includes(t('usageMeterPaceBehind', { points: 30 })), html)
    assert.ok(!html.includes('-30'), html)
    // The reset countdown is humanized and pluralized, never raw minutes.
    assert.ok(html.includes(t('usageMeterReset', { duration: t('usageUnitMinutes', { count: 2 }) })), html)
    // A failed refresh does not move the window: the cursor stays, the reading
    // is labelled stale, and the old percentage is not compared with the
    // current time.
    const stale = renderToStaticMarkup(createElement(UsageMeter, { ...props, stale: true }))
    assert.match(stale, /data-usage-time-marker/)
    assert.match(stale, /data-usage-color="green"/)
    assert.ok(stale.includes(t('usageMeterStale')), stale)
    assert.ok(stale.includes(t('usageMeterPace', { elapsed: 50 })), stale)
    assert.ok(!stale.includes(t('usageMeterPaceBehind', { points: 30 })), stale)
    assert.ok(!stale.includes(t('usageMeterPaceAhead', { points: 30 })), stale)
    assert.ok(!stale.includes(t('usageMeterPaceEven')), stale)
    const noTime = renderToStaticMarkup(createElement(UsageMeter, { t, observedAt: realNow, window: { kind: 'other', usedPercent: 80 } }))
    assert.doesNotMatch(noTime, /data-usage-time-marker/)
    assert.match(noTime, /data-usage-color="green"/)
    // A singular unit is not pluralized.
    const oneMinute = renderToStaticMarkup(createElement(UsageMeter, { t, observedAt: realNow, window: {
      kind: 'session' as const, usedPercent: 10, startsAt: realNow - 100_000, resetsAt: realNow + 59_000,
    } }))
    assert.ok(oneMinute.includes(t('usageMeterReset', { duration: t('usageUnitMinute', { count: 1 }) })), oneMinute)
    // An invalid percentage shows the unavailable state, never a clamped number or NaN.
    const invalid = renderToStaticMarkup(createElement(UsageMeter, { t, observedAt: realNow, window: {
      kind: 'other' as const, usedPercent: 150, resetsAt: realNow + 3_600_000,
    } }))
    assert.ok(invalid.includes(t('usageMeterInvalid')), invalid)
    assert.ok(!invalid.includes(t('usageMeterStale')), invalid)
    assert.match(invalid, /data-usage-color="neutral"/)
    assert.doesNotMatch(invalid, /NaN|150%/)
    // A lead beyond the allowance names pace in the warning and the detail.
    const ahead = renderToStaticMarkup(createElement(UsageMeter, { t, observedAt: realNow, window: {
      kind: 'session' as const, usedPercent: 80, startsAt: realNow - 100_000, resetsAt: realNow + 100_000,
    } }))
    assert.ok(ahead.includes(t('usageMeterAhead')), ahead)
    assert.ok(ahead.includes(t('usageMeterPaceAhead', { points: 30 })), ahead)
    assert.match(ahead, /data-usage-color="yellow"/)
  }
})

/**
 * The cursor shows where the window stands in time. Nothing about it depends on
 * how much was used or on how recently the percentage was read, so each case
 * pins one reading condition and asks only whether the cursor is drawn.
 */
test('the cursor follows the window interval, not the reading: 0%, stale, aged, unobserved, invalid', () => {
  const realNow = Date.now()
  const t = (key: keyof typeof en, params?: Record<string, unknown>) => en[key]
    .replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  const interval = { startsAt: realNow - 100_000, resetsAt: realNow + 100_000 }
  const cursor = (props: { usedPercent: number; observedAt?: number; stale?: boolean; timing?: object }) =>
    /data-usage-time-marker/.test(renderToStaticMarkup(createElement(UsageMeter, {
      t,
      window: { kind: 'session' as const, usedPercent: props.usedPercent, ...(props.timing ?? interval) },
      ...props.observedAt === undefined ? {} : { observedAt: props.observedAt },
      ...props.stale === undefined ? {} : { stale: props.stale },
    })))
  for (const usedPercent of [0, 40]) {
    assert.equal(cursor({ usedPercent, observedAt: realNow }), true, `${usedPercent}% fresh`)
    assert.equal(cursor({ usedPercent, observedAt: realNow, stale: true }), true, `${usedPercent}% refresh failed`)
    assert.equal(cursor({ usedPercent, observedAt: realNow - USAGE_FRESHNESS_MS - 1 }), true, `${usedPercent}% aged`)
    assert.equal(cursor({ usedPercent }), true, `${usedPercent}% no observation time`)
    assert.equal(cursor({ usedPercent, observedAt: realNow + 60_000 }), true, `${usedPercent}% observation in the future`)
  }
  // An unusable percentage says nothing about the window's time.
  for (const usedPercent of [NaN, -1, 150]) {
    assert.equal(cursor({ usedPercent, observedAt: realNow }), true, `${usedPercent} is invalid but the interval is known`)
  }
  // Timing that cannot place a cursor still draws none, however fresh the reading.
  for (const timing of [{}, { resetsAt: realNow + 100_000 }, { resetsAt: realNow - 1, startsAt: realNow - 100_000 },
    { startsAt: realNow + 50_000, resetsAt: realNow + 100_000 }, { resetsAt: realNow + 100_000, windowDurationMs: 200_000 }]) {
    assert.equal(cursor({ usedPercent: 0, observedAt: realNow, timing }), false, JSON.stringify(timing))
  }
})

test('a stale or aged reading keeps its cursor but never compares its old percentage with the current time', () => {
  const realNow = Date.now()
  for (const dictionary of [en, zh]) {
    const t = (key: keyof typeof en, params?: Record<string, unknown>) => dictionary[key]
      .replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
    const window = { kind: 'session' as const, usedPercent: 80, startsAt: realNow - 100_000, resetsAt: realNow + 100_000 }
    const aged = renderToStaticMarkup(createElement(UsageMeter, { t, window, observedAt: realNow - USAGE_FRESHNESS_MS - 1 }))
    assert.match(aged, /data-usage-time-marker/)
    assert.ok(aged.includes(t('usageMeterStale')), aged)
    assert.ok(aged.includes(t('usageMeterPace', { elapsed: 50 })), aged)
    // 80% used at 50% elapsed would be a yellow warning on a fresh reading; an old reading gets no warning.
    assert.match(aged, /data-usage-color="green"/)
    assert.ok(!aged.includes(t('usageMeterAhead')), aged)
    for (const key of ['usageMeterPaceAhead', 'usageMeterPaceBehind'] as const) {
      assert.ok(!aged.includes(t(key, { points: 30 })), aged)
    }
    // The same reading, fresh, still warns and compares.
    const fresh = renderToStaticMarkup(createElement(UsageMeter, { t, window, observedAt: realNow }))
    assert.match(fresh, /data-usage-color="yellow"/)
    assert.ok(fresh.includes(t('usageMeterPaceAhead', { points: 30 })), fresh)
    // Near exhaustion is still red when old: red reports the percentage alone.
    const red = renderToStaticMarkup(createElement(UsageMeter, { t, window: { ...window, usedPercent: 95 }, stale: true }))
    assert.match(red, /data-usage-color="red"/)
    assert.match(red, /data-usage-time-marker/)
  }
})

test('an invalid percentage is reported as unavailable and still shows the interval cursor', () => {
  const realNow = Date.now()
  const t = (key: keyof typeof en, params?: Record<string, unknown>) => en[key]
    .replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  const html = renderToStaticMarkup(createElement(UsageMeter, { t, observedAt: realNow, window: {
    kind: 'other' as const, usedPercent: 150, startsAt: realNow - 100_000, resetsAt: realNow + 100_000,
  } }))
  assert.match(html, /data-usage-time-marker/)
  assert.match(html, /data-usage-color="neutral"/)
  assert.ok(html.includes(t('usageMeterInvalid')), html)
  assert.ok(html.includes(t('usageMeterPace', { elapsed: 50 })), html)
  // No fill and no pace comparison for a number that cannot be trusted.
  assert.ok(!html.includes('width:150%'), html)
  assert.ok(!html.includes(t('usageMeterPaceAhead', { points: 100 })), html)
  assert.doesNotMatch(html, /NaN|150%/)
})
