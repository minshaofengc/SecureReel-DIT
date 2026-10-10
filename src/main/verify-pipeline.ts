/**
 * 端到端验证入口（只在 SECUREREEL_VERIFY=1 时参与构建）。
 *
 * 为什么需要它：单元测试跑在纯 Node 里，而真正发布出去的代码跑在 Electron 里。
 * 「Node 里过了」不等于「Electron 里能跑」—— node:sqlite 是否暴露、
 * printToPDF 是否可用、打包后的路径解析是否正确，这些只有真的在 Electron
 * 运行时里跑一遍才知道。
 *
 * 这里跑的是与生产完全相同的模块：Store / CopyEngine / ReportStore /
 * FfprobeRunner / renderHtmlToPdf，没有任何 stub。
 *
 * 用法：npm run verify:pipeline
 */
import { app, nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CopyJob, MediaProbe, ProjectInfo } from '@shared/types'
import {
  DEFAULT_SETTINGS,
  HASH_ALGORITHMS,
  HASH_ALGORITHM_LABELS
} from '@shared/types'
import { todayLocalDate } from '@shared/format'
import { buildAppPaths } from './paths'
import { Logger } from './logger'
import { Store } from './db/store'
import { CopyEngine, hashFileAt } from './core/copy-engine'
import { hashLooksValid } from './hashing'
import { PauseGate } from './core/concurrency'
import { ReportStore } from './reports/report-store'
import { writeCsvManifest, writeJsonManifest } from './reports/manifests'
import { renderHtmlToPdf } from './reports/pdf'
import { FfprobeRunner } from './media/probe'
import { walkFiles } from './fs-utils'
import { resolveExecutable, runCommand } from './exec'
import { executableName } from './platform'
import { whichInPath } from './fs-utils'

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const results: CheckResult[] = []

/**
 * 解析自检要用的 ffmpeg。
 *
 * ⚠️ **优先用随包分发的那份**（打包后在 `resources/bin`，开发时在
 * `vendor/ffmpeg/<平台-架构>`，与 `electron-builder.yml` 的 extraResources 一致），
 * 只有找不到才退回系统 PATH。
 *
 * 原先这里直接 `whichInPath('ffmpeg')`，拿到的是 Homebrew 那份 —— 于是
 * "换随包二进制、换构建参数"之后流水线照样全绿：它测的根本不是要发出去的东西。
 * 这一条对 2.0.4 换 LGPL ffmpeg 尤其要紧，否则换了二进制没有回归网。
 */
async function resolveVerifyFfmpeg(): Promise<string | null> {
  const bundled = app.isPackaged
    ? join(process.resourcesPath, 'bin', executableName('ffmpeg'))
    : join(
        process.cwd(),
        'vendor',
        'ffmpeg',
        `${process.platform}-${process.arch}`,
        executableName('ffmpeg')
      )

  const resolved = await resolveExecutable(bundled)
  if (resolved !== null) return resolved
  return resolveExecutable(await whichInPath('ffmpeg'))
}

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  process.stdout.write(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}\n`)
}

async function hashOf(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

/** 造一张真实的 JPEG（用 Electron 自带的图像编码器，不引入额外依赖）。 */
function makeTestJpeg(width: number, height: number, rgb: [number, number, number]): Buffer {
  const raw = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      // 加一点渐变，避免纯色被编码器压成极小文件
      raw[offset] = Math.min(255, rgb[0] + (x * 255) / width)
      raw[offset + 1] = Math.min(255, rgb[1] + (y * 255) / height)
      raw[offset + 2] = rgb[2]
      raw[offset + 3] = 255
    }
  }
  return nativeImage.createFromBuffer(raw, { width, height }).toJPEG(88)
}

/**
 * 造一个"厂商私有格式"的测试文件：魔数 + 内嵌 JPEG + 尾部填充。
 *
 * 真实的 R3D / BRAW 就是这种结构（文件里嵌了一张预览图给机内回放用）。
 * 这里复现的是**结构**，用来验证提取逻辑，不是伪造一个能解码的假素材。
 */
function buildPreviewEmbeddedFile(magic: Buffer, jpeg: Buffer, headPad: number): Buffer {
  const head = Buffer.alloc(headPad, 0x11)
  const tail = Buffer.alloc(64 * 1024, 0x22)
  return Buffer.concat([magic, head, jpeg, tail])
}

/**
 * 在指定位置造一份"上一版"的数据库。
 *
 * `jobs` 表结构与当前代码一致，只缺 `parent_project_id` —— 这正是老用户
 * 升级时的真实状态。用来验证升级走的是"就地补列"而不是"判定不兼容后隔离留档"
 * （后者会让用户界面上的任务全部消失）。
 */
async function plantPreviousVersionDatabase(dbFile: string): Promise<void> {
  const { openDatabase } = await import('./db/driver')
  const db = await openDatabase(dbFile)
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE jobs (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      source_path        TEXT NOT NULL,
      source_kind        TEXT NOT NULL DEFAULT 'generic',
      is_codex_vfs       INTEGER NOT NULL DEFAULT 0,
      hash_algorithm     TEXT NOT NULL,
      manifest_format    TEXT NOT NULL,
      verify_after_write INTEGER NOT NULL DEFAULT 1,
      state              TEXT NOT NULL,
      total_files        INTEGER NOT NULL DEFAULT 0,
      total_bytes        INTEGER NOT NULL DEFAULT 0,
      files_done         INTEGER NOT NULL DEFAULT 0,
      files_failed       INTEGER NOT NULL DEFAULT 0,
      bytes_done         INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT NOT NULL,
      started_at         TEXT,
      finished_at        TEXT,
      degradation_notice TEXT
    );
    CREATE TABLE project_info (
      job_id     TEXT PRIMARY KEY,
      data_json  TEXT NOT NULL,
      updated_at TEXT
    );
  `)
  db.prepare(
    `INSERT INTO jobs (id, name, source_path, hash_algorithm, manifest_format, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'job_legacy00001',
    '上一版留下的任务',
    '/Volumes/LegacyCard',
    'xxhash64',
    'asc-mhl-2.0',
    'completed',
    '2026-08-01T00:00:00.000Z'
  )
  db.prepare('INSERT INTO project_info (job_id, data_json, updated_at) VALUES (?, ?, ?)').run(
    'job_legacy00001',
    JSON.stringify({
      projectName: '老项目',
      shootDay: '2026-08-01',
      camera: 'ALEXA Mini',
      cardLabel: 'A001',
      notes: '老版本的备注',
      crew: [{ role: 'DIT', name: '王五' }],
      updatedAt: null
    }),
    null
  )
  db.close()
}

async function main(): Promise<number> {
  const root = await mkdtemp(join(tmpdir(), 'securereel-verify-'))
  process.stdout.write(`\nSecureReel DIT 端到端验证\n工作目录：${root}\n\n`)

  const source = join(root, 'A002R2EC')
  const targetA = join(root, 'BackupA')
  const targetB = join(root, 'BackupB')
  const userData = join(root, 'userData')
  let store: Store | null = null

  try {
    /* ---------- 1. 造素材 ---------- */
    process.stdout.write('[1] 准备素材\n')
    await mkdir(join(source, 'Clips'), { recursive: true })
    await mkdir(join(source, 'Audio'), { recursive: true })
    await mkdir(targetA, { recursive: true })
    await mkdir(targetB, { recursive: true })

    const logger = new Logger({ dir: join(userData, 'logs') })

    // 一份跨多个 8 MiB 分片的大文件，逼出真实的分片写入路径
    const big = Buffer.alloc(9 * 1024 * 1024 + 4321)
    for (let i = 0; i < big.length; i += 997) big.writeUInt8((i * 7) % 256, i)
    await writeFile(join(source, 'Clips/big_generic.mov'), big)
    await writeFile(join(source, 'Audio/A002_001.wav'), Buffer.from('audio payload here'))
    await writeFile(join(source, 'Sidecar.txt'), Buffer.from('sidecar metadata'))
    await writeFile(join(source, '.DS_Store'), Buffer.from('junk'))

    // 真实 ProRes（有 ffmpeg 才造得出来）
    const ffmpegPath = await resolveVerifyFfmpeg()
    let proresCreated = false
    if (ffmpegPath !== null) {
      const result = await runCommand(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=640x360:rate=25:duration=1',
          '-c:v',
          'prores_ks',
          '-profile:v',
          '3',
          '-pix_fmt',
          'yuv422p10le',
          '-y',
          join(source, 'Clips/A002C001_prores422hq.mov')
        ],
        { timeoutMs: 60_000 }
      )
      proresCreated = result.code === 0
    }
    check(
      '生成真实 ProRes 422 HQ 素材',
      proresCreated,
      proresCreated ? `由 ${ffmpegPath ?? '?'} 编码` : '本机没有 ffmpeg，跳过这一项（其它检查照常）'
    )

    // 私有格式：结构复现（魔数 + 内嵌预览图）
    const previewJpeg = makeTestJpeg(512, 288, [180, 60, 40])
    await writeFile(
      join(source, 'Clips/A003C001.R3D'),
      buildPreviewEmbeddedFile(Buffer.from('RED1', 'latin1'), previewJpeg, 512 * 1024)
    )
    await writeFile(
      join(source, 'Clips/A004C001.braw'),
      buildPreviewEmbeddedFile(Buffer.from('\u0000\u0000\u0000\u0008', 'latin1'), previewJpeg, 256 * 1024)
    )

    const walk = await walkFiles(source)
    const videoCount = walk.files.filter((file) =>
      /\.(mov|r3d|braw)$/i.test(file.relPath) && !/big_generic/.test(file.relPath)
    ).length

    // 期望：上面写进去的文件一个不少，唯独 .DS_Store 被跳过
    const expectedFiles = [
      'Audio/A002_001.wav',
      'Clips/A003C001.R3D',
      'Clips/A004C001.braw',
      'Clips/big_generic.mov',
      'Sidecar.txt',
      ...(proresCreated ? ['Clips/A002C001_prores422hq.mov'] : [])
    ].sort()
    const scanned = walk.files.map((file) => file.relPath).sort()
    check(
      '素材清单正确（跳过 .DS_Store，其余一个不少）',
      JSON.stringify(scanned) === JSON.stringify(expectedFiles),
      `${scanned.length} 个文件`
    )
    check('识别出需要提取首帧的视频素材', videoCount === (proresCreated ? 3 : 2), `${videoCount} 条`)

    /* ---------- 2. 数据库与探测工具 ---------- */
    process.stdout.write('\n[2] 数据库与媒体工具\n')
    const paths = buildAppPaths(userData)
    await mkdir(paths.reportsDir, { recursive: true })

    /*
     * 先在数据库文件位置放一份"上一版"的库：jobs 表结构与当前完全一致，
     * 只缺 parent_project_id。这是老用户升级时的真实状态，
     * 也是本次改动唯一有真实数据丢失风险的路径。
     */
    await plantPreviousVersionDatabase(paths.dbFile)

    store = await Store.open(paths.dbFile)
    check('在 Electron 中打开磁盘上的 SQLite', true, paths.dbFile.replace(root, '…'))
    check(
      '上一版数据库被就地升级，而不是被隔离留档',
      store.quarantined === null,
      store.quarantined === null ? '没有触发隔离' : `误判为不兼容：${store.quarantined.reason}`
    )
    const legacyJob = store.getJob('job_legacy00001')
    check(
      '升级后老任务仍在，且新列为空值',
      legacyJob !== null && legacyJob.parentProjectId === null,
      legacyJob === null ? '老任务丢了' : legacyJob.name
    )
    const legacyInfo = store.getProjectInfo('job_legacy00001')
    check(
      '老格式的项目信息读出来缺的字段补默认值（不崩）',
      legacyInfo !== null && legacyInfo.lenses.length === 0 && legacyInfo.copyNotes === '',
      legacyInfo === null ? '读不到' : `机型 ${legacyInfo.camera}`
    )

    const reportStore = new ReportStore(paths, logger)
    const probeRunner = new FfprobeRunner({ logger, userDir: null, bundledDir: null })
    await probeRunner.refresh()
    check(
      'ffprobe / ffmpeg 就绪',
      probeRunner.available,
      probeRunner.available ? '元数据解析可用' : '未找到，元数据与解码取帧会走回退路径'
    )

    const targetIds = ['tgt_1', 'tgt_2']
    const job: CopyJob = {
      id: 'job_verify0001',
      name: '端到端验证任务',
      mode: 'copy',
      sourcePath: source,
      sourceRootName: '',
      sourceKind: 'generic',
      isCodExVfs: false,
      parentProjectId: null,
      targets: [
        { id: targetIds[0] as string, path: targetA, label: 'BackupA', enabled: true, freeBytes: null, writable: true },
        { id: targetIds[1] as string, path: targetB, label: 'BackupB', enabled: true, freeBytes: null, writable: true }
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
      totalFiles: walk.files.length,
      totalBytes: walk.totalBytes,
      filesDone: 0,
      filesFailed: 0,
      bytesDone: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      degradationNotice: null
    }
    store.insertJob(job)
    store.upsertFiles(job.id, walk.files.map((file) => ({ relPath: file.relPath, sizeBytes: file.sizeBytes })))
    check('任务与文件清单落库', store.countFiles(job.id) === walk.files.length, `${store.countFiles(job.id)} 行`)

    /* ---------- 3. 跑真实拷贝引擎（含媒体分析阶段） ---------- */
    process.stdout.write('\n[3] 拷贝引擎（读出即算哈希 + 扇出写 + 重读校验 + 媒体分析）\n')
    probeRunner.setFrameOutputDir(reportStore.frameWorkDir(job.id))

    const progressPhases = new Set<string>()
    const engine = new CopyEngine({
      job,
      store,
      logger,
      settings: { ...DEFAULT_SETTINGS, maxParallelTargets: 4, extractFrames: true, maxFrameExtractions: 0 },
      signal: new AbortController().signal,
      gate: new PauseGate(),
      probeRunner,
      onProgress: (progress) => {
        progressPhases.add(progress.phase)
      }
    })
    const startedAt = Date.now()
    const runResult = await engine.run()
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2)

    store.updateJob(job.id, { finishedAt: new Date().toISOString() })
    const finished = store.getJob(job.id) as CopyJob
    check(
      '任务正常完成',
      runResult.state === 'completed',
      `state=${runResult.state} 文件=${finished.filesDone} 用时=${elapsed}s`
    )
    check('无失败文件', finished.filesFailed === 0, `失败 ${finished.filesFailed} 个`)
    check(
      '进度上报覆盖了拷贝与分析两个阶段',
      progressPhases.has('copying') && progressPhases.has('analyzing'),
      [...progressPhases].join(' → ')
    )

    /* ---------- 4. 逐字节比对目标盘内容 ---------- */
    process.stdout.write('\n[4] 目标盘内容逐字节比对\n')
    let byteIdentical = true
    for (const target of [targetA, targetB]) {
      for (const file of walk.files) {
        if ((await hashOf(file.absPath)) !== (await hashOf(join(target, file.relPath)))) {
          byteIdentical = false
          process.stdout.write(`      不一致：${target}/${file.relPath}\n`)
        }
      }
    }
    check('两个目标盘的内容都与源盘逐字节一致', byteIdentical, `${walk.files.length} 个文件 × 2 个目标`)

    let partialLeft = 0
    for (const target of [targetA, targetB]) {
      for (const name of await readdir(target, { recursive: true })) {
        if (String(name).includes('.securereel-partial')) partialLeft++
      }
    }
    check('没有残留任何分片文件', partialLeft === 0, `残留 ${partialLeft} 个`)

    /* ---------- 5. 格式识别与首帧提取 ---------- */
    process.stdout.write('\n[5] 格式识别与首帧提取\n')
    const probes = new Map<string, MediaProbe>()
    for await (const file of store.iterateFiles(job.id)) {
      if (file.probe !== null) probes.set(file.relPath, file.probe)
    }

    const prores = probes.get('Clips/A002C001_prores422hq.mov')
    if (proresCreated) {
      check(
        'ProRes 422 HQ 被正确识别',
        prores?.formatFamily === 'prores' && (prores?.format ?? '').includes('422 HQ'),
        `format=${prores?.format ?? '（无）'} codec=${prores?.codec ?? '（无）'}`
      )
      check(
        'ProRes 首帧由解码得到',
        prores?.firstFrame !== null && prores?.frameSource === 'decoded',
        `frameSource=${prores?.frameSource ?? '（无）'} file=${prores?.firstFrame ?? '（无）'}`
      )
    }

    const r3d = probes.get('Clips/A003C001.R3D')
    check(
      'R3D 被识别为 REDCODE RAW',
      r3d?.formatFamily === 'r3d',
      `format=${r3d?.format ?? '（无）'} vendorTool=${r3d?.vendorTool ?? '（无）'}`
    )
    check(
      'R3D 首帧取自文件内嵌预览图',
      r3d?.frameSource === 'embedded-preview' && r3d?.firstFrame !== null,
      `frameSource=${r3d?.frameSource ?? '（无）'} 预览分辨率=${r3d?.width ?? '?'}×${r3d?.height ?? '?'}`
    )

    const braw = probes.get('Clips/A004C001.braw')
    check(
      'BRAW 被识别为 Blackmagic RAW',
      braw?.formatFamily === 'braw',
      `format=${braw?.format ?? '（无）'} vendorTool=${braw?.vendorTool ?? '（无）'}`
    )
    check(
      'BRAW 首帧取自文件内嵌预览图',
      braw?.frameSource === 'embedded-preview' && braw?.firstFrame !== null,
      `frameSource=${braw?.frameSource ?? '（无）'} 预览分辨率=${braw?.width ?? '?'}×${braw?.height ?? '?'}`
    )

    // 首帧图必须是真实 JPEG —— 只检查文件名存在是不够的
    const frameDir = reportStore.frameWorkDir(job.id)
    let jpegOk = 0
    const jpegBad: string[] = []
    for (const probe of probes.values()) {
      if (probe.firstFrame === null) continue
      try {
        const bytes = await readFile(join(frameDir, probe.firstFrame))
        const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        if (isJpeg && bytes.length > 1024) jpegOk++
        else jpegBad.push(`${probe.firstFrame}(${bytes.length}B)`)
      } catch {
        jpegBad.push(`${probe.firstFrame}(缺失)`)
      }
    }
    check(
      '提取出的首帧都是合法的 JPEG 文件',
      jpegBad.length === 0 && jpegOk > 0,
      jpegBad.length === 0 ? `${jpegOk} 张通过校验` : `异常：${jpegBad.join(', ')}`
    )
    /* ---------- 6. 报告与清单（含首帧画廊与真实 PDF） ---------- */
    process.stdout.write('\n[6] 报告与清单\n')
    const project: ProjectInfo = {
      projectName: '端到端验证',
      shootDay: todayLocalDate(),
      camera: 'ALEXA 35',
      cardLabel: 'A002',
      lenses: [
        { model: 'Cooke S7/i', detail: '40mm' },
        { model: 'Cooke S7/i', detail: '65mm' }
      ],
      notes: '由 verify:pipeline 自动生成，用于验证报告链路。',
      crew: [
        { role: 'DIT', name: '张三' },
        { role: '摄影助理', name: '李四' }
      ],
      copyNotes: '本次拷贝的现场备注：第一张卡，无异常。',
      parentProjectName: '母亲',
      updatedAt: new Date().toISOString()
    }

    const finalJob = store.getJob(job.id) as CopyJob
    const { revision } = await reportStore.writeRevision({
      job: finalJob,
      project,
      store,
      sourceLabel: 'A002R2EC',
      targets: finalJob.targets,
      hostname: 'verify.local',
      toolName: 'SecureReel DIT',
      toolVersion: '1.0.0',
      now: new Date(),
      writeManifestToTargets: true
    })
    check('修订目录为 R001', revision.revision === 'R001', revision.dir.replace(root, '…'))

    const jsonPath = revision.files.json as string
    const htmlPath = revision.files.html as string
    const parsed = JSON.parse(await readFile(jsonPath, 'utf8')) as {
      summary: { verifiedFiles: number; jobState: string }
      files: { relPath: string; probe: MediaProbe | null }[]
    }
    check(
      'report.json 可解析且内容完整',
      parsed.summary.verifiedFiles === walk.files.length && parsed.summary.jobState === 'completed',
      `verified=${parsed.summary.verifiedFiles} files=${parsed.files.length}`
    )
    check(
      'report.json 里带了格式与首帧来源',
      parsed.files.some((file) => file.probe !== null && file.probe.formatFamily === 'r3d'),
      'R3D 条目含 formatFamily'
    )

    const html = await readFile(htmlPath, 'utf8')
    const imgTags = (html.match(/<img src="frames\//g) ?? []).length
    check(
      'report.html 里嵌入了首帧画面',
      imgTags >= 2,
      `${imgTags} 张图，HTML ${html.length} 字节`
    )
    check(
      'report.html 自包含且包含项目信息',
      html.includes('端到端验证') && html.includes('张三') && !/src=["']https?:/i.test(html),
      '无外链资源'
    )

    // 帧文件真的被拷进了修订目录
    const revisionFrames = await readdir(join(revision.dir, 'frames'))
    check('修订目录里有归档的首帧文件', revisionFrames.length >= 2, revisionFrames.join(', '))

    const pdfPath = join(revision.dir, 'report.pdf')
    const pdf = await renderHtmlToPdf(htmlPath, pdfPath, logger)
    const pdfStat = pdf.ok ? await stat(pdfPath) : null
    check(
      'PDF 由 Chromium 真实渲染出来',
      pdf.ok && pdfStat !== null && pdfStat.size > 2000,
      pdfStat === null ? (pdf.error ?? '未生成') : `${pdfStat.size} 字节`
    )
    if (pdf.ok) {
      const header = (await readFile(pdfPath)).subarray(0, 5).toString('latin1')
      check('PDF 文件头合法（%PDF-）', header === '%PDF-', `header=${header}`)
      // 关键：PDF 里的首帧图必须真的加载成功，否则就是一份只有空白框的报告
      check(
        'PDF 渲染时首帧图全部加载成功',
        pdf.imageTotal > 0 && pdf.imageLoaded === pdf.imageTotal,
        `加载 ${pdf.imageLoaded}/${pdf.imageTotal}`
      )
    }

    /* ---------- 7. 清单分发 ---------- */
    process.stdout.write('\n[7] 清单分发\n')
    for (const [label, target] of [
      ['BackupA', targetA],
      ['BackupB', targetB]
    ] as const) {
      const ascmhlDir = join(target, 'ascmhl')
      const entries = await readdir(ascmhlDir)
      const mhl = entries.find((name) => name.endsWith('.mhl'))
      if (mhl === undefined) {
        check(`${label} 上的清单存在`, false, 'ascmhl 目录为空')
        continue
      }
      const xml = await readFile(join(ascmhlDir, mhl), 'utf8')
      const hashCount = (xml.match(/<hash>/g) ?? []).length
      check(
        `${label} 上的清单含全部 ${walk.files.length} 条哈希记录`,
        hashCount === walk.files.length && xml.includes('<process>transfer</process>'),
        `${mhl}（${xml.length} 字节）`
      )
      await writeFile(join(root, `manifest-${label}.path`), join(ascmhlDir, mhl), 'utf8')
    }

    /* ---------- 7b. 新增的算法与清单格式 ---------- */
    process.stdout.write('\n[7b] 七种校验算法与 CSV / JSON 清单\n')
    {
      /*
       * 七种算法都要在**真实的 Electron 主进程**里各跑一遍。
       *
       * 单元测试跑在纯 Node 里，而 xxHash 三兄弟依赖 WASM 初始化、
       * SHA 系走 node:crypto —— "在 Node 里过了"不等于"在 Electron 里能跑"。
       * 这一节就是那道缝上的检查。
       */
      const sample = join(source, walk.files[0]?.relPath ?? '')
      for (const algorithm of HASH_ALGORITHMS) {
        const label = HASH_ALGORITHM_LABELS[algorithm]
        try {
          const value = await hashFileAt(sample, algorithm)
          check(
            `${label} 能算出形态合法的校验值`,
            hashLooksValid(algorithm, value),
            `${value.slice(0, 20)}…（${value.length} 字符）`
          )
        } catch (error) {
          check(
            `${label} 能算出校验值`,
            false,
            error instanceof Error ? error.message : String(error)
          )
        }
      }

      // CSV / JSON：与 ASC MHL 同一批文件，换格式再出一遍
      const extraDir = join(root, 'extra-manifests')
      const context = {
        job: finalJob,
        project,
        sourceLabel: 'A002R2EC',
        revision: 'R001',
        hostname: 'verify.local',
        toolName: 'SecureReel DIT',
        toolVersion: '1.0.0',
        now: new Date(),
        targetLabels: finalJob.targets.map((target) => target.label)
      }

      const csv = await writeCsvManifest(extraDir, context, store.iterateFiles(finalJob.id))
      const csvText = await readFile(csv.path, 'utf8')
      // ⚠️ 比对表头之前必须先把 BOM 剥掉，否则第一格永远多一个 \uFEFF 比不中
      const csvLines = csvText.replace(/^\uFEFF/, '').split('\r\n')
      check(
        'CSV 清单带 UTF-8 BOM 与固定表头',
        csvText.startsWith('\uFEFF') &&
          csvLines[0] === 'path,size_bytes,algorithm,hash,verified_targets',
        `${csv.entries} 行数据`
      )
      check(
        'CSV 每行都是 5 列',
        csvLines.slice(1, -1).every((line) => line.split(',').length === 5),
        `共 ${csvLines.length} 行（含表头与收尾空行）`
      )

      const json = await writeJsonManifest(extraDir, context, store.iterateFiles(finalJob.id))
      const jsonText = await readFile(json.path, 'utf8')
      let jsonOk = false
      let jsonDetail = '解析失败'
      try {
        const parsed = JSON.parse(jsonText) as {
          format?: string
          hashAlgorithm?: string
          files?: unknown[]
        }
        jsonOk =
          parsed.format === 'securereel-hashlist' &&
          typeof parsed.hashAlgorithm === 'string' &&
          parsed.files?.length === json.entries
        jsonDetail = `${json.entries} 条 · ${jsonText.length} 字节`
      } catch (error) {
        jsonDetail = error instanceof Error ? error.message : String(error)
      }
      check('JSON 清单是合法 JSON，带作业上下文且条数一致', jsonOk, jsonDetail)
    }

    /* ---------- 8. 重跑：不可变性 ---------- */
    process.stdout.write('\n[8] 重跑同一任务\n')
    const r1HtmlHashBefore = await hashOf(htmlPath)
    const second = await reportStore.writeRevision({
      job: finalJob,
      project,
      store,
      sourceLabel: 'A002R2EC',
      targets: finalJob.targets,
      hostname: 'verify.local',
      toolName: 'SecureReel DIT',
      toolVersion: '1.0.0',
      now: new Date(),
      writeManifestToTargets: true
    })
    check('第二次生成得到新修订而非覆盖', second.revision.revision === 'R002', second.revision.revision)
    check(
      'R001 的报告逐字节未被改动',
      r1HtmlHashBefore === (await hashOf(htmlPath)),
      `sha256 ${r1HtmlHashBefore.slice(0, 12)}…`
    )

    /* ---------- 9. 日志 ---------- */
    process.stdout.write('\n[9] 结构化日志\n')
    await logger.flush()
    const logLines = await logger.tail(500)
    check('日志已落盘且是结构化 JSONL', logLines.length > 0, `${logLines.length} 行`)

    /* ---------- 10. 母项目与归属快照 ---------- */
    process.stdout.write('\n[10] 母项目与归属\n')

    const parentId = 'prj_verify00001'
    store.createParentProject({
      id: parentId,
      name: '母亲',
      details: {
        projectName: '母亲',
        shootDay: todayLocalDate(),
        camera: 'ALEXA 35',
        lenses: [
          { model: 'Cooke S7/i', detail: '40mm' },
          { model: 'Cooke S7/i', detail: '65mm' }
        ],
        notes: '整部戏的备注。',
        crew: [
          { role: '导演', name: '张三' },
          { role: '摄影指导', name: '李四' },
          { role: 'DIT', name: '王五' }
        ]
      },
      createdAt: new Date().toISOString(),
      updatedAt: null
    })
    check('母项目落库并可读回', store.getParentProject(parentId)?.name === '母亲', '母亲')

    // 把这个任务归到母项目下，并把母项目信息快照进它的项目信息
    const parent = store.getParentProject(parentId)
    store.updateJob(job.id, { parentProjectId: parentId })
    const snapshot: ProjectInfo = {
      ...(parent?.details ?? project),
      cardLabel: 'A002R2EC',
      copyNotes: '本次拷贝的现场备注：第一张卡，无异常。',
      parentProjectName: parent?.name ?? null,
      updatedAt: new Date().toISOString()
    }
    store.saveProjectInfo(job.id, snapshot)

    const children = store.listJobsByParent(parentId)
    check('按母项目能查到名下任务', children.length === 1 && children[0]?.id === job.id, `${children.length} 个`)
    check(
      '项目信息里存了母项目名的快照',
      store.getProjectInfo(job.id)?.parentProjectName === '母亲',
      store.getProjectInfo(job.id)?.parentProjectName ?? '（空）'
    )

    // 快照语义的硬证据：改母项目，已产生的记录不受影响
    store.updateParentProject(parentId, {
      name: '母亲（暂定名）',
      details: { ...(parent?.details ?? project), camera: 'ALEXA 35 Xtreme' }
    })
    check(
      '改母项目后，任务的记录保持原样（快照而非引用）',
      store.getProjectInfo(job.id)?.camera === 'ALEXA 35' &&
        store.getProjectInfo(job.id)?.parentProjectName === '母亲',
      `任务仍记着 ${store.getProjectInfo(job.id)?.parentProjectName} / ${store.getProjectInfo(job.id)?.camera}`
    )
    check(
      '母项目本身已更新',
      store.getParentProject(parentId)?.name === '母亲（暂定名）',
      store.getParentProject(parentId)?.name ?? '（空）'
    )

    // 报告读的是任务上的快照，不随母项目后续改动而变
    const { revision: snapshotRevision } = await reportStore.writeRevision({
      job: store.getJob(job.id) as CopyJob,
      project: store.getProjectInfo(job.id) as ProjectInfo,
      store,
      sourceLabel: 'A002R2EC',
      targets: (store.getJob(job.id) as CopyJob).targets,
      hostname: 'verify.local',
      toolName: 'SecureReel DIT',
      toolVersion: '1.0.0',
      now: new Date(),
      writeManifestToTargets: false
    })
    const snapshotHtml = await readFile(snapshotRevision.files.html as string, 'utf8')
    check(
      '报告里写的仍是当时的母项目名与机型',
      snapshotHtml.includes('母亲') && snapshotHtml.includes('ALEXA 35'),
      `${snapshotRevision.revision}`
    )
    check(
      '报告里带上了镜头与本次拷贝备注',
      snapshotHtml.includes('Cooke S7/i 40mm') &&
        snapshotHtml.includes('本次拷贝的现场备注') &&
        snapshotHtml.includes('本次拷贝备注'),
      '镜头 + 两层备注'
    )

    /*
     * 未选母项目时的预填来源。
     *
     * 库里现在有两种记录：原始任务已归入母项目，另有一条升级前留下的未分组记录。
     * 预填必须**只**取未分组的那条，且把卡号清空 —— 否则会出现
     * "没选母项目却自动带了某部戏的机型和人名"这种让人心里发毛的情况。
     */
    const template = store.getLatestProjectTemplate()
    check(
      '预填只从未分组的任务里取，且卡号被清空',
      template !== null && template.camera === 'ALEXA Mini' && template.cardLabel === '',
      template === null
        ? '没有取到任何模板'
        : `机型 ${template.camera} / 卡号「${template.cardLabel}」`
    )

    // 删除母项目只解绑，不删任务
    store.deleteParentProject(parentId)
    const afterDelete = store.getJob(job.id)
    check(
      '删除母项目后任务仍在，只是变成未分组',
      afterDelete !== null && afterDelete.parentProjectId === null,
      afterDelete === null ? '任务被删掉了' : '任务保留'
    )
    check('母项目已删除', store.getParentProject(parentId) === null, '已移除')

    /*
     * 把演示数据恢复回来。
     *
     * 上面为了验证"删除只解绑"把母项目真删了，但如果就这样收尾，
     * 产出目录里的样例就只剩未分组的任务，人工检查界面时看不出分组效果。
     * 这里按正常路径再建一次，让产出目录可以直接拿来看。
     */
    store.createParentProject({
      id: parentId,
      name: '母亲',
      details: (parent?.details ?? project),
      createdAt: new Date().toISOString(),
      updatedAt: null
    })
    store.updateJob(job.id, { parentProjectId: parentId })
    store.saveProjectInfo(job.id, { ...snapshot, parentProjectName: '母亲' })
    check('演示数据已恢复（便于人工检查分组与归属）', store.countJobsByParent(parentId) === 1, '1 个任务')
    /* ---------- 汇总 ---------- */

    const failed = results.filter((item) => !item.ok)
    process.stdout.write(
      `\n${'─'.repeat(64)}\n共 ${results.length} 项检查，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项\n`
    )
    if (failed.length > 0) {
      for (const item of failed) process.stdout.write(`  失败：${item.name} — ${item.detail}\n`)
    }
    process.stdout.write(`产出目录保留在：${root}\n${'─'.repeat(64)}\n`)

    await writeFile(join(tmpdir(), 'securereel-verify-root.txt'), root, 'utf8')

    return failed.length === 0 ? 0 : 1
  } catch (error) {
    process.stdout.write(
      `\n验证过程抛出异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    )
    return 1
  } finally {
    try {
      store?.close()
    } catch {
      /* 关闭失败不阻塞退出 */
    }
  }
}

/**
 * 必须显式拦住"窗口全关就退出"的默认行为。
 *
 * PDF 渲染用的是离屏 BrowserWindow，渲染完就销毁。如果这里是唯一窗口，
 * Electron 会在销毁瞬间按默认行为退出应用 —— 表现是验证跑到 PDF 那一步
 * 就静默中断、退出码还是 0，非常难查。
 */
app.on('window-all-closed', () => {
  /* 验证流程需要继续跑完，故意不退出 */
})

void app.whenReady().then(async () => {
  const code = await main()
  app.exit(code)
})
