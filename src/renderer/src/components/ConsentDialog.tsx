/**
 * 首启的「匿名使用统计」告知层。
 *
 * 刻意不做成可关闭的弹窗（没有右上角叉、Escape 也不关）：
 * 同意与拒绝都必须是一次明确的选择，不能靠点空白处糊过去。
 * 两个出口的视觉权重不同，但功能上完全等价 —— 选「暂不开启」不影响任何能力。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { unwrap } from '../state/AppState'
import { useI18n } from '../i18n'

export function ConsentDialog(): ReactNode {
  const { t } = useI18n()
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const agreeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    let cancelled = false
    // 等窗口稳定下来再问：启动瞬间弹层会盖住"正在恢复任务"的提示。
    const timer = window.setTimeout(() => {
      void unwrap(window.securereel.usage.status())
        .then((status) => {
          if (!cancelled && status.needsConsent) setVisible(true)
        })
        .catch(() => undefined)
    }, 1200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (visible) agreeRef.current?.focus()
  }, [visible])

  if (!visible) return null

  const decide = (decision: 'granted' | 'declined'): void => {
    if (busy) return
    setBusy(true)
    void unwrap(window.securereel.usage.decide(decision))
      .then(() => setVisible(false))
      .catch(() => setVisible(false))
      .finally(() => setBusy(false))
  }

  const openPolicy = (): void => {
    void window.securereel.usage.openPrivacyPolicy().catch(() => undefined)
  }

  return (
    <div className="consent-overlay">
      <section
        className="consent-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-title"
      >
        <span className="mono consent-kicker">PRIVACY / USAGE STATS</span>
        <h2 id="consent-title">{t('usage.consentTitle')}</h2>
        <p>{t('usage.consentBody')}</p>
        <p className="consent-note">{t('usage.consentNote')}</p>
        <button type="button" className="consent-link" onClick={openPolicy}>
          {t('usage.policyLink')}
        </button>
        <div className="consent-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => decide('declined')}
          >
            {t('usage.consentDecline')}
          </button>
          <button
            type="button"
            className="btn primary"
            ref={agreeRef}
            disabled={busy}
            onClick={() => decide('granted')}
          >
            {t('usage.consentAgree')}
          </button>
        </div>
      </section>
    </div>
  )
}
