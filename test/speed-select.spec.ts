/**
 * The Speed control's model watch and its load timing. The hook dispatcher
 * runs the real effect; it does not prove browser scheduling. A directory
 * store is the host path. The timer path is only the host that has `load()`
 * and no store, and it must not report a selection that did not change.
 */
import { describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { Component, settle } from './component-harness.js'
import type { Node } from './component-harness.js'
import {
  SpeedSelect,
  SPEED_CHANGED_EVENT,
  createModelSelectionWatch,
  MODEL_DIRECTORY_POLL_INTERVAL_MS,
} from '../src/client/SpeedSelect.js'
import type {
  ModelDirectoriesLike,
  SpeedSelectProps,
} from '../src/client/SpeedSelect.js'

describe('speed select load timing', { concurrency: false }, () => {
  function installWindow(): () => void {
    const listeners = new Map<string, Set<() => void>>()
    const fake = {
      addEventListener(type: string, fn: () => void) {
        const set = listeners.get(type) ?? new Set()
        set.add(fn)
        listeners.set(type, set)
      },
      removeEventListener(type: string, fn: () => void) {
        listeners.get(type)?.delete(fn)
      },
      dispatchEvent(event: Event) {
        for (const fn of listeners.get(event.type) ?? []) fn()
        return true
      },
    }
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: fake,
    })
    return () => {
      if (previous) Object.defineProperty(globalThis, 'window', previous)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  }

  test('SpeedSelect reads speed on mount and on a model change, not on a timer', async () => {
    mock.timers.enable({ apis: ['setInterval'] })
    const uninstall = installWindow()
    try {
      let calls = 0
      let onChange: (() => void) | undefined
      const component = new Component(
        () =>
          SpeedSelect({
            loadSpeed: async () => {
              calls += 1
              return { visible: true, tier: 'standard' as const }
            },
            setSpeed: async () => true,
            watchModel: (listener) => {
              onChange = listener
              return () => {
                onChange = undefined
              }
            },
          } as SpeedSelectProps) as Node,
      )
      component.render()
      await settle(component)
      assert.equal(calls, 1)
      mock.timers.tick(MODEL_DIRECTORY_POLL_INTERVAL_MS * 10)
      await settle(component)
      assert.equal(calls, 1)
      assert.equal(typeof onChange, 'function')
      onChange?.()
      await settle(component)
      assert.equal(calls, 2)
      component.unmount()
      assert.equal(onChange, undefined)
    } finally {
      uninstall()
      mock.timers.reset()
    }
  })

  test('SpeedSelect retries a failed mount read, then stops', async () => {
    mock.timers.enable({ apis: ['setInterval'] })
    const uninstall = installWindow()
    try {
      let calls = 0
      const component = new Component(
        () =>
          SpeedSelect({
            loadSpeed: async () => {
              calls += 1
              if (calls === 1) throw new Error('temporary')
              return { visible: true, tier: 'fast' as const }
            },
            setSpeed: async () => true,
            watchModel: () => () => {},
          } as SpeedSelectProps) as Node,
      )
      component.render()
      await settle(component)
      assert.equal(calls, 1)
      mock.timers.tick(MODEL_DIRECTORY_POLL_INTERVAL_MS)
      await settle(component)
      assert.equal(calls, 2)
      mock.timers.tick(MODEL_DIRECTORY_POLL_INTERVAL_MS * 5)
      await settle(component)
      assert.equal(calls, 2)
      window.dispatchEvent(new Event(SPEED_CHANGED_EVENT))
      await settle(component)
      assert.equal(calls, 3)
      component.unmount()
    } finally {
      uninstall()
      mock.timers.reset()
    }
  })

  function selectionStore(
    initial: { provider: string; model: string } | null,
  ): {
    models: () => ModelDirectoriesLike
    emit: () => void
    set: (next: { provider: string; model: string } | null) => void
    listeners: number
  } {
    let current = initial
    const listeners = new Set<() => void>()
    return {
      models: () => ({
        directoryFor: () => ({
          load: async () => ({ current }),
          store: {
            subscribe(listener: () => void) {
              listeners.add(listener)
              return () => {
                listeners.delete(listener)
              }
            },
            getSnapshot: () => ({ current }),
          },
        }),
      }),
      emit: () => {
        for (const listener of listeners) listener()
      },
      set: (next) => {
        current = next
      },
      get listeners() {
        return listeners.size
      },
    }
  }

  test('model watch follows the directory store only when the selection identity changes', () => {
    const store = selectionStore({ provider: 'codex', model: 'gpt-5' })
    let notices = 0
    const stop = createModelSelectionWatch(
      store.models,
      'session',
    )(() => {
      notices += 1
    })
    assert.equal(store.listeners, 1)
    store.emit()
    assert.equal(notices, 0)
    store.set({ provider: 'codex', model: 'gpt-5' })
    store.emit()
    assert.equal(notices, 0)
    store.set({ provider: 'codex', model: 'gpt-5-fast' })
    store.emit()
    assert.equal(notices, 1)
    stop()
    assert.equal(store.listeners, 0)
    store.set({ provider: 'claude', model: 'opus' })
    store.emit()
    assert.equal(notices, 1)
  })

  test('model watch without a store notifies only after the selection changes', async () => {
    mock.timers.enable({ apis: ['setInterval'] })
    try {
      let current: { provider: string; model: string } | null = {
        provider: 'claude',
        model: 'opus',
      }
      const models = (): ModelDirectoriesLike => ({
        directoryFor: () => ({
          load: async () => ({ current }),
        }),
      })
      let notices = 0
      const stop = createModelSelectionWatch(
        models,
        'session',
      )(() => {
        notices += 1
      })
      await Promise.resolve()
      assert.equal(notices, 0)
      mock.timers.tick(MODEL_DIRECTORY_POLL_INTERVAL_MS)
      await Promise.resolve()
      assert.equal(notices, 0)
      current = { provider: 'codex', model: 'gpt-5' }
      mock.timers.tick(MODEL_DIRECTORY_POLL_INTERVAL_MS)
      await Promise.resolve()
      assert.equal(notices, 1)
      stop()
      mock.timers.tick(MODEL_DIRECTORY_POLL_INTERVAL_MS)
      await Promise.resolve()
      assert.equal(notices, 1)
    } finally {
      mock.timers.reset()
    }
  })

  test('model watch notifies when a missing directory service appears', () => {
    mock.timers.enable({ apis: ['setInterval'] })
    try {
      let ready = false
      const store = selectionStore({ provider: 'codex', model: 'gpt-5' })
      let notices = 0
      const stop = createModelSelectionWatch(
        () => (ready ? store.models() : undefined),
        'session',
      )(() => {
        notices += 1
      })
      assert.equal(notices, 0)
      ready = true
      mock.timers.tick(MODEL_DIRECTORY_POLL_INTERVAL_MS)
      assert.equal(notices, 1)
      store.emit()
      assert.equal(notices, 1)
      stop()
    } finally {
      mock.timers.reset()
    }
  })

  test('model watch notifies when directoryFor starts succeeding', () => {
    mock.timers.enable({ apis: ['setInterval'] })
    try {
      let fail = true
      const store = selectionStore({ provider: 'codex', model: 'gpt-5' })
      let notices = 0
      const stop = createModelSelectionWatch(
        () => ({
          directoryFor: () => {
            if (fail) throw new Error('unknown session')
            return store.models().directoryFor('session')
          },
        }),
        'session',
      )(() => {
        notices += 1
      })
      mock.timers.tick(MODEL_DIRECTORY_POLL_INTERVAL_MS)
      assert.equal(notices, 0)
      fail = false
      mock.timers.tick(MODEL_DIRECTORY_POLL_INTERVAL_MS)
      assert.equal(notices, 1)
      stop()
    } finally {
      mock.timers.reset()
    }
  })
})
