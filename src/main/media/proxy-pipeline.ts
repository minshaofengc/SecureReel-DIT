import { createHash } from 'node:crypto'
import { lstat, mkdir, open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AppSettings,
  CopyJob,
  CopyJobFile,
  MediaProxyResult,
  ProxyTargetResult
} from '@shared/types'
import { PROXY_RESOLUTION_HEIGHT } from '@shared/types'
import { createStreamingHasher } from '@main/hashing'
import { pathExists, resolveInside, syncDirectory, targetRelativePath } from '@main/fs-utils'
import { resolveExecutable, runCommand } from '@main/exec'
import { executableName, proxyPublicationCommand } from '@main/platform'
import { ioCoordinator, volumeKey } from '@main/core/io-coordinator'
import { PauseGate } from '@main/core/concurrency'
import { generateProxy, proxyRelPathFor } from './proxy'
import { detectEncoders, pickEncoder } from './encoder-probe'

export interface ProxyPipelineOptions {
  job: CopyJob
  file: CopyJobFile
  ffmpegPath: string
  gate: PauseGate
  signal: AbortSignal
  settings: AppSettings
  previous?: MediaProxyResult | null
  onUpdate: (result: MediaProxyResult) => void
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('任务已取消')
}

async function hashPath(
  path: string,
  algorithm: CopyJob['hashAlgorithm'],
  signal: AbortSignal,
  gate?: PauseGate
): Promise<string> {
  const hasher = await createStreamingHasher(algorithm)
  const key = await volumeKey(path)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
    for (;;) {
      checkSignal(signal)
      await gate?.waitIfPaused(signal)
      const { bytesRead } = await ioCoordinator.run(
        [key],
        'proxy',
        () => handle.read(buffer),
        signal
      )
      if (bytesRead === 0) break
      hasher.update(buffer.subarray(0, bytesRead))
    }
    return hasher.digest()
  } finally {
    await handle.close()
  }
}

/** No-replace publication also works on exFAT, which cannot create hard links. */
export async function publishProxyPartial(
  partial: string,
  finalPath: string,
  signal: AbortSignal
): Promise<void> {
  checkSignal(signal)
  if (await pathExists(finalPath)) throw new Error('已有同名代理，未覆盖')
  const command = proxyPublicationCommand(partial, finalPath)
  const executable = await resolveExecutable(command.executable)
  if (executable === null) throw new Error('无法安全发布代理：系统移动工具不可用')
  const result = await runCommand(executable, command.args, {
    signal,
    ...(command.env === undefined ? {} : { env: { ...process.env, ...command.env } })
  })
  if (
    result.code !== 0 ||
    result.spawnError !== null ||
    result.timedOut ||
    (await pathExists(partial))
  )
    throw new Error('无法发布代理，目标冲突或移动失败')
  if (!(await lstat(finalPath)).isFile()) throw new Error('代理发布目标不是普通文件')
  await syncDirectory(dirname(finalPath))
}

export async function validateProxy(
  ffmpeg: string,
  path: string,
  expectedDuration: number | null,
  signal: AbortSignal,
  maxHeight?: number
): Promise<{ width: number; height: number }> {
  checkSignal(signal)
  const ffprobe = await resolveExecutable(join(dirname(ffmpeg), executableName('ffprobe')))
  if (ffprobe === null) throw new Error('缺少 ffprobe，无法验证代理')
  const result = await runCommand(
    ffprobe,
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
    { signal }
  )
  if (result.code !== 0 || result.spawnError !== null || result.timedOut)
    throw new Error('代理元数据校验失败')
  const metadata = JSON.parse(result.stdout) as {
    streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[]
    format?: { duration?: string }
  }
  const video = metadata.streams?.find((s) => s.codec_type === 'video')
  const duration = Number(metadata.format?.duration ?? video?.duration)
  if (
    !video ||
    !Number.isInteger(video.width) ||
    !Number.isInteger(video.height) ||
    !video.width ||
    !video.height ||
    video.width < 1 ||
    video.height < 1 ||
    !Number.isFinite(duration) ||
    duration <= 0
  )
    throw new Error('代理没有有效视频流或时长')
  if (maxHeight !== undefined && video.height > maxHeight) throw new Error('代理尺寸超过所选分辨率')
  if (video.width % 2 !== 0 || video.height % 2 !== 0) throw new Error('代理尺寸不符合编码要求')
  if (
    expectedDuration !== null &&
    expectedDuration > 0 &&
    Math.abs(duration - expectedDuration) > Math.max(0.5, expectedDuration * 0.001)
  )
    throw new Error('代理时长与原始素材不一致')
  const decode = await runCommand(
    ffmpeg,
    ['-v', 'error', '-xerror', '-i', path, '-map', '0:v:0', '-f', 'null', '-'],
    { signal, timeoutMs: 60 * 60 * 1000 }
  )
  checkSignal(signal)
  if (decode.code !== 0 || decode.spawnError !== null || decode.timedOut)
    throw new Error('代理完整解码检查失败')
  return { width: video.width, height: video.height }
}

/** Encode one verified copy, then independently verify every target distribution. */
export async function processProxy(options: ProxyPipelineOptions): Promise<MediaProxyResult> {
  const { job, file, signal, gate, onUpdate } = options
  const base: MediaProxyResult = {
    relPath: null,
    ok: false,
    reason: null,
    profile: job.proxyCodec === 'prores' ? job.proxyProfile : null,
    codec: job.proxyCodec,
    resolution: job.proxyResolution,
    width: null,
    height: null,
    lutPath: job.proxyLutPath,
    status: 'pending',
    targets: []
  }
  if (job.mode === 'verify' || !job.proxyEnabled)
    return { ...base, status: 'skipped', reason: '仅校验任务不生成代理' }
  checkSignal(signal)
  await gate.waitIfPaused(signal)
  const targets = job.targets.filter(
    (t) => t.enabled && file.results.some((r) => r.targetId === t.id && r.state === 'verified')
  )
  if (targets.length === 0) return { ...base, status: 'failed', reason: '没有校验通过的素材副本' }
  const relPath = proxyRelPathFor(
    targetRelativePath(job.sourceRootName, file.relPath),
    job.proxyCodec
  )
  let primary = targets[0]!
  for (const target of targets) {
    try {
      if (
        (
          await lstat(
            resolveInside(target.path, targetRelativePath(job.sourceRootName, file.relPath))
          )
        ).isFile()
      ) {
        primary = target
        break
      }
    } catch {
      /* A disconnected target must not prevent using another verified copy. */
    }
  }
  const previous = options.previous ?? file.probe?.proxy
  const results: ProxyTargetResult[] = targets.map((t) => {
    const prior = previous?.targets?.find((r) => r.targetId === t.id && r.relPath === relPath)
    return prior?.hash ? { ...prior } : { targetId: t.id, relPath, state: 'pending', error: null }
  })
  let current: MediaProxyResult = { ...base, targets: results }
  const update = (patch: Partial<MediaProxyResult>): void => {
    current = { ...current, ...patch, targets: results.map((t) => ({ ...t })) }
    onUpdate(current)
  }
  let cachedPath: string | null = null
  try {
    let lutHash: string | null = null
    if (job.proxyLutPath !== null) lutHash = await hashPath(job.proxyLutPath, 'sha256', signal)
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          file.sourceHash,
          job.proxyCodec,
          job.proxyProfile,
          job.proxyResolution,
          lutHash
        ])
      )
      .digest('hex')
    // The complete source path and original extension remain in final names; cache is task-scoped.
    const cacheRoot = join(primary.path, '.securereel-proxy-cache', job.id)
    const key = createHash('sha256').update(file.relPath).digest('hex')
    const volumeKeys = [await volumeKey(primary.path)]
    let cache = join(
      cacheRoot,
      `${key}-${fingerprint}.${job.proxyCodec === 'prores' ? 'mov' : 'mp4'}`
    )
    let cacheHash: string | null = null
    let dimensions: { width: number; height: number } | null = null
    if (
      previous?.fingerprint === fingerprint &&
      previous.cachePath === cache &&
      previous.cacheHash !== null &&
      previous.cacheHash !== undefined &&
      (await pathExists(cache))
    ) {
      const hash = await hashPath(cache, 'sha256', signal)
      if (hash === previous.cacheHash) {
        cacheHash = hash
        dimensions =
          previous.width && previous.height
            ? { width: previous.width, height: previous.height }
            : await validateProxy(
                options.ffmpegPath,
                cache,
                file.probe?.durationSeconds ?? null,
                signal,
                PROXY_RESOLUTION_HEIGHT[job.proxyResolution]
              )
      }
    }
    if (cacheHash === null && previous?.fingerprint === fingerprint && previous.cacheHash) {
      for (const target of targets) {
        const recorded = previous.targets?.find(
          (result) =>
            result.targetId === target.id &&
            result.relPath === relPath &&
            result.hash === previous.cacheHash
        )
        if (!recorded) continue
        const candidate = resolveInside(target.path, relPath)
        try {
          if ((await hashPath(candidate, 'sha256', signal, gate)) === previous.cacheHash) {
            cache = candidate
            cacheHash = previous.cacheHash
            dimensions =
              previous.width && previous.height
                ? { width: previous.width, height: previous.height }
                : await validateProxy(
                    options.ffmpegPath,
                    candidate,
                    file.probe?.durationSeconds ?? null,
                    signal,
                    PROXY_RESOLUTION_HEIGHT[job.proxyResolution]
                  )
            break
          }
        } catch {
          checkSignal(signal)
        }
      }
    }
    if (cacheHash === null) {
      const source = resolveInside(
        primary.path,
        targetRelativePath(job.sourceRootName, file.relPath)
      )
      const encoder = pickEncoder(await detectEncoders(options.ffmpegPath), job.proxyCodec)
      if (encoder === null) throw new Error('本机没有所选编码的可用编码器')
      const partial = join(
        cacheRoot,
        `${key}-${fingerprint}.encoding.${job.proxyCodec === 'prores' ? 'mov' : 'mp4'}`
      )
      for (;;) {
        checkSignal(signal)
        await gate.waitIfPaused(signal)
        await ioCoordinator.waitForIdle(volumeKeys, 'proxy', 250, signal)
        if (
          file.sourceHash === null ||
          (await hashPath(source, job.hashAlgorithm, signal, gate)) !== file.sourceHash
        )
          throw new Error('可信副本已变化，停止代理编码')
        await mkdir(cacheRoot, { recursive: true })
        await rm(partial, { force: true })
        const controller = new AbortController()
        const abort = (): void => controller.abort()
        signal.addEventListener('abort', abort, { once: true })
        const unsubscribe = gate.onPause(abort)
        update({ status: 'running', fingerprint })
        try {
          const encoded = await ioCoordinator.run(
            volumeKeys,
            'proxy',
            () =>
              generateProxy({
                ffmpegPath: options.ffmpegPath,
                inputAbsPath: source,
                outputAbsPath: partial,
                codec: job.proxyCodec,
                profile: job.proxyProfile,
                resolution: job.proxyResolution,
                encoder: encoder.name,
                lutPath: job.proxyLutPath,
                signal: controller.signal
              }),
            controller.signal,
            abort
          )
          checkSignal(signal)
          if (controller.signal.aborted) continue
          if (!encoded.ok) throw new Error(encoded.reason ?? '代理编码失败')
          dimensions = await ioCoordinator.run(
            volumeKeys,
            'proxy',
            () =>
              validateProxy(
                options.ffmpegPath,
                partial,
                file.probe?.durationSeconds ?? null,
                controller.signal,
                PROXY_RESOLUTION_HEIGHT[job.proxyResolution]
              ),
            controller.signal,
            abort
          )
          cacheHash = await hashPath(partial, 'sha256', controller.signal, gate)
          const handle = await open(partial, 'r+')
          try {
            await handle.sync()
          } finally {
            await handle.close()
          }
          if (await pathExists(cache)) await rm(cache, { force: true })
          await publishProxyPartial(partial, cache, signal)
        } catch (error) {
          checkSignal(signal)
          if (controller.signal.aborted) continue
          throw error
        } finally {
          signal.removeEventListener('abort', abort)
          unsubscribe()
          await rm(partial, { force: true }).catch(() => undefined)
        }
        break
      }
    }
    cachedPath = cache
    update({
      cachePath: cache,
      cacheHash,
      fingerprint,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null
    })
    for (const [index, target] of targets.entries()) {
      checkSignal(signal)
      await gate.waitIfPaused(signal)
      const targetResult = results[index]!
      const finalPath = resolveInside(target.path, relPath)
      const partial = `${finalPath}.${job.id}.partial`
      targetResult.state = 'running'
      targetResult.hash = cacheHash
      update({ status: 'running' })
      try {
        if (
          !(
            await lstat(
              resolveInside(target.path, targetRelativePath(job.sourceRootName, file.relPath))
            )
          ).isFile()
        )
          throw new Error('原始副本不可读取，未写入该目标')
        if (await pathExists(finalPath)) {
          const owned = previous?.targets?.find(
            (t) => t.targetId === target.id && t.relPath === relPath && t.hash === cacheHash
          )
          if (!owned || (await hashPath(finalPath, 'sha256', signal)) !== cacheHash)
            throw new Error('已有同名代理，未覆盖')
        } else {
          await mkdir(dirname(finalPath), { recursive: true })
          await rm(partial, { force: true })
          await distributeProxy(cache, partial, signal, gate)
          const handle = await open(partial, 'r+')
          try {
            await handle.sync()
          } finally {
            await handle.close()
          }
          if ((await hashPath(partial, 'sha256', signal, gate)) !== cacheHash)
            throw new Error('代理分发重读校验不一致')
          checkSignal(signal)
          await gate.waitIfPaused(signal)
          await publishProxyPartial(partial, finalPath, signal)
        }
        targetResult.state = 'verified'
        targetResult.hash = cacheHash
        targetResult.error = null
      } catch (error) {
        checkSignal(signal)
        targetResult.state = 'failed'
        targetResult.error = error instanceof Error ? error.message : String(error)
      } finally {
        await rm(partial, { force: true }).catch(() => undefined)
        update({})
      }
    }
    const ok = results.every((t) => t.state === 'verified')
    update({
      ok,
      status: ok ? 'verified' : 'failed',
      relPath: ok ? relPath : null,
      reason: ok ? null : '部分目标代理交付失败'
    })
    return current
  } catch (error) {
    for (const result of results)
      if (result.state !== 'verified') {
        result.state = 'failed'
        result.error = error instanceof Error ? error.message : String(error)
      }
    update({
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      cachePath: cachedPath
    })
    checkSignal(signal)
    return current
  }
}

async function distributeProxy(
  source: string,
  partial: string,
  signal: AbortSignal,
  gate: PauseGate
): Promise<void> {
  const keys = [await volumeKey(source), await volumeKey(partial)]
  const input = await open(source, 'r')
  let output: Awaited<ReturnType<typeof open>> | null = null
  try {
    output = await open(partial, 'wx')
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
    for (;;) {
      checkSignal(signal)
      await gate.waitIfPaused(signal)
      const bytesRead = await ioCoordinator.run(
        keys,
        'proxy',
        async () => {
          const { bytesRead } = await input.read(buffer)
          let offset = 0
          while (offset < bytesRead) {
            const { bytesWritten } = await output!.write(buffer, offset, bytesRead - offset)
            if (bytesWritten === 0) throw new Error('代理分发写入失败')
            offset += bytesWritten
          }
          return bytesRead
        },
        signal
      )
      if (bytesRead === 0) break
    }
    await output.sync()
  } finally {
    await input.close()
    await output?.close()
  }
}
