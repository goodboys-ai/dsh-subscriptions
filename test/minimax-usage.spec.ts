import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchMiniMaxUsage } from '../src/providers/minimax-usage.js'

const row = { model_name: 'MiniMax-M*', start_time: 2_000_000_000_000, end_time: 2_000_018_000_000,
  current_interval_total_count: 100, current_interval_usage_count: 25 }
const http = (model: object, status_code = 0) => (async () => Response.json({ base_resp: { status_code }, model_remains: [model] })) as typeof fetch

test('MiniMax legacy remaining counts retain model scope and explicit millisecond bounds', async () => {
  const usage = await fetchMiniMaxUsage('subscription-key', 'global', http(row))
  assert.deepEqual(usage.windows, [{ kind: 'session', scope: 'MiniMax-M*', usedPercent: 75,
    startsAt: row.start_time, resetsAt: row.end_time }])
})
test('MiniMax explicit percentages win over ambiguous count semantics', async () => {
  const usage = await fetchMiniMaxUsage('key', 'cn', http({ ...row, current_interval_remaining_percent: 25 }))
  assert.equal(usage.windows![0]!.usedPercent, 75)
})
test('MiniMax does not fabricate finite bars for boosted/unlimited pools', async () => {
  // A zero total with no explicit percentage has nothing to derive a bar from.
  await assert.rejects(fetchMiniMaxUsage('key', 'global', http({ ...row, current_interval_total_count: 0 })), /no supported finite/)
  await assert.rejects(fetchMiniMaxUsage('key', 'global', http({ ...row, current_interval_status: 3 })), /no supported finite/)
  await assert.rejects(fetchMiniMaxUsage('key', 'global', http({ ...row, current_interval_remaining_percent: 150 })), /no supported finite/)
})
test('MiniMax rejects business errors and pay-as-you-go keys without leaking credentials', async () => {
  await assert.rejects(fetchMiniMaxUsage('key', 'global', http(row, 1001)), /failed/)
  await assert.rejects(fetchMiniMaxUsage('sk-api-secret', 'global', http(row)), /subscription key/)
})
test('MiniMax accepts the official bare response and resolves weekly boosts', async () => {
  const weekly = { ...row, current_weekly_total_count: 100, current_weekly_remaining_percent: 50,
    weekly_boost_permille: 1500, weekly_start_time: row.start_time, weekly_end_time: row.start_time + 604_800_000 }
  const bare = (async () => Response.json({ model_remains: [weekly] })) as typeof fetch
  const usage = await fetchMiniMaxUsage('key', 'global', bare)
  assert.equal(usage.windows![1]!.usedPercent, 25)
  const over = await fetchMiniMaxUsage('key', 'global', http({ ...weekly, current_weekly_remaining_percent: 80 }))
  assert.equal(over.windows!.length, 1)
})

test('MiniMax region controls a fixed allowlisted endpoint', async () => {
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, 'https://www.minimax.cn/v1/token_plan/remains')
    assert.equal((init!.headers as Record<string, string>).authorization, 'Bearer secret')
    return Response.json({ base_resp: { status_code: 0 }, model_remains: [row] })
  }) as typeof fetch
  await fetchMiniMaxUsage('secret', 'cn', fetcher)
})

/**
 * Shaped after the public MiniMax-AI/cli quota fixtures and its time-plan
 * issue reports: a standard model carries explicit remaining percentages with
 * zero counts, while the video row carries real counts. The values are
 * invented for these tests; no live account response was used.
 */
const NOW = 2_000_000_000_000
const standard = { model_name: 'general', start_time: NOW, end_time: NOW + 18_000_000,
  weekly_start_time: NOW - 86_400_000, weekly_end_time: NOW + 518_400_000,
  current_interval_total_count: 0, current_interval_usage_count: 0, current_interval_remaining_percent: 94, current_interval_status: 1,
  current_weekly_total_count: 0, current_weekly_usage_count: 0, current_weekly_remaining_percent: 98, current_weekly_status: 1 }
const video = { model_name: 'video', start_time: NOW, end_time: NOW + 86_400_000,
  weekly_start_time: NOW - 86_400_000, weekly_end_time: NOW + 518_400_000,
  current_interval_total_count: 3, current_interval_usage_count: 3, current_interval_remaining_percent: 100,
  current_weekly_total_count: 21, current_weekly_usage_count: 21, current_weekly_remaining_percent: 100 }
const body = (...rows: object[]) => (async () => Response.json({ base_resp: { status_code: 0 }, model_remains: rows })) as typeof fetch
const summary = (usage: Awaited<ReturnType<typeof fetchMiniMaxUsage>>) =>
  usage.windows!.map(w => `${w.scope}/${w.kind}=${w.usedPercent}`)

test('MiniMax standard models report percentage-only windows next to video', async () => {
  const usage = await fetchMiniMaxUsage('key', 'global', body(standard, video))
  assert.deepEqual(summary(usage), ['general/session=6', 'general/weekly=2', 'video/other=0', 'video/weekly=0'])
  // The standard windows keep the API's own bounds, so the five-hour window is a session and has a cursor.
  assert.deepEqual(usage.windows![0], { kind: 'session', scope: 'general', usedPercent: 6, startsAt: NOW, resetsAt: NOW + 18_000_000 })
  assert.deepEqual(usage.windows![1], { kind: 'weekly', scope: 'general', usedPercent: 2,
    startsAt: NOW - 86_400_000, resetsAt: NOW + 518_400_000 })
})

test('MiniMax percentage-only standard model is not an error when it is the only row', async () => {
  const usage = await fetchMiniMaxUsage('key', 'cn', body(standard))
  assert.deepEqual(summary(usage), ['general/session=6', 'general/weekly=2'])
})

test('MiniMax percentage-only windows keep exhaustion, usage and the weekly boost explicit', async () => {
  const used = await fetchMiniMaxUsage('key', 'global', body({ ...standard,
    current_interval_remaining_percent: 0, current_interval_status: 2, current_weekly_remaining_percent: 40 }))
  assert.deepEqual(summary(used), ['general/session=100', 'general/weekly=60'])
  const boosted = await fetchMiniMaxUsage('key', 'global', body({ ...standard,
    current_weekly_remaining_percent: 50, weekly_boost_permille: 1500 }))
  // base remaining 50% x 1.5 = 75% remaining, so 25% used, as for count-backed windows.
  assert.deepEqual(summary(boosted), ['general/session=6', 'general/weekly=25'])
})

test('MiniMax percentage-only windows are still omitted when unlimited, unusable or boosted past 100%', async () => {
  // Status 3 with zero totals is "unlimited" for a weekly window and "not in the plan" for a model that has no bucket.
  const unlimited = { ...standard, current_interval_status: 3, current_weekly_status: 3 }
  await assert.rejects(fetchMiniMaxUsage('key', 'global', body(unlimited)), /no supported finite/)
  const mixed = await fetchMiniMaxUsage('key', 'global', body(unlimited, video))
  assert.deepEqual(summary(mixed), ['video/other=0', 'video/weekly=0'])
  for (const remaining of [150, -5, Number.NaN]) {
    await assert.rejects(fetchMiniMaxUsage('key', 'global', body({ ...standard,
      current_interval_remaining_percent: remaining, current_weekly_remaining_percent: remaining })), /no supported finite/)
  }
  // 80% remaining at x1.5 is 120% remaining: a pool larger than the plan, not a negative bar.
  await assert.rejects(fetchMiniMaxUsage('key', 'global', body({ ...standard, current_interval_remaining_percent: undefined,
    current_weekly_remaining_percent: 80, weekly_boost_permille: 1500 })), /no supported finite/)
  await assert.rejects(fetchMiniMaxUsage('key', 'global', body({ ...standard, weekly_boost_permille: 0,
    current_interval_remaining_percent: undefined })), /no supported finite/)
})

test('MiniMax never derives a percentage from nothing', async () => {
  // Neither an explicit percentage nor a usable total: there is nothing to show.
  const bare = { model_name: 'general', start_time: NOW, end_time: NOW + 18_000_000,
    current_interval_total_count: 0, current_interval_usage_count: 0 }
  await assert.rejects(fetchMiniMaxUsage('key', 'global', body(bare)), /no supported finite/)
  await assert.rejects(fetchMiniMaxUsage('key', 'global', body({ ...bare, current_interval_remaining_percent: '94' })), /no supported finite/)
  // Counts alone keep the official CLI's legacy remaining-count reading.
  const counts = await fetchMiniMaxUsage('key', 'global', body({ ...bare, current_interval_total_count: 100, current_interval_usage_count: 25 }))
  assert.deepEqual(summary(counts), ['general/session=75'])
})

test('MiniMax percentage-only windows without valid bounds carry no time fields', async () => {
  const usage = await fetchMiniMaxUsage('key', 'global', body({ ...standard, start_time: 0, end_time: 0,
    weekly_start_time: 'soon', weekly_end_time: NOW }))
  assert.deepEqual(usage.windows!.map(w => [w.scope, w.usedPercent]), [['general', 6], ['general', 2]])
  for (const window of usage.windows!) {
    assert.equal('startsAt' in window, false)
    assert.equal('resetsAt' in window, false)
  }
})
