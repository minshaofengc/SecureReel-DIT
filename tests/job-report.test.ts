/**
 * 「报告必须说清楚这是什么报告」+「运行中不许生成报告」。
 *
 * 这一组测的是 JobManager 与报告层的**接线**，只测报告层是覆盖不到的 ——
 * 缺陷恰恰出在接线上：调用方拿到 writeRevision 返回的 extraNotes 数组，
 * 在报告**渲染之后**往里 push 了四条说明，然后整个数组被丢弃。
 * 结果是「执行说明」一节基本是空的，其中"这是仅校验任务的报告"最要紧：
 * 拿到报告的人分不清它是复核记录还是拷贝交付。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CopyJob, FileTargetResult, MainEvent } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { Store } from '../src/main/db/store'
import { Logger } from '../src/main/logger'
import { buildAppPaths, type AppPaths } from '../src/main/paths'
import { ReportStore } from '../src/main/reports/report-store'
import { JobManager } from '../src/main/core/job-manager'

let root = ''
let store: Store
let paths: AppPaths
let logger: Logger
let reportStore: ReportStore
let manager: JobManager
let events: MainEvent[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'securereel-jobreport-'))
  paths = buildAppPaths(join(root, 'userData'))
  store = await Store.openInMemory()
  logger = new Logger({ dir: '' })
  reportStore = new ReportStore(paths, logger)
  events = []
  manager = new JobManager({
    store,
    logger,
    paths,
    reportStore,
    // generateReports 用不到这两个；真跑引擎的那条用例另见 start() 路径
    probeRunner: { setFrameOutputDir: () => undefined } as never,
    hde: {} as never,
    getSettings: () => DEFAULT_SETTINGS,
    emit: (event) => {
      events.push(event)
    }
  })
})

afterEach(async () => {
  store.close()
  await rm(root, { recursive: true, force: true })
})

/** 直接落库一个已完成的校验任务（不跑引擎），用于测报告内容。 */
async function seedFinishedJob(
  state: CopyJob['state'],
  mode: CopyJob['mode']
): Promise<{ job: CopyJob; targetPath: string }> {
  const targetPath = join(root, 'BackupA')
  await mkdir(targetPath, { recursive: true })

  const job: CopyJob = {
    id: 'job_jobreport01',
    name: 'A002 卡备份',
    mode,
    sourcePath: join(root, 'A002R2EC'),
    sourceKind: 'generic',
    isCodExVfs: false,
    parentProjectId: null,
    targets: [
      { id: 'tgt_1', path: targetPath, label: 'BackupA', enabled: true, freeBytes: null, writable: true }
    ],
    hashAlgorithm: 'xxhash64',
    manifestFormat: 'asc-mhl-2.0',
    verifyAfterWrite: true,
    state,
    totalFiles: 2,
    totalBytes: 200,
    filesDone: 2,
    filesFailed: 0,
    bytesDone: 200,
    createdAt: new Date('2026-09-18T01:00:00.000Z').toISOString(),
    startedAt: new Date('2026-09-18T01:00:00.000Z').toISOString(),
    finishedAt: new Date('2026-09-18T01:05:00.000Z').toISOString(),
    degradationNotice: null
  }
  store.insertJob(job)
  store.upsertFiles(job.id, [
    { relPath: 'Clips/a.mov', sizeBytes: 100 },
    { relPath: 'Clips/b.mov', sizeBytes: 100 }
  ])
  for (const relPath of ['Clips/a.mov', 'Clips/b.mov']) {
    store.updateFile(job.id, relPath, { state: 'verified', sourceHash: 'aabbccdd' })
    const fileId = Number(store.getFileRow(job.id, relPath)?.id)
    const result: FileTargetResult = {
      targetId: 'tgt_1',
      state: 'verified',
      hash: 'aabbccdd',
      hashMatch: true,
      bytesCopied: 100,
      error: null
    }
    store.saveFileResult(fileId, job.id, result)
  }
  store.updateTargetProgress(job.id, 'tgt_1', { state: 'completed', filesDone: 2, bytesCopied: 200 })
  return { job, targetPath }
}

/** 读出一版报告的 HTML 与 report.json 里的 notes。 */
async function readReport(
  htmlPath: string,
  jsonPath: string
): Promise<{ html: string; notes: string[] }> {
  const html = await readFile(htmlPath, 'utf8')
  const json = JSON.parse(await readFile(jsonPath, 'utf8')) as { notes: string[] }
  return { html, notes: json.notes }
}

describe('报告必须写清楚自己是什么报告', () => {
  it('仅校验任务的报告里必须写明「仅校验」，否则分不清复核与拷贝交付', async () => {
    const { job } = await seedFinishedJob('completed', 'verify')
    const summary = await manager.generateReports(job.id, 'completed')

    const { html, notes } = await readReport(
      join(paths.reportsDir, job.id, summary.revision, 'report.html'),
      join(paths.reportsDir, job.id, summary.revision, 'report.json')
    )

    expect(html).toContain('执行说明')
    expect(html).toContain('仅校验')
    expect(notes.some((note) => note.includes('仅校验'))).toBe(true)
  })

  it('校验模式的报告要写清「未向目标盘写入或删除任何数据」', async () => {
    const { job } = await seedFinishedJob('completed', 'verify')
    const summary = await manager.generateReports(job.id, 'completed')
    const html = await readFile(join(paths.reportsDir, job.id, summary.revision, 'report.html'), 'utf8')

    // 同时确认哨兵句在：「未向目标盘写入或删除任何数据」
    expect(html).toContain('未向目标盘写入或删除任何数据')
  })

  it('未正常结束的任务，报告里必须写明当时的状态', async () => {
    const { job } = await seedFinishedJob('cancelled', 'copy')
    const summary = await manager.generateReports(job.id, 'cancelled')

    const { html, notes } = await readReport(
      join(paths.reportsDir, job.id, summary.revision, 'report.html'),
      join(paths.reportsDir, job.id, summary.revision, 'report.json')
    )

    expect(html).toContain('未正常结束')
    expect(html).toContain('cancelled')
    expect(notes.some((note) => note.includes('未正常结束'))).toBe(true)
  })

  it('report.json 的 notes 与 HTML 的「执行说明」是同一批', async () => {
    const { job } = await seedFinishedJob('completed', 'verify')
    const summary = await manager.generateReports(job.id, 'completed')
    const { html, notes } = await readReport(
      join(paths.reportsDir, job.id, summary.revision, 'report.html'),
      join(paths.reportsDir, job.id, summary.revision, 'report.json')
    )

    expect(notes.length).toBeGreaterThan(0)
    for (const note of notes) {
      // HTML 里会做 XML 转义，用前缀片段比对即可
      expect(html).toContain(note.slice(0, 12).replace(/&/g, '&amp;'))
    }
  })

  it('正常跑完的拷贝任务不会被塞进多余的说明', async () => {
    const { job } = await seedFinishedJob('completed', 'copy')
    const summary = await manager.generateReports(job.id, 'completed')
    const html = await readFile(join(paths.reportsDir, job.id, summary.revision, 'report.html'), 'utf8')

    expect(html).not.toContain('仅校验')
    expect(html).not.toContain('未正常结束')
  })
})

describe('任务运行中不许生成报告', () => {
  it('运行中调用生成报告会被拒绝，且不会改动任何文件状态', async () => {
    // 造一份小素材：引擎会在处理第一个文件前的暂停检查点挂住
    const source = join(root, 'source')
    await mkdir(join(source, 'Clips'), { recursive: true })
    await writeFile(join(source, 'Clips/a.mov'), Buffer.alloc(1024, 7))
    await writeFile(join(source, 'Clips/b.mov'), Buffer.alloc(1024, 9))

    const targetPath = join(root, 'target1')
    await mkdir(targetPath, { recursive: true })

    const job: CopyJob = {
      id: 'job_running001',
      name: '运行中的任务',
      mode: 'copy',
      sourcePath: source,
      sourceKind: 'generic',
      isCodExVfs: false,
      parentProjectId: null,
      targets: [
        { id: 'tgt_1', path: targetPath, label: '目标1', enabled: true, freeBytes: null, writable: true }
      ],
      hashAlgorithm: 'xxhash64',
      manifestFormat: 'asc-mhl-2.0',
      verifyAfterWrite: true,
      state: 'draft',
      totalFiles: 2,
      totalBytes: 2048,
      filesDone: 0,
      filesFailed: 0,
      bytesDone: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      degradationNotice: null
    }
    store.insertJob(job)
    store.upsertFiles(job.id, [
      { relPath: 'Clips/a.mov', sizeBytes: 1024 },
      { relPath: 'Clips/b.mov', sizeBytes: 1024 }
    ])

    await manager.start(job.id)
    manager.pause(job.id)

    const pendingBefore = store.fileStateCounts(job.id).pending

    await expect(manager.generateReports(job.id)).rejects.toThrow(/运行/)
    // 关键：一次都不许把 copying / verifying 打回 pending，否则引擎会重做这些文件
    expect(store.fileStateCounts(job.id).pending).toBe(pendingBefore)
    expect(store.listReports(job.id)).toEqual([])

    manager.cancel(job.id)
    await manager.wait(job.id)

    // 跑完之后 JobManager 自己出的那份报告不能被这道闸门误伤
    expect(store.listReports(job.id).length).toBe(1)
  })
})
