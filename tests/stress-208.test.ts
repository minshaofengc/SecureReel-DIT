/** Opt-in software load only. All media and SQLite data live in a dedicated temp root. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Store } from '../src/main/db/store'
import { CopyEngine } from '../src/main/core/copy-engine'
import { PauseGate } from '../src/main/core/concurrency'
import { Logger } from '../src/main/logger'
import { DEFAULT_SETTINGS, type CopyJob } from '../src/shared/types'

const enabled = process.env.SECUREREEL_STRESS === '1'
const fileCount = 5000
const fileBytes = 256
const taskCount = 24
const pageSize = 173
const relativePath = (index: number): string => `batch-${String(Math.floor(index / 100)).padStart(2, '0')}/clip-${String(index).padStart(5, '0')}.bin`
const payload = (index: number): Buffer => {
  const bytes = Buffer.alloc(fileBytes, index % 251)
  bytes.write(`SecureReel QA ${index}`, 0, 'utf8')
  return bytes
}
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

describe.skipIf(!enabled)('2.0.8 opt-in 24 tasks / 5000 files / 1,2,8 targets software stress', () => {
  let root = ''
  let source = ''
  let store: Store
  const scenarios: Record<string, unknown>[] = []
  const queryResults: Record<string, unknown>[] = []
  const results: Record<string, unknown> = {
    evidenceLevel: 'Software load on same-volume temporary directories; NOT independent physical backups, hot unplug, full disk, Windows or Android hardware verification.',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    fileCount,
    fileBytes,
    sourceBytes: fileCount * fileBytes,
    taskCount,
    concurrentEngines: 1,
    scenarios,
    queryResults
  }

  function job(index: number, targets: string[]): CopyJob {
    return {
      id: `qa_stress_${String(index).padStart(2, '0')}`, name: `QA stress ${index}`, mode: 'copy',
      sourcePath: source, sourceRootName: '', sourceKind: 'generic', isCodExVfs: false,
      parentProjectId: null, targets: targets.map((path, position) => ({
        id: `qa_target_${index}_${position}`, path, label: `QA ${position + 1}`,
        enabled: true, freeBytes: null, writable: true
      })),
      hashAlgorithm: 'xxhash64', manifestFormat: 'asc-mhl-2.0', verifyAfterWrite: true,
      proxyEnabled: false, proxyResolution: '1080p', proxyCodec: 'prores', proxyProfile: '422-proxy', proxyLutPath: null,
      state: 'draft', totalFiles: fileCount, totalBytes: fileCount * fileBytes,
      filesDone: 0, filesFailed: 0, bytesDone: 0, createdAt: new Date().toISOString(),
      startedAt: null, finishedAt: null, degradationNotice: null
    }
  }

  beforeAll(async () => {
    const start = performance.now()
    root = await mkdtemp(join(tmpdir(), 'securereel-stress-208-'))
    source = join(root, 'source')
    results.qaRoot = root
    for (let batch = 0; batch < 50; batch++) {
      await mkdir(join(source, `batch-${String(batch).padStart(2, '0')}`), { recursive: true })
      await Promise.all(Array.from({ length: 100 }, (_, offset) => {
        const index = batch * 100 + offset
        return writeFile(join(source, relativePath(index)), payload(index), { flag: 'wx' })
      }))
    }
    store = await Store.open(join(root, 'qa.sqlite'))
    const rows = Array.from({ length: fileCount }, (_, index) => ({ relPath: relativePath(index), sizeBytes: fileBytes }))
    for (let index = 0; index < taskCount; index++) {
      const targetCount = index === 0 ? 1 : index === 1 ? 2 : index === 2 ? 8 : 1
      const targets = Array.from({ length: targetCount }, (_, target) => join(root, `job-${index}`, `target-${target}`))
      await Promise.all(targets.map((path) => mkdir(path, { recursive: true })))
      const entry = job(index, targets)
      store.insertJob(entry)
      store.upsertFiles(entry.id, rows)
    }
    expect(store.listJobs()).toHaveLength(taskCount)
    results.setupWallSeconds = (performance.now() - start) / 1000
    results.seededFileRows = taskCount * fileCount
  }, 120_000)

  afterAll(async () => {
    try {
      if (store) {
        store.close()
        const reopened = await Store.open(join(root, 'qa.sqlite'))
        results.reopenTaskCount = reopened.listJobs().length
        results.reopenCompletedCounts = [0, 1, 2].map((index) => {
          const saved = reopened.getJob(`qa_stress_${String(index).padStart(2, '0')}`)
          return { jobId: saved?.id, state: saved?.state, filesDone: saved?.filesDone, filesFailed: saved?.filesFailed }
        })
        reopened.close()
      }
    } finally {
      const destination = process.env.SECUREREEL_STRESS_OUTPUT
      if (destination) {
        await mkdir(destination, { recursive: true })
        await writeFile(join(destination, 'stress-results.json'), JSON.stringify(results, null, 2))
      }
      if (root.startsWith(join(tmpdir(), 'securereel-stress-208-'))) {
        await rm(root, { recursive: true, force: true })
      }
    }
  }, 120_000)

  it.each([1, 2, 8])('copies and independently rereads 5000 small files to %i target(s)', async (targets) => {
    const index = targets === 1 ? 0 : targets === 2 ? 1 : 2
    const saved = store.getJob(`qa_stress_${String(index).padStart(2, '0')}`)!
    const baselineRss = process.memoryUsage().rss
    let peakRss = baselineRss
    let samples = 0
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
      samples++
    }, 20)
    const start = performance.now()
    const record: Record<string, unknown> = { targetCount: targets, jobId: saved.id, baselineRssBytes: baselineRss }
    scenarios.push(record)
    try {
      const engine = new CopyEngine({
        job: saved, store, logger: new Logger({ dir: '' }),
        settings: { ...DEFAULT_SETTINGS, maxParallelTargets: 4, extractFrames: false },
        signal: AbortSignal.timeout(590_000), gate: new PauseGate(), probeRunner: null
      })
      const outcome = await engine.run()
      const elapsed = (performance.now() - start) / 1000
      Object.assign(record, { ...outcome, wallSeconds: elapsed,
        sourceFilesPerSecond: outcome.filesDone / elapsed
      })
      let files = 0
      let hashes = 0
      let targetResults = 0
      const seen = new Set<string>()
      for (let offset = 0; offset < fileCount; offset += pageSize) {
        const page = store.listFiles(saved.id, pageSize, offset)
        for (const row of page) {
          if (outcome.state === 'completed') {
            expect(row.state).toBe('verified')
            expect(row.sourceHash).toBeTruthy()
            expect(row.results).toHaveLength(targets)
          }
          seen.add(row.relPath)
          files++
          hashes += row.sourceHash ? 1 : 0
          for (const result of row.results) {
            if (outcome.state === 'completed') {
              expect(result.state).toBe('verified')
              expect(result.hashMatch).toBe(true)
              expect(result.hash).toBe(row.sourceHash)
              expect(result.bytesCopied).toBe(fileBytes)
            }
            if (result.state === 'verified' && result.hashMatch === true) targetResults++
          }
        }
      }
      expect(files).toBe(fileCount)
      expect(seen.size).toBe(fileCount)
      Object.assign(record, { fileRows: files, nonemptySourceHashes: hashes, verifiedTargetResults: targetResults,
        targetFilesPerSecond: targetResults / elapsed, targetBytesPerSecond: targetResults * fileBytes / elapsed })
      expect(outcome.state).toBe('completed')
      expect(outcome.filesDone).toBe(fileCount)
      expect(outcome.filesFailed).toBe(0)
      expect(hashes).toBe(fileCount)
      expect(targetResults).toBe(fileCount * targets)
      const shaSamples: { file: string; target: string; sha256: string }[] = []
      for (const sample of [0, 2499, 4999]) {
        const expected = digest(payload(sample))
        expect(digest(await readFile(join(source, relativePath(sample))))).toBe(expected)
        for (const target of saved.targets) {
          const actual = digest(await readFile(join(target.path, relativePath(sample))))
          expect(actual).toBe(expected)
          shaSamples.push({ file: relativePath(sample), target: target.id, sha256: actual })
        }
      }
      Object.assign(record, { verifiedFileRows: files, nonemptySourceHashes: hashes, verifiedTargetResults: targetResults, independentSha256Samples: shaSamples })
    } catch (error) {
      record.error = error instanceof Error ? error.stack : String(error)
      throw error
    } finally {
      clearInterval(sampler)
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
      Object.assign(record, { peakRssBytes: peakRss, endRssBytes: process.memoryUsage().rss, rssSampleCount: samples, rssIntervalMs: 20 })
    }
  }, 600_000)

  it('keeps pagination, literal search and failed filters accurate across 24 isolated 5000-file records', () => {
    const start = performance.now()
    for (let index = 0; index < taskCount; index++) {
      const jobId = `qa_stress_${String(index).padStart(2, '0')}`
      const queried = new Set<string>()
      let actualFailedRows = 0
      for (let offset = 0; offset < fileCount; offset += pageSize) {
        for (const file of store.listFiles(jobId, pageSize, offset)) {
          queried.add(file.relPath)
          if (file.state === 'failed') actualFailedRows++
        }
      }
      expect(queried.size).toBe(fileCount)
      expect(store.countFiles(jobId)).toBe(fileCount)
      expect(store.listFiles(jobId, pageSize, fileCount)).toHaveLength(0)
      expect(store.countFiles(jobId, { search: 'CLIP-000' })).toBe(100)
      expect(store.listFiles(jobId, 5, 3, { search: 'CLIP-000' }).map((file) => file.relPath))
        .toEqual([3, 4, 5, 6, 7].map(relativePath))
      expect(store.countFiles(jobId, { search: '%' })).toBe(0)
      expect(store.countFiles(jobId, { state: 'failed' })).toBe(actualFailedRows)
      queryResults.push({ jobId, paginatedUniqueFiles: queried.size, searchCount: 100, actualFailedRows })
    }
    // Query-only synthetic failures are confined to a never-run QA job; they
    // are not evidence of injected engine failures or a physical disk event.
    const filterJob = 'qa_stress_23'
    for (const index of [0, 99, 100, 4999]) {
      store.updateFile(filterJob, relativePath(index), { state: 'failed', error: 'QA query filter fixture' })
    }
    expect(store.countFiles(filterJob, { state: 'failed' })).toBe(4)
    expect(store.countFiles(filterJob, { state: 'failed', search: 'clip-000' })).toBe(2)
    expect(store.listFiles(filterJob, 1, 1, { state: 'failed', search: 'clip-000' })[0]?.relPath).toBe(relativePath(99))
    expect(store.countFiles('qa_stress_22', { state: 'failed' })).toBe(0)
    results.paginationQueryWallSeconds = (performance.now() - start) / 1000
    results.syntheticFilterFailures = { jobId: filterJob, total: 4, searchIntersection: 2, independentOfEngineScenarios: true }
  }, 120_000)
})
