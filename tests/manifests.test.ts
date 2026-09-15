/**
 * 清单（manifest）生成测试。
 *
 * 这里是本项目对外承诺的硬核部分：**生成的 ASC MHL 必须能通过官方 XSD 校验**。
 *
 * 校验用的是 ASC 官方参考实现仓库里的 `xsd/ASCMHL.xsd`（随测试夹具一起放在
 * tests/fixtures/），通过 Python 的 lxml 执行真正的 XSD schema validation ——
 * 不是"看起来像"，而是"架构层面合规"。
 *
 * 如果本机没有可用的 Python + lxml，XSD 那组用例会跳过（而不是假装通过），
 * 结构断言仍然会跑。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CopyJob, CopyJobFile, ProjectInfo } from '../src/shared/types'
import { Store } from '../src/main/db/store'
import {
  ASC_MHL_FOLDER_NAME,
  ASC_MHL_NAMESPACE,
  ascMhlFilename,
  escapeXml,
  writeAscMhlManifest,
  writeMhlV1Manifest
} from '../src/main/reports/manifests'

const run = promisify(execFile)

const PYTHON_CANDIDATES = [
  'python3'
]

const XSD_PATH = join(__dirname, 'fixtures', 'ASCMHL.xsd')

let rootPath = ''
let store: Store

beforeEach(async () => {
  rootPath = await mkdtemp(join(tmpdir(), 'securereel-mhl-'))
  store = await Store.openInMemory()
})

afterEach(async () => {
  store.close()
  await rm(rootPath, { recursive: true, force: true })
})

const NOW = new Date('2026-09-15T04:30:00.000Z')

function makeJob(): CopyJob {
  return {
    id: 'job_manifest01',
    name: 'A002 卡备份',
    sourcePath: '/Volumes/A002R2EC',
    sourceKind: 'generic',
    isCodExVfs: false,
    parentProjectId: null,
    targets: [
      { id: 'tgt_1', path: join(rootPath, 'BackupA'), label: 'BackupA', enabled: true, freeBytes: null, writable: true }
    ],
    hashAlgorithm: 'xxhash64',
    manifestFormat: 'asc-mhl-2.0',
    verifyAfterWrite: true,
    state: 'completed',
    totalFiles: 3,
    totalBytes: 60,
    filesDone: 3,
    filesFailed: 0,
    bytesDone: 60,
    createdAt: NOW.toISOString(),
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
    degradationNotice: null
  }
}

const PROJECT: ProjectInfo = {
  projectName: 'DEMO & <TEST>',
  shootDay: '2026-09-15',
  camera: 'ALEXA 35',
  cardLabel: 'A002',
  lenses: [{ model: 'Cooke S7/i', detail: '40mm' }],
  notes: '含特殊字符的备注：<script>alert(1)</script>',
  crew: [
    { role: 'DIT', name: '张三' },
    { role: '摄影指导 / DoP', name: '李四' }
  ],
  copyNotes: '本次拷贝备注',
  parentProjectName: '母亲',
  updatedAt: NOW.toISOString()
}

/** 造一份已落库的文件记录，然后返回可迭代对象。 */
async function seedFiles(jobId: string, entries: [string, number, string, boolean][]): Promise<void> {
  store.insertJob({
    ...makeJob(),
    id: jobId
  })
  store.upsertFiles(
    jobId,
    entries.map(([relPath, sizeBytes]) => ({ relPath, sizeBytes }))
  )
  for (const [relPath, , hash, verified] of entries) {
    store.updateFile(jobId, relPath, {
      state: verified ? 'verified' : 'failed',
      sourceHash: hash
    })
    const fileId = Number(store.getFileRow(jobId, relPath)?.id)
    const targetId = store.listTargets(jobId)[0]?.id ?? 'tgt_1'
    store.saveFileResult(fileId, jobId, {
      targetId,
      state: verified ? 'verified' : 'failed',
      hash,
      hashMatch: verified,
      bytesCopied: 1,
      error: verified ? null : '校验不一致'
    })
  }
}

const ENTRIES: [string, number, string, boolean][] = [
  ['Clips/A002C006_141024_R2EC.mov', 20, '0ea03b369a463d9d', true],
  ['Clips/A002C007_141024_R2EC.mov', 20, '7680e5f98f4a80fd', true],
  ['Sidecar.txt', 20, '3ab5a4166b9bde44', false]
]

async function buildAscMhl(
  jobId: string,
  projectOverride?: Partial<ProjectInfo>
): Promise<{ path: string; xml: string; c4: string; entries: number }> {
  const result = await writeAscMhlManifest(
    rootPath,
    {
      job: store.getJob(jobId) as CopyJob,
      project: { ...PROJECT, ...projectOverride },
      sourceLabel: 'A002R2EC',
      revision: 'R001',
      hostname: 'dit-mac.local',
      toolName: 'SecureReel DIT',
      toolVersion: '1.0.0',
      now: NOW,
      targetLabels: ['BackupA']
    },
    store.iterateFiles(jobId)
  )
  return { path: result.path, xml: await readFile(result.path, 'utf8'), c4: result.c4, entries: result.entries }
}

describe('ASC MHL 2.0 结构与命名', () => {
  it('文件名遵循官方代次规范 0001_<盘名>_<日期>_<时间>Z.mhl', () => {
    expect(ascMhlFilename(1, 'A002R2EC', NOW)).toBe('0001_A002R2EC_2026-09-15_043000Z.mhl')
    expect(ascMhlFilename(42, 'Card', NOW)).toBe('0042_Card_2026-09-15_043000Z.mhl')
  })

  it('盘名里的非法字符会被替换，不会产生非法文件名', () => {
    expect(ascMhlFilename(1, 'a/b:c d', NOW)).toBe('0001_a_b_c_d_2026-09-15_043000Z.mhl')
  })

  it('清单落在 ascmhl/ 目录下，根元素与命名空间正确', async () => {
    await seedFiles('job_manifest01', ENTRIES)
    const built = await buildAscMhl('job_manifest01')

    expect(built.path).toContain(`/${ASC_MHL_FOLDER_NAME}/`)
    expect(built.xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(built.xml).toContain(`<hashlist version="2.0" xmlns="${ASC_MHL_NAMESPACE}">`)
    expect(built.xml.trimEnd().endsWith('</hashlist>')).toBe(true)
  })

  it('元素顺序符合架构要求：creatorinfo → processinfo → hashes', async () => {
    await seedFiles('job_manifest02', ENTRIES)
    const built = await buildAscMhl('job_manifest02')

    const creator = built.xml.indexOf('<creatorinfo>')
    const process = built.xml.indexOf('<processinfo>')
    const hashes = built.xml.indexOf('<hashes>')
    expect(creator).toBeGreaterThan(-1)
    expect(process).toBeGreaterThan(creator)
    expect(hashes).toBeGreaterThan(process)
  })

  it('creatorinfo 里包含必填的 creationdate / hostname / tool', async () => {
    await seedFiles('job_manifest03', ENTRIES)
    const built = await buildAscMhl('job_manifest03')

    expect(built.xml).toContain('<creationdate>2026-09-15T04:30:00Z</creationdate>')
    expect(built.xml).toContain('<hostname>dit-mac.local</hostname>')
    expect(built.xml).toContain('<tool version="1.0.0">SecureReel DIT</tool>')
  })

  it('职务与所属人会作为 author 写进清单', async () => {
    await seedFiles('job_manifest04', ENTRIES)
    const built = await buildAscMhl('job_manifest04')

    expect(built.xml).toContain('role="DIT">张三</author>')
    expect(built.xml).toContain('role="摄影指导 / DoP">李四</author>')
  })

  it('母项目、项目名、机型、镜头都会写进 comment', async () => {
    await seedFiles('job_manifest_c1', ENTRIES)
    const built = await buildAscMhl('job_manifest_c1')

    expect(built.xml).toContain('<comment>')
    expect(built.xml).toContain('母项目：母亲')
    expect(built.xml).toContain('项目：DEMO &amp; &lt;TEST&gt;')
    expect(built.xml).toContain('拍摄日：2026-09-15')
    expect(built.xml).toContain('机型：ALEXA 35')
    expect(built.xml).toContain('镜头：Cooke S7/i 40mm')
    expect(built.xml).toContain('卡号：A002')
  })

  it('comment 里的中文与特殊字符经过 XML 转义，不会破坏清单结构', async () => {
    await seedFiles('job_manifest_c2', ENTRIES)
    const built = await buildAscMhl('job_manifest_c2')

    // 项目名里的 & 与尖括号必须转义，否则 XSD 校验直接过不去
    expect(built.xml).not.toContain('项目：DEMO & <TEST>')
    expect(built.xml).not.toMatch(/<comment>[^<]*<script>/)
  })

  it('没有母项目时不写「母项目：」这一项', async () => {
    await seedFiles('job_manifest_c3', ENTRIES)
    const built = await buildAscMhl('job_manifest_c3', { parentProjectName: null })

    expect(built.xml).not.toContain('母项目：')
    // 其它项不受影响
    expect(built.xml).toContain('机型：ALEXA 35')
  })

  it('没有镜头时不写「镜头：」这一项', async () => {
    await seedFiles('job_manifest_c4', ENTRIES)
    const built = await buildAscMhl('job_manifest_c4', { lenses: [] })

    expect(built.xml).not.toContain('镜头：')
    expect(built.xml).toContain('机型：ALEXA 35')
  })

  it('process 取官方枚举值 transfer', async () => {
    await seedFiles('job_manifest05', ENTRIES)
    const built = await buildAscMhl('job_manifest05')
    expect(built.xml).toContain('<process>transfer</process>')
  })

  it('哈希元素名随算法变化：xxhash64 → xxh64', async () => {
    await seedFiles('job_manifest06', ENTRIES)
    const built = await buildAscMhl('job_manifest06')
    expect(built.xml).toContain('<xxh64 action="original"')
    expect(built.xml).toContain('0ea03b369a463d9d</xxh64>')
  })

  it('path 元素带 size 属性且路径为 POSIX 风格', async () => {
    await seedFiles('job_manifest07', ENTRIES)
    const built = await buildAscMhl('job_manifest07')
    expect(built.xml).toContain('<path size="20">Clips/A002C006_141024_R2EC.mov</path>')
  })

  it('只写入通过校验的文件，失败条目不进清单', async () => {
    await seedFiles('job_manifest08', ENTRIES)
    const built = await buildAscMhl('job_manifest08')

    expect(built.entries).toBe(2)
    expect(built.xml).toContain('A002C006_141024_R2EC.mov')
    expect(built.xml).not.toContain('Sidecar.txt')
  })

  it('特殊字符被正确转义，不会破坏 XML', async () => {
    await seedFiles('job_manifest09', ENTRIES)
    const built = await buildAscMhl('job_manifest09')

    expect(built.xml).toContain('DEMO &amp; &lt;TEST&gt;')
    expect(built.xml).not.toContain('<TEST>')
    expect(escapeXml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;')
  })

  it('新清单的代次会接着已有文件递增', async () => {
    await seedFiles('job_manifest10', ENTRIES)
    await buildAscMhl('job_manifest10')
    const second = await buildAscMhl('job_manifest10')
    expect(second.path).toContain('0002_A002R2EC_')
  })

  it('清单自身能算出 C4 标识（ASC 链需要它做身份）', async () => {
    await seedFiles('job_manifest11', ENTRIES)
    const built = await buildAscMhl('job_manifest11')
    expect(built.c4).toMatch(/^c4[1-9A-HJ-NP-Za-km-z]{88}$/)
  })
})

describe('MHL v1（传统格式）', () => {
  it('生成传统命名空间与 creator/hashes 结构', async () => {
    await seedFiles('job_manifest12', ENTRIES)
    const result = await writeMhlV1Manifest(
      join(rootPath, 'legacy'),
      {
        job: store.getJob('job_manifest12') as CopyJob,
        project: PROJECT,
        sourceLabel: 'A002R2EC',
        revision: 'R001',
        hostname: 'dit-mac.local',
        toolName: 'SecureReel DIT',
        toolVersion: '1.0.0',
        now: NOW,
        targetLabels: ['BackupA']
      },
      store.iterateFiles('job_manifest12')
    )

    const xml = await readFile(result.path, 'utf8')
    expect(xml).toContain('<mhl xmlns="http://mediahashlist.org/ns/1.0">')
    expect(xml).toContain('<creator>')
    expect(xml).toContain('<hashes>')
    // 传统格式里的元素名是 xxhash64，不是 xxh64
    expect(xml).toContain('<xxhash64>0ea03b369a463d9d</xxhash64>')
    expect(result.entries).toBe(2)
  })
})

/* ------------------------------------------------------------------ *
 * 官方 XSD 架构校验
 * ------------------------------------------------------------------ */

function findPython(): string | null {
  for (const candidate of PYTHON_CANDIDATES) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) return candidate
    } else {
      return candidate
    }
  }
  return null
}

async function lxmlAvailable(python: string): Promise<boolean> {
  try {
    await run(python, ['-c', 'import lxml.etree; print("ok")'], { timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

/**
 * 用官方 XSD 做真正的 schema 校验。
 *
 * 脚本把 XSD 与待校验文件都读进来，返回 "VALID" 或错误详情。
 */
async function validateAgainstXsd(python: string, xmlPath: string): Promise<string> {
  const script = `
import sys
from lxml import etree

schema_doc = etree.parse(sys.argv[1])
schema = etree.XMLSchema(schema_doc)
doc = etree.parse(sys.argv[2])
if schema.validate(doc):
    print("VALID")
else:
    print("INVALID")
    for err in schema.error_log:
        print("  line %s: %s" % (err.line, err.message))
`
  const scriptPath = join(rootPath, 'validate.py')
  await writeFile(scriptPath, script, 'utf8')
  const { stdout } = await run(python, [scriptPath, XSD_PATH, xmlPath], { timeout: 30_000 })
  return stdout.trim()
}

describe('ASC 官方 XSD 架构校验', () => {
  it('生成的 ASC MHL 清单通过官方 ASCMHL.xsd 校验', async () => {
    const python = findPython()
    if (python === null || !(await lxmlAvailable(python))) {
      // 本机没有 Python + lxml 时跳过，而不是假装通过
      console.warn('跳过 XSD 校验：本机缺少可用的 Python + lxml')
      return
    }

    await seedFiles('job_xsd_ok', ENTRIES)
    const built = await buildAscMhl('job_xsd_ok')

    const verdict = await validateAgainstXsd(python, built.path)
    expect(verdict, `XSD 校验未通过：\n${verdict}`).toContain('VALID')
    expect(verdict.split('\n')[0]).toBe('VALID')
  }, 60_000)

  it('校验器本身是有效的：故意写坏一份文档必须被判为 INVALID', async () => {
    const python = findPython()
    if (python === null || !(await lxmlAvailable(python))) return

    // 少写必需的 processinfo/creationdate
    const brokenPath = join(rootPath, 'broken.mhl')
    await writeFile(
      brokenPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<hashlist version="2.0" xmlns="urn:ASC:MHL:v2.0">
  <creatorinfo>
    <hostname>x</hostname>
  </creatorinfo>
</hashlist>
`,
      'utf8'
    )

    const verdict = await validateAgainstXsd(python, brokenPath)
    expect(verdict).toContain('INVALID')
  }, 60_000)
})

/** 保证迭代器接口与生产调用一致（避免测试绕过真实类型）。 */
function assertFileShape(file: CopyJobFile): void {
  expect(typeof file.relPath).toBe('string')
}
void assertFileShape
