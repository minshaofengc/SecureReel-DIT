import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processProxy, validateProxy } from '../src/main/media/proxy-pipeline'
import { runCommand } from '../src/main/exec'
import { generateProxy } from '../src/main/media/proxy'
import { PauseGate } from '../src/main/core/concurrency'
import { DEFAULT_SETTINGS, type CopyJob, type CopyJobFile } from '../src/shared/types'
import { hashFileAt } from '../src/main/core/copy-engine'
vi.mock('../src/main/media/proxy', async (original) => ({
  ...(await original<object>()),
  generateProxy: vi.fn(async (opts: { outputAbsPath: string }) => {
    await writeFile(opts.outputAbsPath, 'encoded-proxy')
    return { ok: true, reason: null }
  })
}))
vi.mock('../src/main/media/encoder-probe', () => ({
  detectEncoders: vi.fn(async () => ({ prores: true })),
  pickEncoder: vi.fn(() => ({ name: 'prores_ks', hardware: false }))
}))
vi.mock('../src/main/exec', async (original) => {
  const real = await original<typeof import('../src/main/exec')>()
  return {
    ...real,
    runCommand: vi.fn(
      async (exe: string, args: readonly string[], opts: import('../src/main/exec').RunOptions) =>
        exe === '/bin/mv'
          ? real.runCommand(exe, args, opts)
          : {
              code: 0,
              spawnError: null,
              timedOut: false,
              stderr: '',
              stdout: JSON.stringify({
                streams: [
                  {
                    codec_type: 'video',
                    width: 64,
                    height: 64,
                    duration: '1',
                    avg_frame_rate: '25/1'
                  }
                ],
                format: { duration: '1' }
              })
            }
    ),
    resolveExecutable: vi.fn(async (p: string) => p)
  }
})
let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'proxy-pipeline-'))
  vi.clearAllMocks()
  vi.mocked(generateProxy).mockImplementation(async (opts) => {
    await writeFile(opts.outputAbsPath, 'encoded-proxy')
    return { ok: true, reason: null } as Awaited<ReturnType<typeof generateProxy>>
  })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
async function fixture(mode: 'copy' | 'verify' = 'copy') {
  const targets = [join(root, 'target1'), join(root, 'target2')]
  for (const p of targets) {
    await mkdir(join(p, 'CARD'), { recursive: true })
    await writeFile(join(p, 'CARD', 'clip.mov'), 'original')
  }
  const file = {
    relPath: 'clip.mov',
    sourceHash: await hashFileAt(join(targets[0]!, 'CARD', 'clip.mov'), 'xxhash64'),
    results: targets.map((_, i) => ({ targetId: `t${i}`, state: 'verified', hashMatch: true })),
    probe: { available: true, formatFamily: 'mov', durationSeconds: 1 }
  } as unknown as CopyJobFile
  const job = {
    id: 'job_pipeline01',
    mode,
    sourceRootName: 'CARD',
    proxyEnabled: true,
    proxyCodec: 'prores',
    proxyProfile: '422-proxy',
    proxyResolution: '1080p',
    proxyLutPath: null,
    hashAlgorithm: 'xxhash64',
    targets: targets.map((path, i) => ({ id: `t${i}`, path, enabled: true }))
  } as CopyJob
  return {
    job,
    file,
    ffmpegPath: '/ffmpeg',
    gate: new PauseGate(),
    signal: new AbortController().signal,
    settings: DEFAULT_SETTINGS,
    onUpdate: vi.fn()
  }
}
describe('可靠代理流水线', () => {
  it('仅校验不编码也不创建代理目录', async () => {
    const o = await fixture('verify')
    const r = await processProxy(o)
    expect(r.status).toBe('skipped')
    expect(generateProxy).not.toHaveBeenCalled()
    expect(await readdir(join(root, 'target1'))).toEqual(['CARD'])
  })
  it('多目标只编码一次，读取可信副本并分别校验分发', async () => {
    const o = await fixture()
    const r = await processProxy(o)
    expect(r.ok).toBe(true)
    expect(generateProxy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(generateProxy).mock.calls[0]![0].inputAbsPath).toBe(
      join(root, 'target1', 'CARD', 'clip.mov')
    )
    expect(r.targets?.every((t) => t.state === 'verified')).toBe(true)
  })
  it('保留已有目标代理并只让冲突目标失败', async () => {
    const o = await fixture()
    await mkdir(join(root, 'target1', 'Proxies', 'CARD'), { recursive: true })
    await writeFile(join(root, 'target1', 'Proxies', 'CARD', 'clip.mov.mov'), 'previous')
    const r = await processProxy(o)
    expect(r.ok).toBe(false)
    expect(await readFile(join(root, 'target1', 'Proxies', 'CARD', 'clip.mov.mov'), 'utf8')).toBe(
      'previous'
    )
    expect(r.targets?.[1]?.state).toBe('verified')
  })
  it('重试复用校验通过的缓存且不重新编码', async () => {
    const o = await fixture()
    const first = await processProxy(o)
    const again = await processProxy({ ...o, previous: first })
    expect(again.ok).toBe(true)
    expect(generateProxy).toHaveBeenCalledTimes(1)
  })
  it('取消后不派发编码', async () => {
    const o = await fixture()
    const c = new AbortController()
    c.abort()
    await expect(processProxy({ ...o, signal: c.signal })).rejects.toThrow()
    expect(generateProxy).not.toHaveBeenCalled()
  })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('暂停、取消与恢复安全', () => {
  it('暂停中断当前编码，恢复后重新编码并交付', async () => {
    const options = await fixture()
    const started = deferred()
    const interrupted = deferred()
    vi.mocked(generateProxy).mockImplementationOnce(async (input) => {
      await writeFile(input.outputAbsPath, 'unfinished')
      started.resolve()
      await new Promise<void>((resolve) =>
        input.signal!.addEventListener(
          'abort',
          () => {
            interrupted.resolve()
            resolve()
          },
          { once: true }
        )
      )
      return { ok: false, reason: 'interrupted' } as Awaited<ReturnType<typeof generateProxy>>
    })
    const processing = processProxy(options)
    await started.promise
    options.gate.pause()
    await interrupted.promise
    expect(generateProxy).toHaveBeenCalledTimes(1)
    options.gate.resume()
    const result = await processing
    expect(result.ok).toBe(true)
    expect(generateProxy).toHaveBeenCalledTimes(2)
    expect(await readFile(join(root, 'target1', 'Proxies', 'CARD', 'clip.mov.mov'), 'utf8')).toBe(
      'encoded-proxy'
    )
  })

  it('暂停队列取消后不启动编码且不创建代理目录', async () => {
    const options = await fixture()
    const controller = new AbortController()
    options.gate.pause()
    const processing = processProxy({ ...options, signal: controller.signal })
    const rejected = expect(processing).rejects.toThrow('取消')
    controller.abort()
    await rejected
    expect(generateProxy).not.toHaveBeenCalled()
    expect(await readdir(join(root, 'target1'))).toEqual(['CARD'])
  })

  it('取消正在编码的任务会中断进程且不发布正式文件', async () => {
    const options = await fixture()
    const controller = new AbortController()
    const started = deferred()
    vi.mocked(generateProxy).mockImplementationOnce(async (input) => {
      await writeFile(input.outputAbsPath, 'unfinished')
      started.resolve()
      await new Promise<void>((resolve) =>
        input.signal!.addEventListener('abort', () => resolve(), { once: true })
      )
      return { ok: false, reason: 'cancelled' } as Awaited<ReturnType<typeof generateProxy>>
    })
    const processing = processProxy({ ...options, signal: controller.signal })
    const rejected = expect(processing).rejects.toThrow('取消')
    await started.promise
    controller.abort()
    await rejected
    expect(generateProxy).toHaveBeenCalledTimes(1)
    await expect(
      readFile(join(root, 'target1', 'Proxies', 'CARD', 'clip.mov.mov'))
    ).rejects.toThrow()
  })

  it('损坏缓存复用已验证的交付代理，避免重复编码', async () => {
    const options = await fixture()
    const first = await processProxy(options)
    expect(first.ok).toBe(true)
    await writeFile(first.cachePath!, 'corrupt-cache')
    const retried = await processProxy({ ...options, previous: first })
    expect(retried.ok).toBe(true)
    expect(generateProxy).toHaveBeenCalledTimes(1)
    expect(await readFile(retried.cachePath!, 'utf8')).toBe('encoded-proxy')
    expect(await readFile(join(root, 'target1', 'Proxies', 'CARD', 'clip.mov.mov'), 'utf8')).toBe(
      'encoded-proxy'
    )
  })

  it('可信副本已变化时不编码也不发布代理', async () => {
    const options = await fixture()
    await writeFile(join(root, 'target1', 'CARD', 'clip.mov'), 'modified-original')
    const result = await processProxy(options)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('已变化')
    expect(generateProxy).not.toHaveBeenCalled()
    expect(await readdir(join(root, 'target1'))).toEqual(['CARD'])
  })
})

it('暂停期间可信副本变化，恢复后不得编码变更内容', async () => {
  const options = await fixture()
  const started = deferred()
  const interrupted = deferred()
  vi.mocked(generateProxy).mockImplementationOnce(async (input) => {
    await writeFile(input.outputAbsPath, 'unfinished')
    started.resolve()
    await new Promise<void>((resolve) =>
      input.signal!.addEventListener(
        'abort',
        () => {
          interrupted.resolve()
          resolve()
        },
        { once: true }
      )
    )
    return { ok: false, reason: 'interrupted' } as Awaited<ReturnType<typeof generateProxy>>
  })
  const processing = processProxy(options)
  await started.promise
  options.gate.pause()
  await interrupted.promise
  await writeFile(join(root, 'target1', 'CARD', 'clip.mov'), 'modified-during-pause')
  options.gate.resume()
  const result = await processing
  expect(result.ok).toBe(false)
  expect(result.reason).toContain('已变化')
  expect(generateProxy).toHaveBeenCalledTimes(1)
})

it('可解码但超过所选分辨率的代理被拒绝', async () => {
  vi.mocked(runCommand).mockResolvedValueOnce({
    code: 0,
    spawnError: null,
    timedOut: false,
    stderr: '',
    stdout: JSON.stringify({
      streams: [{ codec_type: 'video', width: 3840, height: 2160 }],
      format: { duration: '1' }
    })
  })
  await expect(
    validateProxy('/ffmpeg', '/proxy.mov', 1, new AbortController().signal, 1080)
  ).rejects.toThrow('分辨率')
})

it('一个原始副本不可用时从另一个健康副本编码并隔离交付失败',async()=>{
 const options=await fixture()
 await rm(join(root,'target1','CARD'),{recursive:true,force:true})
 const result=await processProxy(options)
 expect(generateProxy).toHaveBeenCalledTimes(1)
 expect(vi.mocked(generateProxy).mock.calls[0]?.[0].inputAbsPath).toBe(join(root,'target2','CARD','clip.mov'))
 expect(result.targets?.find(t=>t.targetId==='t0')?.state).toBe('failed')
 expect(result.targets?.find(t=>t.targetId==='t1')?.state).toBe('verified')
})

it('临时缓存丢失时复用仍通过校验的交付代理',async()=>{
 const options=await fixture();const first=await processProxy(options)
 await rm(first.cachePath!,{force:true})
 const result=await processProxy({...options,previous:first})
 expect(result.ok).toBe(true)
 expect(generateProxy).toHaveBeenCalledTimes(1)
})
