import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerHooks } from 'node:module'
// These badge tests do not render the host primitives. Its published entry
// imports browser-only dependencies that are not shipped as runtime deps, so
// replace that unused import alongside the CSS modules for Node rendering.
const primitivesStub = `data:text/javascript,${encodeURIComponent(`
  export const IconDataOutlineRegular = () => null
  export const useAnchoredPosition = () => ({})
  export const useDismissOnOutsidePointer = () => {}
`)}`
const css = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === '@deepseek-ai/dsh-client-ui-primitives'
      ? { url: primitivesStub, shortCircuit: true }
      : nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    return url.endsWith('.css')
      ? { format: 'module', source: 'export default {}', shortCircuit: true }
      : nextLoad(url, context)
  },
})
const { AccountWindows, compactSegment, createCurrentModelReader, previewWindows,
  collapsedDisplays, expandedDisplays, retainSubscriptionSelection, rotatingDisplay, usageBadgeIcon,
  groupUsageDisplays, loadBadgeRoster, usageOf } = await import('../src/client/SubscriptionUsageBadge.js')
css.deregister()
import type { ProviderUsageDisplay, UsageRosterEntry } from '../src/client/SubscriptionUsageBadge.js'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { UsageWindow } from '../src/client/SubscriptionsSection.js'
import { en, zh } from '../src/client/locales.js'
import { fetchMiniMaxUsage } from '../src/providers/minimax-usage.js'
import { fetchKimiCodeUsage } from '../src/providers/external-usage.js'
import { externalUsageWindowLabel } from '../src/client/ExternalUsageCards.js'

const windows: UsageWindow[] = Array.from({ length: 60 }, (_, i) => ({
  kind: 'other', scope: `gemini-model-${i}`, usedPercent: i,
}))
function display(provider: ProviderUsageDisplay['provider'] = 'antigravity', values = windows): ProviderUsageDisplay {
  return { provider, name: provider === 'antigravity' ? 'Antigravity' : 'Codex', accounts: [
    { key: 'default', isDefault: true, windows: values },
  ] }
}

test('Antigravity compact readout selects exact current model, not the entire catalog', () => {
  const d = display('antigravity', [...windows, { kind: 'weekly', scope: 'gemini-model-59', usedPercent: 81 }])
  assert.equal(compactSegment(d, 'gemini-model-59'), 'Antigravity Window 59% · Weekly 81%')
  assert.equal(compactSegment(d), 'Antigravity 60 model quotas')
  assert.equal(compactSegment(d, 'missing'), 'Antigravity Current model quota unavailable')
  assert.ok(compactSegment(d, 'gemini-model-1').length < 60)
})

test('compact summary uses default account and preserves bounded non-Antigravity windows', () => {
  const d = display('codex', [{ kind: 'session', usedPercent: 13 }, { kind: 'weekly', usedPercent: 25 }])
  d.accounts.unshift({ key: 'other', isDefault: false, windows: [{ kind: 'session', usedPercent: 99 }] })
  assert.equal(compactSegment(d), 'Codex 5h 13% · Wk 25%')
  assert.ok(compactSegment(display('codex')).endsWith('+58'))
})

test('an unusable percentage shows the no-data state instead of a clamped number', () => {
  for (const usedPercent of [NaN, -1, 101, Infinity]) {
    assert.equal(compactSegment(display('codex', [{ kind: 'session', usedPercent }])), 'Codex 5h —')
    assert.equal(compactSegment(display('antigravity', [{ kind: 'other', scope: 'gemini-model-1', usedPercent }]), 'gemini-model-1'), 'Antigravity Window —')
  }
  // The dialog row matches the meter's unavailable state rather than clamping to 100%.
  for (const dictionary of [en, zh]) {
    const translate = (key: keyof typeof en, params?: Record<string, unknown>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
    const html = renderToStaticMarkup(createElement(AccountWindows, {
      windows: [{ kind: 'session', usedPercent: 150 }], model: undefined, translate,
    }))
    assert.ok(html.includes(translate('usageMeterInvalid')), html)
    assert.ok(!html.includes('150%'), html)
  }
})

test('preview promotes current-model windows without losing, merging, or mutating data', () => {
  const original = structuredClone(windows)
  const { shown, hidden } = previewWindows(windows, 'gemini-model-59')
  assert.equal(shown.length, 4)
  assert.equal(hidden.length, 56)
  assert.equal(shown[0]?.scope, 'gemini-model-59')
  assert.equal(new Set([...shown, ...hidden]).size, 60)
  assert.deepEqual(windows, original)
  assert.deepEqual(previewWindows([]), { shown: [], hidden: [] })
  assert.deepEqual(previewWindows(windows.slice(0, 2)).hidden, [])
})

test('rendered account keeps other windows in a closed native disclosure with localized labels', () => {
  for (const dictionary of [en, zh]) {
    const translate = (key: keyof typeof en, params?: Record<string, unknown>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
    const html = renderToStaticMarkup(createElement(AccountWindows, { windows, model: 'gemini-model-59', translate }))
    assert.ok(html.includes('<details'))
    assert.ok(!html.includes('open=""'))
    assert.ok(html.includes(translate('usageBadgeMoreWindows', { count: 56 })))
    assert.ok(html.includes(translate('usageBadgeCurrent')))
    assert.ok(html.indexOf('gemini-model-59') < html.indexOf('<details'))
    assert.ok(html.includes('gemini-model-58'))
  }
})

test('provider ordering stays independent from model-window filtering', () => {
  const all = [display('codex'), display()]
  assert.deepEqual(collapsedDisplays(all, 'antigravity'), [all[1]])
  assert.deepEqual(expandedDisplays(all, 'antigravity'), [all[1], all[0]])
  assert.deepEqual(collapsedDisplays(all, undefined), [])
  assert.deepEqual(collapsedDisplays(all, 'deepseek'), [])
  assert.deepEqual(collapsedDisplays(all, 'grok'), [])
})

test('non-subscription selections retain only the last subscription and its model scope', () => {
  const codex = { provider: 'codex', model: 'gpt-test' }
  const anti = { provider: 'antigravity', model: 'gemini-model-59' }
  const api = { provider: 'deepseek', model: 'deepseek-chat' }
  assert.equal(retainSubscriptionSelection(undefined, api), undefined)
  assert.equal(retainSubscriptionSelection(undefined, undefined), undefined)
  assert.equal(retainSubscriptionSelection(undefined, codex), codex)
  assert.equal(retainSubscriptionSelection(codex, api), codex)
  assert.equal(retainSubscriptionSelection(codex, anti), anti)
  assert.equal(retainSubscriptionSelection(anti, api), anti)
  assert.equal(retainSubscriptionSelection(anti, undefined), anti)
  assert.deepEqual(collapsedDisplays([display('codex'), display()], retainSubscriptionSelection(anti, api)?.provider).map(d => d.provider), ['antigravity'])
  assert.deepEqual(collapsedDisplays([display('codex')], anti.provider), [])
})

test('Cursor and built-in key providers participate in the session quota selection', () => {
  for (const provider of ['cursor-subscription', 'opencode-go', 'kimi-coding'] as const) {
    const selected = { provider, model: 'sample' }
    assert.deepEqual(retainSubscriptionSelection(undefined, selected), selected)
    assert.equal(collapsedDisplays([display('codex'), display(provider)], provider)[0]?.provider, provider)
  }
})

test('always mode pins the current provider and rotates the rest in display order', () => {
  const all = [display('codex'), display('grok'), display()]
  const pick = (step: number) => rotatingDisplay(all, 'grok', step)[0]?.provider
  // A provider with usage keeps the badge pinned no matter the tick.
  for (const step of [0, 1, 2, 3, 7]) assert.equal(pick(step), 'grok')
  // Without a matching provider the rotation walks the display order and wraps.
  const rotate = (steps: number[]) => steps.map(step => rotatingDisplay(all, undefined, step)[0]?.provider)
  assert.deepEqual(rotate([0, 1, 2, 3, 4, 5]), ['codex', 'grok', 'antigravity', 'codex', 'grok', 'antigravity'])
  assert.deepEqual(rotate([-1, -2, -3]), ['antigravity', 'grok', 'codex'])
  // A shrinking roster keeps every provider reachable: the modulo re-bases as rows drop out.
  const two = [display('codex'), display('grok')]
  assert.deepEqual([0, 1, 2, 3].map(step => rotatingDisplay(two, undefined, step)[0]?.provider), ['codex', 'grok', 'codex', 'grok'])
  // No usage anywhere means no badge; unusable steps stay put on the first row.
  assert.deepEqual(rotatingDisplay([], undefined, 3), [])
  assert.equal(rotatingDisplay(all, 'deepseek', Number.NaN)[0]?.provider, 'codex')
})

test('quota roster and usage calls include Cursor, OpenCode Go and Kimi while tolerating OAuth status failure', async () => {
  const calls: { endpoint: string; payload: unknown }[] = []
  const rpc = { call: async (_channel: string, endpoint: string, payload: unknown) => {
    calls.push({ endpoint, payload })
    if (endpoint.endsWith('.status')) throw new Error('OAuth status unavailable')
    if (endpoint.endsWith('.cursorStatus')) return { ok: true, value: { authenticated: true } }
    if (endpoint.endsWith('.externalStatus')) return { ok: true, value: {
      'opencode-go': { configured: true }, 'kimi-code': { configured: true },
    } }
    return { ok: true, value: { supported: true, windows: [{ kind: 'other', usedPercent: 20 }] } }
  } } satisfies Pick<ClientConnectionRpc, 'call'> as ClientConnectionRpc
  const { roster, refreshed } = await loadBadgeRoster(rpc)
  assert.deepEqual(roster.map(entry => entry.provider), ['cursor-subscription', 'opencode-go', 'kimi-coding'])
  assert.equal(refreshed.has('codex'), false)
  assert.equal(refreshed.has('cursor-subscription'), true)
  await Promise.all(roster.map(entry => usageOf(rpc, entry)))
  assert.deepEqual(calls.slice(3), [
    { endpoint: 'subscriptions-auth.cursorUsage', payload: {} },
    { endpoint: 'subscriptions-auth.externalUsage', payload: { source: 'opencode-go' } },
    { endpoint: 'subscriptions-auth.externalUsage', payload: { source: 'kimi-code' } },
  ])
})

test('grouping merges a provider\'s accounts into one row in roster order and drops accounts without windows', () => {
  const roster: UsageRosterEntry[] = [
    { provider: 'codex', account: { key: 'a', isDefault: true, account: 'a@example.invalid', plan: 'plus' } },
    { provider: 'claude', account: { key: 'c', isDefault: true } },
    { provider: 'codex', account: { key: 'b', isDefault: false } },
    { provider: 'kimi-coding', account: { key: 'kimi-code', isDefault: true } },
  ]
  const session: UsageWindow[] = [{ kind: 'session', usedPercent: 10 }]
  const weekly: UsageWindow[] = [{ kind: 'weekly', usedPercent: 20 }]
  const rows = groupUsageDisplays(
    roster,
    new Map<string, UsageWindow[]>([['codex:a', session], ['codex:b', weekly], ['kimi-coding:kimi-code', session]]),
    new Map([['codex:b', 'pro']]),
  )
  // Claude has no windows, so it has no row; Codex's second account joins
  // the first row instead of opening a new one.
  assert.deepEqual(rows, [
    { provider: 'codex', name: 'Codex', accounts: [
      { key: 'a', isDefault: true, account: 'a@example.invalid', plan: 'plus', windows: session },
      { key: 'b', isDefault: false, plan: 'pro', windows: weekly },
    ] },
    { provider: 'kimi-coding', name: 'Kimi Code', accounts: [
      { key: 'kimi-code', isDefault: true, windows: session },
    ] },
  ])
  // A plan reported by the usage call outranks the one on the roster.
  assert.equal(groupUsageDisplays(roster.slice(0, 1), new Map([['codex:a', session]]), new Map([['codex:a', 'pro']]))[0]?.accounts[0]?.plan, 'pro')
})

test('data icon supports both DSH export names without requiring either named import', (t) => {
  // The empty case is a host contract miss, which warns once; keep it off the test output.
  const warn = t.mock.method(console, 'warn', () => {})
  const modern = () => createElement('svg', { 'data-version': 'modern' })
  const legacy = () => createElement('svg', { 'data-version': 'legacy' })
  assert.equal(usageBadgeIcon({ IconDataOutlineRegular: modern, IconDataOutline16: legacy }), modern)
  assert.equal(usageBadgeIcon({ IconDataOutlineRegular: modern }), modern)
  assert.equal(usageBadgeIcon({ IconDataOutline16: legacy }), legacy)
  assert.match(renderToStaticMarkup(createElement(usageBadgeIcon({ IconDataOutlineRegular: modern }))), /data-version="modern"/)
  assert.equal(renderToStaticMarkup(createElement(usageBadgeIcon({}))), '')
  assert.equal(warn.mock.callCount(), 1)
})

test('Antigravity previews only the exact current model, retaining all hidden windows', () => {
  const original = structuredClone(windows)
  assert.deepEqual(previewWindows(windows, undefined, 'antigravity'), { shown: [], hidden: windows })
  assert.deepEqual(previewWindows(windows, 'missing', 'antigravity'), { shown: [], hidden: windows })
  const current = previewWindows(windows, 'gemini-model-59', 'antigravity')
  assert.equal(current.shown.length, 1)
  assert.equal(current.shown[0]?.scope, 'gemini-model-59')
  assert.equal(current.hidden.length, 59)
  const multiple: UsageWindow[] = [...windows,
    { kind: 'weekly', scope: 'gemini-model-59', usedPercent: 81 },
    { kind: 'session', scope: 'gemini-model-59', usedPercent: 25 }]
  const bounded = previewWindows(multiple, 'gemini-model-59', 'antigravity')
  assert.deepEqual(bounded.shown.map(w => w.usedPercent), [59, 81])
  assert.equal(new Set([...bounded.shown, ...bounded.hidden]).size, multiple.length)
  assert.deepEqual(windows, original)
  for (const provider of ['codex', 'grok', 'claude'] as const) {
    assert.equal(previewWindows(windows, undefined, provider).shown.length, 4)
  }
})

test('inactive Antigravity renders every model inside a closed disclosure', () => {
  const translate = (key: keyof typeof en, params?: Record<string, unknown>) =>
    en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  const html = renderToStaticMarkup(createElement(AccountWindows, { windows, model: undefined, provider: 'antigravity', translate }))
  assert.ok(html.indexOf('<details') < html.indexOf('gemini-model-0'))
  assert.ok(html.includes(translate('usageBadgeMoreWindows', { count: 60 })))
  assert.ok(!html.includes('open=""'))
})

test('model reader observes switches within the same provider and handles missing directories', async () => {
  let model = 'one'
  const read = createCurrentModelReader(() => ({ directoryFor: sessionId => {
    assert.equal(sessionId, 'session')
    return { load: async () => ({ current: { provider: 'antigravity', model } }) }
  } }), 'session')
  assert.deepEqual(await read(), { provider: 'antigravity', model: 'one' })
  model = 'two'
  assert.deepEqual(await read(), { provider: 'antigravity', model: 'two' })
  assert.equal(await createCurrentModelReader(() => undefined, 'session')(), undefined)
  assert.equal(await createCurrentModelReader(() => ({ directoryFor: () => ({ load: async () => ({ current: null }) }) }), 'session')(), undefined)
})

test('MiniMax pill and dialog show the standard model, not only video', async () => {
  // The standard model's windows carry explicit percentages with zero counts.
  const start = Date.now() - 3_600_000
  const rows = [
    { model_name: 'general', start_time: start, end_time: start + 18_000_000,
      weekly_start_time: start, weekly_end_time: start + 604_800_000,
      current_interval_total_count: 0, current_interval_usage_count: 0, current_interval_remaining_percent: 94,
      current_weekly_total_count: 0, current_weekly_usage_count: 0, current_weekly_remaining_percent: 98 },
    { model_name: 'video', start_time: start, end_time: start + 86_400_000,
      weekly_start_time: start, weekly_end_time: start + 604_800_000,
      current_interval_total_count: 3, current_interval_usage_count: 3, current_interval_remaining_percent: 100,
      current_weekly_total_count: 21, current_weekly_usage_count: 21, current_weekly_remaining_percent: 100 },
  ]
  const usage = await fetchMiniMaxUsage('key', 'global', (async () => Response.json({ model_remains: rows })) as typeof fetch)
  const d = display('minimax', usage.windows!)
  d.name = 'MiniMax'
  // The pill reads the first two windows in the API's order: the standard model's two.
  const pill = compactSegment(d)
  assert.match(pill, /^MiniMax \S+ 6% · \S+ 2% · \+2$/)
  const translate = (key: keyof typeof en, params?: Record<string, unknown>) => en[key]
    .replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  const html = renderToStaticMarkup(createElement(AccountWindows, { windows: usage.windows!, model: undefined, provider: 'minimax', translate }))
  for (const label of ['5-hour window · general', 'Weekly · general', 'Weekly · video']) {
    assert.ok(html.includes(label), label)
  }
})

test('a named Kimi limit is labelled the same on the settings card and in the dialog', async () => {
  // Kimi's `limits[]` entries may carry a `name`; the parser keeps it as the
  // window's scope. The dialog has always shown it, and the external card now
  // does too, so the two surfaces must not disagree.
  const usage = await fetchKimiCodeUsage('key', (async () => Response.json({ limits: [
    { name: 'Coding', window: { duration: 300, timeUnit: 'MINUTE' }, detail: { limit: 100, used: 10 } },
    { window: { duration: 7, timeUnit: 'DAY' }, detail: { limit: 100, used: 20 } },
  ] })) as typeof fetch)
  const translate = (key: keyof typeof en, params?: Record<string, unknown>) => en[key]
    .replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  const cardLabels = usage.windows!.map(window => externalUsageWindowLabel(translate, window))
  assert.deepEqual(cardLabels, ['5-hour window · Coding', 'Weekly'])
  const html = renderToStaticMarkup(createElement(AccountWindows, { windows: usage.windows!, model: undefined, provider: 'kimi-coding', translate }))
  for (const label of cardLabels) assert.ok(html.includes(`>${label}<`), label)
})
