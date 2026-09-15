/**
 * 主题应用。
 *
 * 用 `data-theme` / `data-mode` 两个属性挂在 <html> 上，
 * 具体色值由 tokens.css 决定 —— 组件里不出现任何硬编码颜色。
 */
import { useEffect, useState } from 'react'
import type { ThemeId, ThemeMode } from '@shared/types'

/** 跟随系统时实时响应 macOS 的外观切换。 */
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
