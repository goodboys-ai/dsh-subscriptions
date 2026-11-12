import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SubscriptionUsageBadge } from '../src/client/SubscriptionUsageBadge.js'
import type { SubscriptionUsageBadgeInjected } from '../src/client/SubscriptionUsageBadge.js'
import { SubscriptionsSection } from '../src/client/SubscriptionsSection.js'
import { UsageBadgeDisplaySetting } from '../src/client/UsageBadgeDisplaySetting.js'
import { en, zh } from '../src/client/locales.js'
import { USAGE_BADGE_REFRESH_EVENT } from '../src/client/usage-badge-preferences.js'
import { useSubscriptionAnchoredPosition } from '../src/client/useSubscriptionAnchoredPosition.js'

const selections = {
  api: { provider: 'deepseek', model: 'deepseek-chat' },
  codex: { provider: 'codex', model: 'gpt-test' },
  grok: { provider: 'grok', model: 'grok-test' },
  antigravity: { provider: 'antigravity', model: 'gemini-model-59' },
}
let selection = selections.api
let googleModels: string[] | undefined
let failGoogleUsage = false
let showExternal = false
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
            claude: { busy: false, accounts: [] },
            copilot: { busy: false, accounts: [] },
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
    if (method.endsWith('.externalStatus'))
      return {
        ok: true,
        value: Object.fromEntries(
          [
            'opencode-go',
            'kimi-code',
            'minimax',
            'minimax-cn',
            'ollama-cloud',
          ].map((source) => [source, { configured: showExternal }]),
        ),
      }
    if (method.endsWith('.externalUsage'))
      return {
        ok: true,
        value: {
          supported: true,
          windows: [
            {
              kind: 'weekly',
              usedPercent: 13,
              resetsAt: Date.now() - 1000,
            },
          ],
        },
      }
    if (method.endsWith('.ollamaSettings'))
      return {
        ok: true,
        value: {
          provider: 'ollama-cloud',
          settings: {},
          effective: {
            baseURL: 'https://fixture.invalid',
            apiKeyRef: 'OLLAMA_API_KEY',
            web: false,
          },
          models: [],
          configOverridesModels: false,
        },
      }
    throw new Error(`Unexpected RPC: ${method}`)
  },
} as unknown as SubscriptionUsageBadgeInjected['rpc']

function AnchorFallbackFixture() {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState(60)
  const [version, setVersion] = useState(0)
  const position = useSubscriptionAnchoredPosition({
    open,
    anchorRef,
    panelRef,
    side: 'top',
    gap: 8,
    margin: 12,
  })
  return (
    <div style={{ height: 1000, position: 'relative' }}>
      <style>{'body { margin: 0 }'}</style>
      <button
        key={version}
        ref={anchorRef}
        type="button"
        onClick={() => setOpen(true)}
        style={{
          position: 'absolute',
          top: version === 0 ? 240 : 320,
          left: 120,
        }}
      >
        Anchor
      </button>
      <button type="button" onClick={() => setHeight(100)}>
        Resize panel
      </button>
      <button type="button" onClick={() => setVersion(1)}>
        Replace anchor
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Close panel
      </button>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Anchor fixture"
          style={
            position
              ? { ...position, width: 100, height }
              : {
                  position: 'fixed',
                  visibility: 'hidden',
                  width: 100,
                  height,
                }
          }
        >
          Fixture panel
        </div>
      )}
    </div>
  )
}

function App() {
  const [locale, setLocale] = useState<'en' | 'zh'>('en')
  const [rotationMs, setRotationMs] = useState(10_000)
  const [showSettings, setShowSettings] = useState(false)
  const dictionary = locale === 'en' ? en : zh
  const t = (key: keyof typeof en, params?: Record<string, unknown>) =>
    dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) =>
      String(params?.[name] ?? ''),
    )
  return (
    <>
      <style>{`:root { font-family: system-ui; --dsw-alias-bg-layer-1: #f3f4f6; --dsw-alias-bg-layer-2: #fff; --dsw-specific-menu: #fff; --dsw-elevation-prominent: 0 4px 20px #0003; --dsw-menu-backdrop-filter: none; --dsw-alias-label-primary: #171717; --dsw-alias-label-secondary: #444; --dsw-alias-label-tertiary: #666; --dsw-alias-label-dimmed: #888; --dsw-alias-border-l2: #ddd; --dsw-alias-border-l4: #eee; --dsw-alias-state-success-primary: #198754; --dsw-alias-state-error-primary: #cf222e; --dsw-alias-state-warn-label: #9a6700; } body { margin: 0; background: #f3f4f6; } button, select { font: inherit; }`}</style>
      <button onClick={() => setLocale(locale === 'en' ? 'zh' : 'en')}>
        Locale
      </button>
      <button
        onClick={() => {
          showExternal = !showSettings
          setShowSettings(!showSettings)
        }}
      >
        Toggle settings
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
      {showSettings ? (
        <div data-settings>
          <SubscriptionsSection rpc={rpc} t={t} />
        </div>
      ) : (
        <UsageBadgeDisplaySetting t={t} />
      )}
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
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(window.location.search).has('anchor') ? (
    <AnchorFallbackFixture />
  ) : (
    <App />
  ),
)
