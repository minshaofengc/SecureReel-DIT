/**
 * 主进程 IPC 处理器。
 *
 * 三条规矩：
 *   1. 每个入参都先过 Zod（`@shared/schemas`），绝不直接使用界面传来的字符串
 *   2. 全部返回 `IpcResult` 包装，异常不会以栈信息的形式泄露到界面
 *   3. 需要推送的消息统一走 `emitEvent`，不在这里直接操作窗口
 */
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { randomBytes } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AppInfo } from '@shared/ipc'
import { IPC } from '@shared/ipc'
import type { AppSettings, MainEvent, ProjectDetails, SourceDrive } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { APP_VERSION } from '@shared/version'
import {
  absolutePathSchema,
  createJobSchema,
  createParentProjectSchema,
  jobIdSchema,
  parentProjectIdOnlySchema,
  pathPickSchema,
  projectInfoSchema,
  reportPathSchema,
  setJobParentSchema,
  settingsPatchSchema,
  tailSchema,
  updateParentProjectSchema
} from '@shared/schemas'
import type { Store } from '@main/db/store'
import type { Logger } from '@main/logger'
import type { AppPaths } from '@main/paths'
import type { JobManager } from '@main/core/job-manager'
import type { ReportStore } from '@main/reports/report-store'
import type { FfprobeRunner } from '@main/media/probe'
import type { HdeAdapter } from '@main/adapters/hde'
import { inspectSource, scanSource } from '@main/core/source-scan'
import { describeVolume, ejectVolume } from '@main/fs-utils'
import { usageForTargets } from '@main/core/source-scan'
import { createDiagnosticsZip } from '@main/diagnostics'

export interface Services {
  store: Store
  logger: Logger
  paths: AppPaths
  reportStore: ReportStore
  jobManager: JobManager
  probeRunner: FfprobeRunner
  hde: HdeAdapter
  getSettings: () => AppSettings
  saveSettings: (settings: AppSettings) => AppSettings
  getMainWindow: () => BrowserWindow | null
}

type Handler<T> = (payload: unknown) => Promise<T> | T

/** 统一的处理器包装：校验由各 handler 自己做，这里只负责错误包装。 */
function register<T>(channel: string, handler: Handler<T>): void {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      const data = await handler(payload)
      return { ok: true as const, data }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false as const, error: message }
    }
  })
}

function parseOrThrow<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } }, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success || result.data === undefined) {
    // 只把第一条校验信息交出去，不泄露架构细节
    const issues = (result.error as { issues?: { message: string }[] } | undefined)?.issues
    const first = issues?.[0]?.message ?? '输入不合法'
    throw new Error(`参数校验失败：${first}`)
  }
  return result.data
}

/**
 * 生成母项目 ID。
 *
 * 前缀分开是有意的：任务（job_）与母项目（prj_）会同时出现在日志和报告里，
 * 一眼能分清哪个是哪个，比统一用 uuid 更好排查。
 */
function newParentProjectId(): string {
  return `prj_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
}

export function registerIpcHandlers(services: Services): void {
  const { store, paths, reportStore, jobManager, probeRunner, hde, logger } = services

  /* ---------------- 应用信息 ---------------- */

  register<AppInfo>(IPC.appInfo, () => ({
    name: app.getName(),
    // 用共享常量而不是 app.getVersion()：开发模式下后者会返回 Electron 的版本号
    version: APP_VERSION,
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: process.platform,
    arch: process.arch,
    userDataDir: paths.userDataDir,
    logsDir: paths.logsDir,
    reportsDir: paths.reportsDir,
    databaseNotice: describeDatabaseNotice(store)
  }))

  /* ---------------- 设置 ---------------- */

  register<AppSettings>(IPC.settingsGet, () => store.getSettings())

  register<AppSettings>(IPC.settingsUpdate, (payload) => {
    const patch = parseOrThrow<Partial<AppSettings>>(settingsPatchSchema, payload)
    const merged: AppSettings = { ...DEFAULT_SETTINGS, ...store.getSettings(), ...patch }
    const saved = services.saveSettings(merged)
    // 用户改了 ffmpeg 目录就重新探测一次
    if ('ffmpegDir' in patch) {
      void probeRunner.refresh()
    }
    if ('arrirawHdePath' in patch) {
      void hde.status(true)
    }
    return saved
  })

  /* ---------------- 卷 ---------------- */

  register<SourceDrive[]>(IPC.volumesList, async () => {
    const volumes: SourceDrive[] = []
    try {
      const entries = await readdir('/Volumes', { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        const path = join('/Volumes', entry.name)
        volumes.push(await inspectSource(path))
      }
    } catch {
      /* /Volumes 读不到就返回空列表 */
    }
    // 允许用户直接选任意目录，因此也把家目录列出来作为入口
    volumes.push(await inspectSource(app.getPath('home')))
    return volumes
  })

  register<SourceDrive>(IPC.volumesInspect, async (payload) => {
    const { path } = parseOrThrow<{ path: string }>(reportPathSchema, payload)
    return inspectSource(path)
  })

  register(IPC.volumesScan, async (payload) => {
    const { path } = parseOrThrow<{ path: string }>(reportPathSchema, payload)
    return scanSource(path)
  })

  register(IPC.volumesUsage, async (payload) => {
    const paths2 = parseOrThrow<{ paths: string[]; requiredBytes: number | null }>(
      {
        safeParse: (value: unknown) => {
          const record = value as { paths?: unknown; requiredBytes?: unknown }
          if (!Array.isArray(record?.paths)) {
            return { success: false, error: { issues: [{ message: 'paths 必须是数组' }] } }
          }
          return {
            success: true,
            data: {
              paths: record.paths as string[],
              requiredBytes:
                typeof record.requiredBytes === 'number' ? record.requiredBytes : null
            }
          }
        }
      },
      payload
    )
    return usageForTargets(
      paths2.paths.map((path) => ({ path })),
      paths2.requiredBytes
    )
  })

  register(IPC.volumesEject, async (payload) => {
    const { path } = parseOrThrow<{ path: string }>(reportPathSchema, payload)
    const description = await describeVolume(path)
    if (description === null) throw new Error('无法识别该路径所属的卷。')
    const result = await ejectVolume(description.mountPoint)
    if (!result.ok) throw new Error(result.message)
    return true
  })

  register<string | null>(IPC.pathPick, async (payload) => {
    const { kind, title } = parseOrThrow<{ kind: 'directory' | 'file'; title?: string }>(
      pathPickSchema,
      payload
    )
    const window = services.getMainWindow()
    const options = {
      title: title ?? (kind === 'directory' ? '选择目录' : '选择文件'),
      properties: kind === 'directory' ? (['openDirectory', 'createDirectory'] as const) : (['openFile'] as const)
    }
    const result =
      window === null
        ? await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
        : await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })

  /* ---------------- 任务 ---------------- */

  register(IPC.jobCreate, async (payload) => {
    const request = parseOrThrow<Parameters<JobManager['createJob']>[0]>(createJobSchema, payload)
    return jobManager.createJob(request)
  })

  register(IPC.jobList, () => store.listJobs())

  register(IPC.jobGet, (payload) => {
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, payload)
    const job = store.getJob(jobId)
    if (job === null) throw new Error('任务不存在。')
    return job
  })

  register(IPC.jobFiles, (payload) => {
    const { jobId, limit, offset } = parseOrThrow<{ jobId: string; limit: number; offset: number }>(
      { safeParse: filesQuery },
      payload
    )
    return store.listFiles(jobId, limit, offset)
  })

  register(IPC.jobStart, async (payload) => {
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, payload)
    return jobManager.start(jobId)
  })

  register(IPC.jobPause, (payload) => {
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, payload)
    return jobManager.pause(jobId)
  })

  register(IPC.jobResume, (payload) => {
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, payload)
    return jobManager.resume(jobId)
  })

  register(IPC.jobCancel, (payload) => {
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, payload)
    return jobManager.cancel(jobId)
  })

  register(IPC.jobDelete, (payload) => {
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, payload)
    if (jobManager.isRunning(jobId)) {
      throw new Error('任务正在运行，请先取消再删除。')
    }
    store.deleteJob(jobId)
    return true
  })

  register(IPC.jobRecoverable, () => store.listResumableJobs())

  register(IPC.jobAddTarget, async (payload) => {
    const body = payload as { jobId?: unknown; path?: unknown }
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, { jobId: body?.jobId })
    const parsed = absolutePathSchema.safeParse(body?.path)
    if (!parsed.success) throw new Error('目标路径不合法。')
    return jobManager.addTarget(jobId, parsed.data)
  })

  register(IPC.jobProgress, (payload) => {
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, payload)
    const job = store.getJob(jobId)
    if (job === null) throw new Error('任务不存在。')
    return {
      jobId,
      state: job.state,
      phase: 'done' as const,
      totalFiles: job.totalFiles,
      filesDone: job.filesDone,
      filesFailed: job.filesFailed,
      totalBytes: job.totalBytes,
      bytesDone: job.bytesDone,
      bytesPerSecond: 0,
      currentFile: null,
      targets: store.listTargetProgress(jobId),
      etaSeconds: null,
      analyzeDone: 0,
      analyzeTotal: 0
    }
  })

  register(IPC.jobSetParent, (payload) => {
    const { jobId, parentProjectId } = parseOrThrow<{ jobId: string; parentProjectId: string | null }>(
      setJobParentSchema,
      payload
    )
    if (parentProjectId !== null && store.getParentProject(parentProjectId) === null) {
      throw new Error('母项目不存在。')
    }
    store.updateJob(jobId, { parentProjectId })

    // 报告里存的是母项目名的**快照**。归属变了，报告再生成时应当反映新归属，
    // 所以把快照一并更新；已经生成过的旧报告不受影响（那是当时的实况）。
    const info = store.getProjectInfo(jobId)
    if (info !== null) {
      const name = parentProjectId === null ? null : store.getParentProject(parentProjectId)?.name ?? null
      store.saveProjectInfo(jobId, { ...info, parentProjectName: name })
    }

    const job = store.getJob(jobId)
    if (job === null) throw new Error('任务不存在。')
    return job
  })

  /* ---------------- 项目信息 ---------------- */

  register(IPC.projectGet, (payload) => {
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, payload)
    return store.getProjectInfo(jobId)
  })

  register(IPC.projectSave, (payload) => {
    const body = payload as { jobId?: unknown; info?: unknown }
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, { jobId: body?.jobId })
    const info = parseOrThrow<Parameters<Store['saveProjectInfo']>[1]>(projectInfoSchema, body?.info)
    const saved = { ...info, updatedAt: new Date().toISOString() }
    store.saveProjectInfo(jobId, saved)
    return saved
  })

  register(IPC.projectTemplate, () => store.getLatestProjectTemplate())

  /* ---------------- 母项目 ---------------- */

  register(IPC.parentList, () => store.listParentProjects())

  register(IPC.parentGet, (payload) => {
    const { parentProjectId } = parseOrThrow<{ parentProjectId: string }>(
      parentProjectIdOnlySchema,
      payload
    )
    return store.getParentProject(parentProjectId)
  })

  register(IPC.parentCreate, (payload) => {
    const request = parseOrThrow<{ name: string; details: Parameters<Store['createParentProject']>[0]['details'] }>(
      createParentProjectSchema,
      payload
    )
    const now = new Date().toISOString()
    const project = {
      id: newParentProjectId(),
      name: request.name,
      details: request.details,
      createdAt: now,
      updatedAt: null
    }
    store.createParentProject(project)
    logger.info('project', `已创建母项目「${project.name}」（${project.id}）。`)
    return project
  })

  register(IPC.parentUpdate, (payload) => {
    const request = parseOrThrow<{ parentProjectId: string; name?: string; details?: ProjectDetails }>(
      updateParentProjectSchema,
      payload
    )
    const updated = store.updateParentProject(request.parentProjectId, {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.details === undefined ? {} : { details: request.details }),
      updatedAt: new Date().toISOString()
    })
    if (updated === null) throw new Error('母项目不存在。')
    return updated
  })

  register(IPC.parentDelete, (payload) => {
    const { parentProjectId } = parseOrThrow<{ parentProjectId: string }>(
      parentProjectIdOnlySchema,
      payload
    )
    const project = store.getParentProject(parentProjectId)
    if (project === null) throw new Error('母项目不存在。')
    const affected = store.countJobsByParent(parentProjectId)
    store.deleteParentProject(parentProjectId)
    logger.info(
      'project',
      `已删除母项目「${project.name}」，名下 ${affected} 个拷贝任务已移出到未分组（任务本身未删除）。`
    )
    return true
  })

  /* ---------------- 报告 ---------------- */

  register(IPC.reportsList, (payload) => {
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, payload)
    return reportStore.list(store, jobId)
  })

  register(IPC.reportsRegenerate, async (payload) => {
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, payload)
    return jobManager.generateReports(jobId)
  })

  register(IPC.reportsReveal, (payload) => {
    const { path } = parseOrThrow<{ path: string }>(reportPathSchema, payload)
    shell.showItemInFolder(path)
    return true
  })

  register(IPC.reportsOpen, async (payload) => {
    const { path } = parseOrThrow<{ path: string }>(reportPathSchema, payload)
    const error = await shell.openPath(path)
    if (error !== '') throw new Error(error)
    return true
  })

  /* ---------------- HDE ---------------- */

  register(IPC.hdeStatus, () => hde.status(true))

  register(IPC.hdeDecide, async (payload) => {
    const { path, model } = payload as { path?: unknown; model?: unknown }
    const { path: safePath } = parseOrThrow<{ path: string }>(reportPathSchema, { path })
    const scan = await scanSource(safePath)
    const declared = typeof model === 'string' ? (model as never) : 'auto'
    return hde.decide(safePath, scan, declared)
  })

  /* ---------------- 日志 ---------------- */

  register(IPC.logsTail, async (payload) => {
    const { lines } = parseOrThrow<{ lines?: number }>(tailSchema, payload ?? {})
    return services.logger.tail(lines ?? 300)
  })

  register(IPC.logsReveal, async () => {
    const error = await shell.openPath(paths.logsDir)
    if (error !== '') throw new Error(error)
    return true
  })

  register<string | null>(IPC.logsExportDiagnostics, async () => {
    const now = new Date()
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('') + '-' + [
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0')
    ].join('')
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出诊断包',
      defaultPath: join(app.getPath('documents'), `SecureReel-DIT-诊断-${stamp}.zip`),
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    })
    if (canceled || filePath === undefined) return null
    return createDiagnosticsZip(filePath, {
      paths,
      logger,
      store,
      probeRunner
    })
  })
}

/* ---------------- 轻量内联校验 ---------------- */

const idOnly = (value: unknown): { success: boolean; data?: { jobId: string }; error?: unknown } => {
  const candidate = (value as { jobId?: unknown })?.jobId
  const parsed = jobIdSchema.safeParse(candidate)
  if (!parsed.success) {
    return { success: false, error: { issues: [{ message: '任务 ID 不合法' }] } }
  }
  return { success: true, data: { jobId: parsed.data } }
}

const filesQuery = (
  value: unknown
): { success: boolean; data?: { jobId: string; limit: number; offset: number }; error?: unknown } => {
  const record = value as { jobId?: unknown; limit?: unknown; offset?: unknown }
  const parsed = jobIdSchema.safeParse(record?.jobId)
  if (!parsed.success) {
    return { success: false, error: { issues: [{ message: '任务 ID 不合法' }] } }
  }
  const limit = typeof record.limit === 'number' ? Math.min(Math.max(1, record.limit), 5000) : 500
  const offset = typeof record.offset === 'number' ? Math.max(0, record.offset) : 0
  return { success: true, data: { jobId: parsed.data, limit, offset } }
}

/** 广播事件到所有窗口。 */
export function emitToWindows(event: MainEvent, getMainWindow: () => BrowserWindow | null): void {
  const window = getMainWindow()
  if (window === null || window.isDestroyed()) return
  window.webContents.send(IPC.event, event)
}

/** 显示名：把绝对路径压成易读的卷名，仅用于日志。 */
export function shortLabel(path: string): string {
  return basename(path)
}

/**
 * 把旧数据库被隔离这件事翻译成用户能看懂的一句话。
 *
 * 刻意**不**把"缺哪些列"这类细节塞进来 —— 那是给开发者看的，
 * 会写进结构化日志。界面上堆一大串列名只会把真正重要的两件事
 * （数据没丢、备份在哪）淹掉。
 */
export function describeDatabaseNotice(store: Store): string | null {
  const record = store.quarantined
  if (record === null) return null
  const backup =
    record.backupPath === null
      ? '旧库未能备份，已原地保留'
      : `旧库已备份到 ${record.backupPath}`
  return `检测到旧版本的任务数据库，结构与当前版本不兼容。${backup}，旧数据没有被删除。已重新建立新的任务库。`
}
