import { useEffect, useState, type ReactNode } from 'react'
import { AppStateProvider, unwrap, useAppState } from './state/AppState'
import { NavProvider, useNav } from './state/NavState'
import { I18nProvider, useI18n } from './i18n'
import { applyPlatform, applySkin, applyTheme, syncNativeTitleBar, useResolvedMode } from './theme'
import { HomeView } from './views/HomeView'
import { CopyView } from './views/CopyView'
import { QueueView } from './views/QueueView'
import { ReportsView } from './views/ReportsView'
import { HdeView } from './views/HdeView'
import { ProjectView } from './views/ProjectView'
import { SettingsView } from './views/SettingsView'
import { HelpView } from './views/HelpView'
import { NavIcon } from './components/NavIcon'
import { ViewSwitch, type ViewMode } from './components/ViewSwitch'
import { PAGE_ICON, SEGMENTS, TOOL_PAGES, segmentOf, type Page } from './nav'

/**
 * 视图模式。它是**界面偏好**，走 kv 不走 Settings
 * （加 Settings 字段要同时动 zod schema、默认值、老库迁移三处，
 * 为一条"界面长什么样"的偏好不值得）。
 */
const VIEW_MODE_KEY = 'ui.viewMode'

function parseViewMode(raw: string | null): ViewMode {
  return raw === 'compact' || raw === 'focus' || raw === 'cards' ? raw : 'cards'
}

function Shell(): ReactNode {
  const { t } = useI18n()
  const { settings, jobs, toasts, appInfo, dismissToast, recovered, dismissRecovered } = useAppState()
  const { page, navigate } = useNav()

  /**
   * 视图模式。
   *
   * 初始值就用默认的 `cards` —— 它只影响版式，不影响任何测量，
   * 读回来之后再切过去不会看到布局跳动。
   */
  const [viewMode, setViewMode] = useState<ViewMode>('cards')

  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const view = await unwrap(window.securereel.kv.get(VIEW_MODE_KEY))
        if (cancelled) return
        setViewMode(parseViewMode(view))
      } catch {
        // 读不到就按默认渲染：界面偏好没读出来，不该影响干活
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const changeView = (next: ViewMode): void => {
    setViewMode(next)
    void window.securereel.kv.set(VIEW_MODE_KEY, next).catch(() => undefined)
  }

  // 平台标记先挂上：CSS 里 `[data-platform='windows']` 的规则（标题栏留白、
  // 拖拽条）依赖它，晚一步就会出现一帧的布局跳变。
  useEffect(() => {
    applyPlatform(appInfo?.platform)
  }, [appInfo?.platform])

  /*
   * 外观：明暗（themeMode）+ 配色皮肤（themeId），两者都在设置页的「外观」卡里选。
   * 明暗先按 themeMode 解析（system 跟随系统，light / dark 直取），再挂皮肤标记。
   */
  const resolvedMode = useResolvedMode(settings.themeMode)
  useEffect(() => {
    applyTheme(settings.themeId, resolvedMode)
    applySkin(settings.themeId)
    // 主题换了要顺手把 Windows 标题栏按钮区的颜色也换掉。
    const frame = requestAnimationFrame(() => syncNativeTitleBar(appInfo?.platform))
    return () => cancelAnimationFrame(frame)
  }, [settings.themeId, resolvedMode, appInfo?.platform])

  const runningCount = jobs.filter((job) => job.state === 'running' || job.state === 'queued').length
  const showRecovery = recovered.length > 0 && page !== 'queue'

  const currentSegment = segmentOf(page)
  const tabs = SEGMENTS.find((item) => item.segment === currentSegment)?.pages ?? []

  return (
    <div className="shell" data-view={viewMode}>
      <header className="topbar">
        <div className="topbar__brand">
          {/*
           * 顶栏品牌：只留软件名，不放图标。
           *
           * 2026-10-11 曾放过手绘「胶片盘」，又改回软件图标（绿底 #3D7A58）——
           * boss 明确表示不想要那个绿色图标。顶栏这一格本来就窄，纯文字最干净，
           * 也与 macOS 上「窗口左缘直接是标题」的观感一致。
           * 真正的图标仍保留在 Dock / 安装包里（build/icon.svg），不在这里重复。
           */}
          <span className="topbar__name">{t('app.name')}</span>
        </div>

        <nav className="segs" aria-label={t('seg.label')}>
          {SEGMENTS.map((item) => (
            <button
              key={item.segment}
              type="button"
              className="seg"
              data-segment={item.segment}
              data-page={item.pages[0]}
              aria-current={currentSegment === item.segment ? 'page' : undefined}
              onClick={() => navigate(item.pages[0] as Page)}
            >
              <span className="seg__label">{t(`seg.${item.segment}` as never)}</span>
              {item.segment === 'monitor' && runningCount > 0 && (
                <span className="seg__badge">{runningCount}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="topbar__right">
          {runningCount > 0 && (
            <span className="pill pill--run">
              <span className="pill__led" aria-hidden="true" />
              {t('top.running')} · {runningCount}
            </span>
          )}
          {TOOL_PAGES.map((tool) => (
            <button
              key={tool}
              type="button"
              className="iconbtn"
              data-page={tool}
              title={t(`nav.${tool}` as never)}
              aria-label={t(`nav.${tool}` as never)}
              aria-current={page === tool ? 'page' : undefined}
              onClick={() => navigate(tool)}
            >
              <NavIcon name={PAGE_ICON[tool]} />
            </button>
          ))}
        </div>
      </header>

      {/*
       * 段内子标签。只有一个页面的段（监控 / 交付）不渲染这一行 ——
       * 一个只有一项的标签栏纯属占地方。
       */}
      {tabs.length > 1 && (
        <div className="subtabs">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              className="subtab"
              data-page={tab}
              aria-current={page === tab ? 'page' : undefined}
              onClick={() => navigate(tab)}
            >
              {t(`nav.${tab}` as never)}
            </button>
          ))}
        </div>
      )}

      {/*
       * data-page 不是给 JS 读的，是给 CSS 读的：拷贝页有吸底操作条，
       * 右下角停靠区（.dock）要为它让位（见 app.css）。
       */}
      <main className="main" data-page={page}>
        {page === 'home' && <HomeView />}
        {page === 'copy' && <CopyView />}
        {page === 'queue' && <QueueView />}
        {page === 'reports' && <ReportsView />}
        {page === 'hde' && <HdeView />}
        {page === 'project' && <ProjectView />}
        {page === 'settings' && <SettingsView />}
        {page === 'help' && <HelpView />}
      </main>

      {/*
       * 右下角停靠区。
       *
       * 视图切换器**常驻**，临时提示叠在它上方 —— 合成一个 flex 列之后，
       * 两者永远不会互相盖住。
       */}
      <div className="dock">
        {showRecovery && (
          <div className="toast warn">
            <strong>{t('queue.recovered')}</strong>
            <div className="faint" style={{ marginTop: 4 }}>
              {t('queue.recoveredHint')}
            </div>
            <div className="row-actions" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-sm" onClick={() => navigate('queue')}>
                {t('nav.queue')}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={dismissRecovered}>
                {t('queue.dismiss')}
              </button>
            </div>
          </div>
        )}

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

        <ViewSwitch value={viewMode} onChange={changeView} />
      </div>
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
      <NavProvider>
        <Shell />
      </NavProvider>
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
