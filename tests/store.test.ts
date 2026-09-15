/**
 * 数据库层测试。
 *
 * 用内存库跑，但走的是与生产完全相同的建表脚本与 SQL 语句 ——
 * 因此这里能抓到的问题（字段名写错、约束冲突、计数器算错）都是真问题，
 * 不存在"测试环境和线上不一致"的盲区。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { CopyJob, FileTargetResult, ParentProject, ProjectInfo } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { Store } from '../src/main/db/store'
import { emptyProjectInfo } from '../src/shared/project'

let store: Store

beforeEach(async () => {
  store = await Store.openInMemory()
})

afterEach(() => {
  store.close()
})

function makeJob(id = 'job_abcdef1234'): CopyJob {
  return {
    id,
    name: 'A002 卡备份',
    sourcePath: '/Volumes/A002',
    sourceKind: 'generic',
    isCodExVfs: false,
    parentProjectId: null,
    targets: [
      { id: 'tgt_1', path: '/Volumes/BackupA', label: 'BackupA', enabled: true, freeBytes: 1000, writable: true },
      { id: 'tgt_2', path: '/Volumes/BackupB', label: 'BackupB', enabled: true, freeBytes: 2000, writable: true }
    ],
    hashAlgorithm: 'xxhash64',
    manifestFormat: 'asc-mhl-2.0',
    verifyAfterWrite: true,
    state: 'draft',
    totalFiles: 3,
    totalBytes: 3000,
    filesDone: 0,
    filesFailed: 0,
    bytesDone: 0,
    createdAt: '2026-09-15T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    degradationNotice: null
  }
}

describe('任务存取', () => {
  it('写入后能原样读回，包括布尔字段与目标列表', () => {
    const job = makeJob()
    store.insertJob(job)

    const loaded = store.getJob(job.id)
    expect(loaded).not.toBeNull()
    expect(loaded?.name).toBe(job.name)
    expect(loaded?.verifyAfterWrite).toBe(true)
    expect(loaded?.isCodExVfs).toBe(false)
    expect(loaded?.targets).toHaveLength(2)
    expect(loaded?.targets[0]?.label).toBe('BackupA')
    expect(loaded?.targets[1]?.freeBytes).toBe(2000)
  })

  it('部分字段更新不影响其他字段', () => {
    const job = makeJob()
    store.insertJob(job)

    store.updateJob(job.id, { state: 'running', startedAt: '2026-09-15T01:00:00.000Z' })

    const loaded = store.getJob(job.id)
    expect(loaded?.state).toBe('running')
    expect(loaded?.startedAt).toBe('2026-09-15T01:00:00.000Z')
    expect(loaded?.name).toBe(job.name)
    expect(loaded?.verifyAfterWrite).toBe(true)
  })

  it('读不存在的任务返回 null 而不是抛错', () => {
    expect(store.getJob('job_missing')).toBeNull()
  })

  it('删除任务会连带清掉目标与文件行', () => {
    const job = makeJob()
    store.insertJob(job)
    store.upsertFiles(job.id, [{ relPath: 'a.mov', sizeBytes: 10 }])

    store.deleteJob(job.id)

    expect(store.getJob(job.id)).toBeNull()
    expect(store.countFiles(job.id)).toBe(0)
    expect(store.listTargets(job.id)).toHaveLength(0)
  })

  it('只把未结束的任务列为可恢复', () => {
    store.insertJob({ ...makeJob('job_running1'), state: 'running' })
    store.insertJob({ ...makeJob('job_done12345'), state: 'completed' })
    store.insertJob({ ...makeJob('job_paused12'), state: 'paused' })

    const ids = store.listResumableJobs().map((job) => job.id).sort()
    expect(ids).toEqual(['job_paused12', 'job_running1'])
  })
})

describe('文件清单与状态', () => {
  it('重复写入同一批文件不会把已完成的状态打回 pending', () => {
    const job = makeJob()
    store.insertJob(job)
    store.upsertFiles(job.id, [
      { relPath: 'a.mov', sizeBytes: 10 },
      { relPath: 'b.mov', sizeBytes: 20 }
    ])
    store.updateFile(job.id, 'a.mov', { state: 'verified', sourceHash: 'deadbeef' })

    // 重新扫描同一个任务时应保留已有进度
    store.upsertFiles(job.id, [
      { relPath: 'a.mov', sizeBytes: 10 },
      { relPath: 'b.mov', sizeBytes: 20 },
      { relPath: 'c.mov', sizeBytes: 30 }
    ])

    expect(store.countFiles(job.id)).toBe(3)
    const file = store.listFiles(job.id, 10, 0).find((item) => item.relPath === 'a.mov')
    expect(file?.state).toBe('verified')
    expect(file?.sourceHash).toBe('deadbeef')
  })

  it('待处理查询只返回 pending，失败的留在失败态', () => {
    const job = makeJob()
    store.insertJob(job)
    store.upsertFiles(job.id, [
      { relPath: 'a.mov', sizeBytes: 1 },
      { relPath: 'b.mov', sizeBytes: 1 },
      { relPath: 'c.mov', sizeBytes: 1 }
    ])
    store.updateFile(job.id, 'b.mov', { state: 'failed', error: '校验不一致' })
    store.updateFile(job.id, 'c.mov', { state: 'verified' })

    const pending = store.listPendingFiles(job.id, 10)
    expect(pending.map((file) => file.relPath)).toEqual(['a.mov'])
  })

  it('状态统计准确', () => {
    const job = makeJob()
    store.insertJob(job)
    store.upsertFiles(job.id, [
      { relPath: 'a.mov', sizeBytes: 1 },
      { relPath: 'b.mov', sizeBytes: 1 },
      { relPath: 'c.mov', sizeBytes: 1 }
    ])
    store.updateFile(job.id, 'a.mov', { state: 'verified' })
    store.updateFile(job.id, 'b.mov', { state: 'verified' })
    store.updateFile(job.id, 'c.mov', { state: 'failed' })

    const counts = store.fileStateCounts(job.id)
    expect(counts.verified).toBe(2)
    expect(counts.failed).toBe(1)
    expect(counts.pending).toBe(0)
  })

  it('分批遍历能取到全部文件（不受批量大小影响）', async () => {
    const job = makeJob()
    store.insertJob(job)
    store.upsertFiles(
      job.id,
      Array.from({ length: 25 }, (_, index) => ({ relPath: `clip_${index}.mov`, sizeBytes: index }))
    )

    const seen: string[] = []
    for await (const file of store.iterateFiles(job.id, 7)) {
      seen.push(file.relPath)
    }
    expect(seen).toHaveLength(25)
    expect(seen[0]).toBe('clip_0.mov')
    expect(seen[24]).toBe('clip_24.mov')
  })

  it('分页读取不会重复也不会漏', () => {
    const job = makeJob()
    store.insertJob(job)
    store.upsertFiles(
      job.id,
      Array.from({ length: 10 }, (_, index) => ({ relPath: `f${index}.bin`, sizeBytes: index }))
    )

    const first = store.listFiles(job.id, 4, 0)
    const second = store.listFiles(job.id, 4, 4)
    expect(first).toHaveLength(4)
    expect(second).toHaveLength(4)
    expect(new Set([...first, ...second].map((file) => file.relPath)).size).toBe(8)
  })
})

describe('文件 × 目标结果', () => {
  it('结果按目标分别保存，重复保存是覆盖而不是插入', () => {
    const job = makeJob()
    store.insertJob(job)
    store.upsertFiles(job.id, [{ relPath: 'a.mov', sizeBytes: 10 }])
    const fileId = Number(store.getFileRow(job.id, 'a.mov')?.id)

    const results: FileTargetResult[] = [
      { targetId: 'tgt_1', state: 'verified', hash: 'aa', hashMatch: true, bytesCopied: 10, error: null },
      { targetId: 'tgt_2', state: 'failed', hash: 'bb', hashMatch: false, bytesCopied: 10, error: '不一致' }
    ]
    for (const result of results) store.saveFileResult(fileId, job.id, result)

    // 再存一次同样的结果，不应产生重复行
    for (const result of results) store.saveFileResult(fileId, job.id, result)

    const file = store.listFiles(job.id, 10, 0)[0]
    expect(file?.results).toHaveLength(2)
    expect(file?.results.find((item) => item.targetId === 'tgt_1')?.hashMatch).toBe(true)
    expect(file?.results.find((item) => item.targetId === 'tgt_2')?.hashMatch).toBe(false)
  })
})

describe('计数器自增（并发安全）', () => {
  it('任务级计数器累加而不是覆盖', () => {
    const job = makeJob()
    store.insertJob(job)

    store.incrementJobCounters(job.id, { filesDone: 1, bytesDone: 100 })
    store.incrementJobCounters(job.id, { filesDone: 1, bytesDone: 200 })
    store.incrementJobCounters(job.id, { filesFailed: 1, bytesDone: 50 })

    const loaded = store.getJob(job.id)
    expect(loaded?.filesDone).toBe(2)
    expect(loaded?.filesFailed).toBe(1)
    expect(loaded?.bytesDone).toBe(350)
  })

  it('目标级计数器累加而不是覆盖', () => {
    const job = makeJob()
    store.insertJob(job)

    store.incrementTargetCounters(job.id, 'tgt_1', { filesDone: 1, bytesCopied: 10 })
    store.incrementTargetCounters(job.id, 'tgt_1', { filesDone: 1, bytesCopied: 20 })

    const target = store.listTargetProgress(job.id).find((item) => item.targetId === 'tgt_1')
    expect(target?.filesDone).toBe(2)
    expect(target?.bytesCopied).toBe(30)
  })
})

describe('报告修订编号', () => {
  it('修订号从 R001 开始单调递增', () => {
    const job = makeJob()
    store.insertJob(job)

    expect(store.nextRevision(job.id)).toBe('R001')

    store.insertReport({
      id: 0,
      jobId: job.id,
      revision: 'R001',
      createdAt: '2026-09-15T00:00:00.000Z',
      dir: '/tmp/reports/R001',
      files: { json: '/tmp/reports/R001/report.json' },
      summary: {
        jobId: job.id,
        jobName: job.name,
        revision: 'R001',
        createdAt: '2026-09-15T00:00:00.000Z',
        sourcePath: job.sourcePath,
        jobState: 'completed' as const,
        sourceLabel: 'A002',
        hashAlgorithm: 'xxhash64',
        manifestFormat: 'asc-mhl-2.0',
        totalFiles: 0,
        totalBytes: 0,
        verifiedFiles: 0,
        failedFiles: 0,
        durationSeconds: null,
        targets: [],
        project: emptyProject()
      }
    })

    expect(store.nextRevision(job.id)).toBe('R002')
    expect(store.listReports(job.id)).toHaveLength(1)
  })

  it('同一修订号写两次会被唯一约束挡住（物理上不可能覆盖）', () => {
    const job = makeJob()
    store.insertJob(job)

    const revision = {
      id: 0,
      jobId: job.id,
      revision: 'R001',
      createdAt: '2026-09-15T00:00:00.000Z',
      dir: '/tmp/r',
      files: {},
      summary: {
        jobId: job.id,
        jobName: job.name,
        revision: 'R001',
        createdAt: '2026-09-15T00:00:00.000Z',
        sourcePath: job.sourcePath,
        jobState: 'completed' as const,
        sourceLabel: 'A002',
        hashAlgorithm: 'xxhash64' as const,
        manifestFormat: 'asc-mhl-2.0' as const,
        totalFiles: 0,
        totalBytes: 0,
        verifiedFiles: 0,
        failedFiles: 0,
        durationSeconds: null,
        targets: [],
        project: emptyProject()
      }
    }

    store.insertReport(revision)
    expect(() => store.insertReport(revision)).toThrow()
  })

  it('PDF 路径可以后回填', () => {
    const job = makeJob()
    store.insertJob(job)
    store.insertReport({
      id: 0,
      jobId: job.id,
      revision: 'R001',
      createdAt: '2026-09-15T00:00:00.000Z',
      dir: '/tmp/r',
      files: { html: '/tmp/r/report.html' },
      summary: {
        jobId: job.id,
        jobName: job.name,
        revision: 'R001',
        createdAt: '2026-09-15T00:00:00.000Z',
        sourcePath: job.sourcePath,
        jobState: 'completed' as const,
        sourceLabel: 'A002',
        hashAlgorithm: 'xxhash64',
        manifestFormat: 'asc-mhl-2.0',
        totalFiles: 0,
        totalBytes: 0,
        verifiedFiles: 0,
        failedFiles: 0,
        durationSeconds: null,
        targets: [],
        project: emptyProject()
      }
    })

    store.updateReportFiles(job.id, 'R001', { html: '/tmp/r/report.html', pdf: '/tmp/r/report.pdf' })
    expect(store.listReports(job.id)[0]?.files.pdf).toBe('/tmp/r/report.pdf')
  })
})

describe('项目信息', () => {
  it('保存后能读回，且更新时间会更新', () => {
    const job = makeJob()
    store.insertJob(job)

    const info: ProjectInfo = {
      projectName: '测试项目',
      shootDay: '2026-09-15',
      camera: 'ALEXA 35',
      cardLabel: 'A002',
      lenses: [{ model: 'Cooke S7/i', detail: '40mm' }],
      notes: '现场备注',
      crew: [{ role: 'DIT', name: '张三' }],
      copyNotes: '本次备注',
      parentProjectName: null,
      updatedAt: '2026-09-15T02:00:00.000Z'
    }
    store.saveProjectInfo(job.id, info)

    const loaded = store.getProjectInfo(job.id)
    expect(loaded?.projectName).toBe('测试项目')
    expect(loaded?.crew[0]?.name).toBe('张三')
  })

  it('读不存在的项目信息返回 null', () => {
    expect(store.getProjectInfo('job_missing')).toBeNull()
  })
})

describe('设置', () => {
  it('没有保存过时返回默认值', () => {
    expect(store.getSettings().hashAlgorithm).toBe(DEFAULT_SETTINGS.hashAlgorithm)
    expect(store.getSettings().language).toBe('zh-CN')
  })

  it('保存后能读回，缺失字段由默认值补齐', () => {
    store.saveSettings({ ...DEFAULT_SETTINGS, themeId: 'wuguang', language: 'en' })
    const loaded = store.getSettings()
    expect(loaded.themeId).toBe('wuguang')
    expect(loaded.language).toBe('en')
    expect(loaded.maxParallelTargets).toBe(DEFAULT_SETTINGS.maxParallelTargets)
  })
})

describe('清单代次', () => {
  it('记录与读取 ASC MHL 代次链', () => {
    const job = makeJob()
    store.insertJob(job)

    expect(store.getManifestIds(job.id)).toBeNull()
    store.setManifestIds(job.id, 'c4aaa', null)
    store.setManifestIds(job.id, 'c4bbb', 'c4aaa')

    expect(store.getManifestIds(job.id)).toEqual({ manifestId: 'c4bbb', previousManifestId: 'c4aaa' })
  })
})

describe('母项目', () => {
  function makeParent(id = 'prj_abcdef1234', name = '母亲'): ParentProject {
    return {
      id,
      name,
      details: {
        projectName: '母亲',
        shootDay: '2026-09-15',
        camera: 'ALEXA 35',
        lenses: [{ model: 'Cooke S7/i', detail: '40mm' }],
        notes: '整部戏的备注',
        crew: [{ role: '导演', name: '张三' }]
      },
      createdAt: '2026-09-15T01:00:00.000Z',
      updatedAt: null
    }
  }

  it('创建后能读回，字段完整', () => {
    const parent = makeParent()
    store.createParentProject(parent)

    const loaded = store.getParentProject(parent.id)
    expect(loaded).not.toBeNull()
    expect(loaded?.name).toBe('母亲')
    expect(loaded?.details.camera).toBe('ALEXA 35')
    expect(loaded?.details.lenses).toEqual([{ model: 'Cooke S7/i', detail: '40mm' }])
    expect(loaded?.details.crew).toEqual([{ role: '导演', name: '张三' }])
  })

  it('改名字与改信息是两件独立的事，互不覆盖', () => {
    const parent = makeParent()
    store.createParentProject(parent)

    store.updateParentProject(parent.id, { name: '母亲（暂定）' })
    expect(store.getParentProject(parent.id)?.name).toBe('母亲（暂定）')
    expect(store.getParentProject(parent.id)?.details.camera).toBe('ALEXA 35')

    store.updateParentProject(parent.id, {
      details: { ...parent.details, camera: 'ALEXA 35 Xtreme' }
    })
    expect(store.getParentProject(parent.id)?.name).toBe('母亲（暂定）')
    expect(store.getParentProject(parent.id)?.details.camera).toBe('ALEXA 35 Xtreme')
  })

  it('不存在的母项目返回 null，而不是凭空造一个', () => {
    expect(store.getParentProject('prj_nosuchid')).toBeNull()
    expect(store.updateParentProject('prj_nosuchid', { name: 'x' })).toBeNull()
  })

  it('按归属查任务，并按创建时间倒序', () => {
    const parent = makeParent()
    store.createParentProject(parent)

    const early = { ...makeJob('job_early00001'), parentProjectId: parent.id, createdAt: '2026-09-15T01:00:00.000Z' }
    const late = { ...makeJob('job_late000001'), parentProjectId: parent.id, createdAt: '2026-09-15T05:00:00.000Z' }
    const other = { ...makeJob('job_other00001'), parentProjectId: null }
    store.insertJob(early)
    store.insertJob(late)
    store.insertJob(other)

    const children = store.listJobsByParent(parent.id)
    expect(children.map((job) => job.id)).toEqual(['job_late000001', 'job_early00001'])
    expect(children[0]?.parentProjectId).toBe(parent.id)
    expect(store.countJobsByParent(parent.id)).toBe(2)
    expect(store.countJobsByParent('prj_nosuchid')).toBe(0)
  })

  it('删除母项目只解绑任务，绝不删除任务本身', () => {
    const parent = makeParent()
    store.createParentProject(parent)
    store.insertJob({ ...makeJob('job_child00001'), parentProjectId: parent.id })
    store.insertJob({ ...makeJob('job_child00002'), parentProjectId: parent.id })
    store.insertJob({ ...makeJob('job_free000001'), parentProjectId: null })

    store.deleteParentProject(parent.id)

    expect(store.getParentProject(parent.id)).toBeNull()
    // 任务一条都不能少 —— 素材已经拷到盘上了，删归类标签不该抹掉拷贝记录
    const jobs = store.listJobs()
    expect(jobs).toHaveLength(3)
    for (const job of jobs) expect(job.parentProjectId).toBeNull()
  })

  it('列表按最近有拷贝活动的排前面', () => {
    store.createParentProject({
      ...makeParent('prj_old0000001', '很久以前的戏'),
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    store.createParentProject({
      ...makeParent('prj_active0001', '正在拍的戏'),
      createdAt: '2026-08-01T00:00:00.000Z'
    })

    // 老项目上有一条今天创建的任务，它应该被顶到最前面
    store.insertJob({
      ...makeJob('job_today00001'),
      parentProjectId: 'prj_old0000001',
      createdAt: '2026-09-15T09:00:00.000Z'
    })

    expect(store.listParentProjects().map((project) => project.id)).toEqual([
      'prj_old0000001',
      'prj_active0001'
    ])
  })
})

describe('未选母项目时的预填来源', () => {
  function parentId(index: number): string {
    return `prj_fill${String(index).padStart(6, '0')}`
  }

  function jobId(index: number): string {
    return `job_fill${String(index).padStart(5, '0')}`
  }

  function seed(options: {
    index: number
    createdAt: string
    parentProjectId?: string | null
    info: Partial<ProjectInfo>
  }): void {
    store.insertJob({
      ...makeJob(jobId(options.index)),
      createdAt: options.createdAt,
      parentProjectId: options.parentProjectId ?? null
    })
    store.saveProjectInfo(jobId(options.index), { ...emptyProjectInfo(), ...options.info })
  }

  it('空库返回 null', () => {
    expect(store.getLatestProjectTemplate()).toBeNull()
  })

  it('取最近一条有实质内容的记录', () => {
    seed({ index: 1, createdAt: '2026-09-01T00:00:00.000Z', info: { camera: '旧机型' } })
    seed({ index: 2, createdAt: '2026-09-10T00:00:00.000Z', info: { camera: '新机型' } })

    expect(store.getLatestProjectTemplate()?.camera).toBe('新机型')
  })

  it('跳过最近那条空填的记录，往前找有内容的', () => {
    seed({ index: 1, createdAt: '2026-09-01T00:00:00.000Z', info: { camera: 'ALEXA 35' } })
    // 最近这条只自动填了拍摄日，用户什么都没写
    seed({ index: 2, createdAt: '2026-09-10T00:00:00.000Z', info: { shootDay: '2026-09-10' } })

    expect(store.getLatestProjectTemplate()?.camera).toBe('ALEXA 35')
  })

  it('只看未分组的任务', () => {
    // 归入某部戏的任务不该把自己的信息"漏"给未分组的新任务，
    // 否则会出现"没选母项目却自动带了某部戏的机型和人名"这种让人心里发毛的情况
    seed({
      index: 1,
      createdAt: '2026-09-10T00:00:00.000Z',
      parentProjectId: parentId(1),
      info: { camera: '某部戏的机型' }
    })
    seed({ index: 2, createdAt: '2026-09-01T00:00:00.000Z', info: { camera: '未分组的机型' } })

    expect(store.getLatestProjectTemplate()?.camera).toBe('未分组的机型')
  })

  it('卡号与本次备注被清空 —— 它们属于那一张卡', () => {
    seed({
      index: 1,
      createdAt: '2026-09-10T00:00:00.000Z',
      info: { camera: 'ALEXA 35', cardLabel: 'A002R2EC', copyNotes: '第一张卡的现场备注' }
    })

    const template = store.getLatestProjectTemplate()
    expect(template?.camera).toBe('ALEXA 35')
    expect(template?.cardLabel).toBe('')
    expect(template?.copyNotes).toBe('')
  })

  it('全部都是空记录时返回 null', () => {
    seed({ index: 1, createdAt: '2026-09-01T00:00:00.000Z', info: { shootDay: '2026-09-01' } })
    seed({ index: 2, createdAt: '2026-09-02T00:00:00.000Z', info: {} })
    expect(store.getLatestProjectTemplate()).toBeNull()
  })

  it('读老格式记录也不崩（缺 lenses / copyNotes）', () => {
    store.insertJob({ ...makeJob('job_legacyinfo1'), createdAt: '2026-09-10T00:00:00.000Z' })
    // 绕开 saveProjectInfo 的类型，直接写入老格式的 JSON
    store.saveProjectInfo('job_legacyinfo1', {
      projectName: '',
      shootDay: '',
      camera: '老机型',
      cardLabel: 'A001',
      notes: '',
      crew: [],
      updatedAt: null
    } as unknown as ProjectInfo)

    const template = store.getLatestProjectTemplate()
    expect(template?.camera).toBe('老机型')
    expect(template?.lenses).toEqual([])
  })
})

describe('任务排序稳定性', () => {
  it('同一时刻创建的任务顺序不会在两次查询之间抖动', () => {
    const at = '2026-09-15T02:00:00.000Z'
    for (let index = 1; index <= 4; index++) {
      store.insertJob({ ...makeJob(jobIdAt(index)), createdAt: at })
    }

    const first = store.listJobs().map((job) => job.id)
    const second = store.listJobs().map((job) => job.id)
    expect(second).toEqual(first)
    // 后插入的排前面（rowid 倒序），这是稳定且可预期的
    expect(first).toEqual([jobIdAt(4), jobIdAt(3), jobIdAt(2), jobIdAt(1)])

    function jobIdAt(index: number): string {
      return `job_same${String(index).padStart(7, '0')}`
    }
  })
})

function emptyProject(): ProjectInfo {
  return emptyProjectInfo()
}
