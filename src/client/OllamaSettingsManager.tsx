import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { SubscriptionsSectionInjected } from './SubscriptionsSection.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import {
  contextLabel,
  effortOptions,
  moveModel,
  parseContextInput,
  renameModel,
  setModelContext,
  setModelEffort,
  tickModel,
  tickModels,
  untickModel,
  untickModels,
} from './ollama-draft.js'
import type {
  OllamaCloudCandidate,
  OllamaModelDraft,
  OllamaSettingsDraft,
  OllamaSettingsView,
  OllamaStash,
} from './ollama-draft.js'
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
interface OllamaRow {
  id: string
  name: string
  /** In the draft list, so Save will keep it. */
  ticked: boolean
  vision: boolean
  thinking: boolean
  contextWindow?: number
  efforts: string[]
}
const border = '0.5px solid var(--dsw-alias-border-l2)'
const stack: CSSProperties = { display: 'grid', gap: 12, minWidth: 0 }
const actions: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  alignItems: 'center',
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `vision · thinking · context 262K`, dropping whatever the model does not advertise. */
function capabilities(
  t: Translate,
  model: { vision?: boolean; thinking?: boolean; contextWindow?: number },
): string {
  const context = contextLabel(model.contextWindow)
  return [
    model.vision === true ? t('ollamaCapVision') : false,
    model.thinking === true ? t('ollamaCapThinking') : false,
    context === undefined ? false : t('ollamaContext', { tokens: context }),
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Ollama Cloud settings dialog. It owns one draft (model list, web toggle,
 * base URL and credential reference) that Save writes in a single
 * `ollamaSetSettings` call, so a failure keeps every edit. Fetching the cloud
 * catalog is a read-only side trip, and a key typed for the fetch never
 * leaves this component. The model list follows the shared model editor: a
 * filter, select all/none over the filtered rows, and one checkbox per
 * model, where ticking edits the draft and enables Save. Ollama adds what the
 * shared editor lacks: a display name, ordering, and a local context window.
 * Unticking keeps the row's full settings in a dialog-local stash, so ticking
 * it again restores them even when the cloud listing no longer returns it.
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
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [stash, setStash] = useState<OllamaStash>(new Map())
  const [contextText, setContextText] = useState<Record<string, string>>({})
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
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus()
    }
  }, [])
  useEffect(() => {
    let current = true
    setLoading(true)
    setError('')
    void callSubscriptionsAuth<OllamaSettingsView>(rpc, 'ollamaSettings', {})
      .then((data) => {
        if (!current) return
        setView(data)
        // An unset store value inherits the deployed config: the checkbox
        // shows the effective state, and ticking it writes the override.
        setDraft({ ...data.settings })
        setStash(new Map())
        setContextText({})
        setDirty(false)
      })
      .catch((failure) => {
        if (current)
          setError(t('ollamaModelsLoadFailed', { message: message(failure) }))
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
    // `t` only formats the load error. A new translator must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on rpc and attempt only
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
      const value = await callSubscriptionsAuth<{
        models: OllamaCloudCandidate[]
      }>(rpc, 'ollamaModels', {
        ...(apiKey ? { apiKey } : {}),
        ...(draft.baseURL ? { baseURL: draft.baseURL } : {}),
      })
      if (!alive.current) return
      setCandidates(value.models)
    } catch (failure) {
      if (alive.current)
        setFetchError(t('ollamaFetchFailed', { message: message(failure) }))
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
      if (alive.current)
        setSaveError(t('ollamaModelsSaveFailed', { message: message(failure) }))
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
        setAttempt((value) => value + 1)
        onSaved()
      }
    } catch (failure) {
      if (alive.current)
        setSaveError(t('ollamaModelsSaveFailed', { message: message(failure) }))
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

  /**
   * One list for both sources, like the shared editor: the ticked models in
   * draft order first (so Move up/down is visible), then the unticked ones
   * (stashed in this dialog, or fetched and not yet adopted). A kept model
   * the fetch did not return stays listed, ticked or not.
   */
  const fetchedById = new Map(
    (candidates ?? []).map((candidate) => [candidate.id, candidate]),
  )
  const present = new Set((draft.models ?? []).map((model) => model.id))
  const asRow = (model: OllamaModelDraft, ticked: boolean): OllamaRow => {
    const fetched = fetchedById.get(model.id)
    // The latest fetch outranks the stored snapshot, matching the runtime:
    // discovery is the ceiling and the snapshot only stands in without it.
    const contextWindow = fetched?.contextWindow ?? model.contextWindow
    return {
      id: model.id,
      name: model.name ?? fetched?.name ?? model.id,
      ticked,
      vision: model.vision === true || fetched?.vision === true,
      thinking: model.thinking === true || fetched?.thinking === true,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      efforts: model.efforts ?? fetched?.efforts ?? [],
    }
  }
  const rows: OllamaRow[] = [
    ...(draft.models ?? []).map((model) => asRow(model, true)),
    ...[...stash.values()]
      .filter((model) => !present.has(model.id))
      .map((model) => asRow(model, false)),
    ...(candidates ?? [])
      .filter(
        (candidate) => !present.has(candidate.id) && !stash.has(candidate.id),
      )
      .map((candidate) => asRow({ id: candidate.id }, false)),
  ]
  const shown = rows.filter((row) =>
    `${row.name} ${row.id}`.toLowerCase().includes(query.trim().toLowerCase()),
  )

  /** Rename and default-effort edits ride the tested draft helpers. */
  function rename(id: string, name: string): void {
    edit({ ...draft, models: renameModel(draft.models ?? [], id, name) })
  }
  function setEffort(id: string, effort: string): void {
    edit({ ...draft, models: setModelEffort(draft.models ?? [], id, effort) })
  }
  /** Keep the typed text; only a valid number (or blank) reaches the draft. */
  function setContext(id: string, text: string): void {
    setContextText((current) => ({ ...current, [id]: text }))
    const tokens = parseContextInput(text)
    if (tokens !== null)
      edit({
        ...draft,
        models: setModelContext(draft.models ?? [], id, tokens),
      })
  }
  function applyTicks(next: {
    models: OllamaModelDraft[]
    stash: OllamaStash
  }): void {
    setStash(next.stash)
    edit({ ...draft, models: next.models })
  }
  const invalidContext = Object.entries(contextText)
    .filter(([id, text]) => present.has(id) && parseContextInput(text) === null)
    .map(([id]) => id)
  return (
    <dialog
      className="dsh-subscription-manager"
      ref={dialog}
      aria-labelledby={title}
      aria-describedby={description}
      onCancel={(event) => {
        if (saveLock.current) event.preventDefault()
      }}
      onClose={onClose}
      style={{
        width: 620,
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100dvh - 32px)',
        overflow: 'auto',
      }}
    >
      <style>{providerSettingsCss}</style>
      <div style={{ ...stack, padding: 20 }}>
        <header style={{ ...actions, justifyContent: 'space-between' }}>
          <h2 id={title} style={{ margin: 0 }}>
            {t('ollamaManageTitle')}
          </h2>
          <button type="button" autoFocus disabled={saving} onClick={onClose}>
            {t('imageClose')}
          </button>
        </header>
        <p id={description} className="dsh-subscription-hint">
          {t('ollamaManageHint')}
        </p>
        {view?.configOverridesModels === true && (
          <p className="dsh-subscription-hint">{t('ollamaCatalogOverride')}</p>
        )}
        {error && <p role="alert">{error}</p>}
        {loading && (
          <p role="status" className="dsh-subscription-hint">
            {t('modelDefaultsLoading')}
          </p>
        )}
        {!loading && !view && (
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t('modelDefaultsRetry')}
          </button>
        )}
        {view && (
          <fieldset
            disabled={saving}
            style={{ ...stack, border: 0, margin: 0, padding: 0, minWidth: 0 }}
          >
            <div
              style={{
                borderTop: border,
                paddingTop: 12,
                display: 'grid',
                gap: 12,
              }}
            >
              <h3 style={{ margin: 0 }}>{t('modelsEdit')}</h3>
              <div style={actions}>
                <input
                  type="password"
                  autoComplete="off"
                  style={{ flex: '1 1 180px' }}
                  aria-label={t('ollamaKeyPlaceholder')}
                  placeholder={t('ollamaKeyPlaceholder')}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <button
                  type="button"
                  className="dsh-subscription-quiet"
                  disabled={fetching}
                  onClick={() => {
                    void fetchCandidates()
                  }}
                >
                  {fetching ? t('ollamaFetching') : t('ollamaFetch')}
                </button>
                {candidates !== undefined && (
                  <span className="dsh-subscription-hint">
                    {t('ollamaCandidatesCount', { count: candidates.length })}
                  </span>
                )}
              </div>
              <p className="dsh-subscription-hint">{t('ollamaKeyHint')}</p>
              {fetchError && <p role="alert">{fetchError}</p>}
              {candidates?.length === 0 && (
                <p className="dsh-subscription-hint">
                  {t('ollamaCandidatesEmpty')}
                </p>
              )}
              <div style={actions}>
                <input
                  style={{ flex: '1 1 180px' }}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('modelDefaultsFilterPlaceholder')}
                  aria-label={t('modelDefaultsFilterPlaceholder')}
                />
                <button
                  type="button"
                  onClick={() =>
                    applyTicks(
                      tickModels(
                        draft.models ?? [],
                        stash,
                        candidates ?? [],
                        shown.map((row) => row.id),
                      ),
                    )
                  }
                >
                  {t('modelsSelectAll')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    applyTicks(
                      untickModels(
                        draft.models ?? [],
                        stash,
                        shown.map((row) => row.id),
                      ),
                    )
                  }
                >
                  {t('modelsSelectNone')}
                </button>
              </div>
              <div
                style={{
                  maxHeight: 360,
                  overflowY: 'auto',
                  display: 'grid',
                  gap: 8,
                }}
              >
                {shown.map((row) => {
                  const stored = (draft.models ?? []).find(
                    (entry) => entry.id === row.id,
                  )
                  const index = (draft.models ?? []).findIndex(
                    (entry) => entry.id === row.id,
                  )
                  const open = expanded.has(row.id)
                  const details = `${row.id}-details`
                  const efforts =
                    stored === undefined
                      ? []
                      : effortOptions(
                          stored,
                          fetchedById.get(row.id)?.efforts,
                          view.models.find((entry) => entry.id === row.id)
                            ?.efforts,
                        )
                  const contextProblem = invalidContext.includes(row.id)
                  return (
                    <div
                      key={row.id}
                      style={{
                        borderBottom: border,
                        padding: '8px 2px',
                        display: 'grid',
                        gap: 8,
                      }}
                    >
                      <label style={{ overflowWrap: 'anywhere' }}>
                        <input
                          type="checkbox"
                          checked={row.ticked}
                          onChange={(event) => {
                            applyTicks(
                              event.target.checked
                                ? tickModel(
                                    draft.models ?? [],
                                    stash,
                                    candidates ?? [],
                                    row.id,
                                  )
                                : untickModel(
                                    draft.models ?? [],
                                    stash,
                                    row.id,
                                  ),
                            )
                          }}
                        />{' '}
                        {row.name}{' '}
                        <span style={styles.status}>
                          {capabilities(t, row)}
                        </span>
                      </label>
                      {stored !== undefined && (
                        <div style={actions}>
                          {row.thinking && efforts.length > 0 && (
                            <label style={actions}>
                              {t('modelDefaultsTitle')}
                              <select
                                aria-label={`${row.name} ${t('modelDefaultsTitle')}`}
                                value={stored.defaultEffort ?? ''}
                                onChange={(event) =>
                                  setEffort(row.id, event.target.value)
                                }
                              >
                                <option value="">
                                  {t('modelDefaultsFollowProvider')}
                                </option>
                                {efforts.map((effort) => (
                                  <option
                                    key={effort.id}
                                    value={effort.id}
                                    disabled={effort.unavailable === true}
                                  >
                                    {effort.unavailable === true
                                      ? `${effort.name} (${t('modelsUnavailable')})`
                                      : effort.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          {row.thinking && efforts.length === 0 && (
                            <small>{t('ollamaEffortsUnknown')}</small>
                          )}
                          <label style={actions}>
                            {t('modelsContext')}
                            <input
                              style={{ width: 140 }}
                              inputMode="numeric"
                              aria-invalid={contextProblem}
                              value={
                                contextText[row.id] ??
                                (stored.contextOverride === undefined
                                  ? ''
                                  : String(stored.contextOverride))
                              }
                              aria-label={`${row.name} ${t('modelsContext')}`}
                              placeholder={
                                row.contextWindow === undefined
                                  ? ''
                                  : String(row.contextWindow)
                              }
                              onChange={(event) =>
                                setContext(row.id, event.target.value)
                              }
                            />
                          </label>
                          {row.contextWindow !== undefined && (
                            <small>
                              {t('modelsContextBounds', {
                                default: row.contextWindow,
                                max: row.contextWindow,
                              })}
                            </small>
                          )}
                          <button
                            type="button"
                            className="dsh-subscription-quiet"
                            aria-expanded={open}
                            aria-controls={details}
                            aria-label={`${row.name} ${t('ollamaRowDetails')}`}
                            onClick={() => {
                              const next = new Set(expanded)
                              if (open) next.delete(row.id)
                              else next.add(row.id)
                              setExpanded(next)
                            }}
                          >
                            {t('ollamaRowDetails')} {open ? '\u25BE' : '\u25B8'}
                          </button>
                        </div>
                      )}
                      {contextProblem && (
                        <p role="alert">
                          {t('modelsContextInvalid', { model: row.name })}
                        </p>
                      )}
                      {stored !== undefined && open && (
                        <div id={details} style={actions}>
                          <label style={actions}>
                            {t('ollamaDisplayName')}
                            <input
                              value={stored.name ?? ''}
                              placeholder={row.id}
                              aria-label={`${row.name} ${t('ollamaDisplayName')}`}
                              onChange={(event) =>
                                rename(row.id, event.target.value)
                              }
                              onBlur={(event) =>
                                rename(row.id, event.target.value.trim())
                              }
                            />
                          </label>
                          <button
                            type="button"
                            disabled={index === 0}
                            aria-label={`${row.name} ${t('ollamaMoveUp')}`}
                            onClick={() =>
                              edit({
                                ...draft,
                                models: moveModel(
                                  draft.models ?? [],
                                  row.id,
                                  -1,
                                ),
                              })
                            }
                          >
                            {t('ollamaMoveUp')}
                          </button>
                          <button
                            type="button"
                            disabled={index === (draft.models ?? []).length - 1}
                            aria-label={`${row.name} ${t('ollamaMoveDown')}`}
                            onClick={() =>
                              edit({
                                ...draft,
                                models: moveModel(
                                  draft.models ?? [],
                                  row.id,
                                  1,
                                ),
                              })
                            }
                          >
                            {t('ollamaMoveDown')}
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
                {shown.length === 0 && (
                  <span className="dsh-subscription-hint">
                    {query.trim()
                      ? t('modelDefaultsFilterEmpty', { query })
                      : t('ollamaModelsEmpty')}
                  </span>
                )}
              </div>
              <small>{t('modelsContextHint')}</small>
            </div>
            <label style={{ ...stack, gap: 6 }}>
              <span className="dsh-subscription-label">
                {t('ollamaBaseURL')}
              </span>
              <input
                value={draft.baseURL ?? ''}
                placeholder={view.effective.baseURL}
                onChange={(event) =>
                  editOverride('baseURL', event.target.value)
                }
              />
            </label>
            <label style={{ ...stack, gap: 6 }}>
              <span className="dsh-subscription-label">
                {t('ollamaApiKeyRef')}
              </span>
              <input
                value={draft.apiKeyRef ?? ''}
                placeholder={view.effective.apiKeyRef}
                onChange={(event) =>
                  editOverride('apiKeyRef', event.target.value)
                }
              />
            </label>
            <p className="dsh-subscription-hint">{t('ollamaConnectionHint')}</p>
            <label>
              <input
                type="checkbox"
                checked={(draft.web ?? view.effective.web) === true}
                onChange={(event) =>
                  edit({ ...draft, web: event.target.checked })
                }
              />{' '}
              {t('modelsWebSearch')}
            </label>
            <p className="dsh-subscription-hint">{t('ollamaWebHint')}</p>
          </fieldset>
        )}
        <footer
          style={{
            ...stack,
            gap: 8,
            borderTop: border,
            padding: '14px 0 8px',
            position: 'sticky',
            bottom: 0,
            background:
              'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
          }}
        >
          {saveError && <p role="alert">{saveError}</p>}
          <div style={{ ...actions, justifyContent: 'flex-end' }}>
            <button
              type="button"
              style={{ marginRight: 'auto' }}
              disabled={loading || saving}
              onClick={() => {
                void resetDefaults()
              }}
            >
              {t('ollamaResetDefaults')}
            </button>
            <button type="button" disabled={saving} onClick={onClose}>
              {t('cancel')}
            </button>
            <button
              type="button"
              className="dsh-subscription-primary"
              disabled={
                loading || saving || !dirty || invalidContext.length > 0
              }
              onClick={() => {
                void save()
              }}
            >
              {saving ? t('modelDefaultsSaving') : t('modelsSave')}
            </button>
          </div>
        </footer>
      </div>
    </dialog>
  )
}
