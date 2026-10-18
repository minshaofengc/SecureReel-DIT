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
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  CopyJob,
  CopyJobFile,
  CopyTarget,
  ManifestFormat,
  ProjectInfo,
  ReportRevision,
  ReportSummary,
  ReportTheme,
  TargetProgress
} from '@shared/types'
import type { Store } from '@main/db/store'
import type { AppPaths } from '@main/paths'
import type { Logger } from '@main/logger'
import {
  describeError,
  ensureDir,
  pathExists,
  safeFolderName,
  targetRelativePath
} from '@main/fs-utils'
import { StreamWriter } from '@main/stream-writer'
import { reportTimestamp, humanBytes } from '@shared/format'
import { renderHtmlReport } from './html-report'
import {
  writeAscMhlManifest,
  writeCsvManifest,
  writeJsonManifest,
  writeMhlV1Manifest,
  type ManifestContext,
  type ManifestResult
} from './manifests'

/**
 * 清单条目的路径转换：把"源内相对路径"换成"目标盘上的相对路径"。
 *
 * 清单的用途是拿它去核对目标盘上的文件，所以里面必须写**盘上真实存在的路径**。
 * 前缀规则与拷贝引擎共用 `targetRelativePath()` —— 两边各算各的话，
 * 就会出现"清单里列了它、盘上却找不到"这种最难查的问题。
 */
async function* manifestEntries(job: CopyJob, store: Store): AsyncIterable<CopyJobFile> {
  for await (const file of store.iterateFiles(job.id)) {
    const relPath = targetRelativePath(job.sourceRootName, file.relPath)
    yield relPath === file.relPath ? file : { ...file, relPath }
  }
}

export interface WriteRevisionInput {
  theme?: ReportTheme
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
  /**
   * 渲染报告**之前**就已经确定的附注，会写进报告的「执行说明」一节。
   *
   * 为什么要走参数而不是让调用方拿返回值往里补：报告是先渲染再落盘的，
   * 渲染之后再怎么 push 都进不去 —— 曾经调用方拿到一个 `extraNotes` 数组、
   * push 了四条说明（未正常结束 / 仅校验模式 / PDF 缺图 / 内联跳过），
   * 然后整个数组被丢弃，「执行说明」一节基本是空的。
   * 附注必须在渲染前交进来，这条路才走得通。
   */
  preNotes?: string[]
  /**
   * 报告落地的**根目录**覆盖（对应设置里的 `reportOutputDir`）。
   *
   * 省略 / null = 用默认的本机目录 `<userData>/reports/`。
   * 指定绝对路径时，报告改造到该目录下（仍按 `<jobId>/R00N/` 建子结构），
   * 于是用户可以把它直接指到外接盘或项目交付目录。
   */
  outputBaseDir?: string | null
}

export interface WriteRevisionResult {
  revision: ReportRevision
}

/**
 * 目标盘上存放报告的顶层目录名。
 *
 * 单独占一个目录、而不是把文件散在盘根，是为了让"素材"和"交付记录"
 * 一眼分得开；名字用工具名，跟其他 DIT 软件在盘上留品牌目录的惯例一致。
 */
export const TARGET_REPORT_FOLDER = 'SecureReel'

export interface PublishToTargetsInput {
  job: CopyJob
  revision: ReportRevision
  targets: CopyTarget[]
  hostname: string
  toolName: string
  toolVersion: string
  now: Date
}

export interface PublishToTargetsResult {
  /** 成功写入的盘（用标签，给人看） */
  published: string[]
  /** 失败的盘与原因 */
  failed: { label: string; reason: string }[]
  /** 每个盘上那份副本的相对路径（相对盘根），供日志与界面显示 */
  relativeDirs: string[]
  deliveries: NonNullable<ReportRevision['delivery']>
}

/**
 * 生成随报告一起交付的纯文本说明。
 *
 * 为什么除了 HTML/PDF 还要多这一份：能双击打开 HTML 的人会看报告，
 * 但现场更常见的是有人 `ls` 一下盘、或者用脚本批量核对交付物。
 * 一份纯文本说明是最省事的入口 —— 它把"这次拷了什么、怎么验的、
 * 怎么复核"三句话讲清楚，不需要任何工具。
 */
async function renderDeliveryNote(
  input: PublishToTargetsInput,
  target: CopyTarget
): Promise<string> {
  const { revision, job } = input
  const summary = revision.summary
  const html = revision.files.html === undefined ? '' : await readFile(revision.files.html, 'utf8')
  const frameDependencies = /src=["']frames\//i.test(html)
  const snapshot =
    revision.files.json === undefined
      ? null
      : (JSON.parse(await readFile(revision.files.json, 'utf8')) as {
          files: CopyJobFile[]
          manifest: { path: string } | null
          notes: string[]
        })
  const targetSummary = summary.targets.find((item) => item.targetId === target.id)
  const proxyLines = (snapshot?.files ?? []).flatMap((file) => {
    const proxy = file.probe?.proxy
    if (proxy === undefined || proxy === null) return []
    const result = proxy.targets?.find((item) => item.targetId === target.id)
    const state = result?.state ?? proxy.status ?? (proxy.ok ? 'verified' : 'failed')
    const stateText =
      state === 'verified'
        ? '已校验交付'
        : state === 'skipped'
          ? '跳过'
          : state === 'failed'
            ? '失败'
            : '未完成'
    const relPath = result === undefined ? proxy.relPath : result.relPath
    const reason = result === undefined ? proxy.reason : result.error
    return [
      `  ${file.relPath}：${stateText}${relPath ? ` → ${relPath}` : ''}${reason ? `（${reason}）` : ''}`
    ]
  })
  const manifestHelp: Record<ManifestFormat, string> = {
    'asc-mhl-2.0': 'ASC MHL 清单：使用支持 ASC MHL 2.0 的工具复核。',
    'mhl-v1': 'MHL v1 清单：使用支持 MHL v1 的工具复核。',
    csv: 'CSV 清单：用表格工具查看路径、算法和校验值；表格本身不会自动校验素材。',
    json: 'JSON 清单：使用支持本清单结构的脚本逐文件计算并比较校验值。'
  }
  const resultText =
    summary.jobState === 'completed' && summary.failedFiles === 0
      ? '原始素材拷贝完成；代理及报告交付请查看各自状态'
      : `任务状态 ${summary.jobState}；原始素材通过 ${summary.verifiedFiles}，失败 ${summary.failedFiles}，未完成 ${Math.max(0, summary.totalFiles - summary.verifiedFiles - summary.failedFiles)}`
  return [
    `${input.toolName} 交付说明`,
    '='.repeat(48),
    '',
    `修订号：${revision.revision}`,
    `任务名称：${summary.jobName}`,
    `生成时间：${reportTimestamp(revision.createdAt)}`,
    `生成机器：${input.hostname}`,
    `工具版本：${input.toolName} ${input.toolVersion}`,
    '',
    '【原始素材】',
    `  来源路径：${summary.sourcePath}`,
    `  本目标：${target.label}（${target.path}）`,
    `  素材相对目录：${job.sourceRootName || '.'}`,
    `  结果：${resultText}`,
    `  文件数量：${summary.totalFiles}`,
    `  数据量：${humanBytes(summary.totalBytes)}`,
    `  校验算法：${summary.hashAlgorithm}`,
    ...(targetSummary === undefined
      ? []
      : [`  本目标通过：${targetSummary.filesCopied}；失败：${targetSummary.filesFailed}`]),
    '  原始素材副本与源侧校验值经独立重读比对；代理另列结果，不代表与原片字节相同。',
    '',
    '【代理素材】',
    ...(proxyLines.length > 0
      ? proxyLines
      : [job.proxyEnabled ? '  未记录可交付代理，请勿视为代理已完成。' : '  本任务未开启代理。']),
    '',
    '【本目录里有什么】',
    ...(revision.files.html === undefined
      ? []
      : [
          `  report.html    离线报告${frameDependencies ? '（依赖 frames/ 图片目录，转交时保留完整目录）' : '（图片已内联或无需外部图片，可单文件打开）'}`
        ]),
    ...(revision.files.pdf === undefined ? [] : ['  report.pdf     适合打印和归档的报告']),
    ...(revision.files.json === undefined ? [] : ['  report.json    完整逐文件记录和代理状态']),
    ...(snapshot?.manifest === null || snapshot?.manifest === undefined
      ? []
      : [`  manifest/      ${summary.manifestFormat} 清单副本`]),
    '',
    '【怎么复核】',
    `  ${manifestHelp[summary.manifestFormat]}`,
    '  查看本目录 manifest/ 下的实际清单；目标盘清单写入失败等说明见下方。',
    '  在本工具运行「仅校验」可重新读取比对原始素材；该模式不写入或删除目标盘内容。',
    ...(snapshot?.notes.length
      ? ['', '【执行说明】', ...snapshot.notes.map((note) => `  ${note}`)]
      : []),
    ''
  ].join('\n')
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
    // 报告根目录：设置里指定了就写过去，否则用默认的本机 reports 目录。
    const baseDir = input.outputBaseDir ?? this.paths.reportsDir
    const dir = join(baseDir, job.id, revision)

    if (await pathExists(dir)) {
      // 只有并发或人工误操作才可能走到这里，必须炸掉而不是写进去
      throw new Error(`修订目录 ${dir} 已存在。为避免覆盖历史报告，本次写入已中止。`)
    }

    /*
     * 这里**刻意不**再调用 `store.resetInFlightFiles(job.id)`。
     *
     * 写报告不该改动文件状态。而 resetInFlightFiles 会把 copying / verifying
     * 的行改回 pending —— 如果任务正在跑，引擎下一批 listPendingFiles 就会
     * 把同一批文件再处理一遍：重复拷贝、filesDone 翻倍，两个线程同时提交
     * 同一个分片时还会让健康盘被误判隔离。
     *
     * 归零残留状态是任务**开始**时的动作，已经在 copy-engine.run() 里做了。
     * 调用方的契约：写报告前必须确认该任务没有在运行
     * （由 JobManager.generateReports 把守）。
     */

    await ensureDir(dir)
    await ensureDir(join(dir, 'frames'))
    await ensureDir(join(dir, 'manifest'))

    // 调用方在渲染前交进来的附注（未正常结束 / 仅校验模式）排在最前面 ——
    // 「这份报告是什么」比后面那些执行细节更该被先看到。
    const notes: string[] = [...(input.preNotes ?? [])]
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

    /*
     * 清单格式的分发。
     *
     * 每次都重新调 `manifestEntries()` —— 它是 async generator，
     * 一次调用只能被消费一遍。写成"先在外面建好 iterable 再复用"会在
     * 写第二个目标盘时得到一份**空清单**，而且不报错。
     */
    const writeManifest = async (root: string): Promise<ManifestResult> => {
      switch (job.manifestFormat) {
        case 'asc-mhl-2.0':
          return writeAscMhlManifest(root, manifestContext, manifestEntries(job, store))
        case 'mhl-v1':
          return writeMhlV1Manifest(root, manifestContext, manifestEntries(job, store))
        case 'csv':
          return writeCsvManifest(root, manifestContext, manifestEntries(job, store))
        case 'json':
          return writeJsonManifest(root, manifestContext, manifestEntries(job, store))
        default: {
          const never: never = job.manifestFormat
          throw new Error(`未知清单格式：${String(never)}`)
        }
      }
    }

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

    // 这一条必须在渲染之前记上 —— 它曾经写在 renderHtmlReport() 之后，
    // 结果 HTML 和 report.json 里都看不到，等于白算。
    if (copiedFrames > 0) {
      notes.push(`已归档 ${copiedFrames} 张首尾帧缩略图（frames/ 目录）。`)
    }

    // 2b) 代理生成情况汇总 —— 出了多少、跳过多少、为什么跳过。
    // 代理是可选产出，成功不必大书特书，但"哪些没出、为什么"必须说清楚。
    const proxyStat = await this.summarizeProxies(store, job.id)
    if (proxyStat.requested > 0) {
      if (proxyStat.skipped > 0) {
        notes.push(
          `代理素材：已生成 ${proxyStat.ok} 条，未完成或跳过 ${proxyStat.skipped} 条（逐条原因与各目标状态见代理素材明细）。`
        )
      } else if (proxyStat.ok > 0) {
        notes.push(
          `代理素材：已为 ${proxyStat.ok} 条素材生成代理（实际编码规格与各目标路径见代理素材明细）。`
        )
      }
    }

    // 3) report.json —— 完整逐文件记录
    const jsonPath = join(dir, 'report.json')
    await this.writeJsonReport(jsonPath, job, project, summary, store, manifestResult, notes)

    // 4) report.html —— 自包含离线网页
    const htmlPath = join(dir, 'report.html')
    const html = await renderHtmlReport({
      summary,
      theme: input.theme ?? 'delivery',
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

    // 5) 落库
    const row: ReportRevision = {
      theme: input.theme ?? 'delivery',
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

    return { revision: { ...row, files: { ...row.files } } }
  }

  /** PDF 生成完之后回填路径。 */
  attachPdf(store: Store, jobId: string, revision: string, pdfPath: string): void {
    const existing = store.listReports(jobId).find((item) => item.revision === revision)
    if (existing === undefined) return
    store.updateReportFiles(jobId, revision, { ...existing.files, pdf: pdfPath })
  }

  /**
   * 把一份修订目录复制到各目标盘。
   *
   * 为什么报告也要跟着素材走：报告只留在本机时，盘一旦交给别人
   * （剪辑、甲方、归档），就等于没有交付凭证。其他 DIT 工具的惯例
   * 也是在盘上留一份。
   *
   * 落点：`<目标盘根>/SecureReel/<任务名>_R001/`。用任务名而不是内部
   * jobId，是因为这个名字要给人看、给人在访达里找。
   *
   * 三条硬约束：
   *   1. 仅校验模式**一个字节都不写目标盘**（连目录都不建）
   *   2. 目标上已有同名目录时中止并记日志，绝不合并、绝不覆盖
   *   3. 复制失败只影响这一份副本，绝不影响任务结果与本机报告
   */
  async publishToTargets(input: PublishToTargetsInput): Promise<PublishToTargetsResult> {
    const { job, revision, targets } = input
    const published: string[] = []
    const failed: { label: string; reason: string }[] = []
    const relativeDirs: string[] = []
    const deliveries: NonNullable<ReportRevision['delivery']> = []

    // 仅校验模式只读比对，不写任何字节 —— 这条没有例外
    if (job.mode === 'verify') return { published, failed, relativeDirs, deliveries }

    const source = revision.dir
    if (!(await pathExists(source))) {
      return {
        published,
        failed: [{ label: '本机报告目录', reason: '修订目录不存在，无法复制' }],
        relativeDirs,
        deliveries: targets
          .filter((t) => t.enabled)
          .map((t) => ({
            targetId: t.id,
            label: t.label,
            state: 'failed' as const,
            reason: '修订目录不存在'
          }))
      }
    }

    const name = safeFolderName(job.name)
    const subdir = `${name === '' ? job.id : name}_${revision.revision}`
    const relative = join(TARGET_REPORT_FOLDER, subdir)

    for (const target of targets) {
      if (!target.enabled) continue
      const dest = join(target.path, relative)

      if (await pathExists(dest)) {
        // 绝不覆盖：宁可少一份副本，也不能把上一次的交付记录洗掉
        deliveries.push({
          targetId: target.id,
          label: target.label,
          state: 'failed',
          reason: `${relative} 已存在，未覆盖`
        })
        failed.push({ label: target.label, reason: `${relative} 已存在，未覆盖` })
        continue
      }

      let ownsDestination = false
      try {
        await ensureDir(dirname(dest))
        await mkdir(dest)
        ownsDestination = true
        for (const name of await readdir(source)) {
          await cp(join(source, name), join(dest, name), {
            recursive: true,
            force: false,
            errorOnExist: true
          })
        }
        await writeFile(join(dest, '交付说明.txt'), await renderDeliveryNote(input, target), 'utf8')
        deliveries.push({
          targetId: target.id,
          label: target.label,
          state: 'published',
          path: dest
        })
        published.push(target.label)
        relativeDirs.push(relative)
      } catch (error) {
        /*
         * 只清掉**本次刚创建的那份半成品**：留着它会让下一次以为
         * "已经有一份了"而永远不再重试。
         * 删的绝不是用户素材，也不是上一次留下的副本 —— 那种情况在
         * 上面那个 pathExists 分支就已经中止了。
         */
        if (ownsDestination) await rm(dest, { recursive: true, force: true }).catch(() => undefined)
        deliveries.push({
          targetId: target.id,
          label: target.label,
          state: 'failed',
          reason: describeError(error)
        })
        failed.push({ label: target.label, reason: describeError(error) })
      }
    }

    return { published, failed, relativeDirs: [...new Set(relativeDirs)], deliveries }
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
      startedAt !== null &&
      finishedAt !== null &&
      Number.isFinite(startedAt) &&
      Number.isFinite(finishedAt)
        ? Math.max(0, (finishedAt - startedAt) / 1000)
        : null

    return {
      backupSafety: job.backupSafety,
      theme: input.theme ?? 'delivery',
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

  /**
   * 汇总代理生成情况。
   *
   * 只统计"被要求出代理"的文件（probe.proxy 非 null）：没开代理的文件
   * proxy 是 null，不该被算进分母 —— 否则一条纯音频的卡也会显示"跳过 N 条"。
   */
  private async summarizeProxies(
    store: Store,
    jobId: string
  ): Promise<{ requested: number; ok: number; skipped: number }> {
    let requested = 0
    let ok = 0
    for await (const file of store.iterateFiles(jobId)) {
      const proxy = file.probe?.proxy
      if (proxy === undefined || proxy === null) continue
      requested++
      if (proxy.ok) ok++
    }
    return { requested, ok, skipped: requested - ok }
  }

  private async collectReferencedFrames(store: Store, jobId: string): Promise<string[]> {
    const names = new Set<string>()
    for await (const file of store.iterateFiles(jobId)) {
      if (file.probe === null) continue
      if (file.probe.firstFrame !== null) names.add(file.probe.firstFrame)
      if (file.probe.lastFrame !== null) names.add(file.probe.lastFrame)
      // 候选静帧同样要归档进修订目录，否则 HTML 里的 <img> 会指向不存在的图
      for (const still of file.probe.stillFrames ?? []) names.add(still)
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
