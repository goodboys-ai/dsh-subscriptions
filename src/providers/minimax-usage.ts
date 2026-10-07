import type { ProviderUsage, UsageWindow } from './common.js'

/**
 * Used percentage from the legacy counts, read as the official CLI does when no
 * explicit percentage exists: the count is the quota remaining. Undefined
 * unless the total is a positive finite number, so a zero total never yields a
 * bar.
 */
function usedFromCounts(total: unknown, count: unknown): number | undefined {
  return typeof total === 'number' && Number.isFinite(total) && total > 0 && typeof count === 'number'
    ? (1 - count / total) * 100
    : undefined
}

/**
 * Read MiniMax subscription quota (M Plan and Token Plan), not the balance API
 * that `sk-api-*` pay-as-you-go keys use.
 *
 * Each `model_remains` row can yield an interval window and a weekly window.
 * A window needs a finite share: the explicit `*_remaining_percent` (the weekly
 * one scaled by `weekly_boost_permille`), else the legacy counts. Time-based
 * plans report zero counts beside the percentage for standard models, so the
 * percentage stands on its own and a zero total does not hide the window.
 * Windows that cannot be a finite bar are omitted rather than approximated:
 * status 3 (unlimited, or no quota in the plan), a weekly pool boosted past
 * 100% remaining, a percentage outside 0-100, and a row with neither a
 * percentage nor positive counts. Start and end times are kept only when both
 * are valid millisecond bounds.
 * @param key - subscription key for the region; never copied into a result or error.
 * @param region - `global` or `cn`, which selects the fixed quota host.
 * @param http - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @returns the finite windows in the order the API lists them.
 * @throws when the key is pay-as-you-go, the endpoint or its business status
 *   fails, the body has no `model_remains`, or no window is a finite bar.
 */
export async function fetchMiniMaxUsage(
  key: string, region: 'global' | 'cn', http: typeof fetch = fetch, signal?: AbortSignal,
): Promise<ProviderUsage> {
  if (key.startsWith('sk-api-')) throw new Error('MiniMax requires a subscription key, not a pay-as-you-go key')
  const response = await http(`https://www.minimax.${region === 'cn' ? 'cn' : 'io'}/v1/token_plan/remains`, {
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`MiniMax usage endpoint returned HTTP ${response.status}`)
  const body = await response.json() as { base_resp?: { status_code?: number }; model_remains?: unknown[] }
  if ((body?.base_resp?.status_code !== undefined && body.base_resp.status_code !== 0) || !Array.isArray(body?.model_remains)) {
    throw new Error('MiniMax usage response failed or has no quota records')
  }
  const windows: UsageWindow[] = []
  for (const raw of body.model_remains) {
    if (raw === null || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    if (typeof row.model_name !== 'string') continue
    for (const [prefix, startKey, endKey, fallback] of [
      ['current_interval', 'start_time', 'end_time', 'session'],
      ['current_weekly', 'weekly_start_time', 'weekly_end_time', 'weekly'],
    ] as const) {
      const status = row[`${prefix}_status`]
      if (status === 3) continue // Unlimited pools cannot have a finite percentage.
      const remaining = row[`${prefix}_remaining_percent`]
      const boost = prefix === 'current_weekly' ? row.weekly_boost_permille ?? 1000 : 1000
      if (typeof boost !== 'number' || !Number.isFinite(boost) || boost <= 0) continue
      // An explicit percentage needs no counts: time-based plans send zero
      // counts beside it. Official CLI compatibility: without a percentage, the
      // legacy counts are the quota remaining.
      const usedPercent = typeof remaining === 'number' ? 100 - remaining * boost / 1000
        : usedFromCounts(row[`${prefix}_total_count`], row[`${prefix}_usage_count`])
      if (usedPercent === undefined || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue
      const start = row[startKey]
      const end = row[endKey]
      const validBounds = typeof start === 'number' && Number.isFinite(start) && start > 0
        && typeof end === 'number' && Number.isFinite(end) && end > start
      windows.push({ kind: fallback === 'session' && validBounds && end - start !== 18_000_000 ? 'other' : fallback,
        scope: row.model_name, usedPercent,
        ...(validBounds ? { startsAt: start, resetsAt: end } : {}),
      })
    }
  }
  if (!windows.length) throw new Error('MiniMax has no supported finite quota windows')
  return { supported: true, plan: 'MiniMax', windows }
}
