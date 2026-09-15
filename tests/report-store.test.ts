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
import type { CopyJob, FileTargetResult, ProjectInfo } from '../src/shared/types'
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
async function writeRevision(job: CopyJob, writeToTargets = true) {
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
    writeManifestToTargets: writeToTargets
  })
  return { job, revision: result.revision, extraNotes: result.extraNotes }
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
        formatFamily: 'quicktime',
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
