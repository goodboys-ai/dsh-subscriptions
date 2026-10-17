/**
 * Executes the real OllamaSettingsManager with the hook dispatcher in
 * component-harness.ts and fixture RPCs, so the stash, tick/untick, effort
 * selector, context input and Save gating run through their production
 * handlers.
 *
 * What this does not show: real React reconciliation and effect scheduling,
 * layout, focus, the native dialog, theming, or screen-reader behavior. The
 * JSX tree is inspected, not mounted in a browser, and `document` is stubbed
 * only so the dialog effects run. The validator and runtime caps are covered
 * by the store and adapter specs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { OllamaSettingsManager } from '../src/client/OllamaSettingsManager.js'
import { en } from '../src/client/locales.js'
import type { SubscriptionsKey } from '../src/client/locales.js'
import type {
  OllamaCloudCandidate,
  OllamaModelDraft,
  OllamaSettingsView,
} from '../src/client/ollama-draft.js'
import { validateOllamaSettings } from '../src/providers/ollama-settings.js'
import { Component, nodes, settle, text } from './component-harness.js'
import type { Node } from './component-harness.js'

const t = (key: SubscriptionsKey, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params?.[name] ?? ''),
  )

const candidate = (
  id: string,
  efforts: string[],
  extra: Partial<OllamaCloudCandidate> = {},
): OllamaCloudCandidate => ({
  id,
  rawId: id.replace(/:cloud$/, ''),
  name: id.replace(/:cloud$/, ''),
  vision: false,
  thinking: efforts.length > 0,
  efforts,
  ...extra,
})

function fixture(
  stored: OllamaModelDraft[],
  listing: OllamaCloudCandidate[] | Error,
  viewModels: OllamaSettingsView['models'] = [],
) {
  const saved: unknown[] = []
  const rpc = {
    call: async (_channel: string, endpoint: string, payload: any) => {
      if (endpoint === 'subscriptions-auth.ollamaSettings') {
        const view: OllamaSettingsView = {
          provider: 'ollama-cloud',
          settings: { models: structuredClone(stored) },
          effective: {
            baseURL: 'https://ollama.com/api',
            apiKeyRef: 'OLLAMA_API_KEY',
            web: false,
          },
          models: viewModels,
          configOverridesModels: false,
        }
        return { ok: true, value: view }
      }
      if (endpoint === 'subscriptions-auth.ollamaModels') {
        return listing instanceof Error
          ? { ok: false, error: { message: listing.message } }
          : { ok: true, value: { models: listing } }
      }
      if (endpoint === 'subscriptions-auth.ollamaSetSettings') {
        // The real validator decides whether the draft is saveable.
        try {
          validateOllamaSettings(payload.settings)
        } catch (error) {
          return { ok: false, error: { message: (error as Error).message } }
        }
        saved.push(structuredClone(payload.settings))
        return { ok: true, value: {} }
      }
      throw new Error(`unexpected fixture endpoint ${endpoint}`)
    },
  } as unknown as ConnectionHandle['rpc']
  return { rpc, saved }
}

/** The dialog needs a document and HTMLElement for its effects; neither is DOM coverage. */
function mount(rpc: ConnectionHandle['rpc']) {
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  )
  const previousHTMLElement = Object.getOwnPropertyDescriptor(
    globalThis,
    'HTMLElement',
  )
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { activeElement: null },
  })
  Object.defineProperty(globalThis, 'HTMLElement', {
    configurable: true,
    value: class {},
  })
  const dialog = { showModal() {}, close() {} }
  const component = new Component(() => {
    const tree = OllamaSettingsManager({
      rpc,
      t,
      onClose: () => {},
      onSaved: () => {},
    })
    ;(tree as unknown as { ref: { current: unknown } }).ref.current = dialog
    return tree
  })
  return {
    component,
    cleanup() {
      component.unmount()
      if (previousDocument)
        Object.defineProperty(globalThis, 'document', previousDocument)
      else Reflect.deleteProperty(globalThis, 'document')
      if (previousHTMLElement)
        Object.defineProperty(globalThis, 'HTMLElement', previousHTMLElement)
      else Reflect.deleteProperty(globalThis, 'HTMLElement')
    },
  }
}

function button(component: Component, name: string): Node {
  const result = nodes(component.tree).find(
    (node) => node.type === 'button' && text(node).trim() === name,
  )
  assert.ok(result, `button ${name}`)
  return result
}
const checkboxRows = (component: Component) =>
  nodes(component.tree).filter(
    (node) =>
      node.type === 'label' &&
      nodes(node.props.children).some(
        (child) =>
          child.type === 'input' &&
          child.props.type === 'checkbox' &&
          child.props['aria-label'] === undefined &&
          node.props.style?.overflowWrap === 'anywhere',
      ),
  )
function rowBox(component: Component, label: string): Node {
  const row = checkboxRows(component).find((node) =>
    text(node).trim().startsWith(label),
  )
  assert.ok(row, `row ${label}`)
  return nodes(row.props.children).find((child) => child.type === 'input')!
}
const names = (component: Component) =>
  checkboxRows(component).map((node) => text(node).replace(/\s+/g, ' ').trim())
const field = (component: Component, label: string): Node => {
  const result = nodes(component.tree).find(
    (node) => node.type === 'input' && node.props['aria-label'] === label,
  )
  assert.ok(result, `input ${label}`)
  return result
}
const select = (component: Component, label: string): Node => {
  const result = nodes(component.tree).find(
    (node) => node.type === 'select' && node.props['aria-label'] === label,
  )
  assert.ok(result, `select ${label}`)
  return result
}
const saveButton = (component: Component) => button(component, en.modelsSave)

async function open(f: ReturnType<typeof fixture>) {
  const view = mount(f.rpc)
  view.component.render()
  await settle(view.component)
  return view
}
async function fetchList(view: ReturnType<typeof mount>) {
  button(view.component, en.ollamaFetch).props.onClick()
  await settle(view.component)
}

test('ticking a fetched model enables Save without any adopt step', async () => {
  const view = await open(fixture([], [candidate('a:cloud', ['low', 'high'])]))
  await fetchList(view)
  assert.equal(saveButton(view.component).props.disabled, true)
  rowBox(view.component, 'a').props.onChange({ target: { checked: true } })
  await settle(view.component)
  assert.equal(saveButton(view.component).props.disabled, false)
  view.cleanup()
})

test('a stored model missing from a failed fetch can be unticked and ticked back unchanged', async () => {
  const kept: OllamaModelDraft = {
    id: 'legacy:cloud',
    name: 'Custom',
    defaultEffort: 'low',
    efforts: ['low', 'high'],
    maxTokens: 9000,
  }
  const f = fixture([kept], new Error('offline'))
  const view = await open(f)
  await fetchList(view)
  assert.deepEqual(names(view.component), ['Custom'])
  rowBox(view.component, 'Custom').props.onChange({
    target: { checked: false },
  })
  await settle(view.component)
  // Unticked rows stay listed so they can be ticked back.
  assert.deepEqual(names(view.component), ['Custom'])
  assert.equal(rowBox(view.component, 'Custom').props.checked, false)
  rowBox(view.component, 'Custom').props.onChange({ target: { checked: true } })
  await settle(view.component)
  saveButton(view.component).props.onClick()
  await settle(view.component)
  assert.deepEqual(f.saved, [{ models: [kept] }])
  view.cleanup()
})

test('Select none then Select all restores edited names and efforts, not candidate defaults', async () => {
  const kept: OllamaModelDraft = {
    id: 'a:cloud',
    name: 'Custom A',
    defaultEffort: 'low',
    efforts: ['low', 'high'],
    thinking: true,
  }
  const f = fixture(
    [kept],
    [candidate('a:cloud', ['low', 'high'], { defaultEffort: 'high' })],
  )
  const view = await open(f)
  await fetchList(view)
  button(view.component, en.modelsSelectNone).props.onClick()
  await settle(view.component)
  button(view.component, en.modelsSelectAll).props.onClick()
  await settle(view.component)
  saveButton(view.component).props.onClick()
  await settle(view.component)
  assert.deepEqual(f.saved, [{ models: [kept] }])
  view.cleanup()
})

test('the effort selector offers only the row efforts and a stale snapshot never reaches Save', async () => {
  const stored: OllamaModelDraft = {
    id: 'a:cloud',
    thinking: true,
    efforts: ['low', 'high'],
  }
  const f = fixture(
    [stored],
    [candidate('a:cloud', ['low', 'max'])],
    // The opened-dialog snapshot carries a level ('medium') the row and the
    // fresh fetch do not; a snapshot-first selector would offer it.
    [
      {
        id: 'a:cloud',
        name: 'a',
        vision: false,
        thinking: true,
        efforts: [
          { id: 'low', name: 'low' },
          { id: 'medium', name: 'medium' },
          { id: 'high', name: 'high' },
        ],
      },
    ],
  )
  const view = await open(f)
  await fetchList(view)
  rowBox(view.component, 'a').props.onChange({ target: { checked: false } })
  await settle(view.component)
  rowBox(view.component, 'a').props.onChange({ target: { checked: true } })
  await settle(view.component)
  const options = nodes(
    select(view.component, `a ${en.modelDefaultsTitle}`),
  ).filter((node) => node.type === 'option')
  // The ticked row keeps its own stored levels; the snapshot only names them.
  assert.deepEqual(
    options.map((option) => option.props.value),
    ['', 'low', 'high'],
  )
  select(view.component, `a ${en.modelDefaultsTitle}`).props.onChange({
    target: { value: 'high' },
  })
  await settle(view.component)
  saveButton(view.component).props.onClick()
  await settle(view.component)
  assert.deepEqual(f.saved, [
    { models: [{ ...stored, defaultEffort: 'high' }] },
  ])
  view.cleanup()
})

test('context input: invalid text blocks Save once the draft is dirty; valid numbers save', async () => {
  const f = fixture([{ id: 'a:cloud', contextWindow: 262_144 }], [])
  const view = await open(f)
  const input = () => field(view.component, `a:cloud ${en.modelsContext}`)
  // A valid edit makes the draft dirty first. Starting from invalid text would
  // leave Save disabled for the unrelated reason that nothing changed, and the
  // invalid-text gate itself would go untested.
  input().props.onChange({ target: { value: '65536' } })
  await settle(view.component)
  assert.equal(saveButton(view.component).props.disabled, false)
  for (const bad of ['1e3', '0', '-5', 'abc', '99999999999999999999']) {
    input().props.onChange({ target: { value: bad } })
    await settle(view.component)
    assert.equal(
      saveButton(view.component).props.disabled,
      true,
      `rejects ${bad}`,
    )
    assert.equal(input().props['aria-invalid'], true, `flags ${bad}`)
    assert.ok(
      nodes(view.component.tree).some((node) => node.props.role === 'alert'),
      `alerts on ${bad}`,
    )
  }
  input().props.onChange({ target: { value: '131072' } })
  await settle(view.component)
  assert.equal(saveButton(view.component).props.disabled, false)
  assert.equal(input().props['aria-invalid'], false)
  saveButton(view.component).props.onClick()
  await settle(view.component)
  assert.deepEqual(f.saved.at(-1), {
    models: [
      { id: 'a:cloud', contextWindow: 262_144, contextOverride: 131_072 },
    ],
  })
  view.cleanup()
})

test('invalid context text on an unticked row does not block Save', async () => {
  const f = fixture([{ id: 'a:cloud' }, { id: 'b:cloud' }], [])
  const view = await open(f)
  field(view.component, `a:cloud ${en.modelsContext}`).props.onChange({
    target: { value: 'abc' },
  })
  await settle(view.component)
  assert.equal(saveButton(view.component).props.disabled, true)
  // Removing the row removes the problem: only ticked rows are saved.
  rowBox(view.component, 'a:cloud').props.onChange({
    target: { checked: false },
  })
  await settle(view.component)
  assert.equal(saveButton(view.component).props.disabled, false)
  saveButton(view.component).props.onClick()
  await settle(view.component)
  assert.deepEqual(f.saved, [{ models: [{ id: 'b:cloud' }] }])
  view.cleanup()
})

test('a blank context input deletes the stored override', async () => {
  const f = fixture(
    [{ id: 'a:cloud', contextWindow: 262_144, contextOverride: 4096 }],
    [],
  )
  const view = await open(f)
  assert.equal(
    field(view.component, `a:cloud ${en.modelsContext}`).props.value,
    '4096',
  )
  field(view.component, `a:cloud ${en.modelsContext}`).props.onChange({
    target: { value: '' },
  })
  await settle(view.component)
  saveButton(view.component).props.onClick()
  await settle(view.component)
  assert.deepEqual(f.saved, [
    { models: [{ id: 'a:cloud', contextWindow: 262_144 }] },
  ])
  view.cleanup()
})

test('the context bounds follow the latest fetch over the stored snapshot', async () => {
  const f = fixture(
    [{ id: 'a:cloud', contextWindow: 262_144 }],
    [candidate('a:cloud', [], { contextWindow: 128_000 })],
  )
  const view = await open(f)
  const bounds = () => text(view.component.tree).includes('Default 262144')
  assert.equal(bounds(), true)
  await fetchList(view)
  assert.equal(
    text(view.component.tree).includes('Default 128000 · Maximum 128000'),
    true,
  )
  assert.equal(
    field(view.component, `a ${en.modelsContext}`).props.placeholder,
    '128000',
  )
  view.cleanup()
})

test('invalid context text survives untick and re-tick and keeps Save blocked until it is fixed', async () => {
  const f = fixture([{ id: 'a:cloud', contextOverride: 4096 }], [])
  const view = await open(f)
  field(view.component, `a:cloud ${en.modelsContext}`).props.onChange({
    target: { value: '-5' },
  })
  await settle(view.component)
  // Unticking drops the row from the draft, so the problem leaves with it;
  // ticking it back brings the typed text and the gate back together.
  rowBox(view.component, 'a:cloud').props.onChange({
    target: { checked: false },
  })
  await settle(view.component)
  rowBox(view.component, 'a:cloud').props.onChange({
    target: { checked: true },
  })
  await settle(view.component)
  assert.equal(
    field(view.component, `a:cloud ${en.modelsContext}`).props.value,
    '-5',
  )
  // This does not prove the text stays out of the draft: Save is blocked and
  // any later edit overwrites the field, so that guard is defence in depth.
  assert.equal(saveButton(view.component).props.disabled, true)
  field(view.component, `a:cloud ${en.modelsContext}`).props.onChange({
    target: { value: '' },
  })
  await settle(view.component)
  saveButton(view.component).props.onClick()
  await settle(view.component)
  assert.deepEqual(f.saved, [{ models: [{ id: 'a:cloud' }] }])
  view.cleanup()
})
