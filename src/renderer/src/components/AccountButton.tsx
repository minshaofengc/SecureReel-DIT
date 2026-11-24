/**
 * 顶栏账号按钮。
 *
 * 未登录显示「登录」文字按钮，已登录显示邮箱首字母圆点 —— 都不占地方，
 * 也不抢走拷贝页的注意力。点开同一个面板。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { AccountStatus } from '@shared/account'
import { unwrap } from '../state/AppState'
import { useI18n } from '../i18n'
import { AccountDialog } from './AccountDialog'

export function AccountButton(): ReactNode {
  const { t } = useI18n()
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void unwrap(window.securereel.account.status())
      .then((value) => {
        if (!cancelled) setStatus(value)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const loggedIn = status?.loggedIn === true
  const initial = (status?.email ?? '?').slice(0, 1).toUpperCase()

  return (
    <>
      {loggedIn ? (
        <button
          type="button"
          className="account-avatar"
          title={status?.email ?? ''}
          aria-label={t('account.title')}
          onClick={() => setOpen(true)}
        >
          {initial}
        </button>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
          {t('account.login')}
        </button>
      )}
      {open && (
        <AccountDialog
          status={status}
          onStatus={setStatus}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
