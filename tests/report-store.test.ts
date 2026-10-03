/**
 * 报告档案测试。
 *
 * 核心要验证的是 README 里那句承诺：**旧报告不会被覆盖**。
 * 所以这里不只是"生成成功"，还会比对第一次修订的文件内容在第二次生成后
 * 是否逐字节未变 —— 这是不可变性的唯一硬证据。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CopyJob, FileTargetResult, ProjectInfo, ReportRevision } from '../src/shared/types'
import { Store } from '../src/main/db/store'
import { Logger } from '../src/main/logger'
import { buildAppPaths, type AppPaths } from '../src/main/paths'
import { ReportStore } from '../src/main/reports/report-store'

let root = ''
let store: Store
let paths: AppPaths
let reportStore: ReportStore

const NOW = new Date('2026-09-15T06:00:00.000Z')

const PROJECT: ProjectInfo = {
  projectName: '现场备份测试',
  shootDay: '2026-09-15',
  camera: 'ALEXA 35',
  cardLabel: 'A002',
  lenses: [{ model: 'Cooke S7/i', detail: '40mm' }],
  notes: '第一行备注\n第二行备注',
  crew: [{ role: 'DIT', name: '张三' }],
  copyNotes: '本次拷贝的现场备注',
  parentProjectName: '母亲',
  updatedAt: NOW.toISOString()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'securereel-report-'))
  paths = buildAppPaths(join(root, 'userData'))
  store = await Store.openInMemory()
  reportStore = new ReportStore(paths, new Logger({ dir: '' }))
})

afterEach(async () => {
  store.close()
  await rm(root, { recursive: true, force: true })
})

async function seedJob(state: CopyJob['state'] = 'completed'): Promise<{ job: CopyJob; targetPath: string }> {
  const targetPath = join(root, 'BackupA')
  await mkdir(targetPath, { recursive: true })

  const job: CopyJob = {
    id: 'job_report0001',
    name: 'A002 卡备份',
    mode: 'copy',
    sourcePath: join(root, 'A002R2EC'),
    sourceRootName: '',
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
    totalFiles: 3,
    totalBytes: 300,
    filesDone: 2,
    filesFailed: 1,
    bytesDone: 300,
    createdAt: NOW.toISOString(),
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
    degradationNotice: null
  }
  store.insertJob(job)

  const entries: [string, number, string, boolean][] = [
    ['Clips/a.mov', 100, 'aaaaaaaaaaaaaaaa', true],
    ['Clips/b.mov', 100, 'bbbbbbbbbbbbbbbb', true],
    ['Sidecar.txt', 100, 'cccccccccccccccc', false]
  ]
  store.upsertFiles(
    job.id,
    entries.map(([relPath, sizeBytes]) => ({ relPath, sizeBytes }))
  )
  for (const [relPath, , hash, verified] of entries) {
    store.updateFile(job.id, relPath, {
      state: verified ? 'verified' : 'failed',
      sourceHash: hash,
      error: verified ? null : '目标盘校验值不一致'
    })
    const fileId = Number(store.getFileRow(job.id, relPath)?.id)
    const result: FileTargetResult = {
      targetId: 'tgt_1',
      state: verified ? 'verified' : 'failed',
      hash,
      hashMatch: verified,
      bytesCopied: 100,
      error: verified ? null : '目标盘校验值不一致'
    }
    store.saveFileResult(fileId, job.id, result)
  }
  store.updateTargetProgress(job.id, 'tgt_1', { state: 'completed', filesDone: 2, filesFailed: 1, bytesCopied: 300 })

  return { job, targetPath }
}

/** 为已落库的任务写入一个新修订。 */
async function writeRevision(job: CopyJob, writeToTargets = true, preNotes?: string[]) {
  const result = await reportStore.writeRevision({
    job,
    project: PROJECT,
    store,
    sourceLabel: 'A002R2EC',
    targets: job.targets,
    hostname: 'dit-mac.local',
    toolName: 'SecureReel DIT',
    toolVersion: '1.0.0',
    now: NOW,
    writeManifestToTargets: writeToTargets,
    ...(preNotes === undefined ? {} : { preNotes })
  })
  return { job, revision: result.revision }
}

/** 用一份自定义的项目信息生成一版报告（用于验证母项目 / 镜头 / 两层备注的渲染）。 */
async function reviseWith(project: ProjectInfo, state: CopyJob['state'] = 'completed') {
  const { job } = await seedJob(state)
  const result = await reportStore.writeRevision({
    job,
    project,
    store,
    sourceLabel: 'A002R2EC',
    targets: job.targets,
    hostname: 'dit-mac.local',
    toolName: 'SecureReel DIT',
    toolVersion: '1.0.0',
    now: NOW,
    writeManifestToTargets: false
  })
  return result
}

async function hashOfFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

describe('修订目录结构', () => {
  it('生成 R001 并产出 JSON、HTML 与清单副本', async () => {
    const { job, targetPath } = await seedJob()
    const { revision } = await writeRevision(job)

    expect(revision.revision).toBe('R001')
    expect(revision.dir).toBe(join(paths.reportsDir, revision.jobId, 'R001'))

    await expect(stat(revision.files.json as string)).resolves.toBeTruthy()
    await expect(stat(revision.files.html as string)).resolves.toBeTruthy()

    const manifestDir = join(revision.dir, 'manifest', 'ascmhl')
    const manifestFiles = await readdir(manifestDir)
    expect(manifestFiles.some((name) => name.endsWith('.mhl'))).toBe(true)

    // 清单同时写进目标盘，随素材流转
    const targetManifests = await readdir(join(targetPath, 'ascmhl'))
    expect(targetManifests.some((name) => name.endsWith('.mhl'))).toBe(true)
  })

  it('frames/ 目录一定会建出来（即使这次没有缩略图）', async () => {
    const { job } = await seedJob()
    const { revision } = await writeRevision(job)
    const info = await stat(join(revision.dir, 'frames'))
    expect(info.isDirectory()).toBe(true)
  })
})

describe('report.json 内容', () => {
  it('是可解析的 JSON，且包含 summary / files / failures / project', async () => {
    const { job } = await seedJob()
    const { revision } = await writeRevision(job)
    const parsed = JSON.parse(await readFile(revision.files.json as string, 'utf8')) as {
      summary: { totalFiles: number; failedFiles: number; verifiedFiles: number }
      files: { relPath: string; state: string }[]
      failures: { relPath: string }[]
      project: ProjectInfo
      job: CopyJob
    }

    expect(parsed.summary.totalFiles).toBe(3)
    expect(parsed.summary.verifiedFiles).toBe(2)
    expect(parsed.summary.failedFiles).toBe(1)
    expect(parsed.files).toHaveLength(3)
    expect(parsed.failures).toHaveLength(1)
    expect(parsed.failures[0]?.relPath).toBe('Sidecar.txt')
    expect(parsed.project.projectName).toBe('现场备份测试')
    expect(parsed.job.id).toBe('job_report0001')
  })
})

describe('report.html 自包含性', () => {
  it('不引用任何外部资源（离线十年后仍能打开）', async () => {
    const { job } = await seedJob()
    const { revision } = await writeRevision(job)
    const html = await readFile(revision.files.html as string, 'utf8')

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).not.toMatch(/<script\s+src=/i)
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i)
    expect(html).not.toMatch(/src=["']https?:/i)
    expect(html).not.toMatch(/@import\s+url\(/i)
  })

  it('首帧图能被内联成 data URI，内联后 HTML 不再引用 frames/（单文件自包含）', async () => {
    const { job } = await seedJob()

    // 给文件挂一个"已探测到首帧"的记录，并在探测工作目录放一张假 JPEG
    const frameName = 'Clips_a.mov-first.jpg'
    const workFrame = join(reportStore.frameWorkDir(job.id), frameName)
    await mkdir(reportStore.frameWorkDir(job.id), { recursive: true })
    await writeFile(workFrame, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]))
    store.updateFile(job.id, 'Clips/a.mov', {
      probe: {
        available: true,
        reason: null,
        capturedAt: null,
        durationSeconds: 3,
        timecode: null,
        codec: 'prores',
        width: 1920,
        height: 1080,
        frameRate: '25 fps',
        firstFrame: frameName,
        lastFrame: null,
        format: 'QuickTime / ProRes',
        formatFamily: 'prores',
        frameSource: 'decoded',
        vendorTool: null,
        note: null
      }
    })

    const { revision } = await writeRevision(job)
    const htmlPath = revision.files.html as string
    const before = await readFile(htmlPath, 'utf8')
    expect(before).toContain('src="frames/')
    // frames/ 也已经归档进修订目录
    await expect(stat(join(revision.dir, 'frames', frameName))).resolves.toBeTruthy()

    const { inlined, skipped } = await reportStore.inlineReportFrames(revision)
    expect(inlined).toBe(1)
    expect(skipped).toBe(0)

    const after = await readFile(htmlPath, 'utf8')
    expect(after).toContain('data:image/jpeg;base64,')
    expect(after).not.toContain('src="frames/')
  })

  /**
   * 拿不到静帧的素材，报告必须**说明原因**，不能静默留白。
   *
   * 真实场景：boss 用 EOS R5 C 拷了一条 Cinema RAW Light（.CRM），
   * 报告里"首帧画面"整节消失、也没有一个字解释 —— 看起来像拷贝或工具出了问题，
   * 于是来问"报告中没有静帧出来"。实测确认的真实原因：
   *   · .CRM 是 MOV 系容器（major_brand='crx'，画面 fourcc=CRAW）
   *   · 文件里**没有**内嵌预览图 —— 前 96 MiB 与尾部 16 MiB 里 0 个可解析的 JPEG
   *   · ffmpeg 也没有 CRAW 解码器
   * 所以这个格式"有参数、没有画面"。
   *
   * 这里覆盖的是**探测成功但没有画面**那条路（当前 CRM 的实际形态）：
   * available 为 true、frameSource 为 none、说明写在 note 里。
   */
  it('探测成功但拿不到画面的格式（如佳能 CRM）会被单独说明，而不是整块消失', async () => {
    const { job } = await seedJob()
    const note =
      'CRM（Canon Cinema RAW Light） 使用厂商私有编码，FFmpeg 没有对应解码器，无法直接解码画面。' +
      ' 该格式也没有可用的内嵌预览图，因此本报告不含该素材的画面。'
    store.updateFile(job.id, 'Clips/a.mov', {
      probe: {
        available: true,
        reason: null,
        capturedAt: '2026-09-17T00:56:13.000Z',
        durationSeconds: 9.009,
        timecode: '08:21:48:23',
        codec: 'CRAW',
        width: 4096,
        height: 2160,
        frameRate: '23.976 fps',
        firstFrame: null,
        lastFrame: null,
        format: 'CRM（Canon Cinema RAW Light）',
        formatFamily: 'canon-raw',
        frameSource: 'none',
        vendorTool: 'Canon Cinema RAW Development / DaVinci Resolve',
        note
      }
    })

    const { revision } = await writeRevision(job)
    const html = await readFile(revision.files.html as string, 'utf8')

    // 没有首帧时，以前是"整节不渲染"，现在必须有一节把原因讲清楚
    expect(html).toContain('没有首帧画面的素材')
    // 点名格式，而不是含糊地说"某些文件"
    expect(html).toContain('CRM（Canon Cinema RAW Light）')
    // 说明里要讲清"这个格式本来就解不出画面"
    expect(html).toContain('没有可用的内嵌预览图')
    // 最重要的一句：这件事跟拷贝/校验结果无关，别让人误以为素材有问题
    expect(html).toContain('这与拷贝和校验结果无关')
    // 参数照常出现 —— 这正是"有参数、没有画面"的意思
    expect(html).toContain('08:21:48:23')
    expect(html).toContain('4096×2160')
    // 同一句说明只能说一次：它已经进了「没有首帧画面的素材」，
    // 就不该再出现在「素材格式说明」里（项目一直在防这种重复刷屏）
    expect(html.split(note).length - 1).toBe(1)
  })

  it('探测完全不可用的素材（老记录 / 未知扩展名）同样会被点名说明', async () => {
    const { job } = await seedJob()
    store.updateFile(job.id, 'Clips/a.mov', {
      probe: {
        available: false,
        reason: '该文件类型不做媒体元数据探测，仅记录文件级哈希。',
        capturedAt: null,
        durationSeconds: null,
        timecode: null,
        codec: null,
        width: null,
        height: null,
        frameRate: null,
        firstFrame: null,
        lastFrame: null,
        format: '普通文件',
        formatFamily: 'generic',
        frameSource: 'none',
        vendorTool: null,
        note: null
      }
    })

    const { revision } = await writeRevision(job)
    const html = await readFile(revision.files.html as string, 'utf8')

    expect(html).toContain('没有首帧画面的素材')
    expect(html).toContain('这与拷贝和校验结果无关')
  })

  it('母项目、机型、镜头、两层备注都出现在报告里', async () => {
    const { revision } = await reviseWith(PROJECT)
    const html = await readFile(revision.files.html as string, 'utf8')

    // 母项目单独一行，让人一眼看出这条记录属于哪部戏
    expect(html).toContain('母项目')
    expect(html).toContain('母亲')
    expect(html).toContain('ALEXA 35')
    // 镜头行
    expect(html).toContain('<th>镜头</th>')
    expect(html).toContain('Cooke S7/i 40mm')
    // 两层备注分开渲染，不能混在一起
    expect(html).toContain('>项目备注<')
    expect(html).toContain('>本次拷贝备注<')
    expect(html).toContain('本次拷贝的现场备注')
  })

  it('镜头有多颗时每颗一行并标上序号；只有一颗时不带序号', async () => {
    const many = await reviseWith({
      ...PROJECT,
      lenses: [
        { model: 'Cooke S7/i', detail: '40mm' },
        { model: 'Cooke S7/i', detail: '65mm' },
        { model: 'Angénieux', detail: '24-290' }
      ]
    })
    const html = await readFile(many.revision.files.html as string, 'utf8')
    expect(html).toContain('<th>镜头 1</th>')
    expect(html).toContain('<th>镜头 2</th>')
    expect(html).toContain('<th>镜头 3</th>')
    expect(html).toContain('Angénieux 24-290')
  })

  it('只有一颗镜头时不带序号', async () => {
    const { revision } = await reviseWith({ ...PROJECT, lenses: [{ model: 'Cooke S7/i', detail: '40mm' }] })
    const html = await readFile(revision.files.html as string, 'utf8')

    expect(html).toContain('<th>镜头</th>')
    expect(html).not.toContain('镜头 1')
  })

  it('没有母项目时不渲染「母项目」那一行', async () => {
    const { revision } = await reviseWith({ ...PROJECT, parentProjectName: null })
    const html = await readFile(revision.files.html as string, 'utf8')

    expect(html).not.toContain('母项目')
    expect(html).toContain('摄影机')
  })

  it('没有备注时不渲染对应的区块', async () => {
    const { revision } = await reviseWith({ ...PROJECT, notes: '', copyNotes: '' })
    const html = await readFile(revision.files.html as string, 'utf8')

    expect(html).not.toContain('>项目备注<')
    expect(html).not.toContain('>本次拷贝备注<')
  })

  it('JSON 与 HTML 里的项目信息一致，不会各说各话', async () => {
    const { revision } = await reviseWith(PROJECT)
    const parsed = JSON.parse(await readFile(revision.files.json as string, 'utf8')) as {
      project: ProjectInfo
    }
    const html = await readFile(revision.files.html as string, 'utf8')

    expect(parsed.project.parentProjectName).toBe('母亲')
    expect(parsed.project.lenses).toHaveLength(1)
    expect(parsed.project.copyNotes).toBe('本次拷贝的现场备注')
    expect(html).toContain(parsed.project.copyNotes)
  })

  it('包含关键信息：项目名、职务表、失败原因、校验算法', async () => {
    const { job } = await seedJob()
    const { revision } = await writeRevision(job)
    const html = await readFile(revision.files.html as string, 'utf8')

    expect(html).toContain('现场备份测试')
    expect(html).toContain('张三')
    expect(html).toContain('DIT')
    expect(html).toContain('Sidecar.txt')
    expect(html).toContain('目标盘校验值不一致')
    expect(html).toContain('xxhash64')
    expect(html).toContain('第一行备注')
  })
})

describe('不可变性', () => {
  it('第二次生成得到 R002，且 R001 的文件逐字节未变', async () => {
    const { job } = await seedJob()
    const first = await writeRevision(job)

    const htmlBefore = await hashOfFile(first.revision.files.html as string)
    const jsonBefore = await hashOfFile(first.revision.files.json as string)

    const second = await writeRevision(job)

    expect(second.revision.revision).not.toBe(first.revision.revision)
    expect(second.revision.dir).not.toBe(first.revision.dir)

    expect(await hashOfFile(first.revision.files.html as string)).toBe(htmlBefore)
    expect(await hashOfFile(first.revision.files.json as string)).toBe(jsonBefore)
  })

  it('修订号按 R001、R002 递增', async () => {
    const { job } = await seedJob()
    const first = await writeRevision(job)
    const second = await writeRevision(job)
    const third = await writeRevision(job)

    expect(first.revision.revision).toBe('R001')
    expect(second.revision.revision).toBe('R002')
    expect(third.revision.revision).toBe('R003')
    expect(store.listReports(job.id)).toHaveLength(3)
  })

  it('目标盘上的清单不会被第二次生成覆盖（代次递增）', async () => {
    const { job, targetPath } = await seedJob()
    await writeRevision(job)

    const targetManifestDir = join(targetPath, 'ascmhl')
    const before = (await readdir(targetManifestDir)).sort()
    await writeRevision(job)
    const after = (await readdir(targetManifestDir)).sort()

    expect(after.length).toBeGreaterThan(before.length)
    for (const name of before) {
      expect(after).toContain(name)
    }
  })
})

describe('未正常结束的任务', () => {
  it('取消的任务不往目标盘写清单，但报告仍然完整并写明状态', async () => {
    const { job } = await seedJob('cancelled')
    const result = await writeRevision(job, false)

    // 目标盘上不应该出现 ascmhl 目录（清单代表一份可信交付）
    await expect(readdir(join(job.targets[0]?.path as string, 'ascmhl'))).rejects.toThrow()
    // 但报告目录里的清单副本仍然生成，报告本身完整
    await expect(stat(join(result.revision.dir, 'manifest', 'ascmhl'))).resolves.toBeTruthy()
    await expect(stat(result.revision.files.html as string)).resolves.toBeTruthy()

    // 报告必须写明任务没有正常结束，否则拿到报告的人会误判
    const html = await readFile(result.revision.files.html as string, 'utf8')
    expect(html).toContain('未正常结束')
    expect(html).toContain('已取消')
  })
})

describe('修订目录已存在时拒绝写入', () => {
  it('手工占位导致目录冲突时直接报错而不是覆盖', async () => {
    const { job } = await seedJob()
    // 抢先把 R001 目录建出来，模拟并发或人为干扰
    await mkdir(join(paths.reportsDir, job.id, 'R001'), { recursive: true })
    await writeFile(join(paths.reportsDir, job.id, 'R001', 'report.html'), 'someone else data')

    await expect(writeRevision(job)).rejects.toThrow(/已存在/)

    expect(await readFile(join(paths.reportsDir, job.id, 'R001', 'report.html'), 'utf8')).toBe(
      'someone else data'
    )
  })
})

/**
 * 报告复制到目标盘。
 *
 * 报告只留本机时，盘一旦交给别人（剪辑、甲方、归档）就等于没有交付凭证 ——
 * 这组测试守住"复制过去"这个动作，以及它的三条硬约束：
 * 仅校验不写盘、绝不覆盖、不因复制失败影响任务本身。
 */
describe('报告复制到目标盘', () => {
  const publish = (job: CopyJob, revision: ReportRevision) =>
    reportStore.publishToTargets({
      job,
      revision,
      targets: job.targets,
      hostname: 'dit-mac.local',
      toolName: 'SecureReel DIT 2',
      toolVersion: '2.0.0',
      now: NOW
    })

  it('整份修订被复制到 <目标盘>/SecureReel/<任务名>_R001/', async () => {
    const { job, targetPath } = await seedJob()
    const { revision } = await writeRevision(job)

    const result = await publish(job, revision)

    expect(result.failed).toEqual([])
    expect(result.published).toEqual(['BackupA'])
    expect(result.relativeDirs).toEqual([join('SecureReel', `${job.name}_R001`)])

    const dest = join(targetPath, 'SecureReel', `${job.name}_R001`)
    expect((await readFile(join(dest, 'report.html'), 'utf8')).length).toBeGreaterThan(0)
    expect((await readFile(join(dest, 'report.json'), 'utf8')).length).toBeGreaterThan(0)

    // 多一份纯文本说明，给不打开网页、只 ls 一下盘的人看
    const note = await readFile(join(dest, '交付说明.txt'), 'utf8')
    expect(note).toContain('交付说明')
    expect(note).toContain(job.name)
    expect(note).toContain('report.html')
  })

  it('目标盘上已有同名目录时中止，一个字节都不动', async () => {
    const { job, targetPath } = await seedJob()
    const { revision } = await writeRevision(job)

    const dest = join(targetPath, 'SecureReel', `${job.name}_R001`)
    await mkdir(dest, { recursive: true })
    await writeFile(join(dest, 'report.html'), '上一次的交付记录', 'utf8')

    const result = await publish(job, revision)

    expect(result.published).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.reason).toContain('已存在')
    expect(await readFile(join(dest, 'report.html'), 'utf8')).toBe('上一次的交付记录')
  })

  it('仅校验模式连目录都不建 —— 它承诺不向目标盘写任何字节', async () => {
    const { job, targetPath } = await seedJob()
    const verifyJob: CopyJob = { ...job, mode: 'verify' }
    const { revision } = await writeRevision(verifyJob)

    const result = await publish(verifyJob, revision)

    expect(result.published).toEqual([])
    expect(result.failed).toEqual([])
    expect(await readdir(targetPath)).not.toContain('SecureReel')
  })

  it('任务名里的斜杠与冒号会被换掉，不会把目录拆成两级', async () => {
    const { job, targetPath } = await seedJob()
    const tricky: CopyJob = { ...job, name: 'D02/A机:主卡' }
    const { revision } = await writeRevision(tricky)

    await publish(tricky, revision)

    expect(await readdir(join(targetPath, 'SecureReel'))).toEqual(['D02_A机_主卡_R001'])
  })

  it('目标被停用时跳过，不建目录', async () => {
    const { job, targetPath } = await seedJob()
    const disabled: CopyJob = {
      ...job,
      targets: job.targets.map((target) => ({ ...target, enabled: false }))
    }
    const { revision } = await writeRevision(job)

    const result = await publish(disabled, revision)

    expect(result.published).toEqual([])
    expect(await readdir(targetPath)).not.toContain('SecureReel')
  })
})
