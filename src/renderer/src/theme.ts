/**
 * 主题应用。
 *
 * 用 `data-theme` / `data-mode` 两个属性挂在 <html> 上，
 * 具体色值由 tokens.css 决定 —— 组件里不出现任何硬编码颜色。
 */
import { useEffect, useState } from 'react'
import type { ThemeId, ThemeMode } from '@shared/types'
import { isWindows } from './platform'

/** 跟随系统时实时响应系统的外观切换（macOS 与 Windows 都支持）。 */
function usePrefersDark(): boolean {
  const [dark, setDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (event: MediaQueryListEvent): void => setDark(event.matches)
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [])

  return dark
}

export function useResolvedMode(mode: ThemeMode): 'light' | 'dark' {
  const systemDark = usePrefersDark()
  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return mode
}

export function applyTheme(themeId: ThemeId, resolved: 'light' | 'dark'): void {
  const root = document.documentElement
  root.dataset.theme = themeId
  root.dataset.mode = resolved
  root.style.colorScheme = resolved
}

/**
 * 标记当前平台，供 CSS 里 `[data-platform='windows']` 这类规则使用。
 *
 * 数据来自主进程的 `IPC.appInfo`（那里返回 `process.platform`），
 * 所以不需要新增通道；也**不写死** —— 同一份代码要同时跑在 mac 与 win 上。
 */
export function applyPlatform(platform: string | undefined | null): void {
  const root = document.documentElement
  root.dataset.platform = isWindows(platform) ? 'windows' : 'macos'
}

/**
 * 把标题栏按钮区的配色同步给主进程（只有 Windows 的 `titleBarOverlay` 用得上）。
 *
 * 颜色是**从当前主题算出来的**：读 `--bg-elevated`（侧栏底色 —— 标题栏正好压在
 * 侧栏上方，取它才能让接缝没有可见色差）与 `--text`（按钮符号色）。
 * 不新增任何令牌，也**不在主进程复制一份调色板** —— tokens.css 仍是唯一真源。
 *
 * 非 Windows 平台直接返回：主进程那边也会忽略，但少一次 IPC 往返更好。
 */
export function syncNativeTitleBar(platform: string | undefined | null): void {
  if (!isWindows(platform)) return
  const styles = getComputedStyle(document.documentElement)
  const color = styles.getPropertyValue('--bg-elevated').trim()
  const symbolColor = styles.getPropertyValue('--text').trim()
  if (color === '' || symbolColor === '') return
  // 失败只影响标题栏好不好看，绝不能把主题切换本身搞挂 —— 所以吞掉异常
  void window.securereel.window.setTitleBarOverlay({ color, symbolColor }).catch(() => undefined)
}
