import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { SubscriptionsSectionInjected } from './SubscriptionsSection.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { adoptCandidates, contextLabel, moveModel, removeModel } from './ollama-draft.js'
import type { OllamaCloudCandidate, OllamaSettingsDraft, OllamaSettingsView } from './ollama-draft.js'
import { subscriptionCardStyles as styles } from './subscription-card-styles.js'
import { providerSettingsCss } from './provider-settings-styles.js'

type Translate = SubscriptionsSectionInjected['t']
interface Props {
  rpc: ConnectionHandle['rpc']
  t: Translate
  onClose: () => void
  /** Called after a successful save or reset, so the card re-reads its status. */
  onSaved: () => void
}
const border = '0.5px solid var(--dsw-alias-border-l2)'
const stack: CSSProperties = { display: 'grid', gap: 12, minWidth: 0 }
const actions: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `vision · thinking · context 262K`, dropping whatever the model does not advertise. */
function capabilities(t: Translate, model: { vision?: boolean; thinking?: boolean; contextWindow?: number }): string {
  const context = contextLabel(model.contextWindow)
  return [
    model.vision === true ? t('ollamaCapVision') : false,
    model.thinking === true ? t('ollamaCapThinking') : false,
    context === undefined ? false : t('ollamaContext', { tokens: context }),
  ].filter(Boolean).join(' · ')
}

/**
 * Ollama Cloud settings dialog. It owns one draft (model list, web toggle,
 * base URL and credential reference) that Save writes in a single
 * `ollamaSetSettings` call, so a failure keeps every edit. Fetching the cloud
 * catalog is a read-only side trip: adopting a candidate only edits the
 * draft, and a key typed for the fetch never leaves this component.
 */
export function OllamaSettingsManager({ rpc, t, onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  const description = useId()
  const [view, setView] = useState<OllamaSettingsView>()
  const [draft, setDraft] = useState<OllamaSettingsDraft>({})
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [apiKey, setApiKey] = useState('')
  const [candidates, setCandidates] = useState<OllamaCloudCandidate[]>()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const alive = useRef(true)
  const saveLock = useRef(false)
  const fetchLock = useRef(false)

  useEffect(() => {
    alive.current = true
    const element = dialog.current!
    const previous = document.activeElement
    element.showModal()
    return () => {
      alive.current = false
      element.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    let current = true
    setLoading(true)
    setError('')
    void callSubscriptionsAuth<OllamaSettingsView>(rpc, 'ollamaSettings', {}).then(data => {
      if (!current) return
      setView(data)
      // An unset store value inherits the deployed config (N2): the
      // checkbox shows the effective state, so saving writes it down.
      setDraft({ ...data.settings })
      setDirty(false)
    }).catch(failure => {
      if (current) setError(t('ollamaModelsLoadFailed', { message: message(failure) }))
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [rpc, attempt])

  function edit(next: OllamaSettingsDraft) {
    setDraft(next)
    setDirty(true)
  }

  /** Fetch the cloud catalog; a failure keeps the previous list and the draft. */
  async function fetchCandidates() {
    if (fetchLock.current) return
    fetchLock.current = true
    setFetching(true)
    setFetchError('')
    try {
      const value = await callSubscriptionsAuth<{ models: OllamaCloudCandidate[] }>(rpc, 'ollamaModels',
        { ...(apiKey ? { apiKey } : {}), ...(draft.baseURL ? { baseURL: draft.baseURL } : {}) })
      if (!alive.current) return
      setCandidates(value.models)
      setSelected(new Set())
    } catch (failure) {
      if (alive.current) setFetchError(t('ollamaFetchFailed', { message: message(failure) }))
    } finally {
      fetchLock.current = false
      if (alive.current) setFetching(false)
    }
  }

  /** Save the whole draft; a failure keeps the dialog open with every edit. */
  async function save() {
    if (saveLock.current) return
    saveLock.current = true
    setSaving(true)
    setSaveError('')
    try {
      await callSubscriptionsAuth(rpc, 'ollamaSetSettings', { settings: draft })
      if (alive.current) {
        onSaved()
        onClose()
      }
    } catch (failure) {
      if (alive.current) setSaveError(t('ollamaModelsSaveFailed', { message: message(failure) }))
    } finally {
      saveLock.current = false
      if (alive.current) setSaving(false)
    }
  }

  /** Drop every stored override, then reload the draft from the deployment values. */
  async function resetDefaults() {
    if (saveLock.current) return
    if (!window.confirm(t('ollamaResetConfirm'))) return
    saveLock.current = true
    setSaving(true)
    setSaveError('')
    try {
      await callSubscriptionsAuth(rpc, 'ollamaSetSettings', { settings: {} })
      if (alive.current) {
        setAttempt(value => value + 1)
        onSaved()
      }
    } catch (failure) {
      if (alive.current) setSaveError(t('ollamaModelsSaveFailed', { message: message(failure) }))
    } finally {
      saveLock.current = false
      if (alive.current) setSaving(false)
    }
  }

  function editOverride(field: 'baseURL' | 'apiKeyRef', value: string) {
    const next = { ...draft }
    if (value.trim()) next[field] = value
    else delete next[field]
    edit(next)
  }

  const models = draft.models ?? []
  return <dialog className="dsh-subscription-manager" ref={dialog} aria-labelledby={title} aria-describedby={description}
    onCancel={event => { if (saveLock.current) event.preventDefault() }} onClose={onClose}
    style={{ width: 620, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100dvh - 32px)', overflow: 'auto' }}>
    <style>{providerSettingsCss}</style>
    <div style={{ ...stack, padding: 20 }}>
      <header style={{ ...actions, justifyContent: 'space-between' }}>
        <h2 id={title} style={{ margin: 0 }}>{t('ollamaManageTitle')}</h2>
        <button type="button" autoFocus disabled={saving} onClick={onClose}>{t('imageClose')}</button>
      </header>
      <p id={description} className="dsh-subscription-hint">{t('ollamaManageHint')}</p>
      {view?.configOverridesModels === true && <p className="dsh-subscription-hint">{t('ollamaCatalogOverride')}</p>}
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status" className="dsh-subscription-hint">{t('modelDefaultsLoading')}</p>}
      {!loading && !view && <button type="button" onClick={() => setAttempt(value => value + 1)}>{t('modelDefaultsRetry')}</button>}
      {view && <fieldset disabled={saving} style={{ ...stack, border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <fieldset style={{ ...stack, border, borderRadius: 'var(--dsw-radius-lg, 12px)', padding: 14, margin: 0 }}>
          <legend style={{ padding: '0 6px' }}>{t('ollamaCandidates')}</legend>
          <input type="password" autoComplete="off" aria-label={t('ollamaKeyPlaceholder')}
            placeholder={t('ollamaKeyPlaceholder')} value={apiKey} onChange={event => setApiKey(event.target.value)} />
          <p className="dsh-subscription-hint">{t('ollamaKeyHint')}</p>
          <div style={actions}>
            <button type="button" disabled={fetching} onClick={() => { void fetchCandidates() }}>
              {fetching ? t('ollamaFetching') : t('ollamaFetch')}
            </button>
            {candidates !== undefined && <span className="dsh-subscription-hint">
              {t('ollamaCandidatesCount', { count: candidates.length })}</span>}
          </div>
          {fetchError && <p role="alert">{fetchError}</p>}
          {candidates?.length === 0 && <p className="dsh-subscription-hint">{t('ollamaCandidatesEmpty')}</p>}
          {candidates !== undefined && candidates.length > 0 && <div style={{ ...stack, gap: 8, maxHeight: 240, overflowY: 'auto' }}>
            {candidates.map(candidate => <label key={candidate.id} style={{ overflowWrap: 'anywhere' }}>
              <input type="checkbox" checked={selected.has(candidate.id)} onChange={event => {
                const next = new Set(selected)
                if (event.target.checked) next.add(candidate.id)
                else next.delete(candidate.id)
                setSelected(next)
              }} /> {candidate.name} <span style={styles.status}>{capabilities(t, candidate)}</span>
            </label>)}
          </div>}
          <div style={actions}>
            <button type="button" disabled={selected.size === 0} onClick={() => {
              edit({ ...draft, models: adoptCandidates(draft.models, candidates ?? [], [...selected]) })
            }}>{t('ollamaAdopt')}</button>
            <span className="dsh-subscription-hint">{t('ollamaAdoptHint')}</span>
          </div>
        </fieldset>
        <fieldset style={{ ...stack, border, borderRadius: 'var(--dsw-radius-lg, 12px)', padding: 14, margin: 0 }}>
          <legend style={{ padding: '0 6px' }}>{t('ollamaModelsCatalog')}</legend>
          {models.length === 0 && <p className="dsh-subscription-hint">{t('ollamaModelsEmpty')}</p>}
          {models.map((model, index) => <div key={model.id} style={{ ...stack, gap: 6, borderBottom: border, paddingBottom: 8 }}>
            <span style={{ overflowWrap: 'anywhere' }}>{model.name ?? model.id}</span>
            <span style={styles.status}>{capabilities(t, model)}</span>
            <div style={actions}>
              <button type="button" disabled={index === 0}
                onClick={() => edit({ ...draft, models: moveModel(models, model.id, -1) })}>{t('ollamaMoveUp')}</button>
              <button type="button" disabled={index === models.length - 1}
                onClick={() => edit({ ...draft, models: moveModel(models, model.id, 1) })}>{t('ollamaMoveDown')}</button>
              <button type="button"
                onClick={() => edit({ ...draft, models: removeModel(models, model.id) })}>{t('ollamaRemove')}</button>
            </div>
          </div>)}
        </fieldset>
        <label style={{ ...stack, gap: 6 }}>
          <span className="dsh-subscription-label">{t('ollamaBaseURL')}</span>
          <input value={draft.baseURL ?? ''} placeholder={view.effective.baseURL}
            onChange={event => editOverride('baseURL', event.target.value)} />
        </label>
        <label style={{ ...stack, gap: 6 }}>
          <span className="dsh-subscription-label">{t('ollamaApiKeyRef')}</span>
          <input value={draft.apiKeyRef ?? ''} placeholder={view.effective.apiKeyRef}
            onChange={event => editOverride('apiKeyRef', event.target.value)} />
        </label>
        <p className="dsh-subscription-hint">{t('ollamaConnectionHint')}</p>
        <label><input type="checkbox" checked={(draft.web ?? view.effective.web) === true}
          onChange={event => edit({ ...draft, web: event.target.checked })} /> {t('modelsWebSearch')}</label>
        <p className="dsh-subscription-hint">{t('ollamaWebHint')}</p>
      </fieldset>}
      <footer style={{ ...stack, gap: 8, borderTop: border, padding: '14px 0 8px',
        position: 'sticky', bottom: 0, background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))' }}>
        {saveError && <p role="alert">{saveError}</p>}
        <div style={{ ...actions, justifyContent: 'flex-end' }}>
          <button type="button" style={{ marginRight: 'auto' }} disabled={loading || saving}
            onClick={() => { void resetDefaults() }}>{t('ollamaResetDefaults')}</button>
          <button type="button" disabled={saving} onClick={onClose}>{t('cancel')}</button>
          <button type="button" className="dsh-subscription-primary" disabled={loading || saving || !dirty}
            onClick={() => { void save() }}>{saving ? t('modelDefaultsSaving') : t('modelsSave')}</button>
        </div>
      </footer>
    </div>
  </dialog>
}
