/**
 * 输入校验测试。
 *
 * 这些用例对应的是安全边界：界面传来的任何字符串都必须先过 Zod，
 * 否则一个 `../` 或一份超长备注就可能变成越权写入或数据库膨胀。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_COPY_NOTES_LENGTH,
  MAX_CREW_ROWS,
  MAX_LENS_ROWS,
  MAX_PARENT_NAME_LENGTH,
  MAX_PROJECT_NOTES_LENGTH
} from '../src/shared/types'
import {
  absolutePathSchema,
  createJobSchema,
  createParentProjectSchema,
  jobIdSchema,
  lensEntrySchema,
  parentProjectIdSchema,
  projectInfoSchema,
  setJobParentSchema,
  settingsPatchSchema,
  tailSchema
} from '../src/shared/schemas'

describe('绝对路径校验', () => {
  it('接受正常的绝对路径', () => {
    expect(absolutePathSchema.safeParse('/Volumes/A002R2EC').success).toBe(true)
    expect(absolutePathSchema.safeParse('/Users/x/Desktop/素材 卡 001').success).toBe(true)
  })

  it('拒绝相对路径', () => {
    expect(absolutePathSchema.safeParse('Volumes/A002').success).toBe(false)
    expect(absolutePathSchema.safeParse('./local').success).toBe(false)
    expect(absolutePathSchema.safeParse('../up').success).toBe(false)
  })

  it('拒绝空串与含 NUL 的路径', () => {
    expect(absolutePathSchema.safeParse('').success).toBe(false)
    expect(absolutePathSchema.safeParse('/tmp/a\0b').success).toBe(false)
  })

  it('拒绝过长的路径', () => {
    expect(absolutePathSchema.safeParse(`/${'a'.repeat(5000)}`).success).toBe(false)
  })
})

describe('任务创建校验', () => {
  const base = {
    name: 'A002 备份',
    sourcePath: '/Volumes/A002',
    targets: [{ path: '/Volumes/BackupA' }]
  }

  it('接受合法请求', () => {
    expect(createJobSchema.safeParse(base).success).toBe(true)
  })

  it('拒绝空任务名', () => {
    expect(createJobSchema.safeParse({ ...base, name: '' }).success).toBe(false)
  })

  it('至少需要一个目标', () => {
    expect(createJobSchema.safeParse({ ...base, targets: [] }).success).toBe(false)
  })

  it('最多 8 个目标', () => {
    const eight = Array.from({ length: 8 }, (_, index) => ({ path: `/Volumes/T${index}` }))
    expect(createJobSchema.safeParse({ ...base, targets: eight }).success).toBe(true)

    const nine = Array.from({ length: 9 }, (_, index) => ({ path: `/Volumes/T${index}` }))
    expect(createJobSchema.safeParse({ ...base, targets: nine }).success).toBe(false)
  })

  it('目标路径里的相对路径会被拒绝', () => {
    expect(createJobSchema.safeParse({ ...base, targets: [{ path: '../evil' }] }).success).toBe(false)
  })

  it('只接受已定义的校验算法', () => {
    expect(createJobSchema.safeParse({ ...base, hashAlgorithm: 'xxhash64' }).success).toBe(true)
    expect(createJobSchema.safeParse({ ...base, hashAlgorithm: 'sha256' }).success).toBe(false)
  })
})

describe('任务 ID 校验', () => {
  it('接受合法 ID', () => {
    expect(jobIdSchema.safeParse('job_abcdef1234').success).toBe(true)
  })

  it('拒绝路径穿越形态的 ID', () => {
    expect(jobIdSchema.safeParse('../../etc/passwd').success).toBe(false)
    expect(jobIdSchema.safeParse('job_/../x').success).toBe(false)
    expect(jobIdSchema.safeParse('').success).toBe(false)
  })
})

describe('项目信息校验', () => {
  const base = {
    projectName: 'x',
    shootDay: '2026-09-15',
    camera: 'ALEXA 35',
    cardLabel: 'A002',
    lenses: [],
    notes: '',
    crew: [],
    copyNotes: '',
    parentProjectName: null,
    updatedAt: null
  }

  it('接受合法信息', () => {
    expect(projectInfoSchema.safeParse(base).success).toBe(true)
  })

  it('镜头行数上限为 40，且每个字段都被限制长度', () => {
    const atLimit = Array.from({ length: MAX_LENS_ROWS }, () => ({ model: 'Cooke S7/i', detail: '40mm' }))
    expect(projectInfoSchema.safeParse({ ...base, lenses: atLimit }).success).toBe(true)

    const overLimit = Array.from({ length: MAX_LENS_ROWS + 1 }, () => ({ model: 'x', detail: '' }))
    expect(projectInfoSchema.safeParse({ ...base, lenses: overLimit }).success).toBe(false)

    expect(lensEntrySchema.safeParse({ model: 'a'.repeat(121), detail: '' }).success).toBe(false)
    expect(lensEntrySchema.safeParse({ model: 'x', detail: 'a'.repeat(121) }).success).toBe(false)
  })

  it('缺 lenses 时补成空数组而不是报错', () => {
    // 老数据里根本没有 lenses 字段。若这里设成必填，
    // 用户什么都没改却会被拦下来存不上 —— 这是回归防线。
    const { lenses, ...withoutLenses } = base
    void lenses
    const parsed = projectInfoSchema.safeParse(withoutLenses)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.lenses).toEqual([])
  })

  it(`本次拷贝备注上限为 ${MAX_COPY_NOTES_LENGTH} 字`, () => {
    expect(
      projectInfoSchema.safeParse({ ...base, copyNotes: 'a'.repeat(MAX_COPY_NOTES_LENGTH) }).success
    ).toBe(true)
    expect(
      projectInfoSchema.safeParse({ ...base, copyNotes: 'a'.repeat(MAX_COPY_NOTES_LENGTH + 1) }).success
    ).toBe(false)
  })

  it(`职务行数上限为 ${MAX_CREW_ROWS}`, () => {
    const atLimit = Array.from({ length: MAX_CREW_ROWS }, () => ({ role: 'DIT', name: 'x' }))
    expect(projectInfoSchema.safeParse({ ...base, crew: atLimit }).success).toBe(true)

    const overLimit = Array.from({ length: MAX_CREW_ROWS + 1 }, () => ({ role: 'DIT', name: 'x' }))
    expect(projectInfoSchema.safeParse({ ...base, crew: overLimit }).success).toBe(false)
  })

  it(`备注上限为 ${MAX_PROJECT_NOTES_LENGTH} 字`, () => {
    expect(
      projectInfoSchema.safeParse({ ...base, notes: 'a'.repeat(MAX_PROJECT_NOTES_LENGTH) }).success
    ).toBe(true)
    expect(
      projectInfoSchema.safeParse({ ...base, notes: 'a'.repeat(MAX_PROJECT_NOTES_LENGTH + 1) }).success
    ).toBe(false)
  })

  it('拒绝缺少必要字段的对象', () => {
    expect(projectInfoSchema.safeParse({ projectName: 'x' }).success).toBe(false)
    expect(projectInfoSchema.safeParse(null).success).toBe(false)
  })
})

describe('母项目校验', () => {
  it('母项目 ID 必须带 prj_ 前缀', () => {
    expect(parentProjectIdSchema.safeParse('prj_abc123def').success).toBe(true)
    expect(parentProjectIdSchema.safeParse('job_abc123def').success).toBe(false)
    expect(parentProjectIdSchema.safeParse('prj_').success).toBe(false)
    expect(parentProjectIdSchema.safeParse('prj_../etc/passwd').success).toBe(false)
  })

  it('母项目名称不能为空且不能过长', () => {
    expect(createParentProjectSchema.safeParse({ name: '母亲' }).success).toBe(true)
    expect(createParentProjectSchema.safeParse({ name: '' }).success).toBe(false)
    expect(
      createParentProjectSchema.safeParse({ name: 'a'.repeat(MAX_PARENT_NAME_LENGTH + 1) }).success
    ).toBe(false)
  })

  it('不传 details 时自动补一份空的项目信息', () => {
    const parsed = createParentProjectSchema.safeParse({ name: '母亲' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.details).toEqual({
        projectName: '',
        shootDay: '',
        camera: '',
        lenses: [],
        notes: '',
        crew: []
      })
    }
  })

  it('改任务归属时接受 null（移出到未分组）', () => {
    expect(setJobParentSchema.safeParse({ jobId: 'job_abc123def', parentProjectId: null }).success).toBe(true)
    expect(
      setJobParentSchema.safeParse({ jobId: 'job_abc123def', parentProjectId: 'prj_abc123def' }).success
    ).toBe(true)
    expect(setJobParentSchema.safeParse({ jobId: 'job_x', parentProjectId: null }).success).toBe(false)
  })
})

describe('创建任务时的项目信息校验', () => {
  it('可以不带母项目与项目信息（老界面调用的形态）', () => {
    expect(
      createJobSchema.safeParse({
        name: 'A002',
        sourcePath: '/Volumes/A002R2EC',
        targets: [{ path: '/Volumes/BackupA' }]
      }).success
    ).toBe(true)
  })

  it('可以一次带全母项目与项目信息', () => {
    expect(
      createJobSchema.safeParse({
        name: 'A002',
        sourcePath: '/Volumes/A002R2EC',
        targets: [{ path: '/Volumes/BackupA' }],
        parentProjectId: 'prj_abc123def',
        project: {
          projectName: '母亲',
          shootDay: '2026-09-15',
          camera: 'ALEXA 35',
          lenses: [{ model: 'Cooke S7/i', detail: '40mm' }],
          notes: '整部戏的备注',
          crew: [{ role: '导演', name: '张三' }],
          cardLabel: 'A002R2EC',
          copyNotes: '本次备注'
        }
      }).success
    ).toBe(true)
  })

  it('拒绝非法的母项目 ID', () => {
    expect(
      createJobSchema.safeParse({
        name: 'A002',
        sourcePath: '/Volumes/A002R2EC',
        targets: [{ path: '/Volumes/BackupA' }],
        parentProjectId: 'not-a-parent'
      }).success
    ).toBe(false)
  })
})

describe('设置更新校验', () => {
  it('接受合法补丁', () => {
    expect(settingsPatchSchema.safeParse({ themeId: 'wuguang', themeMode: 'dark' }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({ language: 'en' }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({}).success).toBe(true)
  })

  it('拒绝未知的主题与模式', () => {
    expect(settingsPatchSchema.safeParse({ themeId: 'neon' }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ themeMode: 'sepia' }).success).toBe(false)
  })

  it('并发数被限制在 1–8', () => {
    expect(settingsPatchSchema.safeParse({ maxParallelTargets: 4 }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({ maxParallelTargets: 0 }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ maxParallelTargets: 99 }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ maxParallelTargets: 1.5 }).success).toBe(false)
  })

  it('外部工具路径只接受绝对路径或 null', () => {
    expect(settingsPatchSchema.safeParse({ ffmpegDir: '/opt/homebrew/bin' }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({ ffmpegDir: null }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({ ffmpegDir: 'relative/path' }).success).toBe(false)
  })
})

describe('日志读取校验', () => {
  it('行数被限制在合理区间', () => {
    expect(tailSchema.safeParse({ lines: 300 }).success).toBe(true)
    expect(tailSchema.safeParse({}).success).toBe(true)
    expect(tailSchema.safeParse({ lines: 0 }).success).toBe(false)
    expect(tailSchema.safeParse({ lines: 99999 }).success).toBe(false)
  })
})
