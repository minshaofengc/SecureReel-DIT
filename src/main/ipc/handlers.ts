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
import { basename, join } from 'node:path'
import type { AppInfo, EncodersInfo } from '@shared/ipc'
import { IPC } from '@shared/ipc'
import type { AppSettings, MainEvent, ProjectDetails, SourceDrive } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { msg, type MsgKey } from '@shared/messages'
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
  kvGetSchema,
  kvSetSchema,
  tailSchema,
  titleBarOverlaySchema,
  updateParentProjectSchema
} from '@shared/schemas'
import type { Store } from '@main/db/store'
import type { Logger } from '@main/logger'
import type { AppPaths } from '@main/paths'
import type { JobManager } from '@main/core/job-manager'
import type { ReportStore } from '@main/reports/report-store'
import type { FfprobeRunner } from '@main/media/probe'
import { detectEncoders } from '@main/media/encoder-probe'
import type { HdeAdapter } from '@main/adapters/hde'
import { inspectSource, scanSource } from '@main/core/source-scan'
import { describeError, describeVolume } from '@main/fs-utils'
import { ejectVolume, listVolumeEntries } from '@main/volumes'
import { TITLE_BAR_HEIGHT } from '@main/platform'
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

  /*
   * IPC 层的用户可见错误文案。
   *
   * 这里抛出的 Error 会被 `register()` 包成 `{ ok:false, error }` 原样送到界面。
   * 曾经这一层写死了九处中文 —— 英文界面下点「删除运行中的任务」会弹出一句中文，
   * 而"任务不存在。"还在 job-manager 里另有一份走消息表的实现。
   * 引擎层早已统一走消息表，这一层不能是例外。
   */
  const m = (key: MsgKey, params: Record<string, string | number> = {}): string =>
    msg(services.getSettings().language, key, params)

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
    databaseQuarantine: describeDatabaseQuarantine(store)
  }))

  /*
   * 本机可用的代理编码器。
   *
   * 探测要跑几次试编码（每次几百毫秒），所以放在这里**首次调用时**做，
   * 而不是启动时做 —— 用不到代理的人不该为此等待。结果在 encoder-probe
   * 内部按进程缓存，重复调用不会重跑。
   */
  register<EncodersInfo>(IPC.mediaEncoders, async () => {
    const ffmpeg = probeRunner.ffmpegExecutable
    if (ffmpeg === null) {
      // 没有 ffmpeg 时，除了 ProRes 什么都说不上 —— 如实回不可用
      return { h264: false, h265: false, h264Hardware: false, h265Hardware: false }
    }
    const capability = await detectEncoders(ffmpeg)
    return {
      h264: capability.h264.name !== null,
      h265: capability.h265.name !== null,
      h264Hardware: capability.h264.name !== null && capability.h264.hardware,
      h265Hardware: capability.h265.name !== null && capability.h265.hardware
    }
  })

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
    // 平台差异收在 listVolumeEntries 里：
    // macOS 读 /Volumes，Windows 枚举盘符（并用 PowerShell 补卷标）。
    // 拿不到卷标时传 null，inspectSource 会回退到盘符，列表不会因此变空。
    for (const entry of await listVolumeEntries()) {
      volumes.push(await inspectSource(entry.root, entry.label))
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
    if (description === null) throw new Error(m('ipc.pathNotVolume'))
    const result = await ejectVolume(description.mountPoint, services.getSettings().language)
    if (!result.ok) throw new Error(result.message)
    return true
  })

  /* ---------------- 窗口外观 ---------------- */

  /**
   * 同步 Windows 无边框标题栏的按钮区配色。
   *
   * 颜色是渲染层从当前主题的 CSS 变量里算出来再传过来的 —— 主进程
   * **不持有任何调色板**，这样 tokens.css 仍然是配色的唯一真源。
   * 非 Windows 平台上静默接受并返回 true，渲染层因此不需要先判断平台。
   */
  register<boolean>(IPC.windowSetTitleBar, (payload) => {
    const { color, symbolColor } = parseOrThrow<{ color: string; symbolColor: string }>(
      titleBarOverlaySchema,
      payload
    )
    const window = services.getMainWindow()
    if (window !== null && !window.isDestroyed() && process.platform === 'win32') {
      try {
        window.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_HEIGHT })
      } catch (error) {
        // 配色同步失败只影响标题栏好不好看，绝不该把主题切换本身搞挂
        services.logger.warn('window', `标题栏配色同步失败：${describeError(error)}`)
      }
    }
    return true
  })

  /* ---------------- 路径选择 ---------------- */

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
    if (job === null) throw new Error(m('job.notFound'))
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

  register(IPC.jobRetryFailed, async (payload) => {
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, payload)
    return jobManager.retryFailed(jobId)
  })

  register(IPC.jobCancel, (payload) => {
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, payload)
    return jobManager.cancel(jobId)
  })

  register(IPC.jobDelete, (payload) => {
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, payload)
    if (jobManager.isRunning(jobId)) {
      throw new Error(m('ipc.jobRunningCannotDelete'))
    }
    store.deleteJob(jobId)
    return true
  })

  register(IPC.jobRecoverable, () => store.listResumableJobs())

  // 上次任务用过的来源 / 目标 / 选项。读到就预填；读到 null 就按全新一次处理 ——
  // 预填只是便利，不能因为它自己坏了而挡住拷贝。
  register(IPC.jobLastDraft, () => store.getLastJobDraft())

  register(IPC.jobAddTarget, async (payload) => {
    const body = payload as { jobId?: unknown; path?: unknown }
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, { jobId: body?.jobId })
    const parsed = absolutePathSchema.safeParse(body?.path)
    if (!parsed.success) throw new Error(m('ipc.invalidTargetPath'))
    return jobManager.addTarget(jobId, parsed.data)
  })

  register(IPC.jobProgress, (payload) => {
    const { jobId } = parseOrThrow<{ jobId: string }>({ safeParse: idOnly }, payload)
    const job = store.getJob(jobId)
    if (job === null) throw new Error(m('job.notFound'))

    /*
     * 优先给引擎真实上报过的那一份 —— 里面有当前阶段、实时速度、剩余时间，
     * 以及"正在处理哪几个文件"（activeFiles）。
     *
     * 下面那个手拼的兜底只在任务从未跑过时才用得到：它没有任何实时信息，
     * phase 只能写 done、速度只能写 0、currentFile 只能是 null。
     * 曾经这里**只有**兜底，于是界面切走再切回来时问到的是一份
     * "看起来已经结束"的快照，与旁边正在跳的进度完全是两回事。
     */
    const live = jobManager.getProgress(jobId)
    if (live !== null) return live

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
      averageBytesPerSecond: 0,
      currentFile: null,
      activeFiles: [],
      targets: store.listTargetProgress(jobId),
      etaSeconds: null,
      etaFinishAt: null,
      speedHistory: [],
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
      throw new Error(m('ipc.parentMissing'))
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
    if (job === null) throw new Error(m('job.notFound'))
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

  // 拷贝页选中母项目时用它取"该带什么进去"：档案缺的部分由历史任务快照补上。
  // 只读不落库 —— 用户没编辑过，档案就不该变。
  register(IPC.parentRecall, (payload) => {
    const { parentProjectId } = parseOrThrow<{ parentProjectId: string }>(
      parentProjectIdOnlySchema,
      payload
    )
    const details = store.recallParentDetails(parentProjectId)
    if (details === null) throw new Error(m('ipc.parentMissing'))
    return details
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
    if (updated === null) throw new Error(m('ipc.parentMissing'))
    return updated
  })

  register(IPC.parentDelete, (payload) => {
    const { parentProjectId } = parseOrThrow<{ parentProjectId: string }>(
      parentProjectIdOnlySchema,
      payload
    )
    const project = store.getParentProject(parentProjectId)
    if (project === null) throw new Error(m('ipc.parentMissing'))
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

  /* ---------------- 通用键值 ---------------- */

  /*
   * `settings_kv` 里不属于 AppSettings 的零散状态（界面偏好等）。
   *
   * 这类状态不该混进 AppSettings（不是用户偏好、不该被"重置设置"清掉），
   * 而渲染层要能跨重启记住它，就只能落盘。
   *
   * 键名与值的长度限制在 schema 里（kvGetSchema / kvSetSchema），
   * 不在这里补 —— 校验集中在一处，才改一次就全生效。
   */
  register(IPC.kvGet, (payload) => {
    const { key } = parseOrThrow<{ key: string }>(kvGetSchema, payload ?? {})
    return store.getKv(key)
  })

  register(IPC.kvSet, (payload) => {
    const { key, value } = parseOrThrow<{ key: string; value: string }>(kvSetSchema, payload ?? {})
    store.setKv(key, value)
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
      probeRunner,
      language: services.getSettings().language
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
 * 旧数据库被隔离这件事的**结构化**描述。
 *
 * 只给事实（备份到哪了 / 有没有备份成功），**不在这里拼句子** ——
 * 界面是中英双语的，主进程拼一段中文会让英文界面下冒出一整段中文，
 * 而且拼接点散落两处时很容易出现"同一句话说了两遍"。
 * 文案一律归渲染层，主进程只负责给事实。
 */
export function describeDatabaseQuarantine(
  store: Store
): { backupPath: string | null } | null {
  const record = store.quarantined
  if (record === null) return null
  return { backupPath: record.backupPath }
}
