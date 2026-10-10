/**
 * 主进程入口。
 *
 * 职责边界很清楚：**只做装配**。
 * 建窗口、装服务、注册 IPC，业务逻辑一律不在这个文件里。
 */
import { app, BrowserWindow, dialog, powerSaveBlocker, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { DEFAULT_SETTINGS, THEMES, type AppSettings } from '@shared/types'
import { APP_NAME, APP_VERSION } from '@shared/version'
import { buildAppPaths } from './paths'
import { legacyUserDataDirOf, migrateLegacyUserData, type MigrationResult } from './core/data-migration'
import { Logger } from './logger'
import { Store } from './db/store'
import { FfprobeRunner } from './media/probe'
import { HdeAdapter } from './adapters/hde'
import { ReportStore } from './reports/report-store'
import { JobManager, TOOL_NAME } from './core/job-manager'
import { emitToWindows, registerIpcHandlers } from './ipc/handlers'
import { ensureDir } from './fs-utils'
import { IS_MAC, IS_WINDOWS, TITLE_BAR_HEIGHT, USE_OVERLAY_TITLEBAR } from './platform'
import { registerFrameProtocol, registerFrameScheme } from './protocol'
import { closeSplashWindow, createSplashWindow, getSplashWindow, setSplashStatus } from './splash'

app.setName(APP_NAME)

// 自定义协议必须在 app ready 之前登记，否则 Chromium 不会把它当成正常来源
registerFrameScheme()

// 冒烟模式下不需要真的显示窗口：在受限环境（无窗口服务器）里 show() 会让进程挂住
const smokeScreenshotPath = process.env['SECUREREEL_SMOKE_SCREENSHOT']
const smokeMode = smokeScreenshotPath !== undefined && smokeScreenshotPath !== ''
/**
 * 冒烟验证可选的隔离 userData 目录。
 *
 * 只在截图冒烟模式启用，且必须是绝对路径；正常启动 / 正式包完全忽略它。
 * 这样可以用真实数据库的副本验证界面，而不碰用户正在使用的正式数据库。
 */
const smokeUserDataDir = process.env['SECUREREEL_SMOKE_USER_DATA_DIR']
if (smokeMode && smokeUserDataDir !== undefined && isAbsolute(smokeUserDataDir)) {
  app.setPath('userData', smokeUserDataDir)
}
/**
 * 冒烟时是否保留开屏窗（并改为截它）。
 *
 * 平时冒烟不建开屏窗：会拖慢每次验证、还会挡截图。但要验"开屏长什么样"时
 * 必须能把它留住 —— 不然这个窗口就成了唯一没人看过的界面。
 */
const smokeSplash = process.env['SECUREREEL_SMOKE_SPLASH'] !== undefined &&
  process.env['SECUREREEL_SMOKE_SPLASH'] !== ''
if (smokeMode) app.disableHardwareAcceleration()

let mainWindow: BrowserWindow | null = null
let logger: Logger | null = null
let store: Store | null = null

const paths = buildAppPaths(app.getPath('userData'))

/**
 * 启动时的窗口底色（深色模式用竹林的深色底，避免白屏闪一下）。
 *
 * 这两个值同时充当 Windows 标题栏叠加层的**初始**颜色。主进程刻意不持有
 * 整套调色板 —— 配色的唯一真源是渲染层的 `styles/tokens.css`。界面画出来后
 * 会立刻通过 IPC 把真实主题色同步过来（见 theme.ts），用户看不到跳变。
 */
const WINDOW_BOOT_BG = { dark: '#141a17', light: '#f7f6f1' } as const

/**
 * 标题栏选项。
 *
 * - macOS：无边框 + 内缩的红绿灯（x=14,y=18 是现在视觉定下来的位置）
 * - Windows：无边框 + 右上角**系统原生**的最小化/最大化/关闭按钮
 *   （`titleBarOverlay` 由 Chromium 绘制，三态、DPI 缩放、高对比度模式、
 *   `Alt+F4`/`Win+↑` 全都是免费的；自绘按钮要把这些都自己实现一遍）
 * - 其他平台 / 关掉开关：什么都不传 = 系统原生标题栏
 *
 * 三者的顶部留白都是 40px，所以渲染层的布局在两个平台上完全共用。
 */
function titleBarOptions(backgroundColor: string): Electron.BrowserWindowConstructorOptions {
  if (IS_MAC) {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 18 } }
  }
  if (IS_WINDOWS && USE_OVERLAY_TITLEBAR) {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: backgroundColor,
        // 中性灰，浅底深底都看得见。它只活到界面把真实主题色报回来为止（约一帧）。
        symbolColor: '#8a8a8a',
        height: TITLE_BAR_HEIGHT
      }
    }
  }
  return {}
}

function createWindow(settings: AppSettings): BrowserWindow {
  const bootBackground = settings.themeMode === 'dark' ? WINDOW_BOOT_BG.dark : WINDOW_BOOT_BG.light
  const window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: TOOL_NAME,
    backgroundColor: bootBackground,
    ...titleBarOptions(bootBackground),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 安全基线硬性要求：渲染进程跑在沙箱里，开启上下文隔离，关闭 Node 集成
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // 拷贝跑在主进程，本来就不会被 Chromium 节流；关掉渲染层的节流是为了
      // 窗口被挡在后面时进度数字照常刷新。**它不影响拷贝吞吐** —— 别指望
      // 靠这一行提速，提升速度的旋钮在文件级并发里。
      backgroundThrottling: false
    }
  })

  // 冒烟模式：不显示窗口（在无窗口服务器的环境里 show() 会挂住），
  // 渲染完成后截一张图再退出，用于自动化验证界面确实画出来了
  if (smokeMode) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          try {
            /*
             * 开屏窗专用分支。
             *
             * 开屏窗平时只在非冒烟模式出现，于是"它到底长什么样"就一直没人验 ——
             * 而那恰恰是最容易悄悄坏掉的东西（它不接 IPC、不读数据库，
             * 坏了也不会有任何报错，只是启动时多一块白板）。
             * 所以给一个开关：`SECUREREEL_SMOKE_SPLASH=1` 时保留开屏窗，
             * 并且**截它**而不是截主窗口。主窗口那套导航/主题/探针在这里没有意义。
             */
            const splash = getSplashWindow()
            if (splash !== null) {
              // 等它真的画出来：data: 页面加载极快，但 capturePage() 对着
              // 一个还没绘制过一帧的窗口会返回一张全透明的空图 —— 那张图
              // 看起来"截成功了"，其实什么都没证明。所以等到不再 loading。
              for (let i = 0; i < 40 && splash.webContents.isLoading(); i++) {
                await new Promise<void>((resolve) => setTimeout(resolve, 50))
              }
              await new Promise<void>((resolve) => setTimeout(resolve, 400))
              const image = await splash.webContents.capturePage()
              await writeFile(smokeScreenshotPath as string, image.toPNG())
              logger?.info('app', `冒烟截图（开屏窗）已写入 ${smokeScreenshotPath}`)
              return
            }

            // 诊断专用：可以指定要截哪一页、用哪套配色。
            // 只在冒烟模式下生效，既不改设置也不写数据库。
            const navTarget = process.env['SECUREREEL_SMOKE_NAV']
            if (navTarget !== undefined && navTarget !== '') {
              await window.webContents.executeJavaScript(
                `(() => {
                   const el = document.querySelector('[data-page="${navTarget.replace(/"/g, '')}"]')
                   if (el) el.click()
                   return Boolean(el)
                 })()`,
                true
              )
              await new Promise<void>((resolve) => setTimeout(resolve, 1200))
            }

            // 还可以再点几个元素（比如先"+ 添加一行"，再展开职务下拉），
            // 用来给需要多次交互才能看到的界面留证。
            // 传 CSS 选择器，多个用英文逗号分隔，按顺序点，每个之间等一次渲染。
            const clickTarget = process.env['SECUREREEL_SMOKE_CLICK']
            if (clickTarget !== undefined && clickTarget !== '') {
              for (const selector of clickTarget.split(',')) {
                const trimmed = selector.trim()
                if (trimmed === '') continue
                const hit = await window.webContents.executeJavaScript(
                  `(() => {
                     const el = document.querySelector(${JSON.stringify(trimmed)})
                     if (!el) return false
                     /*
                      * 为什么手搓这一串事件，而不是 el.click()：真实的鼠标动作是
                      * pointerdown → mousedown → pointerup → mouseup → click 五步，
                      * 而 click() 只发最后一步。自研下拉这类"在 pointerdown/mousedown
                      * 上开面板"的控件收到 click() 毫无反应，会得到
                      * "点了、日志说命中、界面却没展开"的假阴性 —— 比报错更难查。
                      */
                     const box = el.getBoundingClientRect()
                     const base = {
                       bubbles: true,
                       cancelable: true,
                       composed: true,
                       button: 0,
                       clientX: box.left + box.width / 2,
                       clientY: box.top + box.height / 2
                     }
                     const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 }
                     el.dispatchEvent(new PointerEvent('pointerdown', { ...base, ...pointer }))
                     el.dispatchEvent(new MouseEvent('mousedown', base))
                     el.dispatchEvent(new PointerEvent('pointerup', { ...base, ...pointer }))
                     el.dispatchEvent(new MouseEvent('mouseup', base))
                     el.dispatchEvent(new MouseEvent('click', base))
                     return true
                   })()`,
                  true
                )
                logger?.info('app', `冒烟点击 ${trimmed} → ${hit === true ? '命中' : '未找到'}`)
                await new Promise<void>((resolve) => setTimeout(resolve, 1200))
              }
            }

            // 写法：`steel` 或 `steel:light`（只换皮肤时明暗不动）
            //
            // ⚠️ 皮肤名必须逐个比对 THEMES，不能只做字符消毒就写进去。
            // 真实踩到过：`SECUREREEL_SMOKE_THEME=$t:light` 在 zsh 里会被
            // 参数修饰符吃掉 `:l`（转小写），名字变成 `steelight`。
            // 一个不存在的名字不会报任何错，只会让配色同时失配 ——
            // --accent 等变量全空，界面变成一片无样式的透明块，看起来像应用崩了。
            // 所以这里宁可吵：不认识就明确说"不认识"，并列出合法值。
            const themeOverride = process.env['SECUREREEL_SMOKE_THEME']
            if (themeOverride !== undefined && themeOverride !== '') {
              const [themeName, modeName] = themeOverride.split(':')
              const themeId = THEMES.find((theme) => theme === themeName)
              const modeId = modeName === 'light' || modeName === 'dark' ? modeName : null
              if (themeId === undefined) {
                logger?.warn(
                  'app',
                  `冒烟主题名 ${themeName ?? ''} 不认识，已忽略。合法值：${THEMES.join(' / ')}`
                )
              } else {
                if (modeName !== undefined && modeId === null) {
                  logger?.warn('app', `冒烟明暗值 ${modeName} 不认识，已保留原有明暗（只认 light / dark）`)
                }
                await window.webContents.executeJavaScript(
                  `(() => {
                     document.documentElement.dataset.skin = ${JSON.stringify(themeId)}
                     ${modeId === null ? '' : `document.documentElement.dataset.mode = ${JSON.stringify(modeId)}`}
                     return true
                   })()`,
                  true
                )
                await new Promise<void>((resolve) => setTimeout(resolve, 300))
                // 回读一次：属性写对了不等于配色生效，得确认变量真的解析出来了。
                const applied = await window.webContents.executeJavaScript(
                  `(() => {
                     const root = getComputedStyle(document.documentElement)
                     return {
                       skin: document.documentElement.dataset.skin,
                       mode: document.documentElement.dataset.mode,
                       accent: root.getPropertyValue('--accent').trim()
                     }
                   })()`,
                  true
                )
                const accent = (applied as { accent?: string } | null)?.accent ?? ''
                logger?.info(
                  'app',
                  accent === ''
                    ? `冒烟主题已写入但仍取不到 --accent，页面当前没有生效的配色块`
                    : `冒烟主题生效：${String(themeId)} / ${(applied as { mode?: string }).mode ?? '?'}（--accent=${accent}）`
                )
              }
            }

            // 通用探针：把一个 .js 片段丢进渲染进程执行，结果写成 `<片段路径>.result.json`。
            //
            // 为什么需要它：截图只能证明"画出来了"，证明不了"下拉展开了几项、分组标题是什么、
            // 触发器里显示的字对不对、某个元素的最终配色是什么"。那些是 DOM 事实，
            // 只能靠求值拿到 —— 而项目里没有 jsdom / testing-library（见 ui.tsx 开头）。
            // 诊断专用：只在冒烟模式下生效，片段由调用方提供，产物里没有任何业务代码依赖它。
            const evalSnippetPath = process.env['SECUREREEL_SMOKE_EVAL']
            if (evalSnippetPath !== undefined && evalSnippetPath !== '') {
              const snippet = await readFile(evalSnippetPath, 'utf8')
              const result: unknown = await window.webContents.executeJavaScript(snippet, true)
              const outPath = `${evalSnippetPath}.result.json`
              await writeFile(outPath, JSON.stringify(result, null, 2), 'utf8')
              logger?.info('app', `冒烟探针结果已写入 ${outPath}`)
            }

            const image = await window.webContents.capturePage()
            await writeFile(smokeScreenshotPath as string, image.toPNG())
            logger?.info('app', `冒烟截图已写入 ${smokeScreenshotPath}`)
          } catch (error) {
            logger?.error('app', `冒烟截图失败：${String(error)}`)
          } finally {
            await logger?.flush()
            app.exit(0)
          }
        })()
      }, 2500)
    })
  } else {
    /*
     * 主窗口一直要等到这里才显示（有迁移、开库、装配这一大段在前面）。
     *
     * 顺序很讲究：**先把主窗口显示出来，再关开屏**。
     * 反过来的话，中间会有一瞬间两个窗口都没有 —— 桌面闪一下，
     * 而"闪一下桌面"正是开屏要遮掉的那种观感。
     */
    window.once('ready-to-show', () => {
      window.show()
      void closeSplashWindow()
    })
  }

  // 任何尝试新开窗口的行为都踢到系统浏览器，绝不在应用内开
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // 禁止渲染进程导航到外部地址（例如被注入的链接）
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env['ELECTRON_RENDERER_URL']
    const isDevServer = allowed !== undefined && url.startsWith(allowed)
    if (!isDevServer && !url.startsWith('file://')) {
      event.preventDefault()
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl !== undefined) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

async function bootstrap(): Promise<void> {
  await app.whenReady()

  // 开屏窗必须在 whenReady 之后**立刻**建：它要遮的就是下面这一整段。
  // 冒烟模式下默认不建（会拖慢每次验证、还会挡截图），
  // 除非显式要求把它留下来截图（见 SECUREREEL_SMOKE_SPLASH）。
  if (!smokeMode || smokeSplash) createSplashWindow({ show: !smokeMode })

  // 1.x → 2.0 的数据迁移。**必须赶在 Store.open() 之前**：数据库一旦被打开，
  // 再复制就只能拿到一半旧一半新的状态。结果先存着，等 logger 建好再记
  // （日志本身要落在新目录里，而新目录正是这一步建出来的）。
  setSplashStatus('正在检查本地数据…')
  let migration: MigrationResult = { status: 'skipped', reason: '未执行', copied: [] }
  try {
    await ensureDir(paths.userDataDir)
    migration = await migrateLegacyUserData(paths.userDataDir, legacyUserDataDirOf(paths.userDataDir))
  } catch (error) {
    migration = {
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      copied: []
    }
  }

  await Promise.all([ensureDir(paths.logsDir), ensureDir(paths.reportsDir), ensureDir(paths.hdeWorkDir)])

  logger = new Logger({ dir: paths.logsDir, mirrorToConsole: !app.isPackaged })
  logger.info('app', `${APP_NAME} 启动，版本 ${APP_VERSION}`)

  if (migration.status === 'migrated') logger.info('app', migration.reason)
  if (migration.status === 'failed') {
    // 迁移是可选的舒适项：失败只丢历史记录，素材与拷贝能力一切照旧，绝不阻断启动
    logger.warn('app', `1.x 数据迁移失败（不影响使用）：${migration.reason}`)
  }

  // 顺手清掉 30 天前的按天日志 —— 平时量不大，但没有清理策略的话
  // 几年就是一堆没人看的文件。失败不影响启动。
  void logger.pruneOldLogs().then((removed) => {
    if (removed > 0) logger?.info('app', `已清理 ${removed} 个过期日志文件（保留最近 30 天）。`)
  })

  setSplashStatus('正在打开任务数据库…')
  store = await Store.open(paths.dbFile)

  // 界面里的首帧缩略图走这个受控协议，不把文件系统暴露给渲染进程
  registerFrameProtocol(paths, logger)

  // 旧库被隔离这件事必须留痕：细节进日志，一句话进界面
  if (store.quarantined !== null) {
    logger.warn(
      'db',
      `已有数据库与当前版本不兼容，已留档并重建。原因：${store.quarantined.reason}；备份：${store.quarantined.backupPath ?? '（失败，原地保留）'}`
    )
  }

  let settings = store.getSettings()
  if (Object.keys(settings).length === 0) settings = { ...DEFAULT_SETTINGS }

  const probeRunner = new FfprobeRunner({
    logger,
    userDir: settings.ffmpegDir,
    bundledDir: app.isPackaged ? join(process.resourcesPath, 'bin') : null
  })
  await probeRunner.refresh()

  const hde = new HdeAdapter({
    logger,
    getSettings: () => store?.getSettings() ?? settings,
    resourceDir: app.isPackaged ? process.resourcesPath : null
  })

  const reportStore = new ReportStore(paths, logger)

  const jobManager = new JobManager({
    store,
    logger,
    paths,
    reportStore,
    probeRunner,
    hde,
    getSettings: () => store?.getSettings() ?? settings,
    emit: (event) => emitToWindows(event, () => mainWindow),
    // 真实实现只在装配层出现，JobManager 本身不 import electron ——
    // 否则跑在 node 环境里的单元测试会被这一行拖垮。
    // 用 prevent-app-suspension 而非 prevent-display-sleep：屏幕该黑就黑。
    sleepBlocker: {
      start: () => powerSaveBlocker.start('prevent-app-suspension'),
      stop: (id) => powerSaveBlocker.stop(id),
      isStarted: (id) => powerSaveBlocker.isStarted(id)
    }
  })

  registerIpcHandlers({
    store,
    logger,
    paths,
    reportStore,
    jobManager,
    probeRunner,
    hde,
    getSettings: () => store?.getSettings() ?? settings,
    saveSettings: (next) => {
      const saved = store?.saveSettings(next) ?? next
      settings = saved
      return saved
    },
    getMainWindow: () => mainWindow
  })

  setSplashStatus('正在准备界面…')
  mainWindow = createWindow(settings)

  // 上次异常退出留下的任务：不自动重启，只在界面里提示用户决定
  const recoverable = store.listResumableJobs()
  if (recoverable.length > 0) {
    logger.warn('app', `发现 ${recoverable.length} 个上次未完成的任务，等待用户确认是否继续。`)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow(settings)
    }
  })
}

// 单实例：两个实例同时往同一张卡写是灾难
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void bootstrap().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    void logger?.error('app', `启动失败：${message}`)

    // 开屏窗此时正罩在屏幕中央。不先关掉它，错误框会压在开屏后面、
    // 退出过程也要多绕一圈 —— 启动失败已经够糟了，别再让人怀疑是不是卡死了。
    void closeSplashWindow()

    // 启动失败必须让用户看见，否则只会看到一个空白的 Dock 图标
    void app.whenReady().then(() => {
      dialog.showErrorBox(
        `${TOOL_NAME} 启动失败`,
        `${message}\n\n请把这一段发给开发者。日志目录：${paths.logsDir}`
      )
      app.quit()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void logger?.flush()
  try {
    store?.close()
  } catch {
    /* 关闭失败不阻塞退出 */
  }
})
