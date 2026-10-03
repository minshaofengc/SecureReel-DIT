/**
 * 开屏动画（启动画面）—— 窗口的建立与关闭。
 *
 * ## 为什么需要一个**独立的窗口**
 *
 * 主窗口要等一大串事情做完才能画：1.x 数据迁移、打开 SQLite、建日志目录、
 * 装配服务、跑一次启动恢复。现场电脑上这段可能好几秒 —— 期间用户看到的是
 * 一片空白（或者一个没有任何反馈的窗口），最常见的反应是"再点一次图标"。
 * 开屏窗在 `app.whenReady()` 之后**立刻**出现，并且用**真实步骤**更新文字
 * （见 bootstrap 里的 setSplashStatus 调用点），让这几秒变成"看得见在做什么"。
 *
 * 页面本身在 `splash-html.ts`，那边不 import electron，所以能被单元测试钉住。
 *
 * ## 冒烟模式下默认不启用
 *
 * 自动化验证每次启动都要额外等 1.5 秒，而且它会挡住 `capturePage()` 想截的画面。
 * 要验开屏本身时用 `SECUREREEL_SMOKE_SPLASH=1`（见 main/index.ts）。
 */
import { BrowserWindow, nativeTheme, screen } from 'electron'
import {
  SPLASH_FADE_MS,
  SPLASH_HEIGHT,
  SPLASH_PALETTE,
  SPLASH_WIDTH,
  splashHtml
} from './splash-html'

/**
 * 最短显示时长。
 *
 * 存在的意义是**防止"闪一下"**：启动快的时候（本机热启往往几百毫秒）
 * 开屏会一闪而过，比没有还难看。低于这个时长就不许关。
 */
export const SPLASH_MIN_VISIBLE_MS = 1500

let splashWindow: BrowserWindow | null = null
let splashShownAt = 0

/**
 * 取出当前的开屏窗（可能为 null）。
 *
 * 只给诊断用：冒烟流程要能把开屏窗**本身**截下来。生产代码不要拿它改状态 ——
 * "什么时候关"这件事只应该有 splash.ts 一个地方说了算。
 */
export function getSplashWindow(): BrowserWindow | null {
  return splashWindow !== null && !splashWindow.isDestroyed() ? splashWindow : null
}

/**
 * 建立开屏窗。**不等待它加载完成** —— 它自己就是"等"的替代品，
 * 在这儿再 await 一次就把要遮的时间又还回去了。
 *
 * `show: false` 用于诊断截图：受限环境（无窗口服务器）里 `show()` 会让进程挂住，
 * 而 `capturePage()` 对隐藏窗口一样有效 —— 不必为了截图去冒挂死的风险。
 */
export function createSplashWindow(options: { show?: boolean } = {}): BrowserWindow {
  const shouldShow = options.show ?? true
  splashShownAt = Date.now()

  // 多屏现场笔记本外接监视器时，开屏跑到另一块屏上会让人愣一下 ——
  // 所以居中到**鼠标所在的那块屏**，而不是主屏。
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = display.workArea

  splashWindow = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    x: Math.round(x + (width - SPLASH_WIDTH) / 2),
    y: Math.round(y + (height - SPLASH_HEIGHT) / 2),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      // 与主窗口同一套安全约束：沙箱 + 上下文隔离 + 无 Node。
      // 这个页面一个字节的外部资源都不加载（CSP 也卡死了）。
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  splashWindow.once('ready-to-show', () => {
    if (shouldShow) splashWindow?.show()
  })
  splashWindow.on('closed', () => {
    splashWindow = null
  })

  const palette = nativeTheme.shouldUseDarkColors ? SPLASH_PALETTE.dark : SPLASH_PALETTE.light
  void splashWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(splashHtml(palette))}`)
  return splashWindow
}

/**
 * 告诉开屏窗现在进行到哪一步。
 *
 * 文字是**真实步骤**，不是编好的台词 —— 台词会在步骤变快变慢时和实际对不上，
 * 那种"卡在某句话上"比不显示更让人心慌。
 */
export function setSplashStatus(text: string): void {
  if (splashWindow === null || splashWindow.isDestroyed()) return
  void splashWindow.webContents
    .executeJavaScript(`window.__splashSetStatus(${JSON.stringify(text)})`)
    .catch(() => undefined)
}

/**
 * 关闭开屏窗。
 *
 * 三件事必须都做，少一件都会出问题：
 *   1. **等最短时长**：启动快的时候不闪一下
 *   2. **先淡出再关**：直接消失很生硬
 *   3. **幂等 + 容错**：它可能已经被用户关掉、或者根本没建立（冒烟模式）
 */
export async function closeSplashWindow(): Promise<void> {
  const window = splashWindow
  if (window === null || window.isDestroyed()) return

  const remaining = SPLASH_MIN_VISIBLE_MS - (Date.now() - splashShownAt)
  if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining))
  if (window.isDestroyed()) return

  try {
    await window.webContents.executeJavaScript('window.__splashFadeOut()')
  } catch {
    /* 淡出失败不影响关闭，直接关 */
  }
  await new Promise<void>((resolve) => setTimeout(resolve, SPLASH_FADE_MS))
  if (!window.isDestroyed()) window.close()
  splashWindow = null
}
