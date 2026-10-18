import type { JobPreflightRequest } from '@shared/ipc'
import type { PreflightConfirmation, TargetPreflightResult } from '@shared/storage-safety'
import { preflightStorage, checkPreflightConfirmation } from './storage-preflight'
/**
 * 任务管理：把「扫描 → 拷贝 → 校验 → 出报告」串成一条链路。
 *
 * 这里是唯一持有运行态的地方。界面永远只是发指令 + 收事件，
 * 不直接碰引擎 —— 这样关闭窗口、切换页面都不会影响正在拷的素材。
 */
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { mkdir, stat, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  AppSettings,
  CopyJob,
  CopyJobFile,
  CopyTarget,
  JobProgress,
  MainEvent,
  ProjectInfo,
  ReportSummary,
  ReportTheme,
  ScanResult
} from '@shared/types'
import { isJobLive } from '@shared/types'
import { renderHtmlReport } from '@main/reports/html-report'
import { msg, type MsgKey } from '@shared/messages'
import { todayLocalDate } from '@shared/format'
import type { CreateJobRequest } from '@shared/ipc'
import { APP_NAME, APP_VERSION } from '@shared/version'
import { emptyProjectDraft, emptyProjectInfo } from '@shared/project'
import type { Store } from '@main/db/store'
import type { Logger } from '@main/logger'
import type { AppPaths } from '@main/paths'
import {
  describeVolume,
  isNestedPath,
  pathExists,
  safeSourceRootName,
  stripTrailingSeparators,
  walkFiles
} from '@main/fs-utils'
import { ejectVolume, scheduleShutdown } from '@main/volumes'
import { CopyEngine } from './copy-engine'
import { PauseGate } from './concurrency'
import { inspectSource, scanSource, usageForTargets } from './source-scan'
import type { FfprobeRunner } from '@main/media/probe'
import type { HdeAdapter } from '@main/adapters/hde'
import type { ReportStore } from '@main/reports/report-store'
import { renderHtmlToPdf } from '@main/reports/pdf'

export const TOOL_NAME = APP_NAME
export const TOOL_VERSION = APP_VERSION

/**
 * 防休眠的最小接口。
 *
 * 刻意不在这里直接 `import { powerSaveBlocker } from 'electron'`：
 * JobManager 是被 vitest 直接 new 出来的纯逻辑类（跑在 node 环境），
 * 模块顶层一旦 import electron，整个测试文件就起不来。
 * 真实的 powerSaveBlocker 由主进程装配层注入。
 */
export interface SleepBlocker {
  /** 开始阻止空闲挂起，返回句柄 id */
  start(): number
  stop(id: number): void
  isStarted(id: number): boolean
}

export interface JobManagerDeps {
  storagePreflight?: typeof preflightStorage
  store: Store
  logger: Logger
  paths: AppPaths
  reportStore: ReportStore
  probeRunner: FfprobeRunner
  hde: HdeAdapter
  getSettings: () => AppSettings
  emit: (event: MainEvent) => void
  /** 缺省 = 不阻止休眠（测试环境即如此） */
  sleepBlocker?: SleepBlocker
}

interface RunHandle {
  engine: CopyEngine
  gate: PauseGate
  controller: AbortController
  promise: Promise<void>
}

export class JobManager {
  private readonly starting = new Set<string>()
  private readonly finishing = new Set<string>()
  private readonly allWork = new Map<string, Promise<void>>()
  private readonly endActions = new Set<string>()
  private completionHadErrors = false
  private ending = false
  private readonly reportJobs = new Set<string>()

  get hasActiveWork(): boolean {
    return (
      this.starting.size > 0 ||
      this.runs.size > 0 ||
      this.finishing.size > 0 ||
      this.reportJobs.size > 0
    )
  }

  get canEject(): boolean {
    return !this.hasActiveWork && !this.ending
  }

  async withIdleEjection<T>(action: () => Promise<T>): Promise<T> {
    if (!this.canEject) throw new Error('任务或报告交付仍在进行，不能弹出磁盘')
    this.ending = true
    try {
      return await action()
    } finally {
      this.ending = false
      await this.performEndActions()
    }
  }

  private readonly runs = new Map<string, RunHandle>()
  /**
   * 每个运行中的任务持有一个防休眠句柄。
   *
   * 用引用计数而不是一个布尔量：多个任务可以同时在跑，谁先结束都不该
   * 把别人的防休眠关掉。暂停中的任务**不释放** —— 它随时会继续，
   * 仍属于"用户正在等待的一次交付"。
   */
  private readonly sleepBlockers = new Map<string, number>()
  /**
   * 每个任务最近一次上报的进度快照。
   *
   * 存在的理由：`job:progress` 是**推送**，界面切到别的页面再切回来时
   * 手上什么都没有，只能主动来问一次。此前那个问的接口是手拼的静态快照
   * （phase 恒为 done、速度恒为 0、currentFile 恒为 null），问到的结果
   * 与界面上正在看的实时进度完全是两回事。这里存下引擎的真话，
   * 让"问一次"和"等推送"拿到同一个东西。
   */
  private readonly latestProgress = new Map<string, JobProgress>()

  constructor(private readonly deps: JobManagerDeps) {}

  /**
   * 任务开跑时阻止系统进入空闲挂起。
   *
   * 用 `prevent-app-suspension` 而不是 `prevent-display-sleep`：长拷贝动辄
   * 几小时，屏幕该黑就黑，我们要保的是"数据一直在流"以及应用不被
   * macOS 的 App Nap 降频。
   *
   * 崩溃或强制退出时**不需要任何清理代码**：这是进程级的 OS 断言
   * （macOS 走 IOPMAssertion），进程消失即被系统回收，不存在跨进程残留。
   * 唯一要守的是同一进程内 acquire / release 配对。
   */
  private acquireSleepBlocker(jobId: string): void {
    const blocker = this.deps.sleepBlocker
    if (blocker === undefined || this.sleepBlockers.has(jobId)) return
    this.sleepBlockers.set(jobId, blocker.start())
  }

  private releaseSleepBlocker(jobId: string): void {
    const blocker = this.deps.sleepBlocker
    const id = this.sleepBlockers.get(jobId)
    if (blocker === undefined || id === undefined) return
    this.sleepBlockers.delete(jobId)
    if (blocker.isStarted(id)) blocker.stop(id)
  }

  /** 按当前设置的语言取引擎文案。 */
  private m(key: MsgKey, params: Record<string, string | number> = {}): string {
    return msg(this.deps.getSettings().language, key, params)
  }

  isRunning(jobId: string): boolean {
    return (
      this.starting.has(jobId) ||
      this.runs.has(jobId) ||
      this.finishing.has(jobId) ||
      this.reportJobs.has(jobId)
    )
  }

  /**
   * 某个任务最近一次上报的进度快照；这个任务从未跑过时为 null。
   *
   * 任务不在跑时，缓存里留的仍是最后一拍（phase 为 done、activeFiles 已清空）——
   * 那比凭空拼一个"看起来已经结束"的对象诚实得多。
   */
  getProgress(jobId: string): JobProgress | null {
    return this.latestProgress.get(jobId) ?? null
  }

  async preflight(request: JobPreflightRequest): Promise<TargetPreflightResult> {
    const scan = await scanSource(request.sourcePath)
    return (this.deps.storagePreflight ?? preflightStorage)({
      sourcePath: request.sourcePath,
      targets: request.targets.map((item) => item.path),
      mode: request.mode,
      requiredBytes: scan.totalBytes,
      proxyEnabled: request.proxyEnabled
    })
  }

  private async validateJobSafety(
    job: CopyJob,
    confirmation?: PreflightConfirmation
  ): Promise<void> {
    const evidence = await (this.deps.storagePreflight ?? preflightStorage)({
      sourcePath: job.sourcePath,
      targets: job.targets.filter((t) => t.enabled).map((t) => t.path),
      requiredBytes: job.totalBytes,
      mode: job.mode,
      proxyEnabled: job.proxyEnabled
    })
    const accepted = confirmation ?? this.deps.store.getJobSafetyConfirmation(job.id)
    checkPreflightConfirmation(evidence, accepted)
    this.deps.store.saveJobSafety(job.id, evidence, accepted)
    job.backupSafety = evidence
  }

  /** 任务开始前补加一个目标盘。已开跑的任务不允许改，避免中途改变语义。 */
  async addTarget(
    jobId: string,
    rawTargetPath: string,
    confirmation?: PreflightConfirmation
  ): Promise<CopyTarget[]> {
    const { store } = this.deps
    const targetPath = stripTrailingSeparators(rawTargetPath)
    if (this.isRunning(jobId)) {
      throw new Error(this.m('job.addTargetWhileRunning'))
    }
    this.starting.add(jobId)
    try {
      const job = store.getJob(jobId)
      if (job === null) throw new Error(this.m('job.notFound'))
      if (job.targets.length >= 8) throw new Error(this.m('job.maxTargets'))
      if (job.targets.some((target) => target.path === targetPath)) {
        throw new Error(this.m('job.targetAlreadyInList'))
      }
      if (await isNestedPath(targetPath, job.sourcePath)) {
        throw new Error(this.m('job.nestedPathShort'))
      }

      if (job.state !== 'draft' && job.state !== 'paused')
        throw new Error('只有尚未运行的草稿或已暂停任务可增加目标')
      const evidence = await this.preflight({
        sourcePath: job.sourcePath,
        targets: [...job.targets.map((t) => ({ path: t.path })), { path: targetPath }],
        mode: job.mode,
        proxyEnabled: job.proxyEnabled
      })
      checkPreflightConfirmation(evidence, confirmation)

      const description = await describeVolume(targetPath)
      const usage = await usageForTargets([{ path: targetPath }], job.totalBytes)
      const target: CopyTarget = {
        id: `tgt_${String(job.targets.length + 1).padStart(2, '0')}_${randomBytes(3).toString('hex')}`,
        path: targetPath,
        label: description?.label ?? basename(targetPath),
        enabled: true,
        freeBytes: usage[0]?.freeBytes ?? null,
        writable: true
      }
      const current = store.getJob(jobId)
      if (!current || current.state !== job.state || current.targets.length !== job.targets.length)
        throw new Error('任务状态已变化，请重新预检')
      store.addTarget(jobId, target)
      store.saveJobSafety(jobId, evidence, confirmation)
      return store.listTargets(jobId)
    } finally {
      this.starting.delete(jobId)
    }
  }

  runningJobIds(): string[] {
    return [...new Set([...this.runs.keys(), ...this.finishing, ...this.reportJobs])]
  }

  /* ---------------------------------------------------------------- *
   * 创建
   * ---------------------------------------------------------------- */

  async createJob(request: CreateJobRequest): Promise<{ job: CopyJob; scan: ScanResult }> {
    const settings = this.deps.getSettings()
    const { store, logger } = this.deps
    const verifyOnly = request.mode === 'verify'

    // 界面上的路径是可手输的文本框，从访达/终端粘贴常带尾斜杠。
    // 在这里统一归口，保证落库的路径只有一种写法 —— 否则扫描出来的
    // 相对路径会与后续拼接用的根路径对不上，表现为"每个文件都读不到源"。
    const sourcePath = stripTrailingSeparators(request.sourcePath)

    if (!(await pathExists(sourcePath))) {
      throw new Error(this.m('job.sourceMissing', { path: sourcePath }))
    }

    const scan = await scanSource(sourcePath)
    if (scan.fileCount === 0) {
      throw new Error(this.m('job.sourceEmpty'))
    }

    const safety = await (this.deps.storagePreflight ?? preflightStorage)({
      sourcePath,
      targets: request.targets.map((target) => stripTrailingSeparators(target.path)),
      mode: verifyOnly ? 'verify' : 'copy',
      requiredBytes: scan.totalBytes,
      proxyEnabled: !verifyOnly && (request.proxyEnabled ?? settings.proxyEnabled)
    })
    checkPreflightConfirmation(safety, request.preflightConfirmation)

    // 目标校验：存在；拷贝模式还要求可写、不与源相互嵌套
    const targets: CopyTarget[] = []
    for (const [index, item] of request.targets.entries()) {
      const targetPath = stripTrailingSeparators(item.path)

      if (await isNestedPath(targetPath, sourcePath)) {
        throw new Error(this.m('job.nestedPath', { path: targetPath }))
      }

      // 同卷限制只针对拷贝：拷贝的意义在于产生跨盘副本。
      // 仅校验时源与目标在同一个卷上是合理场景（复核本机上的副本），放行。
      const sourceDevice = await describeVolume(sourcePath)
      const targetDevice = await describeVolume(targetPath)
      if (
        !verifyOnly &&
        sourceDevice !== null &&
        targetDevice !== null &&
        sourceDevice.device === targetDevice.device &&
        sourceDevice.mountPoint === targetDevice.mountPoint
      ) {
        throw new Error(this.m('job.sameVolume', { path: targetPath }))
      }

      if (verifyOnly) {
        // 仅校验不写目标盘：目标必须已存在，绝不替用户创建目录
        let info
        try {
          info = await stat(targetPath)
        } catch {
          throw new Error(this.m('job.verifyTargetMissing', { path: targetPath }))
        }
        if (!info.isDirectory()) {
          throw new Error(this.m('job.targetNotDirectory', { path: targetPath }))
        }
      } else {
        try {
          await mkdir(targetPath, { recursive: true })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(this.m('job.targetNotWritable', { path: targetPath, reason: message }))
        }
      }

      const usage = await usageForTargets([{ path: targetPath }], scan.totalBytes)
      const info = usage[0]
      const label = info?.label ?? basename(targetPath)

      if (!verifyOnly && info?.sufficient === false) {
        logger.warn(
          'job',
          this.m('job.spaceWarning', {
            label,
            free: info.freeBytes ?? 0,
            total: scan.totalBytes
          })
        )
      }

      targets.push({
        id: `tgt_${String(index + 1).padStart(2, '0')}_${randomBytes(3).toString('hex')}`,
        path: targetPath,
        label,
        enabled: true,
        freeBytes: info?.freeBytes ?? null,
        writable: !verifyOnly
      })
    }

    const sourceInfo = await inspectSource(sourcePath)
    const jobId = `job_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`

    const parent = request.parentProjectId ?? null
    const parentProject = parent === null ? null : store.getParentProject(parent)
    if (parent !== null && parentProject === null) {
      throw new Error(this.m('job.parentMissing'))
    }

    const job: CopyJob = {
      id: jobId,
      backupSafety: safety,
      name: request.name,
      mode: verifyOnly ? 'verify' : 'copy',
      sourcePath,
      // 目标盘上为这个来源目录保留一层同名文件夹。见 CopyJob.sourceRootName 的说明：
      // walkFiles 的相对路径不含"用户选中的那一层"，不补回来的话，
      // 选卡内子文件夹时目标盘上会平白少一层，文件全摊在盘根。
      sourceRootName: safeSourceRootName(sourcePath),
      sourceKind: scan.kind,
      isCodExVfs: scan.isCodExVfs,
      parentProjectId: parent,
      targets,
      hashAlgorithm: request.hashAlgorithm ?? settings.hashAlgorithm,
      manifestFormat: request.manifestFormat ?? settings.manifestFormat,
      verifyAfterWrite: true,
      // 代理设置：**每任务**（拷贝页可选），缺省回落到全局设置 ——
      // 与 verifyAfterWrite 同一套"设置给默认、任务可覆盖"的模式。
      proxyEnabled: !verifyOnly && (request.proxyEnabled ?? settings.proxyEnabled),
      proxyResolution: request.proxyResolution ?? settings.proxyResolution,
      proxyCodec: request.proxyCodec ?? settings.proxyCodec,
      proxyProfile: request.proxyProfile ?? settings.proxyProfile,
      // LUT：任务里传了就用任务的（含显式 null = 不套），没传则用全局默认。
      proxyLutPath:
        request.proxyLutPath === undefined ? settings.proxyLutPath : request.proxyLutPath,
      state: 'draft',
      totalFiles: scan.fileCount,
      totalBytes: scan.totalBytes,
      filesDone: 0,
      filesFailed: 0,
      bytesDone: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      degradationNotice: null
    }

    store.insertJob(job)
    store.saveJobSafety(jobId, safety, request.preflightConfirmation)
    store.upsertFiles(
      jobId,
      scan.preview.length > 0 || scan.fileCount > 0 ? await this.collectFileList(sourcePath) : []
    )

    // 项目信息 = 项目级共享信息的**快照** + 这一张卡的属性。
    // 存快照而不是引用母项目：报告是"当时的实况记录"，
    // 母项目后来改名或换镜头，都不该改写已经出过的报告。
    const details = request.project ?? emptyProjectDraft()
    const plain: ProjectInfo = {
      projectName: details.projectName,
      shootDay: details.shootDay === '' ? todayLocalDate() : details.shootDay,
      camera: details.camera,
      lenses: details.lenses,
      notes: details.notes,
      crew: details.crew,
      // 卡号留空时用来源盘的名字兜底 —— 大多数情况它就是了
      cardLabel: details.cardLabel.trim() === '' ? sourceInfo.label : details.cardLabel,
      copyNotes: details.copyNotes,
      parentProjectName: parentProject?.name ?? null,
      updatedAt: null
    }
    store.saveProjectInfo(jobId, plain)

    /*
     * 把这次填的职员与镜头记进母项目档案，下次选它就能直接带出来。
     *
     * 为什么放在这里而不是界面上：任务快照只服务这一份报告，
     * 而"这部戏的主创和镜头"是要跨很多张卡复用的 —— 用户填过一次，
     * 显然不希望下一张卡再从零开始。这是**拷贝流程的收尾动作**，
     * 所以落在创建任务的必经路径上，无论从哪个入口建任务都生效。
     *
     * 三条边界（见 `mergeTalentIntoParent`）：
     *   · 只动 lenses / crew，机型、项目名、备注、拍摄日不碰
     *   · 本次没填的项保持档案原样，绝不用空值覆盖
     *   · 没有实际变化就不写库
     * 已经出过的报告不受影响 —— 它们存的是当时的快照。
     */
    if (parent !== null) {
      const remembered = store.rememberParentTalent(parent, {
        lenses: plain.lenses,
        crew: plain.crew
      })
      if (remembered?.changed === true) {
        logger.info(
          'project',
          `已把本次填写的职员与镜头记入母项目「${remembered.project.name}」，下次选它自动带入。`
        )
      }
    }

    /*
     * 记下这次用过的来源、目标与选项，下次打开拷贝页时预填。
     * 现场常是同一张卡连拷到几块盘，每次都重新选一遍路径纯属浪费。
     * 刻意**不记任务名**：那个每次都不一样（换卡就要改），
     * 自动填一个错的比空着更烦人。
     */
    store.saveLastJobDraft({
      sourcePath,
      targetPaths: targets.map((target) => target.path),
      projectName: plain.projectName
    })

    logger.info(
      'job',
      this.m('job.created', {
        name: job.name,
        files: scan.fileCount,
        bytes: scan.totalBytes,
        targets: targets.length
      }) +
        this.m('job.createdMode', {
          mode: verifyOnly ? this.m('queueMode.verify') : this.m('queueMode.copy')
        }) +
        (parentProject === null
          ? this.m('job.createdNoParent')
          : this.m('job.createdWithParent', { name: parentProject.name }))
    )

    return { job, scan }
  }

  private async collectFileList(root: string): Promise<{ relPath: string; sizeBytes: number }[]> {
    const walk = await walkFiles(root)
    return walk.files.map((file) => ({ relPath: file.relPath, sizeBytes: file.sizeBytes }))
  }

  /* ---------------------------------------------------------------- *
   * 运行
   * ---------------------------------------------------------------- */

  async start(
    jobId: string,
    proxyOnly = false,
    confirmation?: PreflightConfirmation
  ): Promise<CopyJob> {
    const { store } = this.deps
    if (this.ending) throw new Error('正在安全弹出磁盘，请等待完成')
    const job = store.getJob(jobId)
    if (job === null) throw new Error(this.m('job.notFound'))
    if (this.isRunning(jobId)) throw new Error(this.m('job.alreadyRunning'))
    if (job.state === 'cancelled') throw new Error('已取消任务不能再次启动')
    this.starting.add(jobId)
    try {
      await this.validateJobSafety(job, confirmation)
      if (store.getJob(jobId)?.state === 'cancelled') throw new Error('任务已取消')
      const settings = this.deps.getSettings()
      const gate = new PauseGate()
      const controller = new AbortController()

      // 首尾帧先落到任务工作目录，出报告时再挑被引用的拷进修订目录
      const probeRunner = this.deps.probeRunner.fork?.() ?? this.deps.probeRunner
      const frameWorkDir = this.deps.reportStore.frameWorkDir(jobId)
      probeRunner.setFrameOutputDir(frameWorkDir)
      // 候选静帧与首尾帧同目录（报告 frames/），按设置决定每条出几张
      probeRunner.setStillFrameOutputDir(frameWorkDir)
      probeRunner.setStillFrameCount(settings.stillFrameCount)

      const engine = new CopyEngine({
        job,
        store,
        logger: this.deps.logger,
        settings,
        signal: controller.signal,
        gate,
        probeRunner,
        onLog: (level, message) => {
          this.deps.emit({
            type: 'job:log',
            payload: {
              jobId,
              entry: { at: new Date().toISOString(), level, scope: 'copy-engine', message }
            }
          })
        },
        onFileSettled: (file: CopyJobFile) => {
          this.deps.emit({ type: 'job:file', payload: { jobId, file } })
        },
        // 中间态变更（已按 200ms 合并）。与 job:file 的分工：
        // 这条只负责让界面看到"文件在动"，最终事实以 job:file 为准。
        onFilesChanged: (deltas) => {
          this.deps.emit({ type: 'job:files-delta', payload: { jobId, deltas } })
        },
        // 引擎把一批中间态改回了 pending（任务开始时的 resetInFlightFiles）。
        // 这种"往回退"界面自己发现不了，必须显式请它重拉。
        onFilesResync: () => {
          this.deps.emit({ type: 'job:files-resync', payload: { jobId } })
        },
        onProgress: (progress) => {
          // 存一份给"主动来问"的调用方（见 latestProgress 的说明）
          this.latestProgress.set(jobId, progress)
          this.deps.emit({ type: 'job:progress', payload: progress })
        }
      })

      store.updateJob(jobId, { state: 'queued' })
      this.emitState(jobId)

      // 从这一刻起不让系统空闲挂起：任务刚排进队列，用户很可能就切去干别的了，
      // 而后续几小时的拷贝全靠这台机器不要睡着。
      this.acquireSleepBlocker(jobId)

      const promise = (async (): Promise<void> => {
        let terminalState: CopyJob['state'] = 'failed'
        let beganEngine = false
        try {
          await this.validateJobSafety(job, confirmation)
          if (controller.signal.aborted) throw new Error('任务已取消')
          beganEngine = true
          const result = proxyOnly ? await engine.retryProxies() : await engine.run()
          terminalState = result.state
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.deps.logger.error('job', this.m('job.runError', { reason: message }))
          terminalState = controller.signal.aborted ? 'cancelled' : beganEngine ? 'failed' : 'paused'
          store.updateJob(jobId, { state: terminalState, finishedAt: terminalState === 'paused' ? null : new Date().toISOString() })
          this.deps.emit({ type: 'toast', payload: { level: 'warn', message } })
        } finally {
          this.finishing.add(jobId)
          this.runs.delete(jobId)
          const progress = this.latestProgress.get(jobId)
          if (progress) {
            const reporting = { ...progress, phase: 'reporting' as const }
            this.latestProgress.set(jobId, reporting)
            this.deps.emit({ type: 'job:progress', payload: reporting })
          }
          // 与 acquire 的唯一配对点：正常完成、引擎抛错、被取消都会走到这里
          this.emitState(jobId)
        }

        // 无论成功、失败还是被取消，都留一份报告 —— 失败也是取证链的一部分。
        // 例外：用户在设置里关掉了自动报告（generateReport=false），则整段跳过。
        // ⚠️ 只关"自动生成"，手动补报告仍走 generateReport()（受运行中红线约束）。
        if (terminalState === 'paused') {
          this.deps.logger.warn('job', '存储证据已改变，任务暂停并等待重新预检确认，尚未写入素材。')
        } else if (this.deps.getSettings().generateReport) {
          try {
            const report = await this.generateReports(jobId, terminalState)
            if (report.delivery?.some((item) => item.state === 'failed'))
              this.completionHadErrors = true
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.completionHadErrors = true
            this.deps.logger.error('job', this.m('job.reportGenFail', { reason: message }))
            this.deps.emit({
              type: 'toast',
              payload: { level: 'warn', message: this.m('job.reportGenFail', { reason: message }) }
            })
          }
        } else {
          this.deps.logger.info('job', '报告生成已在设置中关闭，跳过。')
        }

        if (terminalState !== 'completed') this.completionHadErrors = true
        else this.endActions.add(jobId)
        this.finishing.delete(jobId)
        this.releaseSleepBlocker(jobId)
        const finalProgress = this.latestProgress.get(jobId)
        if (finalProgress) {
          const done = { ...finalProgress, phase: 'done' as const }
          this.latestProgress.set(jobId, done)
          this.deps.emit({ type: 'job:progress', payload: done })
        }
        await this.performEndActions()
      })()

      this.runs.set(jobId, { engine, gate, controller, promise })
      this.allWork.set(jobId, promise)
      void promise.then(
        () => this.allWork.delete(jobId),
        () => this.allWork.delete(jobId)
      )

      return store.getJob(jobId) ?? job
    } finally {
      this.starting.delete(jobId)
    }
  }

  pause(jobId: string): CopyJob {
    const handle = this.runs.get(jobId)
    if (handle === undefined) throw new Error(this.m('job.notRunning'))
    handle.gate.pause()
    this.deps.store.updateJob(jobId, { state: 'paused' })
    this.emitState(jobId)
    return this.requireJob(jobId)
  }

  async resume(jobId: string, confirmation?: PreflightConfirmation): Promise<CopyJob> {
    const handle = this.runs.get(jobId)
    if (handle === undefined) return this.start(jobId, false, confirmation)
    await this.validateJobSafety(this.requireJob(jobId), confirmation)
    if (handle.controller.signal.aborted || this.runs.get(jobId) !== handle)
      throw new Error('任务状态已改变，请刷新')
    handle.gate.resume()
    this.deps.store.updateJob(jobId, { state: 'running' })
    this.emitState(jobId)
    return this.requireJob(jobId)
  }

  /**
   * 「重试失败项」：把上次失败的文件放回待处理，再按正常流程重新跑。
   *
   * 与 start() 的唯一区别在入口 —— start() 只处理 pending，失败文件刻意留在
   * 失败态等用户判断（见 Store.listPendingFiles 的注释）；这里显式重置它们。
   * 已成功的目标不会被重拷：引擎按目标盘上的成品/分片决定 adopt / 续传 / 写入。
   */
  async retryFailed(jobId: string, confirmation?: PreflightConfirmation): Promise<CopyJob> {
    const job = this.deps.store.getJob(jobId)
    if (job === null) throw new Error(this.m('job.notFound'))
    if (this.isRunning(jobId)) throw new Error(this.m('job.alreadyRunning'))
    this.starting.add(jobId)
    try {
      await this.validateJobSafety(job, confirmation)
      if (this.deps.store.getJob(jobId)?.state === 'cancelled') throw new Error('任务已取消')
      const resetCount = this.deps.store.resetFailedFilesForRetry(jobId)
      if (resetCount === 0) throw new Error(this.m('job.noFailedFiles'))
      this.deps.logger.info('job', this.m('job.retryFailed', { count: resetCount }))
      this.deps.emit({ type: 'job:files-resync', payload: { jobId } })
    } finally {
      this.starting.delete(jobId)
    }
    return this.start(jobId, false, confirmation)
  }

  async retryProxies(jobId: string, confirmation?: PreflightConfirmation): Promise<CopyJob> {
    const job = this.requireJob(jobId)
    if (job.mode === 'verify' || !job.proxyEnabled || isJobLive(job.state))
      throw new Error('该任务不能重试代理')
    return this.start(jobId, true, confirmation)
  }

  cancel(jobId: string): CopyJob {
    if (this.finishing.has(jobId) || this.reportJobs.has(jobId))
      throw new Error('报告交付处理中，请等待完成')
    const handle = this.runs.get(jobId)
    if (handle === undefined) {
      // 没在运行也要把状态修正，避免界面卡在"运行中"。
      // 顺带释放防休眠：正常路径下它早该被 finally 收掉了，
      // 这里只是防御 —— 万一某条异常路径漏了配对，也别让机器一直醒着。
      this.deps.store.updateJob(jobId, { state: 'cancelled', finishedAt: new Date().toISOString() })
      this.releaseSleepBlocker(jobId)
      this.emitState(jobId)
      return this.requireJob(jobId)
    }
    handle.engine.cancel()
    handle.controller.abort()
    this.deps.store.updateJob(jobId, { state: 'cancelled' })
    this.emitState(jobId)
    return this.requireJob(jobId)
  }

  /** 等待某个任务彻底结束（含报告生成）。主要给自动化测试用。 */
  async wait(jobId: string): Promise<void> {
    await this.allWork.get(jobId)
  }

  private requireJob(jobId: string): CopyJob {
    const job = this.deps.store.getJob(jobId)
    if (job === null) throw new Error(this.m('job.notFound'))
    return job
  }

  private emitState(jobId: string): void {
    const job = this.deps.store.getJob(jobId)
    if (job === null) return
    this.deps.emit({ type: 'job:state', payload: { jobId, state: job.state } })
  }

  /* ---------------------------------------------------------------- *
   * 报告
   * ---------------------------------------------------------------- */

  async previewReport(jobId: string, theme: ReportTheme): Promise<string> {
    if (this.ending) throw new Error('正在安全弹出磁盘，请等待完成')
    const { store } = this.deps
    const job = this.requireJob(jobId)
    if (
      this.runs.has(jobId) ||
      this.finishing.has(jobId) ||
      this.reportJobs.has(jobId) ||
      isJobLive(job.state)
    )
      throw new Error(this.m('job.reportWhileRunning'))
    this.reportJobs.add(jobId)
    try {
      const project = store.getProjectInfo(jobId) ?? emptyProjectInfo()
      const targets = store.listTargetProgress(jobId)
      const description = await describeVolume(job.sourcePath)
      const summary: ReportSummary = {
        backupSafety: job.backupSafety,
        theme,
        jobId,
        jobName: job.name,
        revision: '预览',
        createdAt: new Date().toISOString(),
        jobState: job.state,
        sourcePath: job.sourcePath,
        sourceLabel: description?.label ?? basename(job.sourcePath),
        hashAlgorithm: job.hashAlgorithm,
        manifestFormat: job.manifestFormat,
        totalFiles: job.totalFiles,
        totalBytes: job.totalBytes,
        verifiedFiles: job.filesDone,
        failedFiles: job.filesFailed,
        durationSeconds:
          job.startedAt === null || job.finishedAt === null
            ? null
            : Math.max(0, (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000),
        targets: targets.map((target) => ({
          targetId: target.targetId,
          label: target.label,
          path: job.targets.find((item) => item.id === target.targetId)?.path ?? '',
          filesCopied: target.filesDone,
          filesFailed: target.filesFailed,
          bytesCopied: target.bytesCopied
        })),
        project
      }
      let html = await renderHtmlReport({
        summary,
        theme,
        job,
        project,
        targets,
        totalFiles: job.totalFiles,
        files: store.iterateFiles(jobId),
        fileRowLimit: 2000,
        hostname: hostname(),
        toolName: TOOL_NAME,
        toolVersion: TOOL_VERSION,
        manifestPaths: [],
        notes: ['此为报告预览，未生成修订，未写入目标盘。']
      })
      let budget = 16 * 1024 * 1024
      for (const match of [...html.matchAll(/src="frames\/([^"]+)"/g)]) {
        try {
          const frame = await readFile(
            join(this.deps.reportStore.frameWorkDir(jobId), basename(match[1]!))
          )
          if (frame.length > budget) continue
          budget -= frame.length
          html = html.replace(match[0], `src="data:image/jpeg;base64,${frame.toString('base64')}"`)
        } catch {
          /* Preview remains usable when a historical frame is missing. */
        }
      }
      return html
    } finally {
      this.reportJobs.delete(jobId)
      await this.performEndActions()
    }
  }

  async generateReports(
    jobId: string,
    terminalState?: CopyJob['state'],
    theme?: ReportTheme
  ): Promise<ReportSummary> {
    if (this.ending) throw new Error('正在安全弹出磁盘，请等待完成')
    const { store, reportStore, logger } = this.deps
    const job = store.getJob(jobId)
    if (job === null) throw new Error(this.m('job.notFound'))

    /*
     * 任务运行中不许生成报告。
     *
     * 三条理由，从轻到重：
     *   1. 报告会缺数据。中途那一眼看到的是"跑了一半的实况"，不是结果。
     *   2. 会撞上任务结束后 JobManager 自己出的那一份：两份并发各取一次修订号，
     *      后到的那个会被"修订目录已存在"的守卫中止，用户平白看到一条生成失败。
     *   3. 最要命的是重复处理。写报告**曾经**顺带把 copying / verifying 的行
     *      归零成 pending，引擎下一批就把同一批文件再处理一遍 ——
     *      filesDone 可能超过 totalFiles，两个线程同时提交同一个分片时
     *      还会让健康盘被误判隔离。
     *
     * 第 3 条的根因（归零那一步）已经从 report-store 里删掉，这里再兜一道闸，
     * 让"运行中生成报告"在语义上不可能发生 —— 界面上的按钮也会相应禁用。
     */
    if (
      this.runs.has(jobId) ||
      this.reportJobs.has(jobId) ||
      (terminalState === undefined && (this.finishing.has(jobId) || isJobLive(job.state)))
    ) {
      throw new Error(this.m('job.reportWhileRunning'))
    }

    this.reportJobs.add(jobId)
    try {
      const project = store.getProjectInfo(jobId) ?? emptyProjectInfo()

      const sourceDescription = await describeVolume(job.sourcePath)
      const sourceLabel = sourceDescription?.label ?? basename(job.sourcePath)

      const state = terminalState ?? job.state
      const completedCleanly = state === 'completed' || state === 'completed-with-errors'

      /*
       * 附注必须在报告**渲染之前**交进去。
       *
       * 报告是先渲染再落盘的，渲染之后往哪儿 push 都进不去 —— 这里曾经拿 writeRevision
       * 返回的 extraNotes 数组 push 了四条说明，然后整个数组被丢弃，
       * 于是报告的「执行说明」一节基本是空的，其中"这是仅校验任务的报告"
       * 这条尤其要紧：拿到报告的人分不清它是复核记录还是拷贝交付。
       */
      const preNotes: string[] = []
      if (!completedCleanly) {
        preNotes.push(this.m('job.reportNotCleanNote', { state }))
      }
      if (job.mode === 'verify') {
        preNotes.push(this.m('job.verifyModeNote'))
      }

      const { revision } = await reportStore.writeRevision({
        job: terminalState === undefined ? job : { ...job, state: terminalState },
        theme: theme ?? this.deps.getSettings().reportTheme,
        project,
        store,
        sourceLabel,
        targets: job.targets,
        hostname: hostname(),
        toolName: TOOL_NAME,
        toolVersion: TOOL_VERSION,
        now: new Date(),
        // 只有正常跑完的拷贝任务才往目标盘写清单；取消/失败的任务清单并不代表
        // 一份可信的交付。仅校验模式按定义不写目标盘的任何字节，清单同样不写。
        writeManifestToTargets: completedCleanly && job.mode !== 'verify',
        preNotes,
        // 报告根目录覆盖：null 表示用默认的本机 reports 目录
        outputBaseDir: this.deps.getSettings().reportOutputDir
      })

      /*
       * 下面两条只有等报告渲染完才知道，赶不上「执行说明」那一节。
       *
       * 刻意**不**为此把报告再渲染一遍：报告目录里的两份产物（report.html 与
       * report.json）必须一致，补写就等于重写 HTML、并把 report.json 的逐文件
       * 记录整体再流一遍 —— 十万条素材的任务为此多跑一遍全量查询，
       * 代价与收益不成比例。
       * 所以它们改成写日志 + 界面提示：信息没丢，只是不落在交付物里。
       */

      // PDF 需要 Chromium，失败也不影响 JSON / HTML
      const htmlPath = revision.files.html
      if (htmlPath !== undefined) {
        const pdfPath = join(revision.dir, 'report.pdf')
        const pdf = await renderHtmlToPdf(htmlPath, pdfPath, logger)
        if (pdf.ok) {
          reportStore.attachPdf(store, jobId, revision.revision, pdfPath)
        }
        if (pdf.ok && pdf.imageTotal > 0 && pdf.imageLoaded < pdf.imageTotal) {
          const missing = pdf.imageTotal - pdf.imageLoaded
          const message = this.m('job.pdfMissingFrames', { missing, total: pdf.imageTotal })
          logger.warn('job', message)
          this.deps.emit({ type: 'toast', payload: { level: 'warn', message } })
        }

        // PDF 生成完才内联首帧图：内联后的单文件 HTML 不再依赖 frames/ 目录，
        // 单独发出去也能看到画面。超出预算未内联的图保留相对路径引用。
        try {
          const { inlined, skipped } = await reportStore.inlineReportFrames(revision)
          if (inlined > 0) {
            logger.info('job', `已将 ${inlined} 张首帧图内联进 HTML 报告（单文件自包含）。`)
          }
          if (skipped > 0) {
            const message = this.m('job.inlineSkippedNote', { count: skipped })
            logger.warn('job', message)
            this.deps.emit({ type: 'toast', payload: { level: 'warn', message } })
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger.warn('job', `首帧图内联失败（报告仍可用）：${message}`)
        }
      }

      /*
       * 最后一步：把整份修订复制到各目标盘。
       *
       * 必须放在这里 —— 要等 PDF 生成与首帧内联都做完，盘上那一份才是完整的
       * 单文件报告。复制失败只记日志与提示，绝不让它把已经成功的拷贝任务
       * 变成一次"失败"（它只是交付便利，不是交付本身）。
       */
      const delivery: NonNullable<ReportSummary['delivery']> = []
      const publishRevision =
        store.listReports(jobId).find((item) => item.revision === revision.revision) ?? revision
      try {
        const result = await reportStore.publishToTargets({
          job,
          revision: publishRevision,
          targets: job.targets,
          hostname: hostname(),
          toolName: TOOL_NAME,
          toolVersion: TOOL_VERSION,
          now: new Date()
        })
        if (job.mode !== 'verify') delivery.push(...result.deliveries)
        if (result.published.length > 0) {
          logger.info(
            'job',
            this.m('job.reportPublished', { targets: result.published.join('、') })
          )
        }
        for (const item of result.failed) {
          const message = this.m('job.reportPublishFail', {
            label: item.label,
            reason: item.reason
          })
          logger.warn('job', message)
          this.deps.emit({ type: 'toast', payload: { level: 'warn', message } })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('job', `报告复制到目标盘失败（本机报告已生成）：${message}`)
        if (job.mode !== 'verify')
          delivery.push(
            ...job.targets
              .filter((target) => target.enabled)
              .map((target) => ({
                targetId: target.id,
                label: target.label,
                state: 'failed' as const,
                reason: message
              }))
          )
      }

      store.updateReportDelivery(jobId, revision.revision, delivery)
      this.deps.emit({ type: 'reports:changed', payload: { jobId } })
      return { ...revision.summary, delivery }
    } finally {
      this.reportJobs.delete(jobId)
      await this.performEndActions()
    }
  }

  private async performEndActions(): Promise<void> {
    if (this.ending) return
    if (!this.hasActiveWork) {
      this.ending = true
      try {
        const settings = this.deps.getSettings()
        const ejected = new Set<string>()
        const ids = [...this.endActions]
        this.endActions.clear()
        if (settings.ejectAfterCopy)
          for (const id of ids) {
            if (this.hasActiveWork) break
            const finished = this.deps.store.getJob(id)
            if (finished && !(await this.ejectTargets(finished, ejected)))
              this.completionHadErrors = true
          }
        if (
          !this.hasActiveWork &&
          !this.completionHadErrors &&
          ids.length > 0 &&
          settings.shutdownAfterCopy
        )
          await this.scheduleShutdown()
        this.completionHadErrors = false
      } finally {
        this.ending = false
      }
    }
  }

  private async ejectTargets(job: CopyJob, ejected: Set<string>): Promise<boolean> {
    let ok = true
    for (const target of job.targets) {
      if (!target.enabled) continue
      const description = await describeVolume(target.path)
      if (description === null || ejected.has(description.mountPoint)) continue
      ejected.add(description.mountPoint)
      const result = await ejectVolume(description.mountPoint, this.deps.getSettings().language)
      if (result.ok) {
        this.deps.logger.info('job', this.m('job.ejected', { label: target.label }))
      } else {
        ok = false
        this.deps.logger.warn(
          'job',
          this.m('job.ejectFail', { label: target.label, reason: result.message })
        )
      }
    }
    return ok
  }

  /**
   * 任务成功后安排关机。
   *
   * 调用点已经保证了两件事：只在本任务**干净完成**时走到这里，且排在
   * 目标盘弹出**之后**（先卸载再断电）。这里再补一层：无论成功失败都写日志，
   * 失败只提示不重试 —— 关不掉机器是小事，谎报"已关机"让人白等一晚才是大事。
   */
  private async scheduleShutdown(): Promise<void> {
    const result = await scheduleShutdown(this.deps.getSettings().language)
    if (result.ok) {
      this.deps.logger.info('job', this.m('job.shutdownScheduled'))
      this.deps.emit({
        type: 'toast',
        payload: { level: 'info', message: this.m('job.shutdownScheduled') }
      })
    } else {
      this.deps.logger.warn('job', this.m('job.shutdownFail', { reason: result.message }))
      this.deps.emit({
        type: 'toast',
        payload: { level: 'warn', message: this.m('job.shutdownFail', { reason: result.message }) }
      })
    }
  }
}
