/**
 * Executes the real ProviderModelEditor and ProviderAccountManager with a small
 * React hook dispatcher and fixture RPCs. Effects, JSX event handlers and the
 * imperative collect handle exercise production load/collect/save logic; no
 * old view/fetch helper is substituted.
 *
 * What this cannot show, and must not be read as showing: the fixtures link the
 * child's ref and dirty callback by hand from the first render only, and the
 * editor is constructed with a fixed provider, so parent-to-child props are
 * never re-synchronised. Real React reconciliation and effect scheduling, an
 * editor frozen while a save is in flight, and DOM `disabled` events are
 * therefore outside what these tests can observe. The JSX tree is inspected,
 * not mounted in a browser: nothing here proves layout, focus, native dialog
 * behavior, contrast or theming, and the DOM stub exists only so dialog effects
 * can run. In short, this is isolated component logic with a manually linked
 * ref and dirty callback.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { ProviderModelEditor } from '../src/client/ProviderModelEditor.js'
import type { ProviderModelEditorHandle } from '../src/client/ProviderModelEditor.js'
import { ProviderAccountManager } from '../src/client/ProviderAccountManager.js'
import { en } from '../src/client/locales.js'
import type { SubscriptionsKey } from '../src/client/locales.js'
import type { ProviderPreferences } from '../src/provider-settings.js'
import type { SubscriptionProvider } from '../src/client/SubscriptionsSection.js'
import { Component, nodes, settle, text } from './component-harness.js'
import type { Node } from './component-harness.js'

const t = (key: SubscriptionsKey, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
function filter(component: Component) {
  return nodes(component.tree).find(node => node.type === 'input' && node.props['aria-label'] === en.modelDefaultsFilterPlaceholder)!
}
function modelLabels(component: Component): string[] {
  return nodes(component.tree).filter(node => node.type === 'label'
    && nodes(node.props.children).some(child => child.type === 'input' && child.props.type === 'checkbox')
    && !text(node).includes(en.modelsAutomatic)).map(node => text(node).trim())
}
function picker(component: Component, name: string): Node {
  const result = nodes(component.tree).find(node => node.type === 'select'
    && node.props['aria-label'] === `${name} ${en.modelDefaultsTitle}`)
  assert.ok(result, `effort picker for ${name}`)
  return result
}
function button(component: Component, name: string): Node {
  const result = nodes(component.tree).find(node => node.type === 'button' && text(node) === name)
  assert.ok(result, `button ${name}`)
  return result
}
const model = (id: string, name: string, efforts: string[] = ['low', 'high'], configured?: string) => ({
  id, name, efforts: efforts.map(id => ({ id, name: id })), ...(configured === undefined ? {} : { configured }),
})
const catalog = (models = [model('a', 'Alpha')], settings: ProviderPreferences = {}) => ({
  provider: 'codex' as SubscriptionProvider, models, settings, tools: [], accounts: [{ key: 'personal', label: 'Personal', models }],
})
type Catalog = ReturnType<typeof catalog>
type CatalogBody = Omit<Catalog, 'provider'>
type Fixture = { rpc: ConnectionHandle['rpc']; calls: { endpoint: string; payload: any }[]; replace: (next: CatalogBody) => void; failEffort: (fail: boolean) => void }
function fixture(initial: Catalog): Fixture {
  let data: Catalog = initial
  const calls: { endpoint: string; payload: any }[] = []
  let failEffort = false
  const rpc = { call: async (channel: string, endpoint: string, payload: any) => {
    assert.equal(channel, '/api')
    calls.push({ endpoint, payload: structuredClone(payload) })
    if (endpoint === 'subscriptions-auth.providerSettings') return { ok: true, value: structuredClone(data) }
    if (endpoint === 'subscriptions-auth.setModelDefault') {
      if (failEffort) return { ok: false, error: { message: 'fixture save failure' } }
      data = { ...data, models: data.models.map(model => model.id === payload.model
        ? { ...model, configured: payload.effort } : model) }
      return { ok: true, value: {} }
    }
    if (endpoint === 'subscriptions-auth.setProviderSettings') {
      data = { ...data, settings: payload.settings }
      return { ok: true, value: {} }
    }
    throw new Error(`unexpected fixture endpoint ${endpoint}`)
  } } as unknown as ConnectionHandle['rpc']
  return { rpc, calls, replace: (next: CatalogBody) => { data = { ...data, ...next } }, failEffort: (fail: boolean) => { failEffort = fail } }
}
function editor(rpc: ConnectionHandle['rpc'], ref = { current: null as ProviderModelEditorHandle | null },
  onDirtyChange?: (dirty: boolean) => void) {
  const render = (ProviderModelEditor as unknown as { render: (props: any, ref: any) => Node }).render
  const component = new Component(() => render({ provider: 'codex', rpc, t, onDirtyChange }, ref))
  return { component, ref }
}

// The native dialog is not mounted: do not interpret these stubs as DOM coverage.
function manager(rpc: ConnectionHandle['rpc'], provider: SubscriptionProvider = 'codex') {
  let closed = 0
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null } })
  const dialog = { showModal() {}, close() {} }
  const component = new Component(() => {
    const tree = ProviderAccountManager({ provider, name: 'Codex', rpc, t, onClose: () => { closed++ } })
    ;(tree as unknown as { ref: { current: unknown } }).ref.current = dialog
    return tree
  })
  component.render()
  const child = nodes(component.tree).find(node => node.type === ProviderModelEditor)!
  const ref = (child as unknown as { ref: { current: ProviderModelEditorHandle | null } }).ref
  const models = editor(rpc, ref, child.props.onDirtyChange)
  return { component, models: models.component, ref, closed: () => closed, cleanup() {
    // Cleanup never restores focus because the stub's previous activeElement is null.
    const previousHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class {} })
    models.component.unmount(); component.unmount()
    if (previousHTMLElement) Object.defineProperty(globalThis, 'HTMLElement', previousHTMLElement)
    else Reflect.deleteProperty(globalThis, 'HTMLElement')
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  } }
}

test('editor loading catalog exposes status and collects no edits before the RPC settles', async () => {
  let resolve!: (value: unknown) => void
  const rpc = { call: () => new Promise(value => { resolve = value }) } as unknown as ConnectionHandle['rpc']
  const { component, ref } = editor(rpc)
  component.render()
  component.render()
  assert.ok(nodes(component.tree).some(node => node.props.role === 'status'))
  assert.deepEqual(modelLabels(component), [])
  assert.deepEqual(ref.current!.collect(), { efforts: [] })
  resolve({ ok: true, value: catalog() })
  await settle(component)
  assert.deepEqual(modelLabels(component), ['Alpha'])
  component.unmount()
})

test('editor catalog keeps non-reasoning models as visibility rows but gives them no effort picker', async () => {
  const f = fixture(catalog([model('a', 'Alpha'), model('b', 'Beta', [], 'high')]))
  const { component, ref } = editor(f.rpc)
  await settle(component)
  assert.deepEqual(modelLabels(component), ['Alpha', 'Beta'])
  assert.equal(nodes(component.tree).filter(node => node.type === 'select').length, 1)
  button(component, en.modelsSelectNone).props.onClick()
  await settle(component)
  assert.deepEqual(ref.current!.collect()!.efforts, [], 'no effort edit is invented for a non-reasoning model')
  assert.deepEqual(f.calls.map(call => call.endpoint), ['subscriptions-auth.providerSettings'])
  component.unmount()
})

test('editor loads configured overrides, not effective defaults, and collects only changed efforts', async () => {
  const effectiveOnly = { ...model('b', 'Beta'), effective: 'low' }
  const f = fixture(catalog([model('a', 'Alpha', ['low', 'high'], 'high'),
    effectiveOnly, model('c', 'Plain', [])]))
  const { component, ref } = editor(f.rpc)
  await settle(component)
  assert.equal(picker(component, 'Alpha').props.value, 'high')
  assert.equal(picker(component, 'Beta').props.value, '')
  assert.deepEqual(ref.current!.collect(), { efforts: [] })
  picker(component, 'Beta').props.onChange({ target: { value: 'low' } })
  await settle(component)
  assert.deepEqual(ref.current!.collect()!.efforts, [{ model: 'b', effort: 'low' }])
  picker(component, 'Beta').props.onChange({ target: { value: '' } })
  await settle(component)
  picker(component, 'Alpha').props.onChange({ target: { value: '' } })
  await settle(component)
  assert.deepEqual(ref.current!.collect()!.efforts, [{ model: 'a', effort: '' }])
  component.unmount()
})

test('editor filter matches display name or model id, case- and space-insensitively', async () => {
  const f = fixture(catalog([model('gpt-5.6-sol', 'GPT-5.6 Sol'),
    model('claude-sonnet-5', 'Claude Sonnet 5'), model('claude-opus-5', 'Claude Opus 5')]))
  const { component } = editor(f.rpc)
  await settle(component)
  for (const [query, expected] of [
    ['  SONNET ', ['Claude Sonnet 5']],
    ['claude-', ['Claude Sonnet 5', 'Claude Opus 5']],
    ['gpt', ['GPT-5.6 Sol']],
  ] as const) {
    filter(component).props.onChange({ target: { value: query } })
    await settle(component)
    assert.deepEqual(modelLabels(component), expected)
  }
  component.unmount()
})

test('editor empty filter result retains the input and unsaved effort edits', async () => {
  const f = fixture(catalog())
  const { component, ref } = editor(f.rpc)
  await settle(component)
  picker(component, 'Alpha').props.onChange({ target: { value: 'high' } })
  await settle(component)
  filter(component).props.onChange({ target: { value: 'no-such-model' } })
  await settle(component)
  assert.deepEqual(modelLabels(component), [])
  assert.equal(filter(component).props.value, 'no-such-model')
  assert.ok(text(component.tree).includes(t('modelDefaultsFilterEmpty', { query: 'no-such-model' })))
  assert.deepEqual(ref.current!.collect()!.efforts, [{ model: 'a', effort: 'high' }])
  component.unmount()
})

test('editor blank filter keeps the entire catalog including non-reasoning models', async () => {
  const f = fixture(catalog([model('a', 'Alpha'), model('b', 'Beta', [])]))
  const { component } = editor(f.rpc)
  await settle(component)
  filter(component).props.onChange({ target: { value: '   ' } })
  await settle(component)
  assert.deepEqual(modelLabels(component), ['Alpha', 'Beta'])
  component.unmount()
})

test('manager Save persists and clears collected effort overrides; reopening loads the saved value', async () => {
  const f = fixture(catalog())
  let view = manager(f.rpc)
  try {
    await settle(view.component, view.models)
    picker(view.models, 'Alpha').props.onChange({ target: { value: 'high' } })
    await settle(view.models, view.component)
    assert.equal(f.calls.some(call => call.endpoint.endsWith('.setModelDefault')), false, 'edits stay local before Save')
    assert.equal(button(view.component, en.modelsSave).props.disabled, false)
    button(view.component, en.modelsSave).props.onClick()
    await settle(view.models, view.component)
    assert.equal(view.closed(), 1)
    assert.deepEqual(f.calls.filter(call => call.endpoint.endsWith('.setModelDefault')).map(call => call.payload), [
      { provider: 'codex', model: 'a', effort: 'high' },
    ])
  } finally { view.cleanup() }
  view = manager(f.rpc)
  try {
    await settle(view.component, view.models)
    assert.equal(picker(view.models, 'Alpha').props.value, 'high')
    picker(view.models, 'Alpha').props.onChange({ target: { value: '' } })
    await settle(view.models, view.component)
    button(view.component, en.modelsSave).props.onClick()
    await settle(view.models, view.component)
    assert.deepEqual(f.calls.filter(call => call.endpoint.endsWith('.setModelDefault')).at(-1)!.payload,
      { provider: 'codex', model: 'a' }, 'Follow provider clears by omitting effort')
  } finally { view.cleanup() }
})

test('manager failed effort save keeps the collected draft for retry', async () => {
  const f = fixture(catalog())
  const view = manager(f.rpc)
  try {
    await settle(view.component, view.models)
    picker(view.models, 'Alpha').props.onChange({ target: { value: 'high' } })
    await settle(view.models, view.component)
    f.failEffort(true)
    button(view.component, en.modelsSave).props.onClick()
    await settle(view.models, view.component)
    assert.equal(view.closed(), 0)
    assert.ok(text(view.component.tree).includes('fixture save failure'))
    assert.deepEqual(view.ref.current!.collect()!.efforts, [{ model: 'a', effort: 'high' }])
    f.failEffort(false)
    button(view.component, en.modelsSave).props.onClick()
    await settle(view.models, view.component)
    assert.equal(view.closed(), 1)
  } finally { view.cleanup() }
})

test('manager Save re-reads changed accounts instead of restoring the model draft account snapshot', async () => {
  const f = fixture(catalog(undefined, { accounts: { personal: { alias: 'Old' } } }))
  const view = manager(f.rpc)
  try {
    await settle(view.component, view.models)
    button(view.models, en.modelsSelectNone).props.onClick()
    await settle(view.models, view.component)
    f.replace(catalog(undefined, { accounts: { work: { alias: 'New', poolEnabled: false } } }))
    button(view.component, en.modelsSave).props.onClick()
    await settle(view.models, view.component)
    const writes = f.calls.filter(call => call.endpoint.endsWith('.setProviderSettings'))
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].payload.settings, {
      visibleModels: [], contextWindows: {}, accounts: { work: { alias: 'New', poolEnabled: false } },
    }, 'added account survives and removed account is not resurrected')
    assert.equal(f.calls.at(-2)!.endpoint, 'subscriptions-auth.providerSettings', 'fresh read immediately precedes settings write')
  } finally { view.cleanup() }
})

function ttlSelect(component: Component) {
  const select = nodes(component.tree).find(node => node.type === 'select' && node.props['aria-label'] === en.claudeCacheTtl)
  assert.ok(select, 'the prompt-cache TTL select')
  return select
}

test('the prompt-cache TTL select is Claude-only, follows config by default, and Save sends the choice', async () => {
  const f = fixture(catalog())
  const view = manager(f.rpc)
  try {
    await settle(view.component, view.models)
    assert.equal(nodes(view.component.tree).some(node => node.type === 'select' && node.props['aria-label'] === en.claudeCacheTtl), false,
      'the Codex dialog has no Claude TTL picker')
  } finally { view.cleanup() }
  const claude = manager(f.rpc, 'claude')
  try {
    await settle(claude.component, claude.models)
    assert.deepEqual(nodes(ttlSelect(claude.component)).filter(node => node.type === 'option')
      .map(node => ({ value: node.props.value, label: text(node) })), [
      { value: '', label: en.claudeCacheTtlFollowConfig },
      { value: '5m', label: en.claudeCacheTtl5m },
      { value: '1h', label: en.claudeCacheTtl1h },
    ])
    assert.equal(ttlSelect(claude.component).props.value, '', 'absent stored value follows the config')
    assert.equal(button(claude.component, en.modelsSave).props.disabled, true, 'an untouched picker does not enable Save')
    ttlSelect(claude.component).props.onChange({ target: { value: '1h' } })
    await settle(claude.component, claude.models)
    assert.equal(button(claude.component, en.modelsSave).props.disabled, false)
    button(claude.component, en.modelsSave).props.onClick()
    await settle(claude.component, claude.models)
    const writes = f.calls.filter(call => call.endpoint.endsWith('.setProviderSettings'))
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].payload.settings, { promptCacheTtl: '1h', accounts: {} })
  } finally { claude.cleanup() }
  // Reopening shows the saved value, and clearing the picker drops the field so the config applies again.
  const again = manager(f.rpc, 'claude')
  try {
    await settle(again.component, again.models)
    assert.equal(ttlSelect(again.component).props.value, '1h')
    ttlSelect(again.component).props.onChange({ target: { value: '' } })
    await settle(again.component, again.models)
    button(again.component, en.modelsSave).props.onClick()
    await settle(again.component, again.models)
    const writes = f.calls.filter(call => call.endpoint.endsWith('.setProviderSettings'))
    assert.equal(writes.at(-1)!.payload.settings.promptCacheTtl, undefined, 'follow config clears the stored override')
  } finally { again.cleanup() }
})

test('a model-only Save takes the TTL from the re-read settings, not the editor draft', async () => {
  const claudeCatalog = (settings: ProviderPreferences) => ({
    models: [model('a', 'Alpha')], settings, tools: [],
    accounts: [{ key: 'personal', label: 'Personal', models: [model('a', 'Alpha')] }],
  })
  const f = fixture({ provider: 'claude', ...claudeCatalog({ promptCacheTtl: '1h' }) })
  const view = manager(f.rpc, 'claude')
  try {
    await settle(view.component, view.models)
    assert.equal(ttlSelect(view.component).props.value, '1h', 'the dialog loads the stored override')
    // Another client clears the override while this dialog is open.
    f.replace(claudeCatalog({}))
    // Only a model setting changes; the TTL picker is untouched.
    button(view.models, en.modelsSelectNone).props.onClick()
    await settle(view.models, view.component)
    button(view.component, en.modelsSave).props.onClick()
    await settle(view.component, view.models)
    const writes = f.calls.filter(call => call.endpoint.endsWith('.setProviderSettings'))
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].payload.settings, { visibleModels: [], contextWindows: {}, accounts: {} },
      'the editor draft loaded with promptCacheTtl 1h; the write carries the re-read absence, not the stale value')
  } finally { view.cleanup() }
  // With the picker touched, its choice wins over whatever the re-read holds.
  const f2 = fixture({ provider: 'claude', ...claudeCatalog({ promptCacheTtl: '1h' }) })
  const touched = manager(f2.rpc, 'claude')
  try {
    await settle(touched.component, touched.models)
    f2.replace(claudeCatalog({}))
    ttlSelect(touched.component).props.onChange({ target: { value: '5m' } })
    await settle(touched.component, touched.models)
    button(touched.component, en.modelsSave).props.onClick()
    await settle(touched.component, touched.models)
    const writes = f2.calls.filter(call => call.endpoint.endsWith('.setProviderSettings'))
    assert.equal(writes.length, 1)
    assert.equal(writes[0].payload.settings.promptCacheTtl, '5m', 'the picker choice survives the re-read')
  } finally { touched.cleanup() }
})
