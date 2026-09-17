/**
 * 任务管理：把「扫描 → 拷贝 → 校验 → 出报告」串成一条链路。
 *
 * 这里是唯一持有运行态的地方。界面永远只是发指令 + 收事件，
 * 不直接碰引擎 —— 这样关闭窗口、切换页面都不会影响正在拷的素材。
 */
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AppSettings, CopyJob, CopyJobFile, CopyTarget, MainEvent, ProjectInfo, ReportSummary, ScanResult } from '@shared/types'
import { msg, type MsgKey } from '@shared/messages'
import type { CreateJobRequest } from '@shared/ipc'
import { APP_NAME, APP_VERSION } from '@shared/version'
import { emptyProjectDraft, emptyProjectInfo } from '@shared/project'
import type { Store } from '@main/db/store'
import type { Logger } from '@main/logger'
import type { AppPaths } from '@main/paths'
import {
  describeVolume,
  ejectVolume,
  isNestedPath,
  pathExists,
  stripTrailingSeparators,
  walkFiles
} from '@main/fs-utils'
import { CopyEngine } from './copy-engine'
import { PauseGate } from './concurrency'
import { inspectSource, scanSource, usageForTargets } from './source-scan'
import type { FfprobeRunner } from '@main/media/probe'
import type { HdeAdapter } from '@main/adapters/hde'
import type { ReportStore } from '@main/reports/report-store'
import { renderHtmlToPdf } from '@main/reports/pdf'

export const TOOL_NAME = APP_NAME
export const TOOL_VERSION = APP_VERSION

export interface JobManagerDeps {
  store: Store
  logger: Logger
  paths: AppPaths
  reportStore: ReportStore
  probeRunner: FfprobeRunner
  hde: HdeAdapter
  getSettings: () => AppSettings
  emit: (event: MainEvent) => void
}

interface RunHandle {
  engine: CopyEngine
  gate: PauseGate
  controller: AbortController
  promise: Promise<void>
}

export class JobManager {
  private readonly runs = new Map<string, RunHandle>()

  constructor(private readonly deps: JobManagerDeps) {}

  /** 按当前设置的语言取引擎文案。 */
  private m(key: MsgKey, params: Record<string, string | number> = {}): string {
    return msg(this.deps.getSettings().language, key, params)
  }

  isRunning(jobId: string): boolean {
    return this.runs.has(jobId)
  }

  /** 任务开始前补加一个目标盘。已开跑的任务不允许改，避免中途改变语义。 */
  async addTarget(jobId: string, rawTargetPath: string): Promise<CopyTarget[]> {
    const { store } = this.deps
    const targetPath = stripTrailingSeparators(rawTargetPath)
    if (this.runs.has(jobId)) {
      throw new Error(this.m('job.addTargetWhileRunning'))
    }
    const job = store.getJob(jobId)
    if (job === null) throw new Error(this.m('job.notFound'))
    if (job.targets.length >= 8) throw new Error(this.m('job.maxTargets'))
    if (job.targets.some((target) => target.path === targetPath)) {
      throw new Error(this.m('job.targetAlreadyInList'))
    }
    if (await isNestedPath(targetPath, job.sourcePath)) {
      throw new Error(this.m('job.nestedPathShort'))
    }

    await mkdir(targetPath, { recursive: true })

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
    store.addTarget(jobId, target)
    return store.listTargets(jobId)
  }

  runningJobIds(): string[] {
    return [...this.runs.keys()]
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
      name: request.name,
      mode: verifyOnly ? 'verify' : 'copy',
      sourcePath,
      sourceKind: scan.kind,
      isCodExVfs: scan.isCodExVfs,
      parentProjectId: parent,
      targets,
      hashAlgorithm: request.hashAlgorithm ?? settings.hashAlgorithm,
      manifestFormat: request.manifestFormat ?? settings.manifestFormat,
      verifyAfterWrite: request.verifyAfterWrite ?? settings.verifyAfterWrite,
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
    store.upsertFiles(
      jobId,
      scan.preview.length > 0 || scan.fileCount > 0
        ? await this.collectFileList(sourcePath)
        : []
    )

    // 项目信息 = 项目级共享信息的**快照** + 这一张卡的属性。
    // 存快照而不是引用母项目：报告是"当时的实况记录"，
    // 母项目后来改名或换镜头，都不该改写已经出过的报告。
    const details = request.project ?? emptyProjectDraft()
    const plain: ProjectInfo = {
      projectName: details.projectName,
      shootDay: details.shootDay === '' ? new Date().toISOString().slice(0, 10) : details.shootDay,
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

    logger.info(
      'job',
      this.m('job.created', {
        name: job.name,
        files: scan.fileCount,
        bytes: scan.totalBytes,
        targets: targets.length
      }) +
        this.m('job.createdMode', { mode: verifyOnly ? this.m('queueMode.verify') : this.m('queueMode.copy') }) +
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

  async start(jobId: string): Promise<CopyJob> {
    const { store } = this.deps
    const job = store.getJob(jobId)
    if (job === null) throw new Error(this.m('job.notFound'))
    if (this.runs.has(jobId)) throw new Error(this.m('job.alreadyRunning'))

    const settings = this.deps.getSettings()
    const gate = new PauseGate()
    const controller = new AbortController()

    // 首尾帧先落到任务工作目录，出报告时再挑被引用的拷进修订目录
    this.deps.probeRunner.setFrameOutputDir(this.deps.reportStore.frameWorkDir(jobId))

    const engine = new CopyEngine({
      job,
      store,
      logger: this.deps.logger,
      settings,
      signal: controller.signal,
      gate,
      probeRunner: this.deps.probeRunner,
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
      onProgress: (progress) => {
        this.deps.emit({ type: 'job:progress', payload: progress })
      }
    })

    store.updateJob(jobId, { state: 'queued' })
    this.emitState(jobId)

    const promise = (async (): Promise<void> => {
      let terminalState: CopyJob['state'] = 'failed'
      try {
        const result = await engine.run()
        terminalState = result.state
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.deps.logger.error('job', this.m('job.runError', { reason: message }))
        store.updateJob(jobId, { state: 'failed', finishedAt: new Date().toISOString() })
        terminalState = 'failed'
      } finally {
        this.runs.delete(jobId)
        this.emitState(jobId)
      }

      // 无论成功、失败还是被取消，都留一份报告 —— 失败也是取证链的一部分
      try {
        await this.generateReports(jobId, terminalState)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.deps.logger.error('job', this.m('job.reportGenFail', { reason: message }))
        this.deps.emit({
          type: 'toast',
          payload: { level: 'warn', message: this.m('job.reportGenFail', { reason: message }) }
        })
      }

      if (terminalState === 'completed' || terminalState === 'completed-with-errors') {
        const current = store.getJob(jobId)
        if (current !== null && this.deps.getSettings().ejectAfterCopy) {
          await this.ejectTargets(current)
        }
      }
    })()

    this.runs.set(jobId, { engine, gate, controller, promise })

    return store.getJob(jobId) ?? job
  }

  pause(jobId: string): CopyJob {
    const handle = this.runs.get(jobId)
    if (handle === undefined) throw new Error(this.m('job.notRunning'))
    handle.gate.pause()
    this.deps.store.updateJob(jobId, { state: 'paused' })
    this.emitState(jobId)
    return this.requireJob(jobId)
  }

  resume(jobId: string): CopyJob {
    const handle = this.runs.get(jobId)
    if (handle === undefined) throw new Error(this.m('job.notRunning'))
    handle.gate.resume()
    this.deps.store.updateJob(jobId, { state: 'running' })
    this.emitState(jobId)
    return this.requireJob(jobId)
  }

  cancel(jobId: string): CopyJob {
    const handle = this.runs.get(jobId)
    if (handle === undefined) {
      // 没在运行也要把状态修正，避免界面卡在"运行中"
      this.deps.store.updateJob(jobId, { state: 'cancelled', finishedAt: new Date().toISOString() })
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
    const handle = this.runs.get(jobId)
    if (handle !== undefined) await handle.promise
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

  async generateReports(jobId: string, terminalState?: CopyJob['state']): Promise<ReportSummary> {
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
    if (this.runs.has(jobId)) {
      throw new Error(this.m('job.reportWhileRunning'))
    }

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
      job,
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
      preNotes
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

    this.deps.emit({ type: 'reports:changed', payload: { jobId } })
    return revision.summary
  }

  private async ejectTargets(job: CopyJob): Promise<void> {
    for (const target of job.targets) {
      if (!target.enabled) continue
      const description = await describeVolume(target.path)
      if (description === null) continue
      const result = await ejectVolume(description.mountPoint)
      if (result.ok) {
        this.deps.logger.info('job', this.m('job.ejected', { label: target.label }))
      } else {
        this.deps.logger.warn('job', this.m('job.ejectFail', { label: target.label, reason: result.message }))
      }
    }
  }
}
