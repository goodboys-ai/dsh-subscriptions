/**
 * Executes the real ProviderModelEditor and ProviderAccountManager with a small
 * React hook dispatcher and fixture RPCs. Effects, JSX event handlers and the
 * imperative collect handle exercise production load/collect/save logic; no
 * old view/fetch helper is substituted. The JSX tree is inspected, not mounted
 * in a browser: these tests prove nothing about layout, focus, native dialog
 * behavior, contrast or theming. The DOM stub only lets dialog effects run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import type { ReactElement } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { ProviderModelEditor } from '../src/client/ProviderModelEditor.js'
import type { ProviderModelEditorHandle } from '../src/client/ProviderModelEditor.js'
import { ProviderAccountManager } from '../src/client/ProviderAccountManager.js'
import { en } from '../src/client/locales.js'
import type { SubscriptionsKey } from '../src/client/locales.js'
import type { ProviderPreferences } from '../src/provider-settings.js'

const t = (key: SubscriptionsKey, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
type Node = ReactElement<Record<string, any>>
type Slot = { value?: any; deps?: readonly unknown[] | undefined; cleanup?: (() => void) | undefined }
const internals = (React as unknown as {
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
}).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED

/** Only hook scheduling is faked; component logic and RPC unwrapping are real. */
class Component {
  private slots: Slot[] = []
  private cursor = 0
  private effects: (() => void)[] = []
  dirty = true
  tree!: Node
  constructor(private renderBody: () => Node) {}
  render() {
    if (!this.dirty) return
    this.dirty = false
    this.cursor = 0
    const slot = () => this.slots[this.cursor++] ?? (this.slots[this.cursor - 1] = {})
    const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
      const state = slot()
      if (!deps || !state.deps || deps.some((dep, i) => !Object.is(dep, state.deps![i]))) {
        state.deps = deps
        this.effects.push(() => { state.cleanup?.(); state.cleanup = run() || undefined })
      }
    }
    const previous = internals.ReactCurrentDispatcher.current
    internals.ReactCurrentDispatcher.current = {
      useState: (initial: any) => {
        const state = slot()
        if (!('value' in state)) state.value = typeof initial === 'function' ? initial() : initial
        return [state.value, (next: any) => {
          const value = typeof next === 'function' ? next(state.value) : next
          if (!Object.is(value, state.value)) { state.value = value; this.dirty = true }
        }]
      },
      useRef: (initial: any) => {
        const state = slot()
        state.value ??= { current: initial }
        return state.value
      },
      useEffect: effect,
      useId: () => { const state = slot(); return state.value ??= `fixture-${this.cursor}` },
      useImperativeHandle: (ref: { current: unknown }, create: () => unknown, deps: unknown[]) =>
        effect(() => { ref.current = create(); return () => { ref.current = null } }, deps),
    }
    try { this.tree = this.renderBody() } finally { internals.ReactCurrentDispatcher.current = previous }
    for (const run of this.effects.splice(0)) run()
  }
  unmount() { for (const slot of this.slots) slot.cleanup?.() }
}
function nodes(tree: any): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!React.isValidElement(tree)) return []
  const node = tree as Node
  return [node, ...nodes(node.props.children)]
}
function text(tree: any): string {
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (React.isValidElement(tree)) return text((tree as Node).props.children)
  return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : ''
}
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
async function settle(...components: Component[]) {
  // Drain fixture promises and consequent state updates, with a bounded budget.
  for (let i = 0; i < 8; i++) {
    for (const component of components) component.render()
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  for (const component of components) component.render()
  assert.ok(components.every(component => !component.dirty), 'fixture updates settled')
}
const model = (id: string, name: string, efforts: string[] = ['low', 'high'], configured?: string) => ({
  id, name, efforts: efforts.map(id => ({ id, name: id })), ...(configured === undefined ? {} : { configured }),
})
const catalog = (models = [model('a', 'Alpha')], settings: ProviderPreferences = {}) => ({
  provider: 'codex' as const, models, settings, tools: [], accounts: [{ key: 'personal', label: 'Personal', models }],
})
type Catalog = ReturnType<typeof catalog>
function fixture(initial: Catalog) {
  let data = initial
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
  return { rpc, calls, replace: (next: Catalog) => { data = next }, failEffort: (fail: boolean) => { failEffort = fail } }
}
function editor(rpc: ConnectionHandle['rpc'], ref = { current: null as ProviderModelEditorHandle | null },
  onDirtyChange?: (dirty: boolean) => void) {
  const render = (ProviderModelEditor as unknown as { render: (props: any, ref: any) => Node }).render
  const component = new Component(() => render({ provider: 'codex', rpc, t, onDirtyChange }, ref))
  return { component, ref }
}

// The native dialog is not mounted: do not interpret these stubs as DOM coverage.
function manager(rpc: ConnectionHandle['rpc']) {
  let closed = 0
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null } })
  const dialog = { showModal() {}, close() {} }
  const component = new Component(() => {
    const tree = ProviderAccountManager({ provider: 'codex', name: 'Codex', rpc, t, onClose: () => { closed++ } })
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
