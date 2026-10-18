/**
 * 「报告必须说清楚这是什么报告」+「运行中不许生成报告」。
 *
 * 这一组测的是 JobManager 与报告层的**接线**，只测报告层是覆盖不到的 ——
 * 缺陷恰恰出在接线上：调用方拿到 writeRevision 返回的 extraNotes 数组，
 * 在报告**渲染之后**往里 push 了四条说明，然后整个数组被丢弃。
 * 结果是「执行说明」一节基本是空的，其中"这是仅校验任务的报告"最要紧：
 * 拿到报告的人分不清它是复核记录还是拷贝交付。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CopyJob, FileTargetResult, MainEvent } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { Store } from '../src/main/db/store'
import { Logger } from '../src/main/logger'
import { buildAppPaths, type AppPaths } from '../src/main/paths'
import { ReportStore } from '../src/main/reports/report-store'
import { CopyEngine } from '../src/main/core/copy-engine'
import * as volumeActions from '../src/main/volumes'
import { JobManager } from '../src/main/core/job-manager'

let root = ''
let store: Store
let paths: AppPaths
let logger: Logger
let testSettings = { ...DEFAULT_SETTINGS }
let reportStore: ReportStore
let manager: JobManager
let events: MainEvent[]

beforeEach(async () => {
  testSettings = { ...DEFAULT_SETTINGS }
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
    // Report/finalization fixtures simulate device evidence at the OS boundary.
    // Actual storage blocking, consent and replacement are tested independently.
    storagePreflight: async (input) => ({
      fingerprint: 'report-fixture-devices',
      checkedAt: new Date().toISOString(),
      source: {
        path: input.sourcePath,
        label: 'Source',
        filesystemId: 'source',
        physicalDeviceIds: ['source-disk'],
        capacityPoolId: 'source',
        availableBytes: 1000000000,
        present: true
      },
      targets: input.targets.map((path, index) => ({
        path,
        label: 'Backup',
        filesystemId: `target-${index}`,
        physicalDeviceIds: [`target-disk-${index}`],
        capacityPoolId: `target-${index}`,
        availableBytes: 1000000000,
        present: true
      })),
      groups: [],
      risks: [],
      blockingReasons: [],
      requiredBytes: input.requiredBytes,
      independentDeviceGroups: input.targets.length
    }),
    // generateReports 用不到这两个；真跑引擎的那条用例另见 start() 路径
    probeRunner: {
      setFrameOutputDir: () => undefined,
      setStillFrameOutputDir: () => undefined,
      setStillFrameCount: () => undefined
    } as never,
    hde: {} as never,
    getSettings: () => testSettings,
    emit: (event) => {
      events.push(event)
    }
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
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
    sourceRootName: '',
    sourceKind: 'generic',
    isCodExVfs: false,
    parentProjectId: null,
    targets: [
      {
        id: 'tgt_1',
        path: targetPath,
        label: 'BackupA',
        enabled: true,
        freeBytes: null,
        writable: true
      }
    ],
    hashAlgorithm: 'xxhash64',
    manifestFormat: 'asc-mhl-2.0',
    verifyAfterWrite: true,
    proxyEnabled: false,
    proxyResolution: '1080p',
    proxyCodec: 'prores',
    proxyProfile: '422-proxy',
    proxyLutPath: null,
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
  store.updateTargetProgress(job.id, 'tgt_1', {
    state: 'completed',
    filesDone: 2,
    bytesCopied: 200
  })
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
    const html = await readFile(
      join(paths.reportsDir, job.id, summary.revision, 'report.html'),
      'utf8'
    )

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
    const html = await readFile(
      join(paths.reportsDir, job.id, summary.revision, 'report.html'),
      'utf8'
    )

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
      sourceRootName: '',
      sourceKind: 'generic',
      isCodExVfs: false,
      parentProjectId: null,
      targets: [
        {
          id: 'tgt_1',
          path: targetPath,
          label: '目标1',
          enabled: true,
          freeBytes: null,
          writable: true
        }
      ],
      hashAlgorithm: 'xxhash64',
      manifestFormat: 'asc-mhl-2.0',
      verifyAfterWrite: true,
      proxyEnabled: false,
      proxyResolution: '1080p',
      proxyCodec: 'prores',
      proxyProfile: '422-proxy',
      proxyLutPath: null,
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

describe('2.0.7 报告接线', () => {
  it('预览所选主题而不生成任何修订或目录', async () => {
    const { job } = await seedFinishedJob('completed', 'copy')
    const html = await manager.previewReport(job.id, 'print')
    expect(html).toContain('data-report-theme="print"')
    expect(html).toContain('Clips/a.mov')
    expect(store.listReports(job.id)).toEqual([])
    await expect(readFile(join(paths.reportsDir, job.id, 'R001', 'report.html'))).rejects.toThrow()
  })

  it('遗留运行状态没有句柄时也禁止生成正式报告与预览', async () => {
    const { job } = await seedFinishedJob('paused', 'copy')
    await expect(manager.generateReports(job.id)).rejects.toThrow(/运行/)
    await expect(manager.previewReport(job.id, 'delivery')).rejects.toThrow(/运行/)
    expect(store.listReports(job.id)).toEqual([])
  })

  it('生成主题和逐目标报告交付状态持久化', async () => {
    const { job, targetPath } = await seedFinishedJob('completed', 'copy')
    const summary = await manager.generateReports(job.id, undefined, 'technical')
    const revision = store.listReports(job.id)[0]
    expect(revision?.theme).toBe('technical')
    expect(revision?.delivery).toEqual([
      {
        targetId: 'tgt_1',
        label: 'BackupA',
        state: 'published',
        path: join(targetPath, 'SecureReel', `${job.name}_R001`)
      }
    ])
    expect(summary.delivery).toEqual(revision?.delivery)
  })
})

it('同名目标盘的交付结果按目标编号区分', async () => {
  const { job } = await seedFinishedJob('completed', 'copy')
  const path = join(root, 'BackupB')
  await mkdir(path)
  const target = { ...job.targets[0]!, id: 'tgt_duplicate', path }
  store.addTarget(job.id, target)
  await mkdir(join(path, 'SecureReel', `${job.name}_R001`), { recursive: true })
  const summary = await manager.generateReports(job.id)
  expect(summary.delivery?.find((d) => d.targetId === job.targets[0]!.id)?.state).toBe('published')
  expect(summary.delivery?.find((d) => d.targetId === target.id)?.state).toBe('failed')
})

it('报告收尾期间保持运行保护并阻止重启同一任务', async () => {
  const { job } = await seedFinishedJob('completed', 'copy')
  const completedReport = await manager.generateReports(job.id)
  vi.spyOn(CopyEngine.prototype, 'run').mockResolvedValue({
    state: 'completed',
    filesDone: 1,
    filesFailed: 0,
    bytesDone: 1,
    processed: 1
  })
  let resolveReport: (value: Awaited<ReturnType<JobManager['generateReports']>>) => void = () => {}
  const report = new Promise<Awaited<ReturnType<JobManager['generateReports']>>>((resolve) => {
    resolveReport = resolve
  })
  vi.spyOn(manager, 'generateReports').mockReturnValue(report)
  await manager.start(job.id)
  await vi.waitFor(() => expect(manager.generateReports).toHaveBeenCalled())
  expect(manager.isRunning(job.id)).toBe(true)
  expect(manager.canEject).toBe(false)
  await expect(manager.start(job.id)).rejects.toThrow()
  resolveReport({ ...completedReport, delivery: [] })
  await manager.wait(job.id)
  expect(manager.isRunning(job.id)).toBe(false)
})

it('另一个任务仍运行时不弹盘或关机，并在全部结束后去重弹盘', async () => {
  const { job } = await seedFinishedJob('completed', 'copy')
  const other = { ...job, id: 'job_endaction02' }
  store.insertJob(other)
  testSettings = {
    ...DEFAULT_SETTINGS,
    generateReport: false,
    ejectAfterCopy: true,
    shutdownAfterCopy: true
  }
  let completeFirst: () => void = () => {}
  const first = new Promise<void>((resolve) => {
    completeFirst = resolve
  })
  let call = 0
  vi.spyOn(CopyEngine.prototype, 'run').mockImplementation(async () => {
    if (call++ === 0) await first
    return { state: 'completed', filesDone: 1, filesFailed: 0, bytesDone: 1, processed: 1 }
  })
  const eject = vi
    .spyOn(volumeActions, 'ejectVolume')
    .mockResolvedValue({ ok: true, message: 'done' })
  const shutdown = vi
    .spyOn(volumeActions, 'scheduleShutdown')
    .mockResolvedValue({ ok: true, message: 'done' })
  await manager.start(job.id)
  await manager.start(other.id)
  await manager.wait(other.id)
  expect(eject).not.toHaveBeenCalled()
  expect(shutdown).not.toHaveBeenCalled()
  completeFirst()
  await manager.wait(job.id)
  expect(eject).toHaveBeenCalledTimes(1)
  expect(shutdown).toHaveBeenCalledTimes(1)
})

it('弹盘失败时不安排自动关机', async () => {
  const { job } = await seedFinishedJob('completed', 'copy')
  testSettings = {
    ...DEFAULT_SETTINGS,
    generateReport: false,
    ejectAfterCopy: true,
    shutdownAfterCopy: true
  }
  vi.spyOn(CopyEngine.prototype, 'run').mockResolvedValue({
    state: 'completed',
    filesDone: 1,
    filesFailed: 0,
    bytesDone: 1,
    processed: 1
  })
  vi.spyOn(volumeActions, 'ejectVolume').mockResolvedValue({ ok: false, message: 'busy' })
  const shutdown = vi
    .spyOn(volumeActions, 'scheduleShutdown')
    .mockResolvedValue({ ok: true, message: 'done' })
  await manager.start(job.id)
  await manager.wait(job.id)
  expect(shutdown).not.toHaveBeenCalled()
})

it('手动弹盘等待系统响应期间禁止启动任务或生成报告，并在失败后释放锁', async () => {
  const { job } = await seedFinishedJob('completed', 'copy')
  let release!: () => void
  const action = manager.withIdleEjection(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    throw new Error('eject unavailable')
  })
  const rejected = expect(action).rejects.toThrow('eject unavailable')
  expect(manager.canEject).toBe(false)
  await expect(manager.start(job.id)).rejects.toThrow('正在安全弹出磁盘')
  await expect(manager.generateReports(job.id)).rejects.toThrow('正在安全弹出磁盘')
  release()
  await rejected
  expect(manager.canEject).toBe(true)
})

it('archives physical-independence evidence with the revision and never retrofits an older report', async () => {
  const { job } = await seedFinishedJob('completed', 'copy')
  const identity = {
    path: '/backup',
    label: 'Backup',
    filesystemId: 'backup',
    physicalDeviceIds: ['one-disk'],
    capacityPoolId: 'backup',
    availableBytes: 1000,
    present: true
  }
  const evidence = {
    fingerprint: 'original-device',
    checkedAt: '2026-10-18T00:00:00.000Z',
    source: { ...identity, path: '/source', filesystemId: 'source' },
    targets: [identity],
    groups: [],
    risks: [{ code: 'shared-device' as const, paths: ['/backup'] }],
    blockingReasons: [],
    requiredBytes: 200,
    independentDeviceGroups: 1
  }
  store.saveJobSafety(job.id, evidence)
  await manager.generateReports(job.id)
  const first = store.listReports(job.id)[0]!
  const saved = await readFile(first.files.json!, 'utf8')
  expect(JSON.parse(saved).summary.backupSafety.fingerprint).toBe('original-device')
  expect(await readFile(first.files.html!, 'utf8')).toContain('物理独立性')
  store.saveJobSafety(job.id, { ...evidence, fingerprint: 'different-device' })
  await manager.generateReports(job.id)
  expect(await readFile(first.files.json!, 'utf8')).toBe(saved)
})
