/**
 * 母项目"记住职员与镜头"这条链路。
 *
 * 这块功能的意义不是新加了一个字段，而是**把已经存在的数据接回来**：
 * 旧版本只把拷贝页填的内容写进任务快照（`project_info`），从不写回母项目档案。
 * 于是库里明明存着 11 个职员和一颗镜头，切到那个母项目却什么也带不出来 ——
 * 在用户眼里就是"我之前填的东西丢了"。
 *
 * 所以这里最要紧的两条判据是：
 *   1. 回捞**只补空**，绝不覆盖用户自己写进档案的内容；
 *   2. 写回**只动镜头与人员**，且本次没填时什么都不写 —— 宁可少更新，
 *      也不能把攒了几部戏的名单清空。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { CopyJob, ParentProject, ProjectDetails, ProjectInfo } from '../src/shared/types'
import {
  dropEmptyCrew,
  fillMissingDetails,
  hasCrew,
  hasLenses,
  mergeTalentIntoParent
} from '../src/shared/project'
import { todayLocalDate } from '../src/shared/format'
import { Store } from '../src/main/db/store'

let store: Store

beforeEach(async () => {
  store = await Store.openInMemory()
})

afterEach(() => {
  store.close()
})

function makeJob(id: string, parentProjectId: string | null, createdAt: string): CopyJob {
  return {
    id,
    name: `任务 ${id}`,
    mode: 'copy',
    sourcePath: '/Volumes/A002',
    sourceRootName: '',
    sourceKind: 'generic',
    isCodExVfs: false,
    parentProjectId,
    targets: [
      { id: 'tgt_1', path: '/Volumes/Backup', label: 'Backup', enabled: true, freeBytes: 1000, writable: true }
    ],
    hashAlgorithm: 'xxhash64',
    manifestFormat: 'asc-mhl-2.0',
    verifyAfterWrite: true,
    proxyEnabled: false,
    proxyResolution: '1080p',
    proxyCodec: 'prores',
    proxyProfile: '422-proxy',
    proxyLutPath: null,
    state: 'completed',
    totalFiles: 1,
    totalBytes: 100,
    filesDone: 1,
    filesFailed: 0,
    bytesDone: 100,
    createdAt,
    startedAt: null,
    finishedAt: null,
    degradationNotice: null
  }
}

function makeParent(id: string, details: Partial<ProjectDetails> = {}): ParentProject {
  return {
    id,
    name: '疲于奔命',
    details: {
      projectName: '',
      shootDay: '',
      camera: '',
      lenses: [],
      notes: '',
      crew: [],
      ...details
    },
    createdAt: '2026-09-15T01:00:00.000Z',
    updatedAt: null
  }
}

function snapshot(partial: Partial<ProjectInfo>): ProjectInfo {
  return {
    projectName: '',
    shootDay: '',
    camera: '',
    lenses: [],
    notes: '',
    crew: [],
    cardLabel: 'A001',
    copyNotes: '',
    parentProjectName: '疲于奔命',
    updatedAt: null,
    ...partial
  }
}

/* ------------------------------------------------------------------ *
 * 纯函数
 * ------------------------------------------------------------------ */

describe('空行的判定', () => {
  it('只填了一半的行也算有内容 —— 那多半是还没填完', () => {
    expect(hasCrew([{ role: '导演', name: '' }])).toBe(true)
    expect(hasCrew([{ role: '', name: '张三' }])).toBe(true)
    expect(hasLenses([{ model: '雅典娜', detail: '' }])).toBe(true)
    expect(hasLenses([{ model: '', detail: '标准组' }])).toBe(true)
  })

  it('点"添加一行"留下的空行不算内容', () => {
    expect(hasCrew([{ role: '', name: '' }])).toBe(false)
    expect(hasLenses([{ model: '  ', detail: '' }])).toBe(false)
    expect(hasCrew([])).toBe(false)
  })

  it('写回前会把空行丢掉，不会把界面的占位行存进档案', () => {
    const crew = dropEmptyCrew([
      { role: '导演', name: '曹润泽' },
      { role: '', name: '' }
    ])
    expect(crew).toEqual([{ role: '导演', name: '曹润泽' }])
  })
})

describe('从历史补齐档案（只补空）', () => {
  const base: ProjectDetails = {
    projectName: '疲于奔命',
    shootDay: '',
    camera: '',
    lenses: [],
    notes: '',
    crew: []
  }

  it('档案里空着的字段被补上', () => {
    const merged = fillMissingDetails(
      base,
      snapshot({ camera: 'ALEXA 35', crew: [{ role: '导演', name: '张芸飞' }] })
    )
    expect(merged.camera).toBe('ALEXA 35')
    expect(merged.crew).toEqual([{ role: '导演', name: '张芸飞' }])
  })

  it('档案里已经填过的一律不动 —— 用户写的比历史推断可信', () => {
    const own: ProjectDetails = { ...base, camera: '自己填的机型', crew: [{ role: 'DIT', name: '陈善飞' }] }
    const merged = fillMissingDetails(own, snapshot({ camera: '历史机型', crew: [{ role: '导演', name: '别人' }] }))
    expect(merged.camera).toBe('自己填的机型')
    expect(merged.crew).toEqual([{ role: 'DIT', name: '陈善飞' }])
  })

  it('空数组算"没填"，单有一个空行也算没填', () => {
    const merged = fillMissingDetails(
      { ...base, crew: [{ role: '', name: '' }] },
      snapshot({ crew: [{ role: '摄影指导', name: '李献鹏' }] })
    )
    expect(merged.crew).toEqual([{ role: '摄影指导', name: '李献鹏' }])
  })

  it('**拍摄日不参与补齐** —— 它属于某一次拷贝，不属于整部戏', () => {
    const merged = fillMissingDetails(base, snapshot({ shootDay: '2026-09-21' }))
    expect(merged.shootDay).toBe('')
  })

  it('没有历史可补时原样返回', () => {
    expect(fillMissingDetails(base, null)).toEqual(base)
  })
})

describe('把本次填的写回档案', () => {
  const archive: ProjectDetails = {
    projectName: '疲于奔命',
    shootDay: '2026-09-01',
    camera: 'ALEXA 35',
    lenses: [{ model: '旧镜头', detail: '' }],
    notes: '整部戏备注',
    crew: [{ role: '导演', name: '旧导演' }]
  }

  it('填了就覆盖对应的那两项，并报告发生了变化', () => {
    const { details, changed } = mergeTalentIntoParent(archive, {
      lenses: [{ model: '雅典娜', detail: '标准组' }],
      crew: [
        { role: '导演', name: '张芸飞' },
        { role: '摄影指导', name: '李献鹏' }
      ]
    })
    expect(changed).toBe(true)
    expect(details.lenses).toEqual([{ model: '雅典娜', detail: '标准组' }])
    expect(details.crew).toHaveLength(2)
  })

  it('**只动镜头与人员** —— 机型、项目名、备注、拍摄日原样保留', () => {
    const { details } = mergeTalentIntoParent(archive, {
      lenses: [{ model: '雅典娜', detail: '标准组' }],
      crew: [{ role: '导演', name: '张芸飞' }]
    })
    expect(details.camera).toBe('ALEXA 35')
    expect(details.projectName).toBe('疲于奔命')
    expect(details.notes).toBe('整部戏备注')
    expect(details.shootDay).toBe('2026-09-01')
  })

  it('本次一个有效行都没填时，**绝不写空数组**把档案清掉', () => {
    const { details, changed } = mergeTalentIntoParent(archive, { lenses: [], crew: [] })
    expect(changed).toBe(false)
    expect(details).toEqual(archive)
  })

  it('只填了镜头没填人时，人员保持原样', () => {
    const { details, changed } = mergeTalentIntoParent(archive, {
      lenses: [{ model: '雅典娜', detail: '标准组' }],
      crew: [{ role: '', name: '' }]
    })
    expect(changed).toBe(true)
    expect(details.crew).toEqual([{ role: '导演', name: '旧导演' }])
  })

  it('内容完全相同时不报告变化，避免无意义的写库与提示', () => {
    const { changed } = mergeTalentIntoParent(archive, {
      lenses: [{ model: '旧镜头', detail: '' }],
      crew: [{ role: '导演', name: '旧导演' }]
    })
    expect(changed).toBe(false)
  })
})

describe('今天的日期按本机时区算', () => {
  it('凌晨 0 点到 8 点之间不能退回前一天', () => {
    // 2026-10-01 00:30（东八区）—— 此刻 UTC 还停在 09-30。
    // 用 toISOString() 会得到 2026-09-30，拍摄日就此错一天。
    const localMidnight = new Date(2026, 9, 1, 0, 30, 0)
    expect(todayLocalDate(localMidnight)).toBe('2026-10-01')
  })

  it('月底与年底的补零正确', () => {
    expect(todayLocalDate(new Date(2026, 0, 5, 12, 0, 0))).toBe('2026-01-05')
    expect(todayLocalDate(new Date(2026, 11, 31, 23, 59, 0))).toBe('2026-12-31')
  })
})

/* ------------------------------------------------------------------ *
 * 数据库层
 * ------------------------------------------------------------------ */

describe('回捞：档案空着时从名下任务的快照里补', () => {
  it('母项目是空的，但名下任务填过 —— 内容要能带出来', () => {
    const parent = makeParent('prj_mumhoem4_65c72149')
    store.createParentProject(parent)

    const job = makeJob('job_f8npro00001', parent.id, '2026-09-29T10:00:00.000Z')
    store.insertJob(job)
    store.saveProjectInfo(
      job.id,
      snapshot({
        lenses: [{ model: '雅典娜', detail: '标准组' }],
        crew: [
          { role: '导演', name: '张芸飞' },
          { role: '摄影指导', name: '李献鹏' }
        ],
        cardLabel: 'SD1'
      })
    )

    const recalled = store.recallParentDetails(parent.id)
    expect(recalled?.lenses).toEqual([{ model: '雅典娜', detail: '标准组' }])
    expect(recalled?.crew).toHaveLength(2)
  })

  it('多个任务各填了一部分时，逐条叠加补齐，不是只取最近那条', () => {
    const parent = makeParent('prj_mergemulti01')
    store.createParentProject(parent)

    const older = makeJob('job_older00001', parent.id, '2026-09-27T10:00:00.000Z')
    const newer = makeJob('job_newer00001', parent.id, '2026-09-29T10:00:00.000Z')
    store.insertJob(older)
    store.insertJob(newer)
    // 早的那次填了人，近的这次只填了镜头
    store.saveProjectInfo(older.id, snapshot({ crew: [{ role: '导演', name: '张芸飞' }] }))
    store.saveProjectInfo(newer.id, snapshot({ lenses: [{ model: '雅典娜', detail: '标准组' }] }))

    const recalled = store.recallParentDetails(parent.id)
    expect(recalled?.crew).toEqual([{ role: '导演', name: '张芸飞' }])
    expect(recalled?.lenses).toEqual([{ model: '雅典娜', detail: '标准组' }])
  })

  it('用户自己写进档案的内容优先于历史推断', () => {
    const parent = makeParent('prj_ownwins0001', {
      camera: '自己填的机型',
      crew: [{ role: 'DIT', name: '陈善飞' }]
    })
    store.createParentProject(parent)

    const job = makeJob('job_history0001', parent.id, '2026-09-29T10:00:00.000Z')
    store.insertJob(job)
    store.saveProjectInfo(
      job.id,
      snapshot({ camera: '历史机型', crew: [{ role: '导演', name: '别人' }], lenses: [{ model: '历史镜头', detail: '' }] })
    )

    const recalled = store.recallParentDetails(parent.id)
    expect(recalled?.camera).toBe('自己填的机型')
    expect(recalled?.crew).toEqual([{ role: 'DIT', name: '陈善飞' }])
    // 档案里没有的就补上
    expect(recalled?.lenses).toEqual([{ model: '历史镜头', detail: '' }])
  })

  it('回捞是只读的 —— 档案原样不动', () => {
    const parent = makeParent('prj_readonly001')
    store.createParentProject(parent)
    const job = makeJob('job_readonly001', parent.id, '2026-09-29T10:00:00.000Z')
    store.insertJob(job)
    store.saveProjectInfo(job.id, snapshot({ crew: [{ role: '导演', name: '张芸飞' }] }))

    store.recallParentDetails(parent.id)

    // 库里那份要还是空的：用户没编辑过，档案就不该自己变
    expect(store.getParentProject(parent.id)?.details.crew).toEqual([])
  })

  it('名下没有任务时返回档案原样，不报错', () => {
    const parent = makeParent('prj_nojobs00001', { camera: 'ALEXA 35' })
    store.createParentProject(parent)
    expect(store.recallParentDetails(parent.id)?.camera).toBe('ALEXA 35')
  })

  it('不存在的母项目返回 null', () => {
    expect(store.recallParentDetails('prj_nosuchid00')).toBeNull()
  })

  it('名下的任务挂在别的母项目下时不会被误取', () => {
    const mine = makeParent('prj_mine000001')
    const other = makeParent('prj_other00001')
    store.createParentProject(mine)
    store.createParentProject(other)

    const job = makeJob('job_otherjob001', other.id, '2026-09-29T10:00:00.000Z')
    store.insertJob(job)
    store.saveProjectInfo(job.id, snapshot({ crew: [{ role: '导演', name: '别人家的' }] }))

    expect(store.recallParentDetails(mine.id)?.crew).toEqual([])
  })
})

describe('写回：把本次填的记进档案', () => {
  it('填了职员与镜头就记进去', () => {
    const parent = makeParent('prj_remember001')
    store.createParentProject(parent)

    const result = store.rememberParentTalent(parent.id, {
      lenses: [{ model: '雅典娜', detail: '标准组' }],
      crew: [{ role: '导演', name: '张芸飞' }]
    })

    expect(result?.changed).toBe(true)
    expect(store.getParentProject(parent.id)?.details.crew).toEqual([{ role: '导演', name: '张芸飞' }])
    expect(store.getParentProject(parent.id)?.details.lenses).toEqual([{ model: '雅典娜', detail: '标准组' }])
    // 写回要留时间戳，"这个母项目最近被更新过"是看得出来的
    expect(store.getParentProject(parent.id)?.updatedAt).not.toBeNull()
  })

  it('只动镜头与人员，别的字段一概不碰', () => {
    const parent = makeParent('prj_scoped000001', {
      projectName: '疲于奔命',
      camera: 'ALEXA 35',
      notes: '整部戏备注',
      shootDay: '2026-09-01'
    })
    store.createParentProject(parent)

    store.rememberParentTalent(parent.id, {
      lenses: [{ model: '雅典娜', detail: '标准组' }],
      crew: [{ role: '导演', name: '张芸飞' }]
    })

    const saved = store.getParentProject(parent.id)?.details
    expect(saved?.camera).toBe('ALEXA 35')
    expect(saved?.projectName).toBe('疲于奔命')
    expect(saved?.notes).toBe('整部戏备注')
    expect(saved?.shootDay).toBe('2026-09-01')
  })

  it('本次没填时不写库，档案保持原样', () => {
    const parent = makeParent('prj_keepold00001', { crew: [{ role: '导演', name: '旧导演' }] })
    store.createParentProject(parent)

    const result = store.rememberParentTalent(parent.id, { lenses: [], crew: [] })

    expect(result?.changed).toBe(false)
    expect(store.getParentProject(parent.id)?.details.crew).toEqual([{ role: '导演', name: '旧导演' }])
    expect(store.getParentProject(parent.id)?.updatedAt).toBeNull()
  })

  it('写回时把界面上留下的空行丢掉', () => {
    const parent = makeParent('prj_dropempty001')
    store.createParentProject(parent)

    store.rememberParentTalent(parent.id, {
      lenses: [],
      crew: [
        { role: '导演', name: '张芸飞' },
        { role: '', name: '' }
      ]
    })

    expect(store.getParentProject(parent.id)?.details.crew).toEqual([{ role: '导演', name: '张芸飞' }])
  })

  it('不存在的母项目返回 null，不会凭空造一个', () => {
    expect(store.rememberParentTalent('prj_nosuchid00', { lenses: [], crew: [] })).toBeNull()
  })

  it('回捞出来的内容被写回后，下一次读档案就是齐的', () => {
    const parent = makeParent('prj_roundtrip01')
    store.createParentProject(parent)

    const job = makeJob('job_roundtrip01', parent.id, '2026-09-29T10:00:00.000Z')
    store.insertJob(job)
    store.saveProjectInfo(job.id, snapshot({ crew: [{ role: '导演', name: '张芸飞' }] }))

    // 先回捞（读），再原样写回（用户在拷贝页点了创建任务）
    const recalled = store.recallParentDetails(parent.id)
    expect(recalled).not.toBeNull()
    store.rememberParentTalent(parent.id, { lenses: recalled?.lenses ?? [], crew: recalled?.crew ?? [] })

    expect(store.getParentProject(parent.id)?.details.crew).toEqual([{ role: '导演', name: '张芸飞' }])
    // 再捞一次也不该多出东西来
    expect(store.recallParentDetails(parent.id)?.crew).toEqual([{ role: '导演', name: '张芸飞' }])
  })
})

describe('沿用上次（未分组）时不受母项目记忆影响', () => {
  it('未分组的预填仍然只看未分组的任务', () => {
    const parent = makeParent('prj_isolated001')
    store.createParentProject(parent)

    const grouped = makeJob('job_grouped0001', parent.id, '2026-09-29T10:00:00.000Z')
    store.insertJob(grouped)
    store.saveProjectInfo(grouped.id, snapshot({ camera: '挂在母项目下的机型' }))

    // 没选母项目时不该带出别人的信息
    expect(store.getLatestProjectTemplate()).toBeNull()
  })
})
