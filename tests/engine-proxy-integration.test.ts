import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/db/store'
import { CopyEngine } from '../src/main/core/copy-engine'
import { PauseGate } from '../src/main/core/concurrency'
import { processProxy } from '../src/main/media/proxy-pipeline'
import { DEFAULT_SETTINGS, type CopyJob, type MediaProbe } from '../src/shared/types'
import { Logger } from '../src/main/logger'
vi.mock('../src/main/media/proxy-pipeline', () => ({ processProxy: vi.fn() }))
let root = ''
let store: Store
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'engine-proxy-'))
  store = await Store.openInMemory()
  vi.clearAllMocks()
})
afterEach(async () => {
  store.close()
  await rm(root, { recursive: true, force: true })
})
const probe: MediaProbe = {
  available: true,
  reason: null,
  capturedAt: null,
  durationSeconds: 1,
  timecode: null,
  codec: 'prores',
  width: 64,
  height: 64,
  frameRate: '25',
  firstFrame: null,
  lastFrame: null,
  stillFrames: [],
  format: 'ProRes',
  formatFamily: 'prores',
  frameSource: 'decoded',
  vendorTool: null,
  note: null,
  proxy: null
}
async function setup(mode: 'copy' | 'verify' = 'copy') {
  const source = join(root, 'CARD')
  const target = join(root, 'backup')
  await mkdir(source)
  await mkdir(target)
  await writeFile(join(source, 'clip.mov'), 'content')
  const job: CopyJob = {
    id: 'job_proxyengine01',
    name: 'proxy test',
    mode,
    sourcePath: source,
    sourceRootName: 'CARD',
    sourceKind: 'generic',
    isCodExVfs: false,
    parentProjectId: null,
    targets: [
      {
        id: 'target_a',
        path: target,
        label: 'Backup',
        enabled: true,
        freeBytes: null,
        writable: true
      }
    ],
    hashAlgorithm: 'xxhash64',
    manifestFormat: 'asc-mhl-2.0',
    verifyAfterWrite: false,
    proxyEnabled: true,
    proxyResolution: '1080p',
    proxyCodec: 'prores',
    proxyProfile: '422-proxy',
    proxyLutPath: null,
    state: 'draft',
    totalFiles: 1,
    totalBytes: 7,
    filesDone: 0,
    filesFailed: 0,
    bytesDone: 0,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    degradationNotice: null
  }
  store.insertJob(job)
  store.upsertFiles(job.id, [{ relPath: 'clip.mov', sizeBytes: 7 }])
  const runner = {
    probe: vi.fn<(path: string) => Promise<MediaProbe>>().mockResolvedValue({ ...probe }),
    available: true,
    frameToolAvailable: true,
    ffmpegExecutable: '/ffmpeg',
    unavailableReason: null,
    setFrameOutputDir: () => {},
    setStillFrameOutputDir: () => {},
    setStillFrameCount: () => {},
    refresh: async () => {}
  }
  const engine = () =>
    new CopyEngine({
      job,
      store,
      logger: new Logger({ dir: '' }),
      settings: DEFAULT_SETTINGS,
      signal: new AbortController().signal,
      gate: new PauseGate(),
      probeRunner: runner
    })
  return { job, target, runner, engine }
}
describe('引擎和代理接线', () => {
  it('仅校验即使遗留代理开关为真也不调用代理、不写目标', async () => {
    const o = await setup('verify')
    await mkdir(join(o.target, 'CARD'))
    await writeFile(join(o.target, 'CARD', 'clip.mov'), 'content')
    const before = await readdir(o.target)
    const result = await o.engine().run()
    expect(result.state).toBe('completed')
    expect(processProxy).not.toHaveBeenCalled()
    expect(await readdir(o.target)).toEqual(before)
  })
  it('从校验通过的目标副本探测，代理失败不改变原始成功计数', async () => {
    const o = await setup()
    vi.mocked(processProxy).mockImplementation(async (options) => {
      const result = {
        ...probe.proxy!,
        relPath: null,
        ok: false,
        reason: 'GPU failed',
        status: 'failed' as const,
        profile: null,
        codec: null,
        resolution: null,
        width: null,
        height: null,
        lutPath: null
      }
      options.onUpdate(result)
      return result
    })
    const result = await o.engine().run()
    expect(result.state).toBe('completed-with-errors')
    expect(o.runner.probe.mock.calls[0]?.[0]).toBe(join(o.target, 'CARD', 'clip.mov'))
    expect(store.getJob(o.job.id)?.filesDone).toBe(1)
    expect(store.getJob(o.job.id)?.filesFailed).toBe(0)
    expect(await readFile(join(o.target, 'CARD', 'clip.mov'), 'utf8')).toBe('content')
    expect(store.proxyProgress(o.job.id).failed).toBe(1)
  })
  it('独立代理重试不重拷原始文件或重复计数', async () => {
    const o = await setup()
    vi.mocked(processProxy).mockImplementation(async (options) => {
      const result = {
        relPath: 'Proxies/CARD/clip.mov.mov',
        ok: true,
        reason: null,
        status: 'verified' as const,
        profile: null,
        codec: null,
        resolution: null,
        width: 64,
        height: 64,
        lutPath: null
      }
      options.onUpdate(result)
      return result
    })
    await o.engine().run()
    const before = store.getJob(o.job.id)!
    await o.engine().retryProxies()
    const after = store.getJob(o.job.id)!
    expect(after.filesDone).toBe(before.filesDone)
    expect(after.bytesDone).toBe(before.bytesDone)
    expect(await readFile(join(o.target, 'CARD', 'clip.mov'), 'utf8')).toBe('content')
  })
})

it('媒体探测异常会记录代理失败，不把任务伪装为全部成功', async () => {
  const o = await setup()
  o.runner.probe.mockRejectedValue(new Error('probe failed'))
  const result = await o.engine().run()
  expect(result.state).toBe('completed-with-errors')
  expect(store.getJob(o.job.id)?.filesFailed).toBe(0)
  expect(store.getFile(o.job.id, 'clip.mov')?.probe?.proxy?.status).toBe('failed')
})

it('取消独立代理重试会等待活跃编码收尾再结束', async () => {
  const o = await setup()
  await mkdir(join(o.target, 'CARD'))
  await writeFile(join(o.target, 'CARD', 'clip.mov'), 'content')
  const normal = o.engine()
  vi.mocked(processProxy).mockResolvedValue({
    relPath: null,
    ok: false,
    reason: 'fail',
    profile: null,
    codec: null,
    resolution: null,
    width: null,
    height: null,
    lutPath: null,
    status: 'failed'
  })
  await normal.run()
  store.upsertFiles(o.job.id, [{ relPath: 'second.mov', sizeBytes: 7 }])
  await writeFile(join(o.job.sourcePath, 'second.mov'), 'content')
  const second = store.listPendingFiles(o.job.id, 10)[0]!
  store.updateFile(o.job.id, second.relPath, {
    state: 'verified',
    sourceHash: store.getFile(o.job.id, 'clip.mov')!.sourceHash,
    probe
  })
  store.saveFileResult(second.id, o.job.id, {
    targetId: 'target_a',
    state: 'verified',
    hash: null,
    hashMatch: true,
    bytesCopied: 7,
    error: null
  })
  const controller = new AbortController()
  let cleaned = false
  vi.mocked(processProxy).mockImplementation(async (options) => {
    await new Promise<void>((resolve) =>
      options.signal.addEventListener(
        'abort',
        () => {
          setTimeout(() => {
            cleaned = true
            resolve()
          }, 50)
        },
        { once: true }
      )
    )
    throw new Error('cancelled')
  })
  const engine = new CopyEngine({
    job: o.job,
    store,
    logger: new Logger({ dir: '' }),
    settings: { ...DEFAULT_SETTINGS, proxyConcurrency: 1 },
    signal: controller.signal,
    gate: new PauseGate(),
    probeRunner: o.runner
  })
  const retry = engine.retryProxies()
  await vi.waitFor(() => expect(processProxy).toHaveBeenCalledTimes(2))
  controller.abort()
  const result = await retry
  expect(cleaned).toBe(true)
  expect(result.state).toBe('cancelled')
})

it('探测暂时失败后独立重试会重新探测并保留代理恢复凭据', async () => {
  const o = await setup()
  o.runner.probe.mockRejectedValueOnce(new Error('temporary disconnect'))
  await o.engine().run()
  const failed = store.getFile(o.job.id, 'clip.mov')!.probe!
  const previous = { ...failed.proxy!, cachePath: '/trusted/cache', cacheHash: 'recorded' }
  store.updateFile(o.job.id, 'clip.mov', { probe: { ...failed, proxy: previous } })
  vi.mocked(processProxy).mockResolvedValue({ ...previous, ok: true, status: 'verified' })
  const result = await o.engine().retryProxies()
  expect(o.runner.probe).toHaveBeenCalledTimes(2)
  expect(processProxy).toHaveBeenCalledWith(expect.objectContaining({ previous }))
  expect(result.state).toBe('completed')
  expect(store.getJob(o.job.id)?.filesDone).toBe(1)
  expect(store.getJob(o.job.id)?.filesFailed).toBe(0)
})
