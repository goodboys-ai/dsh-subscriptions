/**
 * Elapsed-time cursor across every usage provider, from the parsed window to
 * the rendered meter.
 *
 * Each case feeds a provider parser a response body shaped after its public
 * schema, with 0% used, then renders the real `UsageMeter` for the resulting
 * window. The question is only whether the cursor is drawn. A cursor must
 * appear when the provider's own timing fields place the window in time, and
 * must not appear when they do not: the plugin never supplies a start, a
 * duration, or a fixed-window claim the provider did not.
 *
 * The bodies are written for these tests. They show how this plugin maps
 * fields, not what any provider returns for a real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UsageMeter } from '../src/client/UsageMeter.js'
import { en } from '../src/client/locales.js'
import { fetchAntigravityUsage } from '../src/providers/antigravity.js'
import { fetchClaudeUsage } from '../src/providers/claude.js'
import { fetchCodexUsage } from '../src/providers/codex.js'
import { fetchCursorUsage } from '../src/providers/cursor-usage.js'
import { fetchKimiCodeUsage, fetchOpenCodeGoUsage } from '../src/providers/external-usage.js'
import { fetchGrokUsage } from '../src/providers/grok.js'
import { fetchMiniMaxUsage } from '../src/providers/minimax-usage.js'
import type { FetchFn, ProviderUsage } from '../src/providers/common.js'
import type { ClaudeSession, CodexSession, GrokSession } from '../src/auth/store.js'

const now = Date.now()
const HOUR = 3_600_000
const DAY = 24 * HOUR
const iso = (ms: number): string => new Date(ms).toISOString()
const t = (key: keyof typeof en, params?: Record<string, unknown>): string => en[key]
  .replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))

const answer = (body: unknown): FetchFn => (async () => Response.json(body)) as unknown as FetchFn
const session = { accessToken: 'at', refreshToken: 'rt', expiresAt: now + HOUR }
const cursorToken = `h.${Buffer.from(JSON.stringify({ sub: 'auth0|user_1' })).toString('base64url')}.s`

interface Case {
  name: string
  /** Whether the provider's own timing fields place this window in time. */
  cursor: boolean
  load: () => Promise<ProviderUsage>
}

const cases: Case[] = [
  {
    name: 'Codex: reset and reported duration',
    cursor: true,
    load: () => fetchCodexUsage({ ...session, accountId: 'a' } as CodexSession, answer({
      rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18_000, reset_at: Math.floor((now + 4 * HOUR) / 1000) } },
    })),
  },
  {
    name: 'Codex: reset without a duration',
    cursor: false,
    load: () => fetchCodexUsage({ ...session, accountId: 'a' } as CodexSession, answer({
      rate_limit: { primary_window: { used_percent: 0, reset_at: Math.floor((now + 4 * HOUR) / 1000) } },
    })),
  },
  {
    name: 'Codex: duration without a reset',
    cursor: false,
    load: () => fetchCodexUsage({ ...session, accountId: 'a' } as CodexSession, answer({
      rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18_000 } },
    })),
  },
  {
    name: 'Claude legacy five_hour: reset known',
    cursor: true,
    load: () => fetchClaudeUsage({ ...session, scopes: 'x' } as ClaudeSession,
      answer({ five_hour: { utilization: 0, resets_at: iso(now + 4 * HOUR) } }), undefined, async () => '2.1.0'),
  },
  {
    name: 'Claude modern limits weekly: reset known',
    cursor: true,
    load: () => fetchClaudeUsage({ ...session, scopes: 'x' } as ClaudeSession,
      answer({ limits: [{ kind: 'weekly_all', percent: 0, resets_at: iso(now + 3 * DAY) }] }), undefined, async () => '2.1.0'),
  },
  {
    name: 'Claude: reset is null',
    cursor: false,
    load: () => fetchClaudeUsage({ ...session, scopes: 'x' } as ClaudeSession,
      answer({ five_hour: { utilization: 0, resets_at: null } }), undefined, async () => '2.1.0'),
  },
  {
    name: 'Claude: window of an unrecognized kind has no fixed duration',
    cursor: false,
    load: () => fetchClaudeUsage({ ...session, scopes: 'x' } as ClaudeSession,
      answer({ limits: [{ kind: 'extra', percent: 0, resets_at: iso(now + 3 * DAY) }] }), undefined, async () => '2.1.0'),
  },
  {
    name: 'Grok: period start and end',
    cursor: true,
    load: () => fetchGrokUsage({ ...session, tokenEndpoint: 'https://t.example/token' } as GrokSession, answer({
      config: { creditUsagePercent: 0, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: iso(now - DAY), end: iso(now + 6 * DAY) } },
    })),
  },
  {
    name: 'Grok: period end without a start',
    cursor: false,
    load: () => fetchGrokUsage({ ...session, tokenEndpoint: 'https://t.example/token' } as GrokSession, answer({
      config: { creditUsagePercent: 0, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: iso(now + 6 * DAY) } },
    })),
  },
  {
    name: 'Cursor: billing cycle start and end',
    cursor: true,
    load: () => fetchCursorUsage(cursorToken, (async (url: string | URL | Request) => String(url).includes('usage-summary')
      ? Response.json({ billingCycleStart: iso(now - 10 * DAY), billingCycleEnd: iso(now + 20 * DAY), individualUsage: { plan: { totalPercentUsed: 0 } } })
      : Response.json({})) as typeof fetch),
  },
  {
    name: 'Cursor: billing cycle end without a start',
    cursor: false,
    load: () => fetchCursorUsage(cursorToken, (async (url: string | URL | Request) => String(url).includes('usage-summary')
      ? Response.json({ billingCycleEnd: iso(now + 20 * DAY), individualUsage: { plan: { totalPercentUsed: 0 } } })
      : Response.json({})) as typeof fetch),
  },
  {
    name: 'Antigravity: reset only, no interval or duration the provider vouches for',
    cursor: false,
    load: () => fetchAntigravityUsage({ ...session, projectId: 'p' }, {}, (async (url: string | URL | Request) => String(url).includes('fetchAvailableModels')
      ? Response.json({ models: { m1: { quotaInfo: { remainingFraction: 1, resetTime: iso(now + 4 * HOUR) } } } })
      : Response.json({})) as FetchFn),
  },
  {
    name: 'OpenCode Go rolling: reset and fixed five-hour duration',
    cursor: true,
    load: () => fetchOpenCodeGoUsage('k', answer({ usage: { rolling: { percent: 0, resetsAt: iso(now + 4 * HOUR) } } }) as typeof fetch),
  },
  {
    name: 'OpenCode Go: no reset',
    cursor: false,
    load: () => fetchOpenCodeGoUsage('k', answer({ usage: { rolling: { percent: 0 } } }) as typeof fetch),
  },
  {
    name: 'OpenCode Go monthly: subscription-anchored, reset alone does not place it',
    cursor: false,
    load: () => fetchOpenCodeGoUsage('k', answer({ usage: { monthly: { percent: 0, resetsAt: iso(now + 20 * DAY) } } }) as typeof fetch),
  },
  {
    name: 'Kimi seven-day limit: reset and fixed duration',
    cursor: true,
    load: () => fetchKimiCodeUsage('k', answer({
      limits: [{ window: { duration: 7, timeUnit: 'DAY' }, detail: { limit: 100, used: 0, reset_at: iso(now + 6 * DAY) } }],
    }) as typeof fetch),
  },
  {
    name: 'Kimi five-hour limit: rolling semantics are not established, so no fixed start',
    cursor: false,
    load: () => fetchKimiCodeUsage('k', answer({
      limits: [{ window: { duration: 300, timeUnit: 'MINUTE' }, detail: { limit: 100, used: 0, reset_at: iso(now + 4 * HOUR) } }],
    }) as typeof fetch),
  },
  {
    name: 'MiniMax: explicit start and end',
    cursor: true,
    load: () => fetchMiniMaxUsage('k', 'global', answer({ model_remains: [{
      model_name: 'MiniMax-M*', start_time: now - HOUR, end_time: now + 4 * HOUR,
      current_interval_total_count: 100, current_interval_usage_count: 100, current_interval_remaining_percent: 100,
    }] }) as typeof fetch),
  },
]

for (const { name, cursor, load } of cases) {
  test(`0% usage cursor: ${name}`, async () => {
    const usage = await load()
    const window = usage.windows?.[0]
    assert.ok(window, 'the provider produced a window')
    assert.equal(window.usedPercent, 0)
    // Observed long ago and flagged stale: only the window's own timing may decide.
    for (const observation of [{ observedAt: Date.now() }, { observedAt: Date.now() - 3_600_000, stale: true }, {}]) {
      const html = renderToStaticMarkup(createElement(UsageMeter, { t, window, ...observation }))
      assert.equal(/data-usage-time-marker/.test(html), cursor, `${JSON.stringify(observation)}: ${html}`)
    }
  })
}
