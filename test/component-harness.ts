/**
 * A small React hook dispatcher for executing real client components with
 * fixture RPCs. See the header of model-defaults-view.spec.ts for what this
 * does and does not prove: component logic and handlers run for real, while
 * React reconciliation, effect scheduling, layout, focus and native dialog
 * behavior do not.
 */
import assert from 'node:assert/strict'
import React from 'react'
import type { ReactElement } from 'react'

export type Node = ReactElement<Record<string, any>>
type Slot = { value?: any; deps?: readonly unknown[] | undefined; cleanup?: (() => void) | undefined }
const internals = (React as unknown as {
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
}).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED

/** Hook scheduling, ref wiring and prop propagation are faked; the component logic and RPC unwrapping are real. See the file header for what that excludes. */
export class Component {
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
export function nodes(tree: any): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!React.isValidElement(tree)) return []
  const node = tree as Node
  return [node, ...nodes(node.props.children)]
}
export function text(tree: any): string {
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (React.isValidElement(tree)) return text((tree as Node).props.children)
  return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : ''
}

/** Drain fixture promises and consequent state updates, with a bounded budget. */
export async function settle(...components: Component[]) {
  for (let i = 0; i < 8; i++) {
    for (const component of components) component.render()
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  for (const component of components) component.render()
  assert.ok(components.every(component => !component.dirty), 'fixture updates settled')
}
