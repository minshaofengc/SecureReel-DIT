/**
 * 账号面板：邮箱 → 验证码 → 已登录。
 *
 * 没有密码，也不存密码；验证码 10 分钟有效。所有网络调用都在主进程，
 * 这里只负责收集输入与显示结果。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { AccountStatus } from '@shared/account'
import type { MessageKey } from '../i18n'
import { unwrap, useAppState } from '../state/AppState'
import { useI18n } from '../i18n'

const ERROR_KEYS: Record<string, MessageKey> = {
  invalid_email: 'account.error.invalid_email',
  rate_limited: 'account.error.rate_limited',
  invalid_code: 'account.error.invalid_code',
  code_expired: 'account.error.code_expired',
  unauthorized: 'account.error.unauthorized',
  network: 'account.error.network',
  server: 'account.error.server'
}

export function AccountDialog({
  status,
  onStatus,
  onClose
}: {
  status: AccountStatus | null
  onStatus: (next: AccountStatus) => void
  onClose: () => void
}): ReactNode {
  const { t } = useI18n()
  const { pushToast } = useAppState()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState(status?.email ?? '')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [cooldown])

  const errorText = (raw: string): string => {
    const key = ERROR_KEYS[raw]
    return key === undefined ? t('account.error.server') : t(key)
  }

  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (caught) {
      setError(errorText(caught instanceof Error ? caught.message : ''))
    } finally {
      setBusy(false)
    }
  }

  const sendCode = (event?: FormEvent): void => {
    event?.preventDefault()
    void run(async () => {
      await unwrap(window.securereel.account.requestCode(email))
      setStep('code')
      setCooldown(60)
    })
  }

  const verify = (event: FormEvent): void => {
    event.preventDefault()
    void run(async () => {
      const next = await unwrap(window.securereel.account.verify(email, code))
      onStatus(next)
    })
  }

  const syncNow = (): void => {
    void run(async () => {
      const next = await unwrap(window.securereel.account.syncNow())
      onStatus(next)
      pushToast('success', t('account.syncOk'))
    })
  }

  const logout = (): void => {
    void run(async () => {
      const next = await unwrap(window.securereel.account.logout())
      onStatus(next)
      onClose()
    })
  }

  const remove = (): void => {
    if (!window.confirm(t('account.deleteConfirm'))) return
    void run(async () => {
      const next = await unwrap(window.securereel.account.deleteAccount())
      onStatus(next)
      pushToast('success', t('account.deleteDone'))
      onClose()
    })
  }

  const lastSync =
    status?.lastSyncAt != null && status.lastSyncAt !== ''
      ? new Date(status.lastSyncAt).toLocaleString()
      : null

  return (
    <div className="dialog-overlay">
      <section className="dialog-panel" role="dialog" aria-modal="true" aria-labelledby="account-title">
        <span className="dialog-kicker mono">ACCOUNT / SYNC</span>
        <h2 id="account-title">{t('account.title')}</h2>

        {status?.loggedIn === true ? (
          <>
            <p className="account-email">{status.email}</p>
            <p className="dialog-note">
              {lastSync === null
                ? t('account.neverSynced')
                : t('account.lastSync', { time: lastSync })}
            </p>
            {status.syncError !== null && (
              <div className="account-error">{errorText(status.syncError)}</div>
            )}
            {error !== null && <div className="account-error">{error}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={remove}>
                {t('account.delete')}
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={logout}>
                {t('account.logout')}
              </button>
              <button type="button" className="btn primary" disabled={busy} onClick={syncNow}>
                {status.syncing || busy ? t('account.syncing') : t('account.syncNow')}
              </button>
            </div>
          </>
        ) : step === 'email' ? (
          <form onSubmit={sendCode}>
            <p className="dialog-note">{t('account.intro')}</p>
            <label className="field">
              <span className="field-label">{t('account.email')}</span>
              <input
                className="input"
                type="email"
                autoFocus
                autoComplete="email"
                value={email}
                placeholder={t('account.emailPlaceholder')}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            {error !== null && <div className="account-error">{error}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                {t('account.cancel')}
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                {t('account.sendCode')}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={verify}>
            <p className="account-email">{email}</p>
            <p className="dialog-note">{t('account.codeSent')}</p>
            <label className="field">
              <span className="field-label">{t('account.code')}</span>
              <input
                className="input"
                inputMode="numeric"
                autoFocus
                maxLength={6}
                value={code}
                placeholder={t('account.codePlaceholder')}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              />
            </label>
            {error !== null && <div className="account-error">{error}</div>}
            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy || cooldown > 0}
                onClick={() => sendCode()}
              >
                {cooldown > 0 ? `${t('account.sendCode')} · ${cooldown}s` : t('account.sendCode')}
              </button>
              <button type="submit" className="btn primary" disabled={busy || code.length !== 6}>
                {t('account.verify')}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  )
}
