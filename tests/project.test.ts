/**
 * 项目信息与母项目的纯函数测试。
 *
 * 这里最重要的不是"函数能跑"，而是**老数据不能把界面弄崩**：
 * `project_info` 里存的是整包 JSON，读的时候直接 `JSON.parse`，没有任何校验。
 * 新增字段之后，老记录里那些字段是 `undefined`，界面一 `.map()` 就炸，
 * 而且报错行跟真正的原因毫无关系。
 */
import { describe, expect, it } from 'vitest'
import {
  CREW_ROLE_PRESET_KEYS,
  describeLenses,
  emptyProjectDetails,
  emptyProjectDraft,
  emptyProjectInfo,
  hasSubstance,
  nextAutoShootDay,
  normalizeProjectDetails,
  normalizeProjectDraft,
  normalizeProjectInfo
} from '../src/shared/project'
import { MAX_CREW_ROWS, MAX_LENS_ROWS, MAX_PROJECT_NOTES_LENGTH } from '../src/shared/types'

describe('空值构造', () => {
  it('给出一份结构完整的空信息', () => {
    expect(emptyProjectDetails()).toEqual({
      projectName: '',
      shootDay: '',
      camera: '',
      lenses: [],
      notes: '',
      crew: []
    })
  })

  it('ProjectInfo 带上卡号与两层备注的默认值', () => {
    const info = emptyProjectInfo('A002R2EC')
    expect(info.cardLabel).toBe('A002R2EC')
    expect(info.copyNotes).toBe('')
    expect(info.parentProjectName).toBeNull()
    expect(info.updatedAt).toBeNull()
    expect(info.lenses).toEqual([])
  })

  it('ProjectDraft 与 ProjectInfo 的差别只在服务端补齐的那两个字段', () => {
    const draft = emptyProjectDraft()
    expect('parentProjectName' in draft).toBe(false)
    expect('updatedAt' in draft).toBe(false)
    expect(draft.copyNotes).toBe('')
  })
})

describe('归一化：老数据不能把界面弄崩', () => {
  it('没有 lenses / copyNotes / parentProjectName 的老记录被补成默认值', () => {
    const legacy = {
      projectName: '老项目',
      shootDay: '2026-09-01',
      camera: 'ALEXA Mini',
      cardLabel: 'A001',
      notes: '老备注',
      crew: [{ role: 'DIT', name: '王五' }],
      updatedAt: null
    }

    const info = normalizeProjectInfo(legacy)
    expect(info.lenses).toEqual([])
    expect(info.copyNotes).toBe('')
    expect(info.parentProjectName).toBeNull()
    // 老字段原样保留
    expect(info.projectName).toBe('老项目')
    expect(info.crew).toEqual([{ role: 'DIT', name: '王五' }])
  })

  it('整条记录是 null / 字符串 / 数组时也不抛错', () => {
    for (const raw of [null, undefined, 'oops', 42, []]) {
      const info = normalizeProjectInfo(raw)
      expect(info.projectName).toBe('')
      expect(info.lenses).toEqual([])
      expect(info.crew).toEqual([])
    }
  })

  it('lenses 里的脏元素被丢掉，不会污染出 undefined', () => {
    const dirty = {
      lenses: [
        { model: 'Cooke S7/i', detail: '40mm' },
        null,
        'not-an-object',
        { model: 'Missing detail field' },
        { detail: 'no model' }
      ]
    }

    const details = normalizeProjectDetails(dirty)
    expect(details.lenses).toHaveLength(3)
    for (const lens of details.lenses) {
      expect(typeof lens.model).toBe('string')
      expect(typeof lens.detail).toBe('string')
    }
    expect(details.lenses[0]).toEqual({ model: 'Cooke S7/i', detail: '40mm' })
    expect(details.lenses[1]).toEqual({ model: 'Missing detail field', detail: '' })
  })

  it('lenses 不是数组时按空数组处理', () => {
    expect(normalizeProjectDetails({ lenses: 'nope' }).lenses).toEqual([])
    expect(normalizeProjectDetails({ lenses: {} }).lenses).toEqual([])
    expect(normalizeProjectDetails({}).lenses).toEqual([])
  })

  it('超量的行被截断到上限，超长的字段被截断', () => {
    const tooMany = Array.from({ length: MAX_LENS_ROWS + 10 }, () => ({ model: 'x', detail: '' }))
    expect(normalizeProjectDetails({ lenses: tooMany }).lenses).toHaveLength(MAX_LENS_ROWS)

    const tooManyCrew = Array.from({ length: MAX_CREW_ROWS + 10 }, () => ({ role: 'DIT', name: 'x' }))
    expect(normalizeProjectDetails({ crew: tooManyCrew }).crew).toHaveLength(MAX_CREW_ROWS)

    const longNotes = normalizeProjectDetails({ notes: 'a'.repeat(MAX_PROJECT_NOTES_LENGTH + 500) })
    expect(longNotes.notes).toHaveLength(MAX_PROJECT_NOTES_LENGTH)
  })

  it('字段类型不对时回落成空串，而不是把数字塞进输入框', () => {
    const details = normalizeProjectDetails({ projectName: 123, camera: { a: 1 }, shootDay: null })
    expect(details.projectName).toBe('')
    expect(details.camera).toBe('')
    expect(details.shootDay).toBe('')
  })

  it('草稿的归一化不会带上母项目名与时间戳', () => {
    const draft = normalizeProjectDraft({
      projectName: 'x',
      cardLabel: 'A002',
      copyNotes: '现场备注',
      parentProjectName: '母亲',
      updatedAt: '2026-09-15T00:00:00.000Z'
    })
    expect(draft.cardLabel).toBe('A002')
    expect(draft.copyNotes).toBe('现场备注')
    expect('parentProjectName' in draft).toBe(false)
    expect('updatedAt' in draft).toBe(false)
  })
})

describe('镜头描述', () => {
  it('空列表得到空串', () => {
    expect(describeLenses(emptyProjectDetails())).toBe('')
  })

  it('只有型号时不带多余空格', () => {
    expect(describeLenses({ ...emptyProjectDetails(), lenses: [{ model: 'Cooke S7/i', detail: '' }] })).toBe(
      'Cooke S7/i'
    )
  })

  it('型号与焦段用空格连接，多颗用顿号分隔', () => {
    const text = describeLenses({
      ...emptyProjectDetails(),
      lenses: [
        { model: 'Cooke S7/i', detail: '40mm' },
        { model: 'Cooke S7/i', detail: '65mm' }
      ]
    })
    expect(text).toBe('Cooke S7/i 40mm、Cooke S7/i 65mm')
  })

  it('空行被跳过，不会留下孤零零的分隔符', () => {
    const text = describeLenses({
      ...emptyProjectDetails(),
      lenses: [
        { model: '', detail: '' },
        { model: 'Angénieux', detail: '24-290' },
        { model: '   ', detail: '   ' }
      ]
    })
    expect(text).toBe('Angénieux 24-290')
  })
})

describe('是否有值得沿用的实质内容', () => {
  it('全空时返回 false', () => {
    expect(hasSubstance(emptyProjectDetails())).toBe(false)
  })

  it('只看拍摄日时返回 false —— 它是自动填的当天日期', () => {
    // 主进程创建任务时会自动把 shootDay 填成今天。若把它算作"有内容"，
    // 每一条记录看起来都非空，沿用逻辑就永远挑不到真正空的那条。
    expect(hasSubstance({ ...emptyProjectDetails(), shootDay: '2026-09-15' })).toBe(false)
  })

  it('任一实质字段非空即返回 true', () => {
    expect(hasSubstance({ ...emptyProjectDetails(), projectName: '母亲' })).toBe(true)
    expect(hasSubstance({ ...emptyProjectDetails(), camera: 'ALEXA 35' })).toBe(true)
    expect(hasSubstance({ ...emptyProjectDetails(), notes: '备注' })).toBe(true)
    expect(hasSubstance({ ...emptyProjectDetails(), lenses: [{ model: 'x', detail: '' }] })).toBe(true)
    expect(hasSubstance({ ...emptyProjectDetails(), lenses: [{ model: '', detail: '40mm' }] })).toBe(true)
    expect(hasSubstance({ ...emptyProjectDetails(), crew: [{ role: '', name: '张三' }] })).toBe(true)
  })

  it('只有空行（占位但没填）不算有内容', () => {
    expect(hasSubstance({ ...emptyProjectDetails(), lenses: [{ model: '', detail: '' }] })).toBe(false)
    expect(hasSubstance({ ...emptyProjectDetails(), crew: [{ role: '', name: '' }] })).toBe(false)
  })
})

describe('职务预置', () => {
  it('覆盖了剧组最常用的职务，且键名格式统一', () => {
    expect(CREW_ROLE_PRESET_KEYS.length).toBeGreaterThanOrEqual(10)
    for (const key of CREW_ROLE_PRESET_KEYS) {
      expect(key.startsWith('crew.role.')).toBe(true)
    }
    expect(CREW_ROLE_PRESET_KEYS).toContain('crew.role.director')
    expect(CREW_ROLE_PRESET_KEYS).toContain('crew.role.dp')
    expect(CREW_ROLE_PRESET_KEYS).toContain('crew.role.dit')
  })

  it('没有重复项', () => {
    expect(new Set(CREW_ROLE_PRESET_KEYS).size).toBe(CREW_ROLE_PRESET_KEYS.length)
  })
})

/*
 * 「拍摄日」跨午夜自动推进。
 *
 * 这块的风险很特别：写错了**不会报任何错**，日期格式完全合法，
 * 只是默默错一天，等到报告发出去才发现。所以五种情况全钉住。
 */
describe('拍摄日跨午夜自动推进', () => {
  it('过了半夜、且值还是程序填的 → 推进到新的一天', () => {
    expect(nextAutoShootDay('2026-10-03', '2026-10-03', '2026-10-04')).toBe('2026-10-04')
  })

  it('还没跨天 → 不动', () => {
    expect(nextAutoShootDay('2026-10-03', '2026-10-03', '2026-10-03')).toBeNull()
  })

  it('被人改过 → 不动（补拷昨天的卡就是故意填旧日期）', () => {
    // 程序填的是 10-03，用户手动改成 09-28 去补拷那天的卡，跨天时绝不能覆盖它
    expect(nextAutoShootDay('2026-09-28', '2026-10-03', '2026-10-04')).toBeNull()
  })

  it('值被清空 → 不动', () => {
    expect(nextAutoShootDay('', '2026-10-03', '2026-10-04')).toBeNull()
  })

  it('不知道这值是谁填的（没有记录）→ 不动，宁可不动也不猜', () => {
    expect(nextAutoShootDay('2026-10-03', null, '2026-10-04')).toBeNull()
    expect(nextAutoShootDay(null, null, '2026-10-04')).toBeNull()
  })

  it('没有草稿时（还没进拷贝页）不报错', () => {
    expect(nextAutoShootDay(null, '2026-10-03', '2026-10-04')).toBeNull()
  })

  it('跨月、跨年也能推进', () => {
    expect(nextAutoShootDay('2026-10-31', '2026-10-31', '2026-11-01')).toBe('2026-11-01')
    expect(nextAutoShootDay('2026-12-31', '2026-12-31', '2027-01-01')).toBe('2027-01-01')
  })
})
