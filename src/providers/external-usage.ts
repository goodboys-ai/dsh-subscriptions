/** Usage readers for subscriptions whose model adapters are built into DSH. */

import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { ProviderUsage, UsageWindow } from './common.js'
import { parseProviderJson, readBoundedJson } from './common.js'

type HttpFetch = typeof fetch

function numeric(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

function kimiReset(value: Record<string, unknown>): number | undefined {
  for (const key of ['reset_at', 'resetAt', 'reset_time', 'resetTime']) {
    const reset = resetTime(value[key])
    if (reset !== undefined) return reset
  }
  for (const key of ['reset_in', 'resetIn', 'ttl', 'window']) {
    const seconds = numeric(value[key])
    if (seconds !== undefined && seconds > 0) return Date.now() + seconds * 1000
  }
  return undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined
}

function resetTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function getUsage(url: string, apiKey: string, http: HttpFetch, signal?: AbortSignal): Promise<unknown> {
  const response = await http(url, {
    headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`Usage endpoint returned HTTP ${response.status}`)
  return parseProviderJson(response, 'external usage')
}

/** Read the three account-wide OpenCode Go windows from its Go gateway. */
export async function fetchOpenCodeGoUsage(
  apiKey: string,
  http: HttpFetch = fetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const body = record(await getUsage('https://opencode.ai/zen/go/v1/usage', apiKey, http, signal))
  const usage = record(body?.usage)
  if (usage === undefined) throw new Error('OpenCode Go usage response has no usage object')

  const windows: UsageWindow[] = []
  for (const [field, kind, scope] of [
    ['rolling', 'session', undefined],
    ['weekly', 'weekly', undefined],
    ['monthly', 'other', 'Monthly'],
  ] as const) {
    const value = record(usage[field])
    const usedPercent = percent(value?.percent)
    if (usedPercent === undefined) continue
    const resetsAt = resetTime(value?.resetsAt)
    // Monthly has no interval fields. Both key providers' monthly pools
    // read the same display assumption: a 30-day span back from the
    // reset, clamped to now; the marker only shows, pace never fires.
    const monthlyDisplay = field === 'monthly' && resetsAt !== undefined
      ? { startsAt: Math.min(resetsAt - 30 * 86_400_000, Date.now()) }
      : {}
    windows.push({
      kind,
      ...(scope === undefined ? {} : { scope }),
      usedPercent,
      // Go's rolling counter is first-use anchored, not per-request sliding.
      ...(field === 'rolling' ? { fixedWindow: true, windowDurationMs: 18_000_000 }
        : field === 'weekly' ? { fixedWindow: true, windowDurationMs: 604_800_000 } : {}),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...monthlyDisplay,
    })
  }
  if (windows.length === 0) throw new Error('OpenCode Go usage response has no valid windows')
  return { supported: true, windows, plan: 'OpenCode Go' }
}

/** Read official CLI count windows and retain compatibility with older ratio pools. */
export async function fetchKimiCodeUsage(
  apiKey: string,
  http: HttpFetch = fetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const body = record(await getUsage('https://api.kimi.com/coding/v1/usages', apiKey, http, signal))
  if (body === undefined) throw new Error('Kimi Code usage response is not an object')
  const modern: UsageWindow[] = []
  const rows = [
    ...(record(body.usage) ? [{ detail: body.usage }] : []),
    ...(Array.isArray(body.limits) ? body.limits : []),
  ]
  for (const raw of rows) {
    const item = record(raw)
    if (!item) continue
    const detail = record(item.detail) ?? item
    const limit = numeric(detail.limit)
    const used = numeric(detail.used) ?? (limit !== undefined && numeric(detail.remaining) !== undefined
      ? limit - numeric(detail.remaining)! : undefined)
    if (limit === undefined || limit <= 0 || used === undefined) continue
    const usedPercent = percent(used / limit * 100)
    if (usedPercent === undefined) continue
    const window = record(item.window) ?? item
    const duration = numeric(window.duration ?? item.duration ?? detail.duration)
    const unit = String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? '').toUpperCase()
    const multiplier = unit.includes('MINUTE') ? 60_000 : unit.includes('HOUR') ? 3_600_000
      : unit.includes('DAY') ? 86_400_000 : unit.includes('SECOND') ? 1000 : undefined
    const durationMs = duration === undefined || duration <= 0 || multiplier === undefined
      ? undefined : duration * multiplier
    const kind = durationMs === 18_000_000 ? 'session'
      : durationMs === 604_800_000 ? 'weekly'
        // No period fields at all: the official CLI labels this summary
        // row the weekly limit, so assume that span rather than 'other'.
        : durationMs === undefined && unit === '' ? 'weekly' : 'other'
    const resetsAt = kimiReset(detail)
    const scope = detail.name ?? detail.title ?? item.name ?? item.title
    // A vendor-declared span anchors the display marker at
    // min(reset − span, now); pace stays unverified (rolling semantics
    // are not established).
    const displayStart = resetsAt !== undefined && durationMs !== undefined
      ? { startsAt: Math.min(resetsAt - durationMs, Date.now()) }
      : {}
    modern.push({ kind, usedPercent,
      ...(typeof scope === 'string' ? { scope } : {}),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(durationMs === undefined ? {} : { windowDurationMs: durationMs }),
      // A whole seven-day bucket reset, not a rolling span, only where the
      // endpoint actually said 7 DAY.
      ...(durationMs === 604_800_000 ? { fixedWindow: true } : {}),
      ...displayStart,
    })
  }
  if (modern.length) return { supported: true, windows: modern, plan: 'Kimi Code' }
  const usages = record(body.usages)
  if (usages === undefined) throw new Error('Kimi Code usage response has no valid windows')

  const windows: UsageWindow[] = []
  for (const [field, kind, scope] of [
    ['limit_5h', 'session', undefined],
    ['limit_7d', 'weekly', undefined],
    ['limit_month_total', 'other', 'Monthly'],
  ] as const) {
    const value = record(usages[field])
    const ratio = value?.used_ratio ?? value?.usedRatio
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) continue
    const resetsAt = resetTime(value?.reset_time ?? value?.resetAt)
    // The monthly total resets on the subscription's cycle, not the
    // calendar month; the display marker assumes ~30 days back.
    const monthlyDisplay = field === 'limit_month_total' && resetsAt !== undefined
      ? { startsAt: Math.min(resetsAt - 30 * 86_400_000, Date.now()) }
      : {}
    windows.push({
      kind,
      ...(scope === undefined ? {} : { scope }),
      usedPercent: ratio * 100,
      ...(field === 'limit_7d' ? { fixedWindow: true, windowDurationMs: 604_800_000 } : {}),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...monthlyDisplay,
    })
  }
  return { supported: true, windows, plan: 'Kimi Code' }
}

/** A usage ratio in any spelling the Cloud endpoint has used. */
function usageRatio(window: Record<string, unknown>): number | undefined {
  for (const key of ['usage', 'used_ratio', 'usedRatio', 'consumed', 'consumed_ratio']) {
    const value = numeric(window[key])
    if (value !== undefined && value >= 0) return value
  }
  return undefined
}

/** A reset instant in any spelling the Cloud endpoint has used. */
function usageReset(window: Record<string, unknown>): number | undefined {
  for (const key of ['resets_at', 'reset_at', 'reset', 'resetsAt']) {
    const value = window[key]
    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      if (Number.isFinite(parsed)) return parsed
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value
    }
  }
  return undefined
}

/**
 * Read Ollama Cloud quota from `GET {base}/balance`. The Cloud has no
 * `limits` object: quota is the included allowance against its remaining
 * balance (`included.allowance_usd`, `included.balance_usd`) over the
 * reported period. A 404 means a self-hosted endpoint without the
 * surface: not an error, the card renders an unsupported note instead.
 */
export async function fetchOllamaUsage(
  apiKey: string,
  baseURL: string,
  http: HttpFetch = fetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const combined = signal === undefined
    ? AbortSignal.timeout(15_000)
    : AbortSignal.any([AbortSignal.timeout(15_000), signal])
  const response = await http(`${baseURL.replace(/\/+$/, '')}/balance`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...attributionHeaders(),
    },
    redirect: 'error',
    signal: combined,
  })
  if (signal?.aborted) throw signal.reason
  if (response.status === 404) return { supported: false }
  if (!response.ok) throw new Error(`Usage endpoint returned HTTP ${response.status}`)
  const body = record(await readBoundedJson(response, 'usage', 1 * 1024 * 1024))
  const included = record(body?.included)
  const allowance = numeric(included?.allowance_usd)
  const balance = numeric(included?.balance_usd)
  if (included === undefined || allowance === undefined || allowance <= 0 || balance === undefined) {
    throw new Error('Ollama balance response has no usable included allowance')
  }
  const period = record(included.period)
  const resetsAt = period === undefined ? undefined : resetTime(period.until)
  const startsAt = period === undefined ? undefined : resetTime(period.from)
  return {
    supported: true,
    windows: [{
      kind: 'other',
      scope: 'Credits',
      // An overdrawn balance stays visible instead of dropping the window.
      usedPercent: (allowance - balance) / allowance * 100,
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(startsAt === undefined ? {} : { startsAt }),
    }],
    plan: 'Ollama Cloud',
  }
}
