import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/main/db/store'
import { CopyEngine } from '../src/main/core/copy-engine'
import { JobManager } from '../src/main/core/job-manager'
import { Logger } from '../src/main/logger'
import { ReportStore } from '../src/main/reports/report-store'
import { buildAppPaths } from '../src/main/paths'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import type { TargetPreflightResult } from '../src/shared/storage-safety'
import * as fsUtils from '../src/main/fs-utils'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'sr-preflight-manager-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const target = join(root, 'target')
  await mkdir(source)
  await mkdir(target)
  await writeFile(join(source, 'clip.bin'), 'sample')
  const paths = buildAppPaths(join(root, 'data'))
  const store = await Store.openInMemory()
  cleanup.push(async () => store.close())
  const logger = new Logger({ dir: '' })
  const identity = (path: string) => ({
    path,
    label: path,
    filesystemId: path,
    capacityPoolId: path,
    physicalDeviceIds: ['same-backup-disk'],
    availableBytes: 1000,
    present: true
  })
  let current: TargetPreflightResult = {
    fingerprint: 'current-devices',
    checkedAt: new Date().toISOString(),
    source: identity(source),
    targets: [identity(target)],
    groups: [],
    risks: [{ code: 'shared-device', paths: [target] }],
    blockingReasons: [],
    requiredBytes: 6,
    independentDeviceGroups: 1
  }
  vi.spyOn(fsUtils, 'describeVolume').mockResolvedValue(null)
  const detect = vi.fn(async () => current)
  const manager = new JobManager({
    store,
    logger,
    paths,
    reportStore: new ReportStore(paths, logger),
    probeRunner: { setFrameOutputDir: () => undefined, setStillFrameOutputDir: () => undefined, setStillFrameCount: () => undefined } as never,
    hde: {} as never,
    getSettings: () => ({ ...DEFAULT_SETTINGS, generateReport: false }),
    emit: () => undefined,
    storagePreflight: detect
  })
  return {
    manager,
    detect,
    store,
    source,
    target,
    set: (next: TargetPreflightResult) => {
      current = next
    },
    get: () => current
  }
}
it('refuses an unacknowledged backup risk before persisting a task', async () => {
  const f = await setup()
  await expect(
    f.manager.createJob({ name: 'Card', sourcePath: f.source, targets: [{ path: f.target }] })
  ).rejects.toThrow()
  expect(f.store.listJobs()).toHaveLength(0)
})
it('persists accepted evidence and rejects changed devices before engine startup', async () => {
  const f = await setup()
  const proof = { fingerprint: 'current-devices', acceptRisks: true }
  const { job } = await f.manager.createJob({
    name: 'Card',
    sourcePath: f.source,
    targets: [{ path: f.target }],
    preflightConfirmation: proof
  })
  expect(f.store.getJob(job.id)?.backupSafety?.fingerprint).toBe('current-devices')
  f.set({ ...f.get(), fingerprint: 'replaced-disk' })
  await expect(f.manager.start(job.id)).rejects.toThrow()
  expect(f.store.getJob(job.id)?.state).toBe('draft')
  expect(f.manager.canEject).toBe(true)
})
it('does not mutate a saved task when adding an unsafe unconfirmed target', async () => {
  const f = await setup()
  const { job } = await f.manager.createJob({
    name: 'Card',
    sourcePath: f.source,
    targets: [{ path: f.target }],
    preflightConfirmation: { fingerprint: 'current-devices', acceptRisks: true }
  })
  const extra = join(f.target, 'extra')
  await mkdir(extra)
  f.set({ ...f.get(), fingerprint: 'additional-target' })
  await expect(f.manager.addTarget(job.id, extra)).rejects.toThrow()
  expect(f.store.getJob(job.id)?.targets).toHaveLength(1)
})


it('pauses a queued task without calling the engine if evidence changes before writing', async () => {
  const f = await setup()
  const { job } = await f.manager.createJob({ name: 'Card', sourcePath: f.source, targets: [{ path: f.target }], preflightConfirmation: { fingerprint: 'current-devices', acceptRisks: true } })
  f.detect.mockResolvedValueOnce(f.get()).mockResolvedValueOnce({ ...f.get(), fingerprint: 'replaced-at-queue' })
  const engine = vi.spyOn(CopyEngine.prototype, 'run')
  await f.manager.start(job.id)
  await f.manager.wait(job.id)
  expect(engine).not.toHaveBeenCalled()
  expect(f.store.getJob(job.id)?.state).toBe('paused')
  expect(f.store.listReports(job.id)).toHaveLength(0)
  expect(f.manager.canEject).toBe(true)
})

it('does not reset failed file evidence before a retry has passed storage validation', async () => {
  const f = await setup()
  const { job } = await f.manager.createJob({ name: 'Card', sourcePath: f.source, targets: [{ path: f.target }], preflightConfirmation: { fingerprint: 'current-devices', acceptRisks: true } })
  f.store.updateFile(job.id, 'clip.bin', { state: 'failed', error: 'original readback mismatch' })
  f.set({ ...f.get(), fingerprint: 'replaced-before-retry' })
  await expect(f.manager.retryFailed(job.id)).rejects.toThrow()
  expect(f.store.listFiles(job.id)[0]?.state).toBe('failed')
})

it('blocks startup while a target change is awaiting device evidence', async () => {
  const f = await setup()
  const proof = { fingerprint: 'current-devices', acceptRisks: true }
  const { job } = await f.manager.createJob({ name: 'Card', sourcePath: f.source, targets: [{ path: f.target }], preflightConfirmation: proof })
  const extra = join(f.target, 'extra'); await mkdir(extra)
  let entered!: () => void; let release!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  f.detect.mockImplementationOnce(async () => { entered(); await gate; return f.get() })
  const engine = vi.spyOn(CopyEngine.prototype, 'run').mockResolvedValue({ state: 'completed', filesDone: 1, filesFailed: 0, bytesDone: 6, processed: 1 })
  const adding = f.manager.addTarget(job.id, extra, proof)
  await waiting
  try {
    await expect(f.manager.start(job.id)).rejects.toThrow()
    expect(engine).not.toHaveBeenCalled()
    expect(f.manager.canEject).toBe(false)
  } finally { release(); await adding; await f.manager.wait(job.id) }
  expect(f.store.getJob(job.id)?.targets).toHaveLength(2)
})
