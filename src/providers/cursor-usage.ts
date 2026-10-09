/** Cursor individual-account quota projection from its dashboard endpoints. */

import type { ProviderUsage, UsageWindow } from './common.js'
import { parseProviderJson } from './common.js'

const ORIGIN = 'https://cursor.com'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Cursor's WorkOS user id from the access JWT, without the identity prefix. */
export function cursorUserId(token: string): string | undefined {
  try {
    const parts = token.split('.')
    if (parts.length !== 3 || !parts[1]) return undefined
    const claims = record(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')))
    const raw = claims?.sub
    if (typeof raw !== 'string' || raw.length === 0) return undefined
    const id = raw.includes('|') ? raw.split('|').at(-1) : raw
    return id !== undefined && /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

async function dashboardJson(url: string, cookie: string, http: typeof fetch, signal?: AbortSignal): Promise<unknown> {
  const response = await http(url, {
    headers: {
      accept: 'application/json',
      cookie,
      origin: ORIGIN,
      referer: `${ORIGIN}/dashboard`,
    },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`Cursor usage endpoint returned HTTP ${response.status}`)
  return parseProviderJson(response, 'Cursor usage')
}

function legacyRequestWindow(body: unknown, resetsAt?: number): UsageWindow | undefined {
  const usage = record(body)
  if (usage === undefined) return undefined
  const gpt4 = record(usage['gpt-4'])
  const candidate = gpt4 !== undefined && number(gpt4.numRequests) !== undefined ? gpt4 : Object.values(usage)
    .map(record)
    .filter((value): value is Record<string, unknown> => value !== undefined)
    .sort((a, b) => (number(b.maxRequestUsage) ?? 0) - (number(a.maxRequestUsage) ?? 0))[0]
  const used = number(candidate?.numRequests)
  const limit = number(candidate?.maxRequestUsage)
  if (used === undefined || limit === undefined || limit <= 0) return undefined
  return {
    kind: 'other', scope: 'Included requests',
    usedPercent: Math.max(0, Math.min(100, used / limit * 100)),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  }
}

/**
 * Read Cursor's individual dashboard quota using an OAuth access token.
 * The dashboard cookie is request-local; no token enters ProviderUsage.
 */
export async function fetchCursorUsage(
  accessToken: string,
  http: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const userId = cursorUserId(accessToken)
  if (userId === undefined) throw new Error('Cursor session token has no usable user identity')
  const cookie = `WorkosCursorSessionToken=${userId}::${accessToken}`
  const [summaryResult, legacyResult] = await Promise.allSettled([
    dashboardJson(`${ORIGIN}/api/usage-summary`, cookie, http, signal),
    dashboardJson(`${ORIGIN}/api/usage?user=${encodeURIComponent(userId)}`, cookie, http, signal),
  ])
  if (summaryResult.status === 'rejected' && legacyResult.status === 'rejected') {
    throw summaryResult.reason instanceof Error ? summaryResult.reason : new Error('Cursor usage is unavailable')
  }

  const summary = summaryResult.status === 'fulfilled' ? record(summaryResult.value) : undefined
  const plan = record(record(summary?.individualUsage)?.plan) ?? record(record(summary?.teamUsage)?.plan)
  const resetValue = summary?.billingCycleEnd
  const parsedReset = typeof resetValue === 'string' ? Date.parse(resetValue) : NaN
  const resetsAt = Number.isFinite(parsedReset) ? parsedReset : undefined
  const startValue = summary?.billingCycleStart
  const parsedStart = typeof startValue === 'string' ? Date.parse(startValue) : NaN
  const timing = { ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(Number.isFinite(parsedStart) ? { startsAt: parsedStart } : {}) }
  const windows: UsageWindow[] = []
  for (const [field, scope] of [
    ['totalPercentUsed', 'Included'],
    ['autoPercentUsed', 'Cursor Models'],
    ['apiPercentUsed', 'Other Models'],
  ] as const) {
    const usedPercent = number(plan?.[field])
    if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) continue
    windows.push({ kind: 'other', scope, usedPercent, ...timing })
  }
  const legacy = legacyRequestWindow(legacyResult.status === 'fulfilled' ? legacyResult.value : undefined, resetsAt)
  if (legacy !== undefined) windows.push({ ...legacy, ...timing })
  if (windows.length === 0 && summary?.isUnlimited !== true) {
    throw new Error('Cursor usage response has no quota windows')
  }
  const membershipType = summary?.membershipType
  return {
    supported: true,
    windows,
    ...(typeof membershipType === 'string' && membershipType.length > 0 ? { plan: membershipType } : {}),
  }
}
