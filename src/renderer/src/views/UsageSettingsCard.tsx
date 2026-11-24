/**
 * 设置页的「匿名使用统计」卡片。
 *
 * 只显示状态，不显示逐日明细 —— 界面拿不到逐日数据（见 UsageStatus 的注释）。
 * 开关关闭会清空本机历史，这一点必须写在提示里，不能只在代码里发生。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { UsageStatus } from '@shared/ipc'
import { Card, Field, Toggle } from '../components/ui'
import { unwrap, useAppState } from '../state/AppState'
import { useI18n } from '../i18n'

function maskId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 13)}…` : id
}

function formatTime(iso: string | null): string | null {
  if (iso === null) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toLocaleString()
}

export function UsageSettingsCard(): ReactNode {
  const { t } = useI18n()
  const { settings, updateSettings, pushToast } = useAppState()
  const [status, setStatus] = useState<UsageStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void unwrap(window.securereel.usage.status())
      .then((value) => {
        if (!cancelled) setStatus(value)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = (next: boolean): void => {
    if (busy) return
    setBusy(true)
    void unwrap(window.securereel.usage.setEnabled(next))
      .then((value) => {
        setStatus(value)
        return updateSettings({ usageStatsEnabled: next })
      })
      .catch((error) => {
        pushToast('error', error instanceof Error ? error.message : String(error))
      })
      .finally(() => setBusy(false))
  }

  const reset = (): void => {
    if (busy) return
    if (!window.confirm(t('usage.resetConfirm'))) return
    setBusy(true)
    void unwrap(window.securereel.usage.resetInstallId())
      .then((value) => {
        setStatus(value)
        pushToast('success', t('usage.resetDone'))
      })
      .catch((error) => {
        pushToast('error', error instanceof Error ? error.message : String(error))
      })
      .finally(() => setBusy(false))
  }

  const lastSent = formatTime(status?.lastSentAt ?? null)
  const checked = settings.usageStatsEnabled && status?.enabled === true

  return (
    <Card title={t('usage.cardTitle')}>
      <Toggle checked={checked} label={t('usage.enabled')} disabled={busy} onChange={toggle} />
      <div className="hint">{t('usage.enabledHint')}</div>

      {status !== null && (
        <>
          <Field label={t('usage.installId')}>
            <span className="mono">{maskId(status.installId)}</span>
          </Field>
          <Field label={t('usage.pending')}>
            <span className="mono">{t('usage.pendingValue', { days: status.pendingDays })}</span>
          </Field>
          <Field label={t('usage.lastSent')}>
            <span className="mono">{lastSent ?? t('usage.neverSent')}</span>
          </Field>
          {status.firstSeenDay !== null && (
            <Field label={t('usage.firstSeen')}>
              <span className="mono">{status.firstSeenDay}</span>
            </Field>
          )}
        </>
      )}

      <div className="row-actions" style={{ marginTop: 10 }}>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={reset}>
          {t('usage.reset')}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => void window.securereel.usage.openPrivacyPolicy().catch(() => undefined)}
        >
          {t('usage.policy')}
        </button>
      </div>
    </Card>
  )
}
