/**
 * 首帧缩略图的 URL 形状 —— 主进程与渲染进程共用同一份定义。
 *
 * 主进程按这个形状注册协议并校验入参，渲染进程按这个形状拼 `<img src>`。
 * 两边各写一份字符串拼装是路径穿越漏洞最常见的来源，所以只留一处。
 */

export const FRAME_SCHEME = 'securereel-frame'

/** 拼出缩略图 URL。只接受任务 ID 与纯文件名（不能含路径分隔符）。 */
export function frameUrl(jobId: string, fileName: string): string {
  return `${FRAME_SCHEME}://${jobId}/${encodeURIComponent(fileName)}`
}

export interface ParsedFrameUrl {
  jobId: string
  fileName: string
}

/** 解析缩略图 URL；形状不对返回 null。 */
export function parseFrameUrl(url: string): ParsedFrameUrl | null {
  if (!url.startsWith(`${FRAME_SCHEME}://`)) return null
  try {
    const parsed = new URL(url)
    const jobId = parsed.hostname
    const fileName = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    if (jobId === '' || fileName === '') return null
    return { jobId, fileName }
  } catch {
    return null
  }
}
