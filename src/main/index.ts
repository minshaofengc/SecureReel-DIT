/**
 * 主进程入口。
 *
 * 职责边界很清楚：**只做装配**。
 * 建窗口、装服务、注册 IPC，业务逻辑一律不在这个文件里。
 */
import { app, BrowserWindow, dialog, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, THEMES, type AppSettings } from '@shared/types'
import { APP_NAME, APP_VERSION } from '@shared/version'
import { buildAppPaths } from './paths'
import { Logger } from './logger'
import { Store } from './db/store'
import { FfprobeRunner } from './media/probe'
import { HdeAdapter } from './adapters/hde'
import { ReportStore } from './reports/report-store'
import { JobManager, TOOL_NAME } from './core/job-manager'
import { emitToWindows, registerIpcHandlers } from './ipc/handlers'
import { ensureDir } from './fs-utils'
import { registerFrameProtocol, registerFrameScheme } from './protocol'

app.setName(APP_NAME)

// 自定义协议必须在 app ready 之前登记，否则 Chromium 不会把它当成正常来源
registerFrameScheme()

// 冒烟模式下不需要真的显示窗口：在受限环境（无窗口服务器）里 show() 会让进程挂住
const smokeScreenshotPath = process.env['SECUREREEL_SMOKE_SCREENSHOT']
const smokeMode = smokeScreenshotPath !== undefined && smokeScreenshotPath !== ''
if (smokeMode) app.disableHardwareAcceleration()

let mainWindow: BrowserWindow | null = null
let logger: Logger | null = null
let store: Store | null = null

const paths = buildAppPaths(app.getPath('userData'))

function createWindow(settings: AppSettings): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: TOOL_NAME,
    // 深色模式下用竹林的深色底，避免白屏闪一下
    backgroundColor: settings.themeMode === 'dark' ? '#141a17' : '#f7f6f1',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // AGENTS.md 硬性要求：渲染进程跑在沙箱里，开启上下文隔离，关闭 Node 集成
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  // 冒烟模式：不显示窗口（在无窗口服务器的环境里 show() 会挂住），
  // 渲染完成后截一张图再退出，用于自动化验证界面确实画出来了
  if (smokeMode) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          try {
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

            // 写法：`wuguang` 或 `wuguang:dark`（只换主题时明暗不动）
            //
            // ⚠️ 主题名必须逐个比对 THEMES，不能只做字符消毒就写进去。
            // 真实踩到过：`SECUREREEL_SMOKE_THEME=$t:light` 在 zsh 里会被
            // 参数修饰符吃掉 `:l`（转小写），主题名变成 `qingheight`。
            // 一个不存在的主题名不会报任何错，只会让六套配色同时失配 ——
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
                     document.documentElement.dataset.theme = ${JSON.stringify(themeId)}
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
                       theme: document.documentElement.dataset.theme,
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
    window.once('ready-to-show', () => window.show())
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

  await Promise.all([ensureDir(paths.logsDir), ensureDir(paths.reportsDir), ensureDir(paths.hdeWorkDir)])

  logger = new Logger({ dir: paths.logsDir, mirrorToConsole: !app.isPackaged })
  logger.info('app', `${APP_NAME} 启动，版本 ${APP_VERSION}`)

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
    emit: (event) => emitToWindows(event, () => mainWindow)
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
