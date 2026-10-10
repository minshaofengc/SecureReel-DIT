import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { DEFAULT_PAGE, segmentOf, type Page, type Segment } from '../nav'

/**
 * 导航状态。
 *
 * 2026-10-05 第五次改（方案 E）引入，替换掉此前 App.tsx 里那套
 * **props 回调**（`<CopyView onCreated={() => setPage('queue')} />`、
 * `<QueueView onCreate={…} onReports={…} />`）。
 *
 * 那套写法有三个问题，都是随着页面变多才暴露的：
 *   ① 每加一条跳转就要在 App 和视图之间接一根新线，App 越来越像调度台；
 *   ② 视图只能"向上喊"，没法把上下文一起带过去 —— 比如"跳到监控页**并选中
 *      这个任务**"，用回调就得再设计一个参数；
 *   ③ 深层组件要跳转就得一路透传，中间层被迫认识它并不关心的回调。
 *
 * 换成 Context 之后，任何一层都能 `const { navigate } = useNav()`，
 * 而 `focusJob(id)` 把"跳到哪"和"看哪个"合成一个动作。
 */
interface NavValue {
  page: Page
  /** 当前页所属的段；工具页（设置/帮助）为 null。 */
  segment: Segment | null
  navigate: (page: Page) => void
  /** 跳到监控页并选中某个任务。 */
  focusJob: (jobId: string) => void
  /** 被要求聚焦的任务 id。QueueView 消费后调 clearFocus 清掉。 */
  focusJobId: string | null
  clearFocus: () => void
}

const NavContext = createContext<NavValue | null>(null)

export function NavProvider({ children }: { children: ReactNode }): ReactNode {
  const [page, setPage] = useState<Page>(DEFAULT_PAGE)
  const [focusJobId, setFocusJobId] = useState<string | null>(null)

  const navigate = useCallback((next: Page): void => {
    setPage(next)
  }, [])

  /*
   * 两个 setState 一起调不会闪：React 18 会把它们批到同一次渲染里，
   * 所以不会出现"先切到监控页、任务列表还没选中"的中间帧。
   */
  const focusJob = useCallback((jobId: string): void => {
    setFocusJobId(jobId)
    setPage('queue')
  }, [])

  const clearFocus = useCallback((): void => setFocusJobId(null), [])

  const value = useMemo<NavValue>(
    () => ({ page, segment: segmentOf(page), navigate, focusJob, focusJobId, clearFocus }),
    [page, navigate, focusJob, focusJobId, clearFocus]
  )

  return <NavContext.Provider value={value}>{children}</NavContext.Provider>
}

export function useNav(): NavValue {
  const value = useContext(NavContext)
  if (value === null) throw new Error('useNav 必须在 NavProvider 内使用')
  return value
}
