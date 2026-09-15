/**
 * 拷贝引擎测试。
 *
 * 这是整个项目里最该被测试覆盖的地方 —— 它同时管着
 * 数据完整性、故障隔离、断点续传和"绝不覆盖"这四条硬约束。
 * 每个测试都在真实的临时目录上跑完整的读写与校验流程。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CopyJob, CopyJobFile, HashAlgorithm } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { Store } from '../src/main/db/store'
import { Logger } from '../src/main/logger'
import { CopyEngine, hashFileAt, isNameConflictReason } from '../src/main/core/copy-engine'
import { PauseGate } from '../src/main/core/concurrency'
import { PARTIAL_MARKER, partialPathFor, walkFiles } from '../src/main/fs-utils'

let root = ''
let store: Store
let logger: Logger

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'securereel-test-'))
  store = await Store.openInMemory()
  logger = new Logger({ dir: '' })
})

afterEach(async () => {
  store.close()
  await rm(root, { recursive: true, force: true })
})

/** 造一个带内容的源盘。 */
async function makeSource(files: Record<string, Buffer>): Promise<string> {
  const source = join(root, 'source')
  for (const [relPath, content] of Object.entries(files)) {
    const absolute = join(source, relPath)
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, content)
  }
  await mkdir(source, { recursive: true })
  return source
}

async function makeTargets(count: number): Promise<string[]> {
  const targets: string[] = []
  for (let i = 1; i <= count; i++) {
    const path = join(root, `target${i}`)
    await mkdir(path, { recursive: true })
    targets.push(path)
  }
  return targets
}

async function seedJob(
  sourcePath: string,
  targets: string[],
  algorithm: HashAlgorithm = 'xxhash64'
): Promise<CopyJob> {
  const scan = await walkFiles(sourcePath)
  const job: CopyJob = {
    id: `job_test_${Math.random().toString(36).slice(2, 10)}`,
    name: '测试任务',
    sourcePath,
    sourceKind: 'generic',
    isCodExVfs: false,
    parentProjectId: null,
    targets: targets.map((path, index) => ({
      id: `tgt_${index + 1}`,
      path,
      label: `目标${index + 1}`,
      enabled: true,
      freeBytes: null,
      writable: true
    })),
    hashAlgorithm: algorithm,
    manifestFormat: 'asc-mhl-2.0',
    verifyAfterWrite: true,
    state: 'draft',
    totalFiles: scan.files.length,
    totalBytes: scan.totalBytes,
    filesDone: 0,
    filesFailed: 0,
    bytesDone: 0,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    degradationNotice: null
  }
  store.insertJob(job)
  store.upsertFiles(
    job.id,
    scan.files.map((file) => ({ relPath: file.relPath, sizeBytes: file.sizeBytes }))
  )
  return job
}

async function runEngine(
  job: CopyJob,
  options: { signal?: AbortSignal; gate?: PauseGate } = {}
): Promise<{ state: string; files: CopyJobFile[] }> {
  const engine = new CopyEngine({
    job,
    store,
    logger,
    settings: { ...DEFAULT_SETTINGS, maxParallelTargets: 4 },
    signal: options.signal ?? new AbortController().signal,
    gate: options.gate ?? new PauseGate(),
    probeRunner: null
  })
  const result = await engine.run()
  const files = store.listFiles(job.id, 1000, 0)
  return { state: result.state, files }
}

/** 列出目录下所有残留的分片文件。 */
async function listPartials(directory: string): Promise<string[]> {
  const found: string[] = []
  const queue = [directory]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) queue.push(absolute)
      else if (entry.name.includes(PARTIAL_MARKER)) found.push(absolute)
    }
  }
  return found
}

describe('基本拷贝与校验', () => {
  it('把文件完整写到所有目标，且不留下任何分片残留', async () => {
    const source = await makeSource({
      'A001C001.mov': Buffer.from('first clip payload'),
      'A001C002.mov': Buffer.from('second clip payload!'),
      'sub/nested.txt': Buffer.from('nested')
    })
    const targets = await makeTargets(2)
    const job = await seedJob(source, targets)

    const result = await runEngine(job)

    expect(result.state).toBe('completed')
    const done = store.getJob(job.id)
    expect(done?.filesDone).toBe(3)
    expect(done?.filesFailed).toBe(0)

    for (const target of targets) {
      expect(await readFile(join(target, 'A001C001.mov'), 'utf8')).toBe('first clip payload')
      expect(await readFile(join(target, 'sub/nested.txt'), 'utf8')).toBe('nested')
      expect(await listPartials(target)).toEqual([])
    }
  })

  it('各目标的校验值等于源侧值', async () => {
    const source = await makeSource({ 'clip.mov': Buffer.from('payload for hashing') })
    const targets = await makeTargets(3)
    const job = await seedJob(source, targets)

    await runEngine(job)

    const expected = await hashFileAt(join(source, 'clip.mov'), 'xxhash64')
    for (const target of targets) {
      expect(await hashFileAt(join(target, 'clip.mov'), 'xxhash64')).toBe(expected)
    }
    const file = store.listFiles(job.id, 10, 0)[0]
    expect(file?.sourceHash).toBe(expected)
    expect(file?.state).toBe('verified')
    expect(file?.results.every((item) => item.hashMatch === true)).toBe(true)
  })

  it.each(['xxhash64', 'md5', 'asc-c4'] as const)('%s 算法也能完成端到端校验', async (algorithm) => {
    const source = await makeSource({ 'a.bin': Buffer.from('x'.repeat(5000)) })
    const targets = await makeTargets(1)
    const job = await seedJob(source, targets, algorithm)

    const result = await runEngine(job)
    expect(result.state).toBe('completed')

    const hash = await hashFileAt(join(targets[0] as string, 'a.bin'), algorithm)
    expect(hash).toBe(await hashFileAt(join(source, 'a.bin'), algorithm))
  })

  it('空文件也能被正确拷贝与校验', async () => {
    const source = await makeSource({ 'empty.txt': Buffer.alloc(0) })
    const targets = await makeTargets(1)
    const job = await seedJob(source, targets)

    const result = await runEngine(job)
    expect(result.state).toBe('completed')
    expect((await stat(join(targets[0] as string, 'empty.txt'))).size).toBe(0)
  })

  it('大文件跨多个分片也能正确校验', async () => {
    // 故意超过 8 MiB 的分片大小，逼出多分片路径
    const big = Buffer.alloc(9 * 1024 * 1024 + 777)
    for (let i = 0; i < big.length; i += 4096) big[i] = i % 251

    const source = await makeSource({ 'big.bin': big })
    const targets = await makeTargets(2)
    const job = await seedJob(source, targets)

    const result = await runEngine(job)
    expect(result.state).toBe('completed')

    const sourceHash = await hashFileAt(join(source, 'big.bin'), 'xxhash64')
    for (const target of targets) {
      expect(await hashFileAt(join(target, 'big.bin'), 'xxhash64')).toBe(sourceHash)
      expect((await stat(join(target, 'big.bin'))).size).toBe(big.length)
    }
  }, 60_000)
})

describe('断点续传', () => {
  it('目标盘上已有半个分片时，从断点继续而不是从头重写', async () => {
    const payload = Buffer.from('0123456789abcdef'.repeat(2000))
    const source = await makeSource({ 'resume.bin': payload })
    const targets = await makeTargets(1)
    const target = targets[0] as string

    // 预置：目标上已有前 4000 字节的正确内容，模拟上次中断
    const finalPath = join(target, 'resume.bin')
    await writeFile(partialPathFor(finalPath), payload.subarray(0, 4000))

    const job = await seedJob(source, targets)
    const result = await runEngine(job)

    expect(result.state).toBe('completed')
    expect(await readFile(finalPath)).toEqual(payload)
    expect(await listPartials(target)).toEqual([])
  })

  it('分片已完整但尚未校验时，只补做校验与改名', async () => {
    const payload = Buffer.from('complete partial content')
    const source = await makeSource({ 'done.bin': payload })
    const targets = await makeTargets(1)
    const target = targets[0] as string

    const finalPath = join(target, 'done.bin')
    await writeFile(partialPathFor(finalPath), payload)

    const job = await seedJob(source, targets)
    const result = await runEngine(job)

    expect(result.state).toBe('completed')
    expect(await readFile(finalPath)).toEqual(payload)
    expect(store.listFiles(job.id, 10, 0)[0]?.state).toBe('verified')
  })

  it('进程异常退出留下的 copying 状态会被重置为待处理', async () => {
    const source = await makeSource({ 'x.txt': Buffer.from('x') })
    const targets = await makeTargets(1)
    const job = await seedJob(source, targets)

    // 模拟上次被强杀：文件停在 copying
    store.updateFile(job.id, 'x.txt', { state: 'copying' })
    expect(store.listPendingFiles(job.id, 10)).toHaveLength(0)

    const reset = store.resetInFlightFiles(job.id)
    expect(reset).toBe(1)
    expect(store.listPendingFiles(job.id, 10)).toHaveLength(1)
  })
})

describe('故障隔离', () => {
  it('一个目标盘不可用不会影响其他目标完成', async () => {
    const source = await makeSource({
      'a.mov': Buffer.from('clip a'),
      'b.mov': Buffer.from('clip b')
    })
    const targets = await makeTargets(1)
    // 第二个"目标"是一个普通文件，不可能是目录
    const brokenPath = join(root, 'not-a-directory')
    await writeFile(brokenPath, 'i am a file, not a folder')

    const job = await seedJob(source, [targets[0] as string, brokenPath])
    const result = await runEngine(job)

    // 健康目标应全部完成
    expect(await readFile(join(targets[0] as string, 'a.mov'), 'utf8')).toBe('clip a')
    expect(await readFile(join(targets[0] as string, 'b.mov'), 'utf8')).toBe('clip b')

    // 任务整体标记为"有失败"，但成功的文件是成功态
    expect(result.state).toBe('completed-with-errors')
    const goodTargetFiles = store
      .listFiles(job.id, 10, 0)
      .filter((file) => file.results.some((item) => item.targetId === 'tgt_1' && item.state === 'verified'))
    expect(goodTargetFiles.length).toBeGreaterThan(0)
  })

  it('目标盘上分片内容损坏时，该目标被标记失败且不生成最终文件', async () => {
    const payload = Buffer.from('the real payload that must match')
    const source = await makeSource({ 'corrupt.bin': payload })
    const targets = await makeTargets(2)
    const [good, bad] = targets as [string, string]

    // 坏目标：分片大小和源一致，但内容被人改过 —— 这正是"介质静默损坏"的样子
    const badFinal = join(bad, 'corrupt.bin')
    const corrupted = Buffer.from(payload)
    corrupted.writeUInt8(corrupted.readUInt8(0) ^ 0xff, 0)
    await writeFile(partialPathFor(badFinal), corrupted)

    const job = await seedJob(source, targets)
    const result = await runEngine(job)

    expect(result.state).toBe('completed-with-errors')

    // 健康目标不受影响
    expect(await readFile(join(good, 'corrupt.bin'))).toEqual(payload)

    // 坏目标既不能出现最终文件，也不能留下坏分片
    await expect(stat(badFinal)).rejects.toThrow()
    expect(await listPartials(bad)).toEqual([])

    const file = store.listFiles(job.id, 10, 0)[0]
    expect(file?.state).toBe('failed')
    const badResult = file?.results.find((item) => item.targetId === 'tgt_2')
    expect(badResult?.hashMatch).toBe(false)
    expect(badResult?.error).toContain('不一致')
  })
})

describe('绝不覆盖既有素材', () => {
  it('目标已有同名但不同大小的文件时保留原文件并报错', async () => {
    const source = await makeSource({ 'conflict.mov': Buffer.from('new content here') })
    const targets = await makeTargets(1)
    const target = targets[0] as string
    const existing = join(target, 'conflict.mov')
    await writeFile(existing, 'someone else data')

    const job = await seedJob(source, targets)
    const result = await runEngine(job)

    expect(result.state).toBe('completed-with-errors')
    // 原文件必须原封不动
    expect(await readFile(existing, 'utf8')).toBe('someone else data')
    expect(await listPartials(target)).toEqual([])
  })

  it('目标已有同名同大小但内容不同的文件时会校验失败而不是算完成', async () => {
    const source = await makeSource({ 'same-size.bin': Buffer.from('AAAAAAAA') })
    const targets = await makeTargets(1)
    const target = targets[0] as string
    const existing = join(target, 'same-size.bin')
    await writeFile(existing, 'BBBBBBBB') // 同长度、不同内容

    const job = await seedJob(source, targets)
    const result = await runEngine(job)

    expect(result.state).toBe('completed-with-errors')
    expect(await readFile(existing, 'utf8')).toBe('BBBBBBBB')
  })

  it('目标已有同名同内容的文件时直接算完成，不重复拷贝', async () => {
    const payload = Buffer.from('identical payload')
    const source = await makeSource({ 'identical.bin': payload })
    const targets = await makeTargets(1)
    const target = targets[0] as string
    await writeFile(join(target, 'identical.bin'), payload)

    const job = await seedJob(source, targets)
    const result = await runEngine(job)

    expect(result.state).toBe('completed')
    expect(store.listFiles(job.id, 10, 0)[0]?.state).toBe('verified')
  })

  it('命名冲突只让那一个文件失败，同盘后续文件照常写入', async () => {
    // 评估 P1 第 8 条的回归测试：以前一个撞名文件会把整块好盘判死，
    // 后续所有文件都不再往里写 —— 现在必须只影响冲突文件本身。
    const source = await makeSource({
      'conflict.mov': Buffer.from('new content'),
      'after-conflict.mov': Buffer.from('written after the conflict')
    })
    const targets = await makeTargets(2)
    const [conflicted, clean] = targets as [string, string]
    await writeFile(join(conflicted, 'conflict.mov'), 'old data with different length')

    const job = await seedJob(source, targets)
    const result = await runEngine(job)

    // 任务有失败，但冲突文件原封不动
    expect(result.state).toBe('completed-with-errors')
    expect(await readFile(join(conflicted, 'conflict.mov'), 'utf8')).toBe('old data with different length')

    // 关键断言：冲突之后，同一块盘上的后续文件**必须照常写入**
    expect(await readFile(join(conflicted, 'after-conflict.mov'), 'utf8')).toBe(
      'written after the conflict'
    )
    expect(await readFile(join(clean, 'after-conflict.mov'), 'utf8')).toBe('written after the conflict')

    // 失败原因属于"命名冲突"这一类，而不是介质故障
    const conflictFile = store.listFiles(job.id, 10, 0).find((file) => file.relPath === 'conflict.mov')
    const conflictedResult = conflictFile?.results.find((item) => item.targetId === 'tgt_1')
    expect(conflictedResult?.error).toContain('同名')
    expect(isNameConflictReason(conflictedResult?.error ?? null)).toBe(true)
  })

  it('同名同尺寸但内容不同：同样只影响该文件，盘继续使用', async () => {
    const source = await makeSource({
      'same-size.bin': Buffer.from('AAAAAAAA'),
      'next.bin': Buffer.from('follow-up payload')
    })
    const targets = await makeTargets(1)
    const target = targets[0] as string
    await writeFile(join(target, 'same-size.bin'), 'BBBBBBBB') // 同长度、不同内容

    const job = await seedJob(source, targets)
    const result = await runEngine(job)

    expect(result.state).toBe('completed-with-errors')
    expect(await readFile(join(target, 'same-size.bin'), 'utf8')).toBe('BBBBBBBB')
    // 盘没有被误伤：后续文件照样写进来了
    expect(await readFile(join(target, 'next.bin'), 'utf8')).toBe('follow-up payload')

    const file = store.listFiles(job.id, 10, 0).find((item) => item.relPath === 'same-size.bin')
    expect(file?.state).toBe('failed')
    expect(file?.results[0]?.error).toContain('同名')
    expect(isNameConflictReason(file?.results[0]?.error ?? null)).toBe(true)
  })
})

describe('目标被停用', () => {
  it('停用的目标完全不会被写入', async () => {
    const source = await makeSource({ 'x.txt': Buffer.from('payload') })
    const targets = await makeTargets(2)
    const job = await seedJob(source, targets)

    // 把第二个目标标记为停用（等价于用户在界面上取消勾选）
    const entries = await readdir(root, { withFileTypes: true })
    void entries
    const disabledJob = {
      ...job,
      targets: job.targets.map((target, index) => ({ ...target, enabled: index === 0 }))
    }
    store.deleteJob(job.id)
    store.insertJob(disabledJob)
    store.upsertFiles(job.id, [{ relPath: 'x.txt', sizeBytes: 7 }])

    const result = await runEngine(disabledJob)
    expect(result.state).toBe('completed')

    expect(await readFile(join(targets[0] as string, 'x.txt'), 'utf8')).toBe('payload')
    await expect(stat(join(targets[1] as string, 'x.txt'))).rejects.toThrow()
  })
})
