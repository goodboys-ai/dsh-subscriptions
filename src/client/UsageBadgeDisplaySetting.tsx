import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { SubscriptionsKey } from './locales.js'
import { setUsageBadgeMode, useUsageBadgeMode } from './usage-badge-preferences.js'
import { isUsageColorPreset, setUsageColorPreset, useUsageColorPreset } from './usage-color-preferences.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** Browser-local display preference; never changes provider or account settings. */
export function UsageBadgeDisplaySetting({ t }: { t: Translate }) {
  const mode = useUsageBadgeMode()
  const preset = useUsageColorPreset()
  const [failed, setFailed] = useState(false)
  return (
    <div style={styles.card}>
      <label style={styles.field}>
        <span>{t('usageBadgeDisplay')}</span>
        <select
          style={styles.select}
          aria-label={t('usageBadgeDisplay')}
          value={mode}
          onChange={event => {
            const value = event.currentTarget.value
            if (value !== 'recent' && value !== 'always' && value !== 'hidden') return
            try {
              setUsageBadgeMode(value)
              setFailed(false)
            } catch (error) {
              if (!(error instanceof DOMException) || !['SecurityError', 'QuotaExceededError'].includes(error.name)) throw error
              setFailed(true)
            }
          }}
        >
          <option value="recent">{t('usageBadgeDisplayRecent')}</option>
          <option value="always">{t('usageBadgeDisplayAlways')}</option>
          <option value="hidden">{t('usageBadgeDisplayHidden')}</option>
        </select>
      </label>
      <p style={styles.hint}>{t('usageBadgeDisplayHint')}</p>
      <label style={styles.field}>
        <span>{t('usageColorLabel')}</span>
        <select style={styles.select} aria-label={t('usageColorLabel')} value={preset}
          onChange={event => {
            const value = event.currentTarget.value
            if (!isUsageColorPreset(value)) return
            try { setUsageColorPreset(value); setFailed(false) }
            catch (error) {
              if (!(error instanceof DOMException) || !['SecurityError', 'QuotaExceededError'].includes(error.name)) throw error
              setFailed(true)
            }
          }}>
          <option value="standard">{t('usageColorStandard')}</option>
          <option value="relaxed">{t('usageColorRelaxed')}</option>
          <option value="remaining">{t('usageColorRemaining')}</option>
        </select>
      </label>
      <p style={styles.hint}>{t(preset === 'remaining' ? 'usageColorRemainingHint' : 'usageColorPaceHint', {
        allowance: preset === 'relaxed' ? 15 : 10,
      })}</p>
      {failed && <p role="alert" style={{ ...styles.hint, color: 'var(--dsw-alias-state-error-primary)' }}>{t('usageBadgeDisplaySaveFailed')}</p>}
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  card: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
  },
  field: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14, lineHeight: '22px' },
  select: {
    height: 32, width: '100%', boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '0 10px', font: 'inherit',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  },
  hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
}
