/**
 * PDF 报告渲染。
 *
 * 直接复用 Electron 自带的 Chromium 打印管线（`printToPDF`），
 * 不引入 Puppeteer 之类的额外依赖 —— 那会为了一个导出功能
 * 多打包一个几十 MB 的浏览器。
 *
 * 用离屏窗口（`show: false`）渲染，用户不会看到窗口一闪而过。
 *
 * 特别处理：报告里带首帧缩略图，而缩略图是本地 `file://` 图片。
 * **打印前必须确认它们真的加载完了** —— 否则会导出一份只有空白占位框的 PDF，
 * 看起来"生成成功"，实际内容缺失。
 */
import { writeFile } from 'node:fs/promises'
import { BrowserWindow } from 'electron'
import type { Logger } from '@main/logger'

export interface PdfOptions {
  /** A4 / A3 / Letter 等 Chromium 支持的页面尺寸 */
  pageSize?: 'A4' | 'A3' | 'Letter'
  printBackground?: boolean
  landscape?: boolean
  /** 等图片加载的最长时间（毫秒） */
  imageWaitTimeoutMs?: number
}

export interface PdfRenderResult {
  ok: boolean
  /** 成功渲染出 PDF 时为文件字节数 */
  bytes: number
  /** 页面里的图片总数 */
  imageTotal: number
  /** 实际加载成功的图片数 */
  imageLoaded: number
  /** 失败原因（ok 为 false 时） */
  error: string | null
}

/**
 * 等页面里所有图片加载完成，并统计加载成功的数量。
 *
 * 用 `complete && naturalWidth > 0` 判断成功 —— 这是唯一可靠的判据，
 * `complete` 在加载失败时也会是 true。
 */
async function waitForImages(
  window: BrowserWindow,
  timeoutMs: number
): Promise<{ total: number; loaded: number }> {
  const script = `(async () => {
    const imgs = Array.from(document.images)
    if (imgs.length === 0) return { total: 0, loaded: 0 }
    const settled = Promise.all(imgs.map((img) => {
      if (img.complete) return null
      return new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true })
        img.addEventListener('error', resolve, { once: true })
      })
    }))
    await Promise.race([settled, new Promise((r) => setTimeout(r, ${Math.max(500, timeoutMs)}))])
    return {
      total: imgs.length,
      loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    }
  })()`

  const result = (await window.webContents.executeJavaScript(script, true)) as {
    total: number
    loaded: number
  }
  return result
}

/**
 * 把一个本地 HTML 文件渲染成 PDF。
 *
 * 任何失败都返回 `ok: false` 并记日志 —— 缺一个 PDF 不该让整个报告流程失败，
 * JSON 与 HTML 已经写好了。
 */
export async function renderHtmlToPdf(
  htmlPath: string,
  pdfPath: string,
  logger: Logger,
  options: PdfOptions = {}
): Promise<PdfRenderResult> {
  let window: BrowserWindow | null = null

  try {
    window = new BrowserWindow({
      show: false,
      width: 1240,
      height: 1754,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true
      }
    })

    await window.loadFile(htmlPath)

    // 先让图片加载完，再打印 —— 顺序反了就会导出空白框
    let images = { total: 0, loaded: 0 }
    try {
      images = await waitForImages(window, options.imageWaitTimeoutMs ?? 20_000)
    } catch (error) {
      logger.warn('reports', `等待图片加载时出错（继续打印）：${String(error)}`)
    }

    if (images.total > 0 && images.loaded < images.total) {
      logger.warn(
        'reports',
        `报告里有 ${images.total - images.loaded} / ${images.total} 张首帧图未能加载，PDF 中这部分会是空白。`
      )
    }

    // 给排版一点时间落定（字体、网格换行）
    await new Promise<void>((resolve) => setTimeout(resolve, 300))

    const buffer = await window.webContents.printToPDF({
      pageSize: options.pageSize ?? 'A4',
      printBackground: options.printBackground ?? true,
      landscape: options.landscape ?? false,
      // 单位是英寸；Electron 43 已移除旧的 marginsType 写法
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
    })

    await writeFile(pdfPath, buffer)
    logger.info(
      'reports',
      `PDF 已生成：${pdfPath}（${buffer.byteLength} 字节，图片 ${images.loaded}/${images.total}）`
    )

    return {
      ok: true,
      bytes: buffer.byteLength,
      imageTotal: images.total,
      imageLoaded: images.loaded,
      error: null
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn('reports', `PDF 生成失败（其余格式不受影响）：${message}`)
    return { ok: false, bytes: 0, imageTotal: 0, imageLoaded: 0, error: message }
  } finally {
    if (window !== null && !window.isDestroyed()) {
      window.destroy()
    }
  }
}
