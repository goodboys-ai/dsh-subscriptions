import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SubscriptionUsageBadge } from '../src/client/SubscriptionUsageBadge.js'
import type { SubscriptionUsageBadgeInjected } from '../src/client/SubscriptionUsageBadge.js'
import { UsageBadgeDisplaySetting } from '../src/client/UsageBadgeDisplaySetting.js'
import { en, zh } from '../src/client/locales.js'
import { USAGE_BADGE_REFRESH_EVENT } from '../src/client/usage-badge-preferences.js'

const selections = {
  api: { provider: 'deepseek', model: 'deepseek-chat' },
  codex: { provider: 'codex', model: 'gpt-test' },
  grok: { provider: 'grok', model: 'grok-test' },
  antigravity: { provider: 'antigravity', model: 'gemini-model-59' },
}
let selection = selections.api
let googleModels: string[] | undefined
let failGoogleUsage = false
let reads = 0
let statusCalls = 0
let usageCalls = 0
const refreshUsage = () => {
  window.dispatchEvent(new Event(USAGE_BADGE_REFRESH_EVENT))
}
const currentModel = async () => {
  document.documentElement.dataset.modelReads = String(++reads)
  document.documentElement.dataset.lastRead = selection.provider
  return selection
}
const rpc = {
  call: async (
    _channel: string,
    method: string,
    payload: { provider?: string },
  ) => {
    if (method.endsWith('.status'))
      document.documentElement.dataset.statusCalls = String(++statusCalls)
    if (method.endsWith('.status'))
      return {
        ok: true,
        value: {
          providers: {
            codex: { accounts: [{ key: 'codex-test', isDefault: true }] },
            grok: { accounts: [{ key: 'grok-test', isDefault: true }] },
            antigravity: {
              accounts: [
                { key: 'anti-test', isDefault: true },
                { key: 'anti-other', isDefault: false },
              ],
              visibleModels: googleModels,
            },
          },
        },
      }
    if (method.endsWith('.usage')) {
      document.documentElement.dataset.usageCalls = String(++usageCalls)
      if (payload.provider === 'antigravity' && failGoogleUsage)
        throw new Error('synthetic Google usage failure')
      return {
        ok: true,
        value: {
          supported: true,
          windows:
            payload.provider === 'antigravity'
              ? Array.from({ length: 60 }, (_, i) => ({
                  kind: 'other',
                  scope: `gemini-model-${i}`,
                  usedPercent: i,
                }))
              : [
                  {
                    kind: 'weekly',
                    usedPercent: payload.provider === 'codex' ? 13 : 25,
                  },
                ],
        },
      }
    }
    throw new Error(`Unexpected RPC: ${method}`)
  },
} as unknown as SubscriptionUsageBadgeInjected['rpc']

function App() {
  const [locale, setLocale] = useState<'en' | 'zh'>('en')
  const [rotationMs, setRotationMs] = useState(10_000)
  const dictionary = locale === 'en' ? en : zh
  const t = (key: keyof typeof en, params?: Record<string, unknown>) =>
    dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) =>
      String(params?.[name] ?? ''),
    )
  return (
    <>
      <button onClick={() => setLocale(locale === 'en' ? 'zh' : 'en')}>
        Locale
      </button>
      <button
        onClick={() => {
          setRotationMs(1000)
          document.documentElement.dataset.rotationMs = '1000'
        }}
      >
        Fast rotation
      </button>
      {Object.entries(selections).map(([name, next]) => (
        <button
          key={name}
          onClick={() => {
            selection = next
          }}
        >
          {name}
        </button>
      ))}
      <button
        onClick={() => {
          googleModels = ['gemini-model-1', 'gemini-model-59']
          refreshUsage()
        }}
      >
        Filter Google models
      </button>
      <button
        onClick={() => {
          googleModels = []
          refreshUsage()
        }}
      >
        Clear Google models
      </button>
      <button
        onClick={() => {
          googleModels = undefined
          refreshUsage()
        }}
      >
        Show all Google models
      </button>
      <button
        onClick={() => {
          failGoogleUsage = true
          refreshUsage()
        }}
      >
        Fail Google usage
      </button>
      <UsageBadgeDisplaySetting t={t} />
      <div>
        <div data-composer-stats />
        <SubscriptionUsageBadge
          rpc={rpc}
          currentModel={currentModel}
          t={t}
          rotationMs={rotationMs}
        />
      </div>
    </>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
