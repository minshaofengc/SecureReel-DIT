import { useEffect, useState, type ReactNode } from 'react'
import type { UpdateCheckResult } from '@shared/update'
import { useAppState } from '../state/AppState'
import { useI18n } from '../i18n'

/**
 * 「有新版本」横幅。
 *
 * 三条设计约束：
 *   1. **不打断干活**。它是一条贴顶的细横幅，不是模态框 ——
 *      现场正在拷卡时弹窗挡住界面是最招人烦的事。
 *   2. **失败完全静默**。检查更新是锦上添花，网络不通、代理没开、
 *      GitHub 连不上都不该在界面上留下任何痕迹（只进日志）。
 *   3. **节流在主进程**。这里只负责"显示主进程说该显示的东西"，
 *      不在渲染层再算一遍 7 天 —— 否则两个进程各记一份时间，迟早对不上。
 */
export function UpdateBanner(): ReactNode {
  const { t } = useI18n()
  const { settings, pushToast } = useAppState()
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [opening, setOpening] = useState(false)

  useEffect(() => {
    if (!settings.autoCheckUpdates) return
    let cancelled = false
    /*
     * 延迟 4 秒：启动瞬间主进程正在开库、迁移、探测 ffmpeg，
     * 这时候再插一个网络请求只会让首屏更慢。等界面稳定下来再说。
     */
    const timer = window.setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const response = await window.securereel.updates.check(false)
          if (cancelled || !response.ok) return
          if (response.data.shouldNotify && response.data.hasUpdate) setResult(response.data)
        } catch {
          /* 检查更新失败绝不打扰用户 */
        }
      })()
    }, 4000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [settings.autoCheckUpdates])

  if (result === null || dismissed) return null

  const openRelease = async (): Promise<void> => {
    setOpening(true)
    try {
      const opened = await window.securereel.updates.openRelease()
      if (!opened.ok) {
        pushToast('error', t('update.openFailed'))
        return
      }
      if (!opened.data) pushToast('error', t('update.openFailed'))
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="update-banner" role="status">
      <span className="update-banner__led" aria-hidden="true" />
      <span className="update-banner__text">
        {t('update.available', {
          version: result.latestVersion ?? '',
          current: result.currentVersion
        })}
      </span>
      <div className="update-banner__actions">
        <button
          type="button"
          className="btn btn-sm"
          disabled={opening}
          onClick={() => void openRelease()}
        >
          {t('update.open')}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setDismissed(true)}
        >
          {t('update.dismiss')}
        </button>
      </div>
    </div>
  )
}
