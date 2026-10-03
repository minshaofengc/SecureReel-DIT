/**
 * 拷贝引擎 —— 本项目的心脏。
 *
 * 核心工程决策：**源盘只读一遍**。
 * 一次顺序读取源文件，边读边算校验值，同时把同一份数据扇出写到所有目标。
 * 「有几个目标就读几遍源盘」的做法在现场不可接受 —— 那是成倍的读卡器负载，
 * 会让 ALEXA 的 CFexpress 读卡器立刻成为瓶颈。
 *
 * 文件生命周期：
 *   1. 打开源文件与各目标的 `.securereel-partial` 分片
 *   2. 读一个分片 → 算哈希 → 并发写到所有健康目标
 *   3. 全部写完就 fsync + 关闭（拔盘前这一步不能省）
 *   4. 各目标**独立重读**分片并重新算哈希，与源侧值比对
 *   5. 比对通过才原子改名到最终文件名
 *
 * 两条硬约束：
 *   · 故障隔离 —— 某个盘写失败只会让这个盘那一行变成 failed，
 *     其他健康目标照常完成并提交。
 *   · 绝不覆盖 —— 目标盘上已有同名不同内容的文件时明确报错并保留原文件。
 *     静默覆盖别人的素材在 DIT 流程里是事故，不是功能。
 */
import { open, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import type {
  ActiveFileProgress,
  AppSettings,
  CopyJob,
  CopyJobFile,
  CopyTarget,
  FileState,
  FileStateDelta,
  FileTargetResult,
  JobPhase,
  JobProgress,
  JobState,
  MediaProbe,
  TargetProgress
} from '@shared/types'
import { NAME_CONFLICT_PREFIXES, msg, type MsgKey } from '@shared/messages'
import { computeOverallPercent } from '@shared/progress'
import type { PendingFile, Store } from '@main/db/store'
import type { Logger } from '@main/logger'
import { createStreamingHasher, type StreamingHasher } from '@main/hashing'
import {
  commitPartial,
  describeError,
  ensureDir,
  partialPathFor,
  pathExists,
  removeQuietly,
  resolveInside,
  syncDirectory,
  targetRelativePath
} from '@main/fs-utils'
import { PauseGate, RateMeter, Semaphore } from './concurrency'
import { FileDeltaBuffer } from './file-delta-buffer'
import type { MediaProbeRunner } from '@main/media/probe'

export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024

/**
 * 中间态变更的合并窗口。
 *
 * 取 200ms 的理由：人对"进度在动"的感知阈值大约就是这个量级，
 * 再密也不会让人看得更清楚；而一个上千文件的卡如果每文件推两条
 * （copying + verifying），不合并就是几千条 IPC —— 界面会被自己的
 * 状态更新拖垮，真正的大文件拷贝反而更慢。
 */
export const FILE_DELTA_FLUSH_MS = 200

export interface CopyEngineDeps {
  job: CopyJob
  store: Store
  logger: Logger
  settings: AppSettings
  signal: AbortSignal
  gate: PauseGate
  /** 结构化日志同时推给界面 */
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** 单个文件在全部目标上安定后触发（含失败） */
  onFileSettled?: (file: CopyJobFile) => void
  /** 进度变化 */
  onProgress?: (progress: JobProgress) => void
  /**
   * 一批中间态变更（`copying` / `verifying`），已按 `FILE_DELTA_FLUSH_MS` 合并。
   *
   * 与 `onFileSettled` 的分工：这条只负责"让界面看到文件在动"，
   * 最终事实仍以 `onFileSettled` 推的完整行为准。
   */
  onFilesChanged?: (deltas: FileStateDelta[]) => void
  /**
   * 要求界面重新拉取文件清单。
   *
   * 只在主进程把一批中间态**改回 pending** 之后发（任务开始时的
   * `resetInFlightFiles`）。界面侧无法自己发现这种回退，
   * 不发的话会一直挂着上次中断时的那几个"拷贝中"。
   */
  onFilesResync?: () => void
  /** 媒体探测；为 null 表示不做探测 */
  probeRunner?: MediaProbeRunner | null
  /**
   * 进度上报的最小间隔（毫秒），默认 250。
   *
   * 允许调小只为测试：端到端跑一次拷贝时，小文件可能几十毫秒就全部完成，
   * 250ms 的窗口会让"正在处理哪个文件"这类瞬时状态完全观察不到。
   */
  progressThrottleMs?: number
}

/** 进度上报的默认节流窗口。 */
export const DEFAULT_PROGRESS_THROTTLE_MS = 250

export interface CopyEngineResult {
  state: JobState
  filesDone: number
  filesFailed: number
  bytesDone: number
  processed: number
}

/** 目标盘在整个任务期间的状态（跨文件存活）。 */
interface TargetSlot {
  target: CopyTarget
  /** 用户是否启用了这个目标 */
  enabled: boolean
  /** 运行时被判定不可用（不可写、写入出错、重读校验不符） */
  failed: boolean
  error: string | null
  /**
   * 该盘上因「目标已有同名文件」而跳过的文件数。
   *
   * 刻意与 `failed` 分开记：这些文件确实没拷成，但**盘本身是好的**，
   * 不应该被隔离，也不该阻断后续文件。混为一谈会让一块健康的盘
   * 因为一个撞名字的旧文件而整盘停摆。
   */
  conflictCount: number
}

/**
 * 目标盘在**单个文件**上的写入状态。
 *
 * 刻意做成每个文件新建的对象：后台校验是异步跑的，
 * 如果把这些状态挂在共享的 TargetSlot 上，处理下一个文件时会和
 * 上一个文件的校验互相踩踏。
 */
interface FileTargetWork {
  slot: TargetSlot
  finalPath: string
  partialPath: string
  handle: FileHandle | null
  /** 已确定的起始写入偏移，>0 表示断点续传 */
  writeOffset: number
  /** 写入前该文件在目标上就已完整（上次写完没来得及校验） */
  completeBeforeWrite: boolean
  /** 直接采用已存在的最终文件，不需要改名 */
  adopted: boolean
  /** 实际用于校验读取的路径 */
  verifyPath: string
  bytesWritten: number
  /** 该目标在本文件上已注定失败（冲突、无法写入等） */
  fatalError: string | null
  /**
   * 本文件的失败属于「命名冲突」而不是介质故障。
   *
   * 只影响这一个文件：盘继续用，后续文件照常写。
   */
  nameConflict: boolean
  /** 用户停用了这个目标 —— 不写入、也不算失败 */
  skipped: boolean
}

interface FileOutcome {
  /** 读源过程中算出的校验值（这是所有目标比对的基准） */
  sourceHash: string
  actualBytes: number
  sourceError: string | null
}

/**
 * 命名冲突错误信息的前缀按语言存在 `NAME_CONFLICT_PREFIXES`（见 `@shared/messages`）。
 *
 * 关键区分：**命名冲突不是介质故障**。
 * 目标盘上碰巧躺着一个同名文件，重读校验自然对不上；
 * 若照 I/O 故障处理，整块好盘会被判死、后续文件全部不写 ——
 * 现场看到的是"这个盘拷到一半就不拷了"，而盘其实好得很。
 */

/** 判断一条失败原因是不是"目标已有同名文件"这一类（兼容两种语言的文案）。 */
export function isNameConflictReason(error: string | null): boolean {
  return (
    error !== null &&
    Object.values(NAME_CONFLICT_PREFIXES).some((prefix) => error.startsWith(prefix))
  )
}

/**
 * 只有真·介质/写入故障才把整盘踢出（`slot.failed`）。
 * 命名冲突走 `nameConflict` 标记 + `conflictCount` 计数，只让那一个文件失败。
 */
export class CopyEngine {
  private readonly deps: CopyEngineDeps
  private readonly slots: TargetSlot[] = []
  private readonly verifySemaphore: Semaphore
  private readonly pendingVerifications = new Set<Promise<void>>()
  private readonly openWorks = new Set<FileTargetWork>()
  /**
   * 媒体探测（解析元数据 + 提首帧）刻意与拷贝主循环解耦。
   *
   * 每次探测是几十到几百毫秒级的活，一条五千文件的卡如果串在拷贝循环里，
   * 会平白多出十几分钟，而且拷贝进度会一顿一顿的。
   * 放在这里并行跑，拷贝跑完后统一等它们收尾。
   */
  private readonly pendingProbes = new Set<Promise<void>>()
  private readonly probeSemaphore: Semaphore
  private readonly rate = new RateMeter()
  private cancelled = false
  private lastProgressAt = 0
  /**
   * 当前正在处理的文件 → 已读字节数。
   *
   * 取代了从前的全局单计数器 `inFlightBytes`：那个计数器一旦遇到文件级并发
   * 就会把多个文件的字节混在一起，既算不准速率，也说不清"现在在动的是哪个"。
   */
  private readonly activeFiles = new Map<string, { sizeBytes: number; bytesRead: number }>()
  /**
   * 中间态变更的合并缓冲。
   *
   * 用 `Map` 而不是数组，让同一个文件在一个窗口内的多次变更
   * **天然折叠**成一条（`copying → verifying` 只剩最后那个状态）。
   * 上千文件的卡上，这一步能把 IPC 条数压掉一个数量级。
   */
  private readonly deltas: FileDeltaBuffer
  private readonly progressThrottleMs: number
  /** 已经提取过首尾帧的文件数，用于限制总提取量 */
  private frameExtractions = 0
  /** 已排入探测队列 / 已完成探测的文件数，用于「分析素材」阶段进度 */
  private analyzeTotal = 0
  private analyzeDone = 0
  /**
   * 拷贝阶段已完成读取的字节数（读完就算，不等判定）。
   *
   * 存在的理由：数据库里的 `bytesDone` 只在文件**判定之后**才跳一次，
   * 而"读完 → 校验 → 判定"之间有真实的时间差。少了这个计数器，
   * 每个文件读完的那一刻进度会掉一截，整条卡看起来在往后退。
   */
  private copiedBytesDone = 0
  /**
   * 校验阶段已完成重读的字节数。
   *
   * 这是"进度条卡在 100% 不动"的解药：拷贝读完后，每个目标盘上的成品
   * 还要被完整重读一遍才能判定，那段工作在老口径里完全不计入。
   */
  private verifyBytesDone = 0
  private phase: JobPhase = 'copying'

  constructor(deps: CopyEngineDeps) {
    this.deps = deps
    this.deltas = new FileDeltaBuffer(FILE_DELTA_FLUSH_MS, (list) => deps.onFilesChanged?.(list))
    this.progressThrottleMs = deps.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS
    this.verifySemaphore = new Semaphore(Math.max(1, deps.settings.maxParallelTargets))
    this.probeSemaphore = new Semaphore(Math.max(1, deps.settings.frameConcurrency))
    for (const target of deps.job.targets) {
      this.slots.push({
        target,
        enabled: target.enabled,
        failed: false,
        error: target.enabled ? null : this.m('engine.targetDisabled'),
        conflictCount: 0
      })
    }
  }

  cancel(): void {
    this.cancelled = true
  }

  /** 按当前设置的语言取引擎文案。 */
  private m(key: MsgKey, params: Record<string, string | number> = {}): string {
    return msg(this.deps.settings.language, key, params)
  }

  /** 仅校验模式：两侧只算校验值并比对，绝不写入、绝不删除目标盘上的任何字节。 */
  private get verifyOnly(): boolean {
    return this.deps.job.mode === 'verify'
  }

  async run(): Promise<CopyEngineResult> {
    const { job, store } = this.deps

    store.updateJob(job.id, { state: 'running', startedAt: new Date().toISOString() })
    const resetCount = store.resetInFlightFiles(job.id)
    if (resetCount > 0) {
      this.log('warn', this.m('engine.resumeReset', { count: resetCount }))
      // 上面这一步把上次中断留下的 copying/verifying 归零了。界面无从自己发现
      // 这种"往回退"的变更，必须让它重拉一次 —— 否则会一直挂着
      // 上次崩溃时卡住的那几个"拷贝中"，用户会以为任务还在跑。
      this.deps.onFilesResync?.()
    }

    await this.prepareSlots()
    this.emitProgress(true)

    // 只要还有启用的目标可用，任务就能继续 —— 被停用的目标不算"不可用"
    if (this.slots.filter((slot) => slot.enabled).every((slot) => slot.failed)) {
      store.updateJob(job.id, { state: 'failed', finishedAt: new Date().toISOString() })
      this.log('error', this.m('engine.allTargetsUnavailable'))
      this.flushFileDeltas()
      return { state: 'failed', filesDone: 0, filesFailed: job.totalFiles, bytesDone: 0, processed: 0 }
    }

    let processed = 0

    try {
      for (;;) {
        this.throwIfCancelled()
        await this.deps.gate.waitIfPaused(this.deps.signal)

        const batch = store.listPendingFiles(job.id, 64)
        if (batch.length === 0) break

        for (const file of batch) {
          this.throwIfCancelled()
          await this.deps.gate.waitIfPaused(this.deps.signal)
          await this.processFile(file)
          processed++
          this.emitProgress()
        }
      }

      await this.drainVerifications()

      // 拷贝与校验都结束了，剩下的是解析素材元数据、提取首帧。
      // 单独成阶段上报，否则用户会看到进度条停在 100% 却什么都不动。
      if (this.pendingProbes.size > 0) {
        this.phase = 'analyzing'
        this.emitProgress(true)
        await this.drainProbes()
      }
      this.phase = 'finalizing'
      this.emitProgress(true)
    } catch (error) {
      await this.drainVerifications()
      await this.drainProbes()
      await this.releaseAllHandles()
      const cancelled = this.cancelled || this.deps.signal.aborted
      this.log(
        cancelled ? 'warn' : 'error',
        cancelled ? this.m('engine.cancelledResume') : this.m('engine.jobInterrupted', { reason: describeError(error) })
      )
      store.updateJob(job.id, {
        state: cancelled ? 'cancelled' : 'failed',
        finishedAt: new Date().toISOString()
      })
      const snapshot = store.getJob(job.id)
      this.emitProgress(true)
      this.flushFileDeltas()
      return {
        state: cancelled ? 'cancelled' : 'failed',
        filesDone: snapshot?.filesDone ?? 0,
        filesFailed: snapshot?.filesFailed ?? 0,
        bytesDone: snapshot?.bytesDone ?? 0,
        processed
      }
    }

    await this.releaseAllHandles()

    const snapshot = store.getJob(job.id)
    const filesFailed = snapshot?.filesFailed ?? 0
    const state: JobState = filesFailed > 0 ? 'completed-with-errors' : 'completed'

    // 收尾时把各目标的状态定下来。少了这一步，任务结束后界面里每个目标
    // 都会一直显示「进行中」，而任务本身已经显示「已完成」—— 自相矛盾。
    for (const slot of this.slots) {
      if (!slot.enabled) continue
      store.updateTargetProgress(job.id, slot.target.id, {
        state: slot.failed ? 'failed' : 'completed'
      })
    }

    // 冲突单独汇报：这些文件没拷成，但盘是好的 —— 别让用户以为盘出了问题。
    const conflictTotal = this.slots.reduce((sum, slot) => sum + slot.conflictCount, 0)
    if (conflictTotal > 0) {
      this.log('warn', this.m('engine.conflictSummary', { count: conflictTotal }))
    }

    store.updateJob(job.id, { state, finishedAt: new Date().toISOString() })
    this.phase = 'done'
    this.emitProgress(true)

    if (filesFailed > 0) {
      this.log('warn', this.m('engine.jobDoneWithFailures', { count: filesFailed }))
    } else {
      this.log('info', this.m('engine.jobDoneClean'))
    }

    // 收尾：把还在合并窗口里排队的中间态送出去。
    // 没有这一步，任务结束时最后 200ms 内的状态变更就永远到不了界面。
    this.flushFileDeltas()

    return {
      state,
      filesDone: snapshot?.filesDone ?? 0,
      filesFailed,
      bytesDone: snapshot?.bytesDone ?? 0,
      processed
    }
  }

  /* ---------------------------------------------------------------- *
   * 目标盘准备
   * ---------------------------------------------------------------- */

  private async prepareSlots(): Promise<void> {
    const { job, store } = this.deps
    for (const slot of this.slots) {
      if (!slot.enabled) {
        store.updateTargetProgress(job.id, slot.target.id, { state: 'disabled', error: slot.error })
        continue
      }
      try {
        if (this.verifyOnly) {
          // 仅校验模式不创建任何目录：目标不存在说明盘上没有这份拷贝，
          // 直接隔离该目标并如实报告，而不是替它把目录建出来。
          const info = await stat(slot.target.path)
          if (!info.isDirectory()) throw new Error(this.m('engine.notDirectory'))
        } else {
          await ensureDir(slot.target.path)
          const info = await stat(slot.target.path)
          if (!info.isDirectory()) throw new Error(this.m('engine.notDirectory'))
        }
        store.updateTargetProgress(job.id, slot.target.id, { state: 'running', error: null })
      } catch (error) {
        slot.failed = true
        slot.error = this.m('engine.targetUnavailable', { reason: describeError(error) })
        store.updateTargetProgress(job.id, slot.target.id, { state: 'failed', error: slot.error })
        this.log(
          'error',
          this.m('engine.targetQuarantined', { label: slot.target.label, reason: slot.error })
        )
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * 单文件处理
   * ---------------------------------------------------------------- */

  /**
   * 文件在目标盘上的相对路径。
   *
   * 比 `file.relPath` 多一层来源目录名 —— 因为 `walkFiles` 算出来的相对路径
   * 是相对**用户选中的那一层**的，那一层本身不会出现在任何 relPath 里。
   * 选卡根时它正好是 DCIM 这些内容目录的父亲，看不出问题；
   * 选卡内的子文件夹时就会平白少一层，现场看到的是"文件全摊在目标盘根"。
   *
   * 拼接规则统一在 `targetRelativePath()` 里，报告层拼清单路径用的是同一个函数。
   */
  private targetRelPath(relPath: string): string {
    return targetRelativePath(this.deps.job.sourceRootName, relPath)
  }

  private async processFile(file: PendingFile): Promise<void> {
    const { job, store } = this.deps
    const sourceAbs = resolveInside(job.sourcePath, file.relPath)

    store.updateFile(job.id, file.relPath, { state: 'copying', error: null })
    this.recordFileDelta(file.relPath, { state: 'copying', error: null })

    let sourceSize = file.sizeBytes
    try {
      const info = await stat(sourceAbs)
      // CODEX VFS 上的 HDE 素材在 Finder 里显示 0 字节，这个值只作参考
      sourceSize = info.size
    } catch (error) {
      await this.failFile(file, this.m('engine.sourceReadFail', { reason: describeError(error) }))
      return
    }

    const works = await this.prepareWorks(file, sourceSize)
    const usable = works.filter((work) => work.fatalError === null && !work.skipped)

    if (usable.length === 0) {
      const enabled = this.slots.filter((slot) => slot.enabled)
      const reason =
        enabled.length === 0
          ? this.m('engine.noEnabledTargets')
          : enabled.every((slot) => slot.failed)
            ? this.m('engine.allTargetsBroken')
            : this.verifyOnly
              ? this.m('engine.verifyNoFileOnAnyTarget')
              : this.m('engine.copyBlockedOnAllTargets')
      await this.failFile(file, reason, works)
      return
    }

    const needsWrite = usable.some((work) => !work.adopted && !work.completeBeforeWrite)

    let outcome: FileOutcome
    if (needsWrite) {
      // 哈希器必须在进入读取循环之前就绪（xxHash64 的 WASM 初始化是异步的），
      // 否则 update() 就只能把数据暂存在内存里 —— 上百 GB 的素材会直接撑爆内存。
      const hasher = await createStreamingHasher(job.hashAlgorithm)
      // 登记为「正在处理」，界面据此显示"现在在动的是哪几个文件"。
      //
      // 这个表只负责**正在读、还没读完**的那一段（给进度条补一小段平滑量，
      // 否则大文件期间数字会长时间不动）。读完之后的去向分两处：
      //   · 已判定 → 数据库里的 bytesDone
      //   · 读完但还在校验 → copiedBytesDone（见下面）
      // 三者合起来才是"拷贝阶段完成了多少"，缺一段进度就会往后退。
      this.activeFiles.set(file.relPath, { sizeBytes: file.sizeBytes, bytesRead: 0 })
      try {
        outcome = await this.streamAndFanOut(file.relPath, sourceAbs, works, hasher)
      } finally {
        this.activeFiles.delete(file.relPath)
      }
    } else {
      // 目标上文件都已完整，无需写入；但源侧校验值仍然必须算出来，
      // 否则"重读校验"就变成了"自说自话"。
      outcome = await this.hashSourceOnly(sourceAbs)
    }

    /*
     * 这一段读取到此结束，无论后面判成什么，读掉的字节都算数。
     *
     * 必须**在**取消 `activeFiles` 之后、**在**判定之前记 ——
     * 这是唯一一个"读完了但还没判定"的时点。漏了这一步，进度会在
     * 每个文件读完时掉一截（activeFiles 里那份没了，bytesDone 又还没涨），
     * 大文件多的卡上表现为进度条一跳一跳地往后退。
     */
    this.copiedBytesDone += Math.max(0, outcome.actualBytes)

    if (outcome.sourceError !== null) {
      await this.closeHandles(works)
      await this.failFile(file, outcome.sourceError, works)
      return
    }

    if (outcome.actualBytes !== file.sizeBytes) {
      store.updateFileSize(job.id, file.relPath, outcome.actualBytes)
      if (file.sizeBytes === 0 && outcome.actualBytes > 0) {
        this.log(
          'info',
          this.m('engine.codexZeroByte', { relPath: file.relPath, bytes: outcome.actualBytes })
        )
      }
    }

    this.scheduleVerification(file, works, outcome)
  }

  /**
   * 为每个目标准备单文件写入状态。
   *
   * 优先级：已有的完整最终文件 > 可续传的分片 > 从零开始写。
   */
  private async prepareWorks(file: PendingFile, sourceSize: number): Promise<FileTargetWork[]> {
    const { job, store } = this.deps
    const works: FileTargetWork[] = []

    for (const slot of this.slots) {
      const finalPath = resolveInside(slot.target.path, this.targetRelPath(file.relPath))
      const partialPath = partialPathFor(finalPath)
      const work: FileTargetWork = {
        slot,
        finalPath,
        partialPath,
        handle: null,
        writeOffset: 0,
        completeBeforeWrite: false,
        adopted: false,
        verifyPath: partialPath,
        bytesWritten: 0,
        fatalError: slot.failed ? (slot.error ?? '目标不可用') : null,
        nameConflict: false,
        skipped: !slot.enabled
      }

      if (work.skipped || work.fatalError !== null) {
        works.push(work)
        continue
      }

      // 仅校验模式：不创建目录、不打开写入句柄，只判断目标文件在不在、尺寸对不对。
      // 真正的内容比对统一走后面的重读校验流程。
      if (this.verifyOnly) {
        try {
          if (await pathExists(finalPath)) {
            const info = await stat(finalPath)
            if (sourceSize > 0 && info.size !== sourceSize) {
              work.fatalError = this.m('engine.verifySizeMismatch', {
                actual: info.size,
                expected: sourceSize
              })
            } else {
              work.adopted = true
              work.completeBeforeWrite = true
              work.verifyPath = finalPath
              work.bytesWritten = 0
            }
          } else {
            work.fatalError = this.m('engine.verifyFileMissing')
          }
        } catch (error) {
          work.fatalError = this.m('engine.verifyTargetReadFail', { reason: describeError(error) })
        }
        works.push(work)
        continue
      }

      try {
        await ensureDir(dirname(finalPath))

        if (await pathExists(finalPath)) {
          const info = await stat(finalPath)
          if (sourceSize > 0 && info.size === sourceSize) {
            // 尺寸吻合：走"重读校验"，省掉一次全量拷贝
            work.adopted = true
            work.completeBeforeWrite = true
            work.verifyPath = finalPath
            work.bytesWritten = info.size
            works.push(work)
            continue
          }
          // 命名冲突：只让这一个文件在此目标上失败，盘继续用。
          // 若按 I/O 故障隔离整盘，一块好盘会因为一个撞名的旧文件整批停摆。
          work.fatalError = this.m('engine.conflictSizeDiff', {
            prefix: NAME_CONFLICT_PREFIXES[this.deps.settings.language],
            actual: info.size,
            expected: sourceSize
          })
          work.nameConflict = true
          slot.conflictCount++
          store.updateTargetProgress(job.id, slot.target.id, { error: work.fatalError })
          this.log(
            'warn',
            this.m('engine.conflictSizeDiffLog', { label: slot.target.label, relPath: file.relPath })
          )
          works.push(work)
          continue
        }

        let resumeOffset = 0
        if (this.deps.settings.resumePartialFiles && (await pathExists(partialPath))) {
          const partialInfo = await stat(partialPath)
          if (sourceSize > 0 && partialInfo.size === sourceSize) {
            // 上次写完但没来得及校验，直接进校验阶段
            work.completeBeforeWrite = true
            work.verifyPath = partialPath
            work.bytesWritten = partialInfo.size
            works.push(work)
            continue
          }
          if (partialInfo.size > 0 && (sourceSize === 0 || partialInfo.size < sourceSize)) {
            resumeOffset = partialInfo.size
          }
        }

        const handle = await open(partialPath, resumeOffset > 0 ? 'r+' : 'w')
        if (resumeOffset > 0) {
          // 截掉可能多出来的尾巴，避免残留脏字节
          await handle.truncate(resumeOffset)
          this.log(
            'info',
            this.m('engine.resumeFrom', {
              offset: resumeOffset,
              relPath: file.relPath,
              label: slot.target.label
            })
          )
        }
        work.handle = handle
        work.writeOffset = resumeOffset
        work.bytesWritten = resumeOffset
        this.openWorks.add(work)
        works.push(work)
      } catch (error) {
        work.fatalError = this.m('engine.prepareWriteFail', { reason: describeError(error) })
        slot.failed = true
        slot.error = work.fatalError
        store.updateTargetProgress(job.id, slot.target.id, {
          state: 'failed',
          error: work.fatalError
        })
        this.log(
          'error',
          this.m('engine.prepareWriteQuarantined', { label: slot.target.label, reason: work.fatalError })
        )
        works.push(work)
      }
    }

    return works
  }

  /**
   * 单次顺序读源 + 扇出写所有目标。
   *
   * 分片缓冲复用：所有目标的写入全部落定后才会读下一片，
   * 因此不存在数据竞争。写入用带偏移的定位写，断点续传时
   * 已完成的头部无需重写。
   */
  private async streamAndFanOut(
    relPath: string,
    sourceAbs: string,
    works: FileTargetWork[],
    hasher: StreamingHasher
  ): Promise<FileOutcome> {
    const { job, store } = this.deps
    const buffer = Buffer.allocUnsafe(DEFAULT_CHUNK_SIZE)
    let position = 0
    let sourceError: string | null = null
    let sourceHandle: FileHandle | null = null

    try {
      sourceHandle = await open(sourceAbs, 'r')

      for (;;) {
        this.throwIfCancelled()
        await this.deps.gate.waitIfPaused(this.deps.signal)

        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break

        const chunk = buffer.subarray(0, bytesRead)

        // 边读边算：源侧校验值就在这一步产生，不需要二次读取源盘
        hasher.update(chunk)

        this.rate.add(bytesRead)
        const active = this.activeFiles.get(relPath)
        if (active !== undefined) active.bytesRead += bytesRead

        for (const work of works) {
          if (work.fatalError !== null || work.adopted || work.completeBeforeWrite) continue
          if (work.handle === null) continue

          const from = Math.max(position, work.writeOffset)
          const length = position + bytesRead - from
          if (length <= 0) continue

          const slice = buffer.subarray(from - position, bytesRead)
          try {
            await writeFully(work.handle, slice, from)
            work.bytesWritten += length
            work.writeOffset = from + length
            store.incrementTargetCounters(job.id, work.slot.target.id, { bytesCopied: length })
          } catch (error) {
            work.fatalError = this.m('engine.writeFail', {
              reason:
                error instanceof ZeroByteWriteError
                  ? this.m('engine.writeZeroBytes')
                  : describeError(error)
            })
            work.slot.failed = true
            work.slot.error = work.fatalError
            store.updateTargetProgress(job.id, work.slot.target.id, { error: work.fatalError })
            this.log(
              'error',
              this.m('engine.writeInterrupted', { label: work.slot.target.label, reason: work.fatalError })
            )
            await this.closeHandle(work)
          }
        }

        position += bytesRead

        // 让进度在拷一条大素材的过程中持续动起来。数据库里的 bytesDone 只在
        // 文件结清时才跳一次，大文件期间它会长时间停在原处 —— 那正是用户
        // 以为"卡死了"的时刻。emitProgress 自带 250ms 节流，不会打爆 IPC。
        this.emitProgress()
      }
    } catch (error) {
      sourceError = this.m('engine.sourceReadFailShort', { reason: describeError(error) })
    } finally {
      if (sourceHandle !== null) {
        try {
          await sourceHandle.close()
        } catch {
          /* 关闭失败不影响结果判定 */
        }
      }
    }

    if (sourceError !== null) {
      return { sourceHash: '', actualBytes: position, sourceError }
    }

    // 读取循环走完才允许取值；哈希实例只能取一次
    const sourceHash = hasher.digest()

    // 收尾：fsync 每个分片，确保拔盘时数据真的在介质上
    for (const work of works) {
      if (work.adopted || work.completeBeforeWrite) {
        work.verifyPath = work.adopted ? work.finalPath : work.partialPath
        continue
      }
      if (work.handle === null) {
        // 上面写入或开句柄时已经标过失败，这里不再覆盖原因
        continue
      }
      try {
        await work.handle.sync()
        await work.handle.close()
        work.handle = null
        this.openWorks.delete(work)
        work.verifyPath = work.partialPath
      } catch (error) {
        work.fatalError = this.m('engine.finalizeFail', { reason: describeError(error) })
        work.slot.failed = true
        work.slot.error = work.fatalError
        await this.closeHandle(work)
      }
    }

    return { sourceHash, actualBytes: position, sourceError: null }
  }

  /** 无需写入时（文件在目标上已完整），仍然必须算出源侧校验值。 */
  private async hashSourceOnly(sourceAbs: string): Promise<FileOutcome> {
    try {
      const hash = await hashFileAt(sourceAbs, this.deps.job.hashAlgorithm)
      let size = 0
      try {
        size = (await stat(sourceAbs)).size
      } catch {
        size = 0
      }
      return { sourceHash: hash, actualBytes: size, sourceError: null }
    } catch (error) {
      return {
        sourceHash: '',
        actualBytes: 0,
        sourceError: this.m('engine.sourceReadFail', { reason: describeError(error) })
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * 校验与提交
   * ---------------------------------------------------------------- */

  private scheduleVerification(file: PendingFile, works: FileTargetWork[], outcome: FileOutcome): void {
    const { job, store } = this.deps

    store.updateFile(job.id, file.relPath, {
      state: 'verifying',
      sourceHash: outcome.sourceHash === '' ? null : outcome.sourceHash,
      bytesCopied: outcome.actualBytes
    })
    this.recordFileDelta(file.relPath, {
      state: 'verifying',
      sourceHash: outcome.sourceHash === '' ? null : outcome.sourceHash,
      bytesCopied: outcome.actualBytes
    })

    const task = (async (): Promise<void> => {
      const results = await Promise.all(works.map((work) => this.verifyWork(file, work, outcome)))
      await this.settleFile(file, outcome, results)
    })()

    this.pendingVerifications.add(task)
    void task.finally(() => this.pendingVerifications.delete(task))
  }

  private async verifyWork(
    file: PendingFile,
    work: FileTargetWork,
    outcome: FileOutcome
  ): Promise<FileTargetResult> {
    const { job, store } = this.deps

    // 用户主动停用的目标：不算失败，只是没参与
    if (work.skipped) {
      return {
        targetId: work.slot.target.id,
        state: 'skipped',
        hash: null,
        hashMatch: null,
        bytesCopied: 0,
        error: null
      }
    }

    if (work.fatalError !== null) {
      return {
        targetId: work.slot.target.id,
        state: 'failed',
        hash: null,
        hashMatch: false,
        bytesCopied: work.bytesWritten,
        error: work.fatalError
      }
    }

    return this.verifySemaphore.run(async (): Promise<FileTargetResult> => {
      try {
        const targetHash = await hashFileAt(work.verifyPath, job.hashAlgorithm)
        /*
         * 目标盘上的这一遍重读到此结束，无论比对结果如何，这段工作量都发生了。
         * 记在比对**之前**：比对不符时说明这个文件是坏的，但读它的时间一样花掉了 ——
         * 计在比对之后的话，失败的文件会让进度条永远差最后一截。
         */
        this.verifyBytesDone += Math.max(0, file.sizeBytes)
        const match = targetHash === outcome.sourceHash

        if (!match) {
          // adopted = 这个文件是目标上**预先存在**的（本次任务没有写过它）。

          // 仅校验模式：比对不符就是复核结论 —— 内容不同或已损坏。
          // 校验的意义恰恰是把所有差异都查出来，所以只记失败、不隔离目标，
          // 后续文件照常比对；也绝不动目标上的原文件。
          if (this.verifyOnly) {
            const message = this.m('engine.verifyMismatch')
            store.updateTargetProgress(job.id, work.slot.target.id, { error: message })
            this.log(
              'error',
              this.m('engine.verifyMismatchLog', { relPath: file.relPath, label: work.slot.target.label })
            )
            return {
              targetId: work.slot.target.id,
              state: 'failed',
              hash: targetHash,
              hashMatch: false,
              bytesCopied: work.bytesWritten,
              error: message
            }
          }

          // 拷贝模式下：那是同名同尺寸但内容不同的别的文件 —— 仍然是命名冲突，
          // 不是这块盘写坏了。隔离整盘会误伤，只让这一个文件失败。
          if (work.adopted) {
            work.nameConflict = true
            work.slot.conflictCount++
            const conflictError = this.m('engine.conflictSameSize', {
              prefix: NAME_CONFLICT_PREFIXES[this.deps.settings.language]
            })
            store.updateTargetProgress(job.id, work.slot.target.id, { error: conflictError })
            this.log(
              'warn',
              this.m('engine.conflictSameSizeLog', {
                label: work.slot.target.label,
                relPath: file.relPath
              })
            )
            return {
              targetId: work.slot.target.id,
              state: 'failed',
              hash: targetHash,
              hashMatch: false,
              bytesCopied: work.bytesWritten,
              error: conflictError
            }
          }

          // 走到这里说明分片是**本次任务写入**的 —— 校验不符就是写入/介质故障，
          // 宁可停手也不能让不可信的数据以最终文件名留在盘上。
          await removeQuietly(work.partialPath)
          work.slot.failed = true
          work.slot.error = this.m('engine.verifyMismatchTargetError')
          store.updateTargetProgress(job.id, work.slot.target.id, { error: work.slot.error })
          this.log(
            'error',
            this.m('engine.verifyMismatchQuarantineLog', {
              relPath: file.relPath,
              label: work.slot.target.label
            })
          )
          return {
            targetId: work.slot.target.id,
            state: 'failed',
            hash: targetHash,
            hashMatch: false,
            bytesCopied: work.bytesWritten,
            error: this.m('engine.verifyMismatchResult')
          }
        }

        // 校验通过才让文件以最终名字出现在目标盘上
        if (!work.adopted) {
          await commitPartial(work.partialPath, work.finalPath)
          await syncDirectory(dirname(work.finalPath))
        }

        // 目标盘计数不在这里记 —— 统一由 settleFile / failFile 按最终结果记一次。
        // 分散在各分支里记曾导致"某些失败路径忘了记"，报告的目标表与任务级数字对不上。
        return {
          targetId: work.slot.target.id,
          state: 'verified',
          hash: targetHash,
          hashMatch: true,
          bytesCopied: work.bytesWritten > 0 ? work.bytesWritten : outcome.actualBytes,
          error: null
        }
      } catch (error) {
        // 仅校验模式不隔离目标：复核要覆盖全部文件，读不动哪一个就记哪一个，
        // 其余文件照常比对。隔离是拷贝时的保护动作，复核时只会掩盖问题。
        if (this.verifyOnly) {
          const message = this.m('engine.verifyTargetReadFail', { reason: describeError(error) })
          store.updateTargetProgress(job.id, work.slot.target.id, { error: message })
          this.log(
            'error',
            this.m('engine.verifyReadFailLog', {
              relPath: file.relPath,
              label: work.slot.target.label,
              reason: message
            })
          )
          return {
            targetId: work.slot.target.id,
            state: 'failed',
            hash: null,
            hashMatch: false,
            bytesCopied: work.bytesWritten,
            error: message
          }
        }
        work.slot.failed = true
        work.slot.error = this.m('engine.verifyHashFail', { reason: describeError(error) })
        store.updateTargetProgress(job.id, work.slot.target.id, { error: work.slot.error })
        return {
          targetId: work.slot.target.id,
          state: 'failed',
          hash: null,
          hashMatch: false,
          bytesCopied: work.bytesWritten,
          error: work.slot.error
        }
      }
    })
  }

  /** 一个文件在所有目标上尘埃落定：落库检查点 + 通知界面 + 可选媒体探测。 */
  private async settleFile(
    file: PendingFile,
    outcome: FileOutcome,
    results: FileTargetResult[]
  ): Promise<void> {
    const { job, store } = this.deps

    /*
     * 这里**刻意不撤销**还在合并窗口里排队的中间态。
     *
     * 撤销看着更省流量，但它要在每一条结清路径上都记得调一次 ——
     * 漏掉任何一条（冲突、取消、异常分支），界面就会显示"校验完了又倒回去"。
     * 迟到的中间态改由 `shouldApplyFileStateChange()` 在界面侧无状态地挡掉。
     */
    const failedResults = results.filter((result) => result.state === 'failed')
    const verifiedCount = results.filter((result) => result.state === 'verified').length
    const state: FileState = failedResults.length === 0 && verifiedCount > 0 ? 'verified' : 'failed'
    const error =
      failedResults.length > 0
        ? failedResults.map((item) => `${item.targetId}: ${item.error ?? '未知错误'}`).join('；')
        : null

    const fileRow = store.getFileRow(job.id, file.relPath)
    const fileId = fileRow === undefined ? 0 : Number(fileRow.id)

    // ★ 目标盘计数在这里**唯一**记一次，按每个目标在这一文件上的最终结果累加。
    //
    // 曾经分散在 verifyWork / prepareWorks / streamAndFanOut 的各个失败分支里记，
    // 结果是漏记了一整类失败 —— 「仅校验时目标上文件不存在 /尺寸不符 /读不动」
    // 走的是 verifyWork 早退的 fatalError 分支，那里没有计数。
    // 现象是报告里的「目标」表显示该目标失败 0 个，而任务级失败数不是 0，
    // 同一份报告里两个数字自相矛盾。对仅校验任务（复核交付）尤其严重。
    for (const result of results) {
      if (fileId > 0) store.saveFileResult(fileId, job.id, result)
      this.countTargetResult(result)
    }

    store.updateFile(job.id, file.relPath, {
      state,
      bytesCopied: outcome.actualBytes,
      error
    })

    store.incrementJobCounters(job.id, {
      filesDone: state === 'verified' ? 1 : 0,
      filesFailed: state === 'verified' ? 0 : 1,
      bytesDone: outcome.actualBytes
    })

    this.deps.onFileSettled?.({
      id: fileId,
      jobId: job.id,
      relPath: file.relPath,
      sizeBytes: outcome.actualBytes,
      sourceHash: outcome.sourceHash === '' ? null : outcome.sourceHash,
      state,
      bytesCopied: outcome.actualBytes,
      results,
      probe: null,
      error
    })

    this.scheduleProbe(file.relPath, state, resolveInside(job.sourcePath, file.relPath))
    this.emitProgress()
  }

  /**
   * 目标盘计数：每个（文件 × 目标）只记一次。
   *
   * 刻意做成一个方法而不是散在各分支里写 —— 散着写时"漏记某一类失败"
   * 不会报错、不会崩，只会让报告里的数字对不上，极难发现。
   */
  private countTargetResult(result: FileTargetResult): void {
    const { job, store } = this.deps
    if (result.state === 'verified') {
      store.incrementTargetCounters(job.id, result.targetId, { filesDone: 1 })
    } else if (result.state === 'failed') {
      store.incrementTargetCounters(job.id, result.targetId, { filesFailed: 1 })
    }
    // skipped（用户在界面上停用的目标）：既不算成功也不算失败，不参与计数
  }

  /**
   * 把媒体探测排进后台队列。
   *
   * 只在确认成功的文件上做 —— 校验失败的文件连副本都不可信，
   * 再去解析它的元数据没有意义。任何探测失败都不影响哈希结论。
   */
  private scheduleProbe(relPath: string, state: FileState, sourceAbs: string): void {
    const runner = this.deps.probeRunner
    if (state !== 'verified' || runner == null) return

    // 首尾帧提取有实际开销（要解码或读文件前若干 MB），
    // 按设置里的上限控制总量；0 表示不限制。元数据解析不受此限，它很便宜。
    const limit = this.deps.settings.maxFrameExtractions
    const budgetLeft = limit <= 0 || this.frameExtractions < limit
    if (budgetLeft) this.frameExtractions++

    this.analyzeTotal++

    const task = this.probeSemaphore.run(async (): Promise<void> => {
      let probe: MediaProbe | null = null
      try {
        probe = await runner.probe(sourceAbs, {
          extractFrames: budgetLeft && this.deps.settings.extractFrames,
          signal: this.deps.signal
        })
      } catch {
        // 探测失败绝不影响哈希报告，只是少几行元数据
        probe = null
      }

      if (probe !== null) {
        this.deps.store.updateFile(this.deps.job.id, relPath, { probe })
        this.emitFileRow(relPath)
      }
      this.analyzeDone++
      this.emitProgress()
    })

    this.pendingProbes.add(task)
    void task.finally(() => this.pendingProbes.delete(task))
  }

  /** 探测完成后把这一行的最新状态推给界面（界面按 relPath 做 upsert）。 */
  private emitFileRow(relPath: string): void {
    const file = this.deps.store.getFile(this.deps.job.id, relPath)
    if (file !== null) this.deps.onFileSettled?.(file)
  }

  private async drainProbes(): Promise<void> {
    while (this.pendingProbes.size > 0) {
      await Promise.all([...this.pendingProbes])
    }
  }

  private async failFile(
    file: PendingFile,
    reason: string,
    works: FileTargetWork[] = []
  ): Promise<void> {
    const { job, store } = this.deps

    // 同 settleFile：不在这里撤销中间态，理由见那一处的说明
    store.updateFile(job.id, file.relPath, { state: 'failed', error: reason })
    store.incrementJobCounters(job.id, { filesFailed: 1, bytesDone: file.sizeBytes })

    for (const work of works) {
      if (work.slot.failed) continue
      await this.closeHandle(work)
    }

    this.log('error', `${file.relPath}：${reason}`)

    const fileRow = store.getFileRow(job.id, file.relPath)
    const failedResults: FileTargetResult[] = works
      .filter((work) => work.fatalError !== null)
      .map((work) => ({
        targetId: work.slot.target.id,
        state: 'failed' as FileState,
        hash: null,
        hashMatch: false,
        bytesCopied: work.bytesWritten,
        error: work.fatalError
      }))

    // 目标盘失败计数与 settleFile 走同一规则（每个"文件 × 目标"只记一次）。
    // 放在 fileRow 判空之外：计数是计数，与那一行有没有查到无关。
    for (const result of failedResults) this.countTargetResult(result)

    if (fileRow !== undefined) {
      const fileId = Number(fileRow.id)
      for (const result of failedResults) store.saveFileResult(fileId, job.id, result)
      this.deps.onFileSettled?.({
        id: fileId,
        jobId: job.id,
        relPath: file.relPath,
        sizeBytes: file.sizeBytes,
        sourceHash: null,
        state: 'failed',
        bytesCopied: 0,
        results: failedResults,
        probe: null,
        error: reason
      })
    }

    this.emitProgress()
  }

  /* ---------------------------------------------------------------- *
   * 句柄与收尾
   * ---------------------------------------------------------------- */

  private async closeHandle(work: FileTargetWork): Promise<void> {
    if (work.handle === null) return
    try {
      await work.handle.close()
    } catch {
      /* 已失败的目标不必再纠缠 */
    }
    work.handle = null
    this.openWorks.delete(work)
  }

  private async closeHandles(works: FileTargetWork[]): Promise<void> {
    for (const work of works) await this.closeHandle(work)
  }

  private async releaseAllHandles(): Promise<void> {
    // 正常路径下分片句柄在 streamAndFanOut 收尾时已关闭；
    // 这里兜底处理取消 / 异常中断留下的句柄，避免文件描述符泄漏。
    for (const work of [...this.openWorks]) {
      await this.closeHandle(work)
    }
  }

  private async drainVerifications(): Promise<void> {
    while (this.pendingVerifications.size > 0) {
      await Promise.all([...this.pendingVerifications])
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelled || this.deps.signal.aborted) {
      throw new Error(this.m('engine.cancelled'))
    }
  }

  /* ---------------------------------------------------------------- *
   * 中间态推送
   * ---------------------------------------------------------------- */

  /**
   * 记一次文件状态变更，交由合并窗口批量送出。
   *
   * 同一个文件在窗口内的多次变更会自然折叠，所以调用方可以放心地
   * 在每个状态转换点都调一次，不必自己节流。
   */
  private recordFileDelta(relPath: string, patch: Omit<FileStateDelta, 'relPath'>): void {
    this.deltas.record(relPath, patch)
  }

  /** 立刻把攒下的变更送出去。任务收尾时必须调，否则最后一拍永远发不出去。 */
  private flushFileDeltas(): void {
    this.deltas.flush()
  }

  /* ---------------------------------------------------------------- *
   * 进度上报
   * ---------------------------------------------------------------- */

  private emitProgress(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastProgressAt < this.progressThrottleMs) return
    this.lastProgressAt = now

    const { job, store } = this.deps
    const snapshot = store.getJob(job.id)
    if (snapshot === null) return

    const totalBytes = snapshot.totalBytes
    // 正在读、但还没落库的字节要单独加进来：数据库里的 bytesDone 只在文件
    // 结清时才动，拷一条上百 GB 的素材期间它会一直停在原处，看着像卡住了。
    let inFlightBytes = 0
    const activeFiles: ActiveFileProgress[] = []
    for (const [relPath, active] of this.activeFiles) {
      inFlightBytes += active.bytesRead
      activeFiles.push({ relPath, sizeBytes: active.sizeBytes, bytesRead: active.bytesRead })
    }
    const bytesDone = Math.min(snapshot.bytesDone + inFlightBytes, Math.max(totalBytes, snapshot.bytesDone))
    const rate = this.rate.rate()

    /*
     * 总进度在**主进程**算，界面只负责画。
     *
     * 放在这里的原因很实际：只有这一侧同时知道"读完但没判定"的字节、
     * "已重读校验"的字节、以及目标盘数量。让渲染层拿几个半成品数字自己拼，
     * 迟早会拼出一个和实际不一致的口径 —— 而且换一处就漏一处。
     */
    const enabledTargets = this.slots.filter((slot) => slot.enabled).length
    const verifyPasses =
      job.mode === 'verify' || job.verifyAfterWrite ? enabledTargets : 0
    const overallPercent = computeOverallPercent({
      totalBytes,
      // 拷贝阶段的完成量 = 已读完的 + 正在读的那一段。
      // 用 copiedBytesDone 而不是数据库里的 bytesDone：后者要等校验完才涨，
      // 中间那一大段真空会让进度往回退（原因见字段上的注释）。
      copiedBytes: this.copiedBytesDone + inFlightBytes,
      verifyBytesDone: this.verifyBytesDone,
      verifyPasses,
      filesSettled: snapshot.filesDone + snapshot.filesFailed,
      totalFiles: snapshot.totalFiles
    })

    const targets: TargetProgress[] = this.slots.map((slot) => ({
      targetId: slot.target.id,
      label: slot.target.label,
      state: !slot.enabled ? 'disabled' : slot.failed ? 'failed' : 'running',
      filesDone: 0,
      filesFailed: 0,
      bytesCopied: 0,
      bytesPerSecond: 0,
      error: slot.error
    }))

    // 用数据库里的真实计数覆盖，界面看到的数字与实际落库一致
    const dbTargets = store.listTargetProgress(job.id)
    for (const dbTarget of dbTargets) {
      const index = targets.findIndex((item) => item.targetId === dbTarget.targetId)
      if (index >= 0) {
        targets[index] = { ...dbTarget, bytesPerSecond: rate }
      }
    }

    const analyzing = this.phase === 'analyzing'

    this.deps.onProgress?.({
      jobId: job.id,
      state: snapshot.state,
      phase: this.phase,
      totalFiles: snapshot.totalFiles,
      filesDone: snapshot.filesDone,
      filesFailed: snapshot.filesFailed,
      totalBytes,
      bytesDone,
      // 界面用它画进度条。已经算好、且含校验阶段，界面不要再自己拼一份。
      overallPercent,
      // 分析阶段源盘已经不读了，此时再显示字节速率只会误导
      bytesPerSecond: analyzing ? 0 : rate,
      currentFile: activeFiles[0]?.relPath ?? null,
      activeFiles,
      targets,
      etaSeconds: !analyzing && rate > 0 && totalBytes > bytesDone ? (totalBytes - bytesDone) / rate : null,
      analyzeDone: this.analyzeDone,
      analyzeTotal: this.analyzeTotal
    })
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    if (level === 'error') this.deps.logger.error('copy-engine', message)
    else if (level === 'warn') this.deps.logger.warn('copy-engine', message)
    else this.deps.logger.info('copy-engine', message)
    this.deps.onLog?.(level, message)
  }

  /** 供外部读取当前速率（报告里要写平均速率）。 */
  get currentRate(): number {
    return this.rate.rate()
  }
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

/**
 * 写入返回 0 字节。
 *
 * 单独做成一个错误类型、而不是在 `writeFully` 里就地拼一句中文：
 * `writeFully` 是模块级函数，拿不到 CopyEngine 里那个按语言取文案的 `m()`。
 * 而这句话是要给用户看的（"盘满了"和"线被拔了"处置完全不同），
 * 所以由调用处翻译成当前语言 —— 之前它写死成中文，
 * 于是 `engine.writeZeroBytes` 这个键配好了中英文却从来没人用。
 */
export class ZeroByteWriteError extends Error {
  constructor() {
    super('write returned 0 bytes')
    this.name = 'ZeroByteWriteError'
  }
}

/** 完整写出一片数据，处理短写。 */
async function writeFully(handle: FileHandle, data: Buffer, position: number): Promise<void> {
  let written = 0
  while (written < data.length) {
    const result = await handle.write(data, written, data.length - written, position + written)
    if (result.bytesWritten <= 0) throw new ZeroByteWriteError()
    written += result.bytesWritten
  }
}

/** 独立地对一个文件重新计算校验值（目标侧重读、源侧单独计算共用）。 */
export async function hashFileAt(path: string, algorithm: CopyJob['hashAlgorithm']): Promise<string> {
  const hasher = await createStreamingHasher(algorithm)
  const handle = await open(path, 'r')
  const buffer = Buffer.allocUnsafe(DEFAULT_CHUNK_SIZE)
  try {
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      hasher.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
  return hasher.digest()
}
