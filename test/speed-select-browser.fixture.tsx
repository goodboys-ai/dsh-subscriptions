import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createModelSelectionWatch,
  createSpeedLoader,
  createSpeedSetter,
  SpeedSelect,
} from '../src/client/SpeedSelect.js'
import { en, zh } from '../src/client/locales.js'
import type { SubscriptionsKey } from '../src/client/locales.js'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'

let current = { provider: 'codex', model: 'fast-model' }
const choices = new Map<string, 'standard' | 'fast'>()
const writes: unknown[] = []
const listeners = new Set<() => void>()
const store = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  getSnapshot: () => ({ current }),
}
const models = () => ({
  directoryFor: () => ({
    load: async () => ({ current }),
    store,
  }),
})
const connection = {
  rpc: {
    call: async (
      _channel: string,
      endpoint: string,
      payload: { model?: string; tier?: 'standard' | 'fast' },
    ) => {
      if (endpoint === 'subscriptions-auth.speed') {
        return {
          ok: true,
          value: {
            tier: choices.get(payload.model ?? '') ?? 'standard',
            fastModels: ['fast-model', 'other-model'],
          },
        }
      }
      if (endpoint === 'subscriptions-auth.setSpeed') {
        writes.push(payload)
        if (payload.model !== undefined && payload.tier !== undefined)
          choices.set(payload.model, payload.tier)
        document.documentElement.dataset.setSpeedCalls = String(writes.length)
        return { ok: true, value: { ok: true } }
      }
      throw new Error(`unexpected RPC ${endpoint}`)
    },
  },
} as unknown as ConnectionHandle

function Fixture() {
  const [locale, setLocale] = useState<'en' | 'zh'>('en')
  const dictionary = locale === 'en' ? en : zh
  return (
    <main style={{ fontFamily: 'sans-serif', padding: '150px 24px 24px' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => {
            current = { provider: 'codex', model: 'fast-model' }
            for (const listener of listeners) listener()
          }}
        >
          Fast model
        </button>
        <button
          onClick={() => {
            current = { provider: 'codex', model: 'other-model' }
            for (const listener of listeners) listener()
          }}
        >
          Other model
        </button>
        <button
          onClick={() => setLocale((value) => (value === 'en' ? 'zh' : 'en'))}
        >
          Locale
        </button>
      </div>
      <SpeedSelect
        loadSpeed={createSpeedLoader(connection, models, 'session')}
        setSpeed={createSpeedSetter(connection, 'session', models)}
        watchModel={createModelSelectionWatch(models, 'session')}
        t={(key: SubscriptionsKey) => dictionary[key]}
      />
      <p style={{ marginTop: 80, color: '#666' }}>
        Synthetic model-bound Speed choices; no provider requests.
      </p>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
