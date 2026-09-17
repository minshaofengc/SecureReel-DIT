/**
 * 诊断包导出。
 *
 * 用户遇到问题时，原来唯一的办法是人工翻日志文件夹；这个模块把
 * 「当天（含前一日）的日志 + 版本与系统信息」打成一个 zip，一键存到
 * 用户选的位置。目标只有一个：把"教用户找文件"的来回沟通砍掉。
 *
 * 设计要点：
 *   - 内容只读，打包在系统临时目录里组装，不往用户数据目录写任何东西
 *   - 打包用系统自带的 /usr/bin/zip，走 exec.ts 的参数化调用（与所有外部命令同规）
 *   - 诊断包里只有日志与静态信息，不含任务数据库 —— 那里面可能有项目信息
 */
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { APP_NAME, APP_VERSION } from '@shared/version'
import { msg, type MsgKey } from '@shared/messages'
import type { Language } from '@shared/types'
import type { AppPaths } from '@main/paths'
import type { Logger } from '@main/logger'
import type { Store } from '@main/db/store'
import type { FfprobeRunner } from '@main/media/probe'
import { resolveExecutable, runCommand } from '@main/exec'

const ZIP_PATH = '/usr/bin/zip'
/** 打包最近几天的日志：问题常常跨半夜，只有当天的不够查 */
const LOG_DAYS = 3

export interface DiagnosticsDeps {
  paths: AppPaths
  logger: Logger
  store: Store
  probeRunner: FfprobeRunner
  /**
   * 界面语言。
   *
   * 这个模块抛出的错误会经 IPC 原样送到界面上，所以必须跟着界面语言走 ——
   * 之前这里写死了中文，英文界面下导出诊断包失败会弹出一句中文。
   * （包内的 system-info.txt 仍是中文：那是给维护者看的静态信息，不在此列。）
   */
  language: Language
}

/** 按当前界面语言取一条文案。 */
function m(deps: DiagnosticsDeps, key: MsgKey, params: Record<string, string | number> = {}): string {
  return msg(deps.language, key, params)
}

/** 生成人类可读的系统信息文本。 */
function buildSystemInfo(deps: DiagnosticsDeps): string {
  const { paths, store, probeRunner } = deps
  const lines: string[] = [
    `${APP_NAME} 诊断信息`,
    `生成时间：${new Date().toISOString()}`,
    '',
    `应用版本：${APP_VERSION}`,
    `Electron：${process.versions.electron ?? '?'}`,
    `Node：${process.versions.node ?? '?'}`,
    `系统：macOS ${systemVersion()}（${process.arch}）`,
    `主机名：${hostname()}`,
    `系统语言：${appLocale()}`,
    '',
    `数据目录：${paths.userDataDir}`,
    `日志目录：${paths.logsDir}`,
    `报告目录：${paths.reportsDir}`
  ]

  const quarantined = store.quarantined
  if (quarantined !== null) {
    lines.push(
      '',
      '数据库曾因结构不兼容被隔离留档：',
      `  原因：${quarantined.reason}`,
      `  备份：${quarantined.backupPath ?? '（留档失败，原地保留）'}`
    )
  }

  lines.push(
    '',
    `ffprobe 可用：${probeRunner.available ? '是' : '否'}`,
    `ffmpeg 可用：${probeRunner.frameToolAvailable ? '是' : '否'}`
  )
  if (!probeRunner.available && probeRunner.unavailableReason !== null) {
    lines.push(`不可用原因：${probeRunner.unavailableReason}`)
  }

  return lines.join('\n')
}

/** 系统版本号。`process.getSystemVersion` 是 Electron 专属 API，纯 Node 下兜底。 */
function systemVersion(): string {
  try {
    const p = process as NodeJS.Process & { getSystemVersion?: () => string }
    return p.getSystemVersion?.() ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function appLocale(): string {
  try {
    // process.env 在打包后的 GUI 启动下通常没有 LANG，拿不到就留空
    return process.env.LANG ?? '（未知）'
  } catch {
    return '（未知）'
  }
}

/** 列出日志目录里最近 N 天的日志文件（按文件名里的日期判断）。 */
async function recentLogFiles(logsDir: string, days: number): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(logsDir)
  } catch {
    return []
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  return entries
    .map((name) => {
      const match = /^securereel-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
      const stamp = match === null ? Number.NaN : Date.parse(`${match[1]}T00:00:00Z`)
      return { name, stamp }
    })
    .filter((item) => Number.isFinite(item.stamp) && item.stamp >= cutoff)
    .sort((a, b) => a.stamp - b.stamp)
    .map((item) => item.name)
}

/**
 * 生成诊断包 zip，返回其绝对路径。
 *
 * 每一步的失败都以带上下文的错误抛出，由 IPC 包装层统一兜底。
 */
export async function createDiagnosticsZip(destination: string, deps: DiagnosticsDeps): Promise<string> {
  const { paths, logger } = deps
  const staging = await mkdtemp(join(tmpdir(), 'securereel-diag-'))

  try {
    // 1) 最近几天的日志
    const logs = await recentLogFiles(paths.logsDir, LOG_DAYS)
    if (logs.length === 0) {
      logger.warn('diagnostics', '日志目录里没有找到近几天的日志文件，诊断包将只包含系统信息。')
    }
    for (const name of logs) {
      await cp(join(paths.logsDir, name), join(staging, name))
    }

    // 2) 系统信息
    await writeFile(join(staging, 'system-info.txt'), buildSystemInfo(deps), 'utf8')

    // 3) 打包：staging 里是平铺的文件，-j 直接归档到 zip 根
    const zipPath = await resolveExecutable(ZIP_PATH)
    if (zipPath === null) {
      throw new Error(m(deps, 'ipc.diagnosticsZipMissing'))
    }
    const staged = await readdir(staging)
    // 注意：macOS 自带的 BSD zip 不支持 `--` 结束选项符，目标路径用绝对路径传入
    const result = await runCommand(zipPath, ['-j', destination, ...staged], {
      timeoutMs: 60_000,
      cwd: staging
    })
    if (result.spawnError !== null) {
      throw new Error(m(deps, 'ipc.diagnosticsZipSpawn', { reason: result.spawnError }))
    }
    if (result.timedOut || result.code !== 0) {
      throw new Error(
        m(deps, 'ipc.diagnosticsZipFailed', {
          code: result.code ?? 0,
          reason: result.stderr.trim() || '（无输出）'
        })
      )
    }

    logger.info('diagnostics', `已导出诊断包：${destination}（含 ${logs.length} 个日志文件）`)
    return destination
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
