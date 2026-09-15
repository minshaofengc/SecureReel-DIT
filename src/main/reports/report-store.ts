/**
 * 报告档案库。
 *
 * 核心约束：**旧修订永不被覆盖**。
 * 每个修订独占一个目录 `reports/<任务ID>/R00N/`，号只增不减；
 * 目录已存在就直接报错而不是往里写 —— 让"覆盖"在物理上不可能发生。
 *
 * 一个修订目录里有什么：
 *   report.json        机器可读的完整逐文件记录
 *   report.html        自包含的离线网页（可直接双击打开）
 *   report.pdf         适合归档与交付的版式
 *   frames/            首尾帧缩略图
 *   manifest/          本次写入的清单副本（ASC MHL 同时也会写进各目标盘）
 */
import { createWriteStream } from 'node:fs'
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  CopyJob,
  CopyJobFile,
  CopyTarget,
  ManifestFormat,
  ProjectInfo,
  ReportRevision,
  ReportSummary,
  TargetProgress
} from '@shared/types'
import type { Store } from '@main/db/store'
import type { AppPaths } from '@main/paths'
import type { Logger } from '@main/logger'
import { ensureDir, pathExists } from '@main/fs-utils'
import { StreamWriter } from '@main/stream-writer'
import { humanBytes } from '@shared/format'
import { renderHtmlReport } from './html-report'
import { writeAscMhlManifest, writeMhlV1Manifest, type ManifestContext, type ManifestResult } from './manifests'

export interface WriteRevisionInput {
  job: CopyJob
  project: ProjectInfo
  store: Store
  sourceLabel: string
  targets: CopyTarget[]
  hostname: string
  toolName: string
  toolVersion: string
  now: Date
  /** 是否同时把清单写进各目标盘根目录（ASC MHL 的标准做法） */
  writeManifestToTargets: boolean
  /** 在 HTML 里展开多少条文件明细 */
  htmlFileRowLimit?: number
}

export interface WriteRevisionResult {
  revision: ReportRevision
  extraNotes: string[]
}

export class ReportStore {
  constructor(
    private readonly paths: AppPaths,
    private readonly logger: Logger
  ) {}

  /** 任务的工作目录（含探测产生的首尾帧）。 */
  jobDir(jobId: string): string {
    return join(this.paths.reportsDir, jobId)
  }

  /** 探测阶段首尾帧的落地位置。 */
  frameWorkDir(jobId: string): string {
    return join(this.jobDir(jobId), 'frames')
  }

  revisionDir(jobId: string, revision: string): string {
    return join(this.jobDir(jobId), revision)
  }

  /** 列出一个任务已有的全部修订（读数据库，不扫磁盘）。 */
  list(store: Store, jobId: string): ReportRevision[] {
    return store.listReports(jobId)
  }

  async writeRevision(input: WriteRevisionInput): Promise<WriteRevisionResult> {
    const { job, store, project } = input
    const revision = store.nextRevision(job.id)
    const dir = this.revisionDir(job.id, revision)

    if (await pathExists(dir)) {
      // 只有并发或人工误操作才可能走到这里，必须炸掉而不是写进去
      throw new Error(`修订目录 ${dir} 已存在。为避免覆盖历史报告，本次写入已中止。`)
    }

    store.resetInFlightFiles(job.id)

    await ensureDir(dir)
    await ensureDir(join(dir, 'frames'))
    await ensureDir(join(dir, 'manifest'))

    const notes: string[] = []
    const targetProgress = store.listTargetProgress(job.id)
    const summary = this.buildSummary(job, project, revision, targetProgress, input)

    const manifestContext: ManifestContext = {
      job,
      project,
      sourceLabel: input.sourceLabel,
      revision,
      hostname: input.hostname,
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      now: input.now,
      targetLabels: targetProgress.map((target) => target.label)
    }

    // 1) 清单：先写进各目标盘（标准做法，清单随素材走），再在报告目录留一份副本
    const manifestPaths: string[] = []
    let manifestResult: ManifestResult | null = null

    const writeManifest = async (root: string): Promise<ManifestResult> =>
      job.manifestFormat === 'asc-mhl-2.0'
        ? writeAscMhlManifest(root, manifestContext, store.iterateFiles(job.id))
        : writeMhlV1Manifest(root, manifestContext, store.iterateFiles(job.id))

    if (input.writeManifestToTargets) {
      for (const target of input.targets) {
        if (!target.enabled) continue
        try {
          const result = await writeManifest(target.path)
          manifestPaths.push(join(target.path, result.relPath))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          notes.push(`清单写入目标「${target.label}」失败：${message}`)
          this.logger.error('reports', `清单写入失败：${target.path} —— ${message}`)
        }
      }
    }

    try {
      manifestResult = await writeManifest(join(dir, 'manifest'))
      manifestPaths.push(join(dir, 'manifest', manifestResult.relPath))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      notes.push(`清单副本生成失败：${message}`)
      this.logger.error('reports', `清单副本生成失败：${message}`)
    }

    // 2) 首尾帧：把探测阶段产生、且被本次报告引用的图拷进修订目录
    const frameNames = await this.collectReferencedFrames(store, job.id)
    let copiedFrames = 0
    for (const name of frameNames) {
      const from = join(this.frameWorkDir(job.id), name)
      if (!(await pathExists(from))) continue
      try {
        await copyFile(from, join(dir, 'frames', basename(name)))
        copiedFrames++
      } catch {
        /* 少一张缩略图不是问题 */
      }
    }

    // 3) report.json —— 完整逐文件记录
    const jsonPath = join(dir, 'report.json')
    await this.writeJsonReport(jsonPath, job, project, summary, store, manifestResult, notes)

    // 4) report.html —— 自包含离线网页
    const htmlPath = join(dir, 'report.html')
    const html = await renderHtmlReport({
      summary,
      job,
      project,
      targets: targetProgress,
      totalFiles: summary.totalFiles,
      files: store.iterateFiles(job.id),
      fileRowLimit: input.htmlFileRowLimit ?? 2000,
      hostname: input.hostname,
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      manifestPaths,
      notes
    })
    await writeFile(htmlPath, html, 'utf8')

    if (copiedFrames > 0) {
      notes.push(`已归档 ${copiedFrames} 张首尾帧缩略图（frames/ 目录）。`)
    }

    // 5) 落库
    const row: ReportRevision = {
      id: 0,
      jobId: job.id,
      revision,
      createdAt: input.now.toISOString(),
      dir,
      files: { json: jsonPath, html: htmlPath },
      summary
    }
    store.insertReport(row)

    this.logger.info(
      'reports',
      `已生成报告修订 ${revision}：${humanBytes(summary.totalBytes)} / ${summary.totalFiles} 个文件`
    )

    return { revision: { ...row, files: { ...row.files } }, extraNotes: notes }
  }

  /** PDF 生成完之后回填路径。 */
  attachPdf(store: Store, jobId: string, revision: string, pdfPath: string): void {
    const existing = store.listReports(jobId).find((item) => item.revision === revision)
    if (existing === undefined) return
    store.updateReportFiles(jobId, revision, { ...existing.files, pdf: pdfPath })
  }

  /**
   * 把报告里引用的 `frames/*.jpg` 内联为 base64 data URI，让 report.html
   * 成为真正的**单文件**：把 HTML 单独发到微信、邮件里，首帧图也照样显示。
   *
   * 这是报告"离线自包含"承诺的最后一环 —— 相对路径引用在"整个文件夹一起走"
   * 时是对的，但最常见的分享方式恰恰是只发那一个 HTML 文件。
   *
   * 设有总量预算（64MB）：几千条素材的报告若全部内联会膨胀到不可用，
   * 超出预算的图保留相对路径引用（frames/ 目录仍在修订目录里归档）。
   * 返回值告诉调用方内联了多少张、有多少张超出预算没内联。
   */
  async inlineReportFrames(
    revision: ReportRevision,
    budgetBytes = 64 * 1024 * 1024
  ): Promise<{ inlined: number; skipped: number }> {
    const htmlPath = revision.files.html
    if (htmlPath === undefined) return { inlined: 0, skipped: 0 }

    let html: string
    try {
      html = await readFile(htmlPath, 'utf8')
    } catch {
      return { inlined: 0, skipped: 0 }
    }

    const framesDir = join(dirname(htmlPath), 'frames')
    const pattern = /src="frames\/([^"]+)"/g
    const matches = [...html.matchAll(pattern)]
    if (matches.length === 0) return { inlined: 0, skipped: 0 }

    let used = 0
    let inlined = 0
    let skipped = 0
    const parts: string[] = []
    let cursor = 0

    for (const match of matches) {
      const start = match.index
      const full = match[0]
      if (start === undefined) continue
      parts.push(html.slice(cursor, start))
      cursor = start + full.length

      const name = decodeURIComponent(match[1] ?? '')
      let dataUri: string | null = null
      try {
        const jpeg = await readFile(join(framesDir, name))
        if (used + jpeg.length <= budgetBytes) {
          used += jpeg.length
          dataUri = `data:image/jpeg;base64,${jpeg.toString('base64')}`
        }
      } catch {
        /* 图不在了就保持原样 */
      }

      if (dataUri === null) {
        skipped++
        parts.push(full)
      } else {
        inlined++
        parts.push(`src="${dataUri}"`)
      }
    }
    parts.push(html.slice(cursor))

    await writeFile(htmlPath, parts.join(''), 'utf8')
    return { inlined, skipped }
  }

  private buildSummary(
    job: CopyJob,
    project: ProjectInfo,
    revision: string,
    targetProgress: TargetProgress[],
    input: WriteRevisionInput
  ): ReportSummary {
    const startedAt = job.startedAt === null ? null : Date.parse(job.startedAt)
    const finishedAt = job.finishedAt === null ? null : Date.parse(job.finishedAt)
    const durationSeconds =
      startedAt !== null && finishedAt !== null && Number.isFinite(startedAt) && Number.isFinite(finishedAt)
        ? Math.max(0, (finishedAt - startedAt) / 1000)
        : null

    return {
      jobId: job.id,
      jobName: job.name,
      revision,
      createdAt: input.now.toISOString(),
      jobState: job.state,
      sourcePath: job.sourcePath,
      sourceLabel: input.sourceLabel,
      hashAlgorithm: job.hashAlgorithm,
      manifestFormat: job.manifestFormat,
      totalFiles: job.totalFiles,
      totalBytes: job.totalBytes,
      verifiedFiles: job.filesDone,
      failedFiles: job.filesFailed,
      durationSeconds,
      targets: targetProgress.map((target) => ({
        targetId: target.targetId,
        label: target.label,
        path: input.targets.find((item) => item.id === target.targetId)?.path ?? '',
        filesCopied: target.filesDone,
        filesFailed: target.filesFailed,
        bytesCopied: target.bytesCopied
      })),
      project
    }
  }

  private async writeJsonReport(
    path: string,
    job: CopyJob,
    project: ProjectInfo,
    summary: ReportSummary,
    store: Store,
    manifest: ManifestResult | null,
    notes: string[]
  ): Promise<void> {
    const writer = new StreamWriter(createWriteStream(path, { encoding: 'utf8' }))

    const write = (chunk: string): Promise<void> => writer.write(chunk)

    const serialize = (value: unknown): string => JSON.stringify(value, null, 2)

    try {
      await write('{\n')
      await write(`  "summary": ${indentBlock(serialize(summary), 2)},\n`)
      await write(`  "project": ${indentBlock(serialize(project), 2)},\n`)
      await write(`  "job": ${indentBlock(serialize(job), 2)},\n`)
      await write(
        `  "manifest": ${indentBlock(manifest === null ? 'null' : serialize({ path: manifest.path, c4: manifest.c4, entries: manifest.entries }), 2)},\n`
      )
      await write(`  "notes": ${indentBlock(serialize(notes), 2)},\n`)

      // 逐文件记录单独流式写出，避免十万级文件的整体字符串占用
      await write('  "files": [\n')
      let first = true
      for await (const file of store.iterateFiles(job.id)) {
        if (!first) await write(',\n')
        first = false
        await write(indentBlock(serialize(compactFile(file)), 4))
      }
      await write('\n  ],\n')

      await write('  "failures": [\n')
      let firstFailure = true
      for await (const file of store.iterateFiles(job.id)) {
        if (file.state !== 'failed') continue
        if (!firstFailure) await write(',\n')
        firstFailure = false
        await write(
          indentBlock(
            serialize({
              relPath: file.relPath,
              sizeBytes: file.sizeBytes,
              error: file.error,
              results: file.results
            }),
            4
          )
        )
      }
      await write('\n  ]\n')
      await write('}\n')
    } finally {
      await writer.end()
    }
  }

  private async collectReferencedFrames(store: Store, jobId: string): Promise<string[]> {
    const names = new Set<string>()
    for await (const file of store.iterateFiles(jobId)) {
      if (file.probe === null) continue
      if (file.probe.firstFrame !== null) names.add(file.probe.firstFrame)
      if (file.probe.lastFrame !== null) names.add(file.probe.lastFrame)
    }
    return [...names]
  }

  /** 报告目录下已存在的修订（用于诊断磁盘与数据库不一致的情况）。 */
  async diskRevisions(jobId: string): Promise<string[]> {
    try {
      const entries = await readdir(this.jobDir(jobId), { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory() && /^R\d{3,}$/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
    } catch {
      return []
    }
  }

  /** 报告目录的父目录，供"在访达中显示"。 */
  get reportsRoot(): string {
    return this.paths.reportsDir
  }

  /** 相对报告目录的展示路径。 */
  displayPath(revision: ReportRevision): string {
    return `${revision.jobId}/${revision.revision}`
  }

  absoluteReportDir(jobId: string, revision: string): string {
    return this.revisionDir(jobId, revision)
  }

  dirnameOf(path: string): string {
    return dirname(path)
  }
}

/** 把一段 JSON 文本按层级缩进，用于拼装大文件。 */
function indentBlock(block: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return block
    .split('\n')
    .map((line, index) => (index === 0 ? pad + line : pad + line))
    .join('\n')
}

/** JSON 里每个文件只保留必要字段，避免报告膨胀。 */
function compactFile(file: CopyJobFile): Record<string, unknown> {
  return {
    relPath: file.relPath,
    sizeBytes: file.sizeBytes,
    state: file.state,
    sourceHash: file.sourceHash,
    error: file.error,
    probe: file.probe,
    targets: file.results.map((result) => ({
      targetId: result.targetId,
      state: result.state,
      hash: result.hash,
      hashMatch: result.hashMatch,
      bytesCopied: result.bytesCopied,
      error: result.error
    }))
  }
}

/** 供报告生成的默认格式说明。 */
export function describeManifestFormat(format: ManifestFormat): string {
  return format === 'asc-mhl-2.0' ? 'ASC MHL 2.0' : 'MHL v1（传统格式）'
}
