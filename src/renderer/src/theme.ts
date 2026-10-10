/**
 * 主题应用。
 *
 * 两件事彼此正交：**明暗**（`html[data-mode]`）由 `applyTheme` 写、
 * **配色皮肤**（`html[data-skin]`）由 `applySkin` 写，两者都由 tokens.css 消费。
 *
 * `applyTheme` 的第一个参数（皮肤 id）已不再被它使用 —— 皮肤改由 `applySkin`
 * 单独挂；保留该参数只是为了兼容调用方签名与老存档。
 */
import { useEffect, useState } from 'react'
import { THEMES, type ThemeId, type ThemeMode } from '@shared/types'
import { isWindows } from './platform'

/** 跟随显式的系统外观变化；首次运行时 `system` 以暗色为产品默认。 */
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

/*
 * 第一个参数（皮肤 id）已不参与选色 —— 皮肤改由 `applySkin` 单独挂。
 * 参数留着不删是为了兼容调用方签名与老存档；明确忽略而不是悄悄留着不管，
 * 免得以后有人以为改它有用。
 */
export function applyTheme(_themeId: ThemeId, resolved: 'light' | 'dark'): void {
  const root = document.documentElement
  root.dataset.mode = resolved
  root.style.colorScheme = resolved
}

/**
 * 配色皮肤。
 *
 * 清单的**真源在 `@shared/types` 的 `THEMES`** —— 那边同时喂给设置 schema 与
 * 设置页的下拉，这里只是转出一个更好读的名字，避免两处清单漂移。
 * CSS 覆盖块在 `styles/tokens.css`。
 */
export const SKINS = THEMES
export type Skin = ThemeId

export function isSkin(value: unknown): value is Skin {
  return typeof value === 'string' && (SKINS as readonly string[]).includes(value)
}

/**
 * 挂上皮肤标记。
 *
 * 值直接写进 `data-skin`，不做 `steel` 的特判 —— 默认皮肤没有覆盖块，
 * 写了也等于没写，反而少一个分支。
 */
export function applySkin(skin: Skin): void {
  document.documentElement.dataset.skin = skin
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
  /*
   * 2026-10-04：取 `--rail` 而不是 `--bg-elevated`。
   *
   * 侧栏反色成近黑之后，Windows 那个标题栏叠加层压在侧栏上方 ——
   * 若还取白底，标题栏会是一条白带压在黑侧栏顶上，接缝非常明显。
   * 符号色同理：深底上必须用浅色符号。
   */
  const color = styles.getPropertyValue('--rail').trim()
  const symbolColor = styles.getPropertyValue('--rail-text').trim()
  if (color === '' || symbolColor === '') return
  // 失败只影响标题栏好不好看，绝不能把主题切换本身搞挂 —— 所以吞掉异常
  void window.securereel.window.setTitleBarOverlay({ color, symbolColor }).catch(() => undefined)
}
