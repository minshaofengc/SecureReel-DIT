/**
 * 自定义协议：把报告目录里的首帧缩略图安全地喂给渲染进程。
 *
 * 为什么需要这个：渲染进程跑在沙箱里，没有文件系统访问权限。
 * 直接在界面里显示本地图片有两条路 ——
 *   1. 通过 IPC 读成 base64 data URL：一千行文件列表就是几十 MB 的字符串，
 *      内存和渲染都吃不消
 *   2. 注册一个受控的协议：浏览器原生支持 `<img src>` 懒加载，几乎零成本
 *
 * 这里走第 2 条。安全性靠三层限制：
 *   · 只接受 `securereel-frame://<任务ID>/<文件名>` 这一种形状
 *   · 任务 ID 必须通过正则校验
 *   · 文件名必须落在该任务的 frames/ 目录内（拒绝任何路径穿越）
 */
import { readFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { protocol } from 'electron'
import { jobIdSchema } from '@shared/schemas'
import { FRAME_SCHEME, parseFrameUrl } from '@shared/frames'
import type { AppPaths } from './paths'
import type { Logger } from './logger'

export { FRAME_SCHEME }

/**
 * 必须在 app ready **之前**调用。
 *
 * 把 scheme 标成 standard + secure，Chromium 才会按正常来源处理它，
 * `<img>` 也才能在没有 CSP 干涉的情况下加载。
 */
export function registerFrameScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FRAME_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false }
    }
  ])
}

/** 在 app ready 之后调用，挂上真正的处理器。 */
export function registerFrameProtocol(paths: AppPaths, logger: Logger): void {
  protocol.handle(FRAME_SCHEME, async (request) => {
    try {
      const parsed = parseFrameUrl(request.url)
      if (parsed === null) {
        return new Response('请求形状不合法', { status: 400 })
      }
      const { jobId, fileName } = parsed

      if (!jobIdSchema.safeParse(jobId).success) {
        return new Response('非法的任务 ID', { status: 400 })
      }

      // 只取基名：任何 `../`、绝对路径、子目录都会被压平
      const safeName = basename(fileName)
      if (safeName === '' || safeName !== fileName) {
        return new Response('非法的文件名', { status: 400 })
      }

      const framesDir = resolve(paths.reportsDir, jobId, 'frames')
      const target = resolve(join(framesDir, safeName))
      if (!target.startsWith(framesDir + sep)) {
        return new Response('越权访问', { status: 403 })
      }

      const bytes = await readFile(target)
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          // 缩略图在任务运行期间不会变，缓存起来避免列表滚动时反复读盘
          'cache-control': 'private, max-age=600'
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('protocol', `首帧图读取失败：${message}`)
      return new Response('未找到', { status: 404 })
    }
  })
}
