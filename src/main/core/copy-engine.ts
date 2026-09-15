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
  AppSettings,
  CopyJob,
  CopyJobFile,
  CopyTarget,
  FileState,
  FileTargetResult,
  JobPhase,
  JobProgress,
  JobState,
  MediaProbe,
  TargetProgress
} from '@shared/types'
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
  syncDirectory
} from '@main/fs-utils'
import { PauseGate, RateMeter, Semaphore } from './concurrency'
import type { MediaProbeRunner } from '@main/media/probe'

export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024

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
  /** 媒体探测；为 null 表示不做探测 */
  probeRunner?: MediaProbeRunner | null
}

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
 * 命名冲突的固定前缀。
 *
 * 关键区分：**命名冲突不是介质故障**。
 * 目标盘上碰巧躺着一个同名文件，重读校验自然对不上；
 * 若照 I/O 故障处理，整块好盘会被判死、后续文件全部不写 ——
 * 现场看到的是"这个盘拷到一半就不拷了"，而盘其实好得很。
 */
const NAME_CONFLICT_PREFIX = '目标上已存在同名文件'

/** 判断一条失败原因是不是"目标已有同名文件"这一类。 */
export function isNameConflictReason(error: string | null): boolean {
  return error !== null && error.startsWith(NAME_CONFLICT_PREFIX)
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
  /** 当前正在读取的文件已读字节（用于大文件拷贝时的实时进度） */
  private inFlightBytes = 0
  /** 已经提取过首尾帧的文件数，用于限制总提取量 */
  private frameExtractions = 0
  /** 已排入探测队列 / 已完成探测的文件数，用于「分析素材」阶段进度 */
  private analyzeTotal = 0
  private analyzeDone = 0
  private phase: JobPhase = 'copying'

  constructor(deps: CopyEngineDeps) {
    this.deps = deps
    this.verifySemaphore = new Semaphore(Math.max(1, deps.settings.maxParallelTargets))
    this.probeSemaphore = new Semaphore(Math.max(1, deps.settings.frameConcurrency))
    for (const target of deps.job.targets) {
      this.slots.push({
        target,
        enabled: target.enabled,
        failed: false,
        error: target.enabled ? null : '已停用',
        conflictCount: 0
      })
    }
  }

  cancel(): void {
    this.cancelled = true
  }

  async run(): Promise<CopyEngineResult> {
    const { job, store } = this.deps

    store.updateJob(job.id, { state: 'running', startedAt: new Date().toISOString() })
    const resetCount = store.resetInFlightFiles(job.id)
    if (resetCount > 0) {
      this.log('warn', `有 ${resetCount} 个文件上次未处理完，已回到待处理状态并将自动断点续传。`)
    }

    await this.prepareSlots()
    this.emitProgress(true)

    // 只要还有启用的目标可用，任务就能继续 —— 被停用的目标不算"不可用"
    if (this.slots.filter((slot) => slot.enabled).every((slot) => slot.failed)) {
      store.updateJob(job.id, { state: 'failed', finishedAt: new Date().toISOString() })
      this.log('error', '所有启用的目标盘都不可用，任务无法开始。')
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
          this.inFlightBytes = 0
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
        cancelled ? '任务已取消，已写入的分片会保留以便续传。' : `任务中断：${describeError(error)}`
      )
      store.updateJob(job.id, {
        state: cancelled ? 'cancelled' : 'failed',
        finishedAt: new Date().toISOString()
      })
      const snapshot = store.getJob(job.id)
      this.emitProgress(true)
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
      this.log(
        'warn',
        `另有 ${conflictTotal} 个文件因目标上已存在同名文件而未拷贝（原文件已保留，目标盘本身正常）。请查看各目标的失败清单后人工核对。`
      )
    }

    store.updateJob(job.id, { state, finishedAt: new Date().toISOString() })
    this.phase = 'done'
    this.emitProgress(true)

    if (filesFailed > 0) {
      this.log('warn', `任务结束：${filesFailed} 个文件未通过校验，请查看失败清单与报告。`)
    } else {
      this.log('info', '任务结束：全部文件已拷贝并通过独立重读校验。')
    }

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
        await ensureDir(slot.target.path)
        const info = await stat(slot.target.path)
        if (!info.isDirectory()) throw new Error('目标路径不是目录')
        store.updateTargetProgress(job.id, slot.target.id, { state: 'running', error: null })
      } catch (error) {
        slot.failed = true
        slot.error = `目标盘不可用：${describeError(error)}`
        store.updateTargetProgress(job.id, slot.target.id, { state: 'failed', error: slot.error })
        this.log('error', `目标「${slot.target.label}」不可用，本次任务已隔离该盘：${slot.error}`)
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * 单文件处理
   * ---------------------------------------------------------------- */

  private async processFile(file: PendingFile): Promise<void> {
    const { job, store } = this.deps
    const sourceAbs = resolveInside(job.sourcePath, file.relPath)

    store.updateFile(job.id, file.relPath, { state: 'copying', error: null })

    let sourceSize = file.sizeBytes
    try {
      const info = await stat(sourceAbs)
      // CODEX VFS 上的 HDE 素材在 Finder 里显示 0 字节，这个值只作参考
      sourceSize = info.size
    } catch (error) {
      await this.failFile(file, `无法读取源文件：${describeError(error)}`)
      return
    }

    const works = await this.prepareWorks(file, sourceSize)
    const usable = works.filter((work) => work.fatalError === null && !work.skipped)

    if (usable.length === 0) {
      const enabled = this.slots.filter((slot) => slot.enabled)
      const reason =
        enabled.length === 0
          ? '没有启用的目标盘。'
          : enabled.every((slot) => slot.failed)
            ? '所有启用的目标盘都已不可用。'
            : '所有目标都无法写入该文件（多为目标上已存在同名但内容不同的文件）。'
      await this.failFile(file, reason, works)
      return
    }

    const needsWrite = usable.some((work) => !work.adopted && !work.completeBeforeWrite)

    let outcome: FileOutcome
    if (needsWrite) {
      // 哈希器必须在进入读取循环之前就绪（xxHash64 的 WASM 初始化是异步的），
      // 否则 update() 就只能把数据暂存在内存里 —— 上百 GB 的素材会直接撑爆内存。
      const hasher = await createStreamingHasher(job.hashAlgorithm)
      outcome = await this.streamAndFanOut(sourceAbs, works, hasher)
    } else {
      // 目标上文件都已完整，无需写入；但源侧校验值仍然必须算出来，
      // 否则"重读校验"就变成了"自说自话"。
      outcome = await this.hashSourceOnly(sourceAbs)
    }

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
          `${file.relPath} 扫描记录为 0 字节、实际读出 ${outcome.actualBytes} 字节 —— CODEX Device Manager 虚拟文件系统的正常表现，已按实际值记录。`
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
      const finalPath = resolveInside(slot.target.path, file.relPath)
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
          work.fatalError =
            `${NAME_CONFLICT_PREFIX}且大小不同（现有 ${info.size} 字节，源 ${sourceSize} 字节）。` +
            '为避免覆盖素材，已保留原文件；该文件在此目标上未拷贝，其余文件照常写入。'
          work.nameConflict = true
          slot.conflictCount++
          store.incrementTargetCounters(job.id, slot.target.id, { filesFailed: 1 })
          store.updateTargetProgress(job.id, slot.target.id, { error: work.fatalError })
          this.log(
            'warn',
            `「${slot.target.label}」上已存在同名不同大小的文件，已跳过该文件（目标盘继续使用）：${file.relPath}`
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
          this.log('info', `从 ${resumeOffset} 字节处续传：${file.relPath} → ${slot.target.label}`)
        }
        work.handle = handle
        work.writeOffset = resumeOffset
        work.bytesWritten = resumeOffset
        this.openWorks.add(work)
        works.push(work)
      } catch (error) {
        work.fatalError = `无法准备写入：${describeError(error)}`
        slot.failed = true
        slot.error = work.fatalError
        store.incrementTargetCounters(job.id, slot.target.id, { filesFailed: 1 })
        store.updateTargetProgress(job.id, slot.target.id, {
          state: 'failed',
          error: work.fatalError
        })
        this.log('error', `目标「${slot.target.label}」准备写入失败，该盘已隔离：${work.fatalError}`)
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
        this.inFlightBytes += bytesRead

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
            work.fatalError = `写入失败：${describeError(error)}`
            work.slot.failed = true
            work.slot.error = work.fatalError
            store.incrementTargetCounters(job.id, work.slot.target.id, { filesFailed: 1 })
            store.updateTargetProgress(job.id, work.slot.target.id, { error: work.fatalError })
            this.log(
              'error',
              `目标「${work.slot.target.label}」写入中断，该盘已隔离，其余目标继续：${work.fatalError}`
            )
            await this.closeHandle(work)
          }
        }

        position += bytesRead
      }
    } catch (error) {
      sourceError = `读取源文件失败：${describeError(error)}`
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
        work.fatalError = `收尾失败：${describeError(error)}`
        work.slot.failed = true
        work.slot.error = work.fatalError
        store.incrementTargetCounters(job.id, work.slot.target.id, { filesFailed: 1 })
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
        sourceError: `无法读取源文件：${describeError(error)}`
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
        const match = targetHash === outcome.sourceHash

        if (!match) {
          // adopted = 这个文件是目标上**预先存在**的（本次任务一个字节都没写它）。
          // 校验不符说明那是同名同尺寸但内容不同的别的文件 —— 仍然是命名冲突，
          // 不是这块盘写坏了。隔离整盘会误伤，只让这一个文件失败。
          if (work.adopted) {
            work.nameConflict = true
            work.slot.conflictCount++
            const conflictError =
              `${NAME_CONFLICT_PREFIX}（同名同尺寸，但内容与源不一致）。` +
              '为避免覆盖素材，已保留原文件；该文件在此目标上未拷贝。请人工核对该文件是否为别的素材。'
            store.incrementTargetCounters(job.id, work.slot.target.id, { filesFailed: 1 })
            store.updateTargetProgress(job.id, work.slot.target.id, { error: conflictError })
            this.log(
              'warn',
              `「${work.slot.target.label}」上已存在同名同尺寸但内容不同的文件，已跳过该文件（目标盘继续使用）：${file.relPath}`
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
          work.slot.error = '目标侧重读校验值与源侧不一致'
          store.incrementTargetCounters(job.id, work.slot.target.id, { filesFailed: 1 })
          store.updateTargetProgress(job.id, work.slot.target.id, { error: work.slot.error })
          this.log(
            'error',
            `校验不一致：${file.relPath} @ ${work.slot.target.label} —— 该目标已标记为不可信，建议更换介质后重跑。`
          )
          return {
            targetId: work.slot.target.id,
            state: 'failed',
            hash: targetHash,
            hashMatch: false,
            bytesCopied: work.bytesWritten,
            error: '目标侧重读校验值与源侧不一致（文件可能损坏，请更换目标介质后重跑）。'
          }
        }

        // 校验通过才让文件以最终名字出现在目标盘上
        if (!work.adopted) {
          await commitPartial(work.partialPath, work.finalPath)
          await syncDirectory(dirname(work.finalPath))
        }

        store.incrementTargetCounters(job.id, work.slot.target.id, { filesDone: 1 })
        return {
          targetId: work.slot.target.id,
          state: 'verified',
          hash: targetHash,
          hashMatch: true,
          bytesCopied: work.bytesWritten > 0 ? work.bytesWritten : outcome.actualBytes,
          error: null
        }
      } catch (error) {
        work.slot.failed = true
        work.slot.error = `校验失败：${describeError(error)}`
        store.incrementTargetCounters(job.id, work.slot.target.id, { filesFailed: 1 })
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

    const failedResults = results.filter((result) => result.state === 'failed')
    const verifiedCount = results.filter((result) => result.state === 'verified').length
    const state: FileState = failedResults.length === 0 && verifiedCount > 0 ? 'verified' : 'failed'
    const error =
      failedResults.length > 0
        ? failedResults.map((item) => `${item.targetId}: ${item.error ?? '未知错误'}`).join('；')
        : null

    const fileRow = store.getFileRow(job.id, file.relPath)
    const fileId = fileRow === undefined ? 0 : Number(fileRow.id)

    if (fileId > 0) {
      for (const result of results) {
        store.saveFileResult(fileId, job.id, result)
      }
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
      throw new Error('任务已取消')
    }
  }

  /* ---------------------------------------------------------------- *
   * 进度上报
   * ---------------------------------------------------------------- */

  private emitProgress(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastProgressAt < 250) return
    this.lastProgressAt = now

    const { job, store } = this.deps
    const snapshot = store.getJob(job.id)
    if (snapshot === null) return

    const totalBytes = snapshot.totalBytes
    const bytesDone = Math.min(snapshot.bytesDone + this.inFlightBytes, Math.max(totalBytes, snapshot.bytesDone))
    const rate = this.rate.rate()

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
      // 分析阶段源盘已经不读了，此时再显示字节速率只会误导
      bytesPerSecond: analyzing ? 0 : rate,
      currentFile: null,
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

/** 完整写出一片数据，处理短写。 */
async function writeFully(handle: FileHandle, data: Buffer, position: number): Promise<void> {
  let written = 0
  while (written < data.length) {
    const result = await handle.write(data, written, data.length - written, position + written)
    if (result.bytesWritten <= 0) {
      throw new Error('写入返回 0 字节 —— 目标盘可能已满或被拔出')
    }
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
