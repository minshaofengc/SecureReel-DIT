import { useEffect, useState, type ReactNode } from 'react'
import { AppStateProvider, useAppState } from './state/AppState'
import { I18nProvider, useI18n } from './i18n'
import { applyPlatform, applyTheme, syncNativeTitleBar, useResolvedMode } from './theme'
import { CopyView } from './views/CopyView'
import { QueueView } from './views/QueueView'
import { ReportsView } from './views/ReportsView'
import { HdeView } from './views/HdeView'
import { ProjectView } from './views/ProjectView'
import { SettingsView } from './views/SettingsView'
import { HelpView } from './views/HelpView'

type Page = 'copy' | 'queue' | 'reports' | 'hde' | 'project' | 'settings' | 'help'

const NAV: { page: Page; icon: string }[] = [
  { page: 'copy', icon: '⤓' },
  { page: 'queue', icon: '☰' },
  { page: 'reports', icon: '▤' },
  { page: 'hde', icon: '◈' },
  { page: 'project', icon: '✎' },
  { page: 'settings', icon: '⚙' },
  { page: 'help', icon: '?' }
]

function Shell(): ReactNode {
  const { t } = useI18n()
  const { settings, jobs, toasts, appInfo, dismissToast, recovered, dismissRecovered } = useAppState()
  const [page, setPage] = useState<Page>('copy')
  const resolved = useResolvedMode(settings.themeMode)

  // 平台标记先挂上：CSS 里 `[data-platform='windows']` 的规则（标题栏留白、
  // 拖拽条）依赖它，晚一步就会出现一帧的布局跳变。
  useEffect(() => {
    applyPlatform(appInfo?.platform)
  }, [appInfo?.platform])

  useEffect(() => {
    applyTheme(settings.themeId, resolved)
    // 主题换了要顺手把 Windows 标题栏按钮区的颜色也换掉。
    // 读 CSS 变量必须在 applyTheme **之后**，否则读到的是上一套配色。
    // 等一帧再读，确保样式已经重算完。
    const frame = requestAnimationFrame(() => syncNativeTitleBar(appInfo?.platform))
    return () => cancelAnimationFrame(frame)
  }, [settings.themeId, resolved, appInfo?.platform])

  const runningCount = jobs.filter((job) => job.state === 'running' || job.state === 'queued').length
  const showRecovery = recovered.length > 0 && page !== 'queue'

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h1>{t('app.name')}</h1>
          <p>{t('app.tagline')}</p>
        </div>
        <nav className="sidebar-nav">
          {NAV.map((item) => (
            <button
              key={item.page}
              type="button"
              className="nav-item"
              data-page={item.page}
              aria-current={page === item.page ? 'page' : undefined}
              onClick={() => setPage(item.page)}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span>{t(`nav.${item.page}` as never)}</span>
              {item.page === 'queue' && runningCount > 0 && <span className="nav-badge">{runningCount}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div>v{appInfo?.version ?? '—'}</div>
          <div className="faint">Electron {appInfo?.electron ?? '—'}</div>
        </div>
      </aside>

      <main className="main">
        {page === 'copy' && <CopyView onCreated={() => setPage('queue')} />}
        {page === 'queue' && (
          <QueueView onCreate={() => setPage('copy')} onReports={() => setPage('reports')} />
        )}
        {page === 'reports' && <ReportsView />}
        {page === 'hde' && <HdeView />}
        {page === 'project' && <ProjectView />}
        {page === 'settings' && <SettingsView />}
        {page === 'help' && <HelpView />}
      </main>

      {showRecovery && (
        <div className="toasts" style={{ bottom: toasts.length > 0 ? 150 : 18 }}>
          <div className="toast warn">
            <strong>{t('queue.recovered')}</strong>
            <div className="faint" style={{ marginTop: 4 }}>
              {t('queue.recoveredHint')}
            </div>
            <div className="row-actions" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-sm" onClick={() => setPage('queue')}>
                {t('nav.queue')}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={dismissRecovered}>
                {t('queue.dismiss')}
              </button>
            </div>
          </div>
        </div>
      )}

      {toasts.length > 0 && (
        <div className="toasts" style={{ bottom: showRecovery ? 150 : 18 }}>
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`toast ${toast.level === 'success' ? 'ok' : toast.level}`}
              role="status"
              onClick={() => dismissToast(toast.id)}
            >
              {toast.message}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 语言来自主进程的设置。依赖方向：设置 → 语言 → 界面，
 * 因此 I18nProvider 必须嵌在 AppStateProvider 里面。
 */
function LocalizedShell(): ReactNode {
  const { settings } = useAppState()
  return (
    <I18nProvider language={settings.language}>
      <Shell />
    </I18nProvider>
  )
}

export function App(): ReactNode {
  return (
    <AppStateProvider>
      <LocalizedShell />
    </AppStateProvider>
  )
}
