/**
 * 媒体元数据探测与首帧提取。
 *
 * 用 FFmpeg / ffprobe 读取素材的拍摄时间、时长、时码、编码与分辨率，
 * 并提取首帧（R3D / BRAW 这类私有格式取文件内嵌的预览图）。
 *
 * 四条硬性设计：
 *   1. **探测失败绝不影响哈希报告**。读不动的素材只是少几行元数据，
 *      拷贝与校验的结论不变。
 *   2. ffprobe / ffmpeg **不由本应用分发**，只从用户系统或用户指定目录里找。
 *      找不到就明确说明原因，不做任何猜测。
 *   3. 调用一律走 `exec.ts`，参数数组 + shell:false，且带超时。
 *   4. **首帧来源如实标注**。"解码出来的"和"读的文件内嵌预览"是两回事，
 *      报告里必须让人分得清 —— 预览图分辨率通常低于实际记录分辨率。
 */
import { basename, join } from 'node:path'
import { open, readFile, writeFile } from 'node:fs/promises'
import type { FrameSource, MediaProbe } from '@shared/types'
import { resolveExecutable, runCommand } from '@main/exec'
import { ensureDir, whichInPath } from '@main/fs-utils'
import type { Logger } from '@main/logger'
import { extractEmbeddedPreview, type EmbeddedPreview } from './embedded-preview'
import {
  canDecodeWithFfmpeg,
  extensionOf,
  fallbackByExtension,
  formatFromFfprobe,
  formatFromMagic,
  usuallyHasEmbeddedPreview,
  type FormatDescriptor
} from './formats'

export interface ProbeOptions {
  /** 是否提取首帧（对长片材有解码开销，按设置决定） */
  extractFrames: boolean
  signal?: AbortSignal
}

export interface MediaProbeRunner {
  /** 探测一个素材文件。永不抛错，失败时返回 available=false 并说明原因。 */
  probe(absPath: string, options: ProbeOptions): Promise<MediaProbe>
  /** 工具是否可用 */
  readonly available: boolean
  /** 不可用原因 */
  readonly unavailableReason: string | null
  /** ffmpeg 是否可用（提取首帧需要它，除了内嵌预览那条路） */
  readonly frameToolAvailable: boolean
  /** 设置首帧输出目录（报告的 frames/ 子目录） */
  setFrameOutputDir(dir: string): void
  /** 重新探测工具位置（用户改了设置之后调用） */
  refresh(): Promise<void>
}

/** 会尝试探测的扩展名（小写，不含点）。 */
const PROBEABLE_EXTENSIONS = new Set([
  // 专业录制格式
  'mov',
  'mxf',
  'r3d',
  'braw',
  'ari',
  'arx',
  'dng',
  'cine',
  // 通用视频
  'mp4',
  'm4v',
  'avi',
  'mkv',
  'webm',
  'mts',
  'm2ts',
  // 音频
  'wav',
  'bwf',
  'aif',
  'aiff',
  'mp3',
  'flac'
])

/** 无法从元数据得到结果、也不值得花时间的扩展名。 */
export function isProbeable(path: string): boolean {
  return PROBEABLE_EXTENSIONS.has(extensionOf(path))
}

/** 视频类扩展名（决定要不要提首帧；音频不提）。 */
const VIDEO_EXTENSIONS = new Set([
  'mov',
  'mxf',
  'r3d',
  'braw',
  'ari',
  'arx',
  'dng',
  'cine',
  'mp4',
  'm4v',
  'avi',
  'mkv',
  'webm',
  'mts',
  'm2ts'
])

export function isVideoLike(path: string): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(path))
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  profile?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  duration?: string
  tags?: Record<string, string>
}

interface FfprobeFormat {
  duration?: string
  format_name?: string
  tags?: Record<string, string>
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: FfprobeFormat
}

function baseProbe(
  format: FormatDescriptor,
  frameSource: FrameSource,
  reason: string | null
): MediaProbe {
  return {
    available: false,
    reason,
    capturedAt: null,
    durationSeconds: null,
    timecode: null,
    codec: null,
    width: null,
    height: null,
    frameRate: null,
    firstFrame: null,
    lastFrame: null,
    format: format.label,
    formatFamily: format.family,
    frameSource,
    vendorTool: format.vendorTool,
    note: null
  }
}

/**
 * 把 "24000/1001" 这种分数帧率转成可读文本。
 *
 * 带合理性检查：R3D 这类"只能看到预览流"的素材，ffprobe 可能报出
 * `1200000/1` 这种荒谬值。报告上出现「1200000 fps」比留空更糟。
 */
function formatFrameRate(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null
  const [numeratorRaw, denominatorRaw] = raw.split('/')
  const numerator = Number(numeratorRaw)
  const denominator = denominatorRaw === undefined ? 1 : Number(denominatorRaw)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null
  const value = numerator / denominator
  if (value < 1 || value > 1000) return null
  return `${value.toFixed(3).replace(/\.?0+$/, '')} fps`
}

/** 在 r_frame_rate / avg_frame_rate 里挑一个合理的。 */
function pickFrameRate(stream: FfprobeStream | undefined): string | null {
  return formatFrameRate(stream?.avg_frame_rate) ?? formatFrameRate(stream?.r_frame_rate)
}

/** 把 "01:23:45:12" 或帧号转成显示用文本。 */
function normalizeTimecode(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null
  const value = raw.trim()
  if (/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(value)) return value
  if (/^\d+$/.test(value)) return `${value} 帧`
  return value
}

function safeStem(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_')
}

export class FfprobeRunner implements MediaProbeRunner {
  private ffprobePath: string | null = null
  private ffmpegPath: string | null = null
  private frameOutputDir: string | null = null

  constructor(
    private readonly deps: {
      logger: Logger
      /** 用户指定目录；null 表示自动查找 */
      userDir: string | null
      /** 随应用资源目录（若用户自行放入了 ffmpeg，可被找到） */
      bundledDir: string | null
    }
  ) {}

  get available(): boolean {
    return this.ffprobePath !== null
  }

  get frameToolAvailable(): boolean {
    return this.ffmpegPath !== null
  }

  get unavailableReason(): string | null {
    if (this.ffprobePath !== null) return null
    return (
      '未找到 ffprobe，因此无法读取拍摄时间、时长、时码与编码信息。' +
      '这部分属于报告的附加内容，缺失不会影响拷贝与哈希校验结果。' +
      'R3D / BRAW 这类私有格式即使没有 ffprobe，也能从文件内嵌预览图取到首帧。' +
      '如需完整元数据，请自行安装 FFmpeg（例如 brew install ffmpeg），或在设置里指定其所在目录。'
    )
  }

  setFrameOutputDir(dir: string): void {
    this.frameOutputDir = dir
  }

  async refresh(): Promise<void> {
    const candidates: string[] = []
    if (this.deps.userDir !== null) {
      candidates.push(join(this.deps.userDir, 'ffprobe'), join(this.deps.userDir, 'ffmpeg'))
    }
    if (this.deps.bundledDir !== null) {
      candidates.push(join(this.deps.bundledDir, 'ffprobe'), join(this.deps.bundledDir, 'ffmpeg'))
    }

    const pathProbe = await whichInPath('ffprobe')
    const pathMux = await whichInPath('ffmpeg')

    this.ffprobePath = (await resolveExecutable(candidates[0] ?? null)) ?? (await resolveExecutable(pathProbe))
    this.ffmpegPath = (await resolveExecutable(candidates[1] ?? null)) ?? (await resolveExecutable(pathMux))

    if (this.ffprobePath !== null) {
      this.deps.logger.info('media', `已找到 ffprobe：${this.ffprobePath}`)
    } else {
      this.deps.logger.warn('media', '未找到 ffprobe，媒体元数据将不可用')
    }
    if (this.ffmpegPath !== null) {
      this.deps.logger.info('media', `已找到 ffmpeg：${this.ffmpegPath}`)
    }
  }

  async probe(absPath: string, options: ProbeOptions): Promise<MediaProbe> {
    if (!isProbeable(absPath)) {
      const format = fallbackByExtension(absPath)
      return baseProbe(format, 'none', '该文件类型不做媒体元数据探测，仅记录文件级哈希。')
    }

    // ---- 1. 先定格式：ffprobe 优先（容器优先于流编码），认不出来再看文件头与扩展名 ----
    const parsed = this.ffprobePath === null ? null : await this.runFfprobe(absPath, options.signal)

    let format: FormatDescriptor
    if (parsed !== null) {
      format = formatFromFfprobe(
        parsed.video?.codec_name,
        parsed.video?.profile,
        absPath,
        parsed.format?.format_name
      )
    } else {
      format = (await this.readHeaderDescriptor(absPath)) ?? fallbackByExtension(absPath)
    }

    const probe = baseProbe(format, 'none', null)
    const decodable = canDecodeWithFfmpeg(format.family)

    // ---- 2. 填元数据 ----
    // 关键判断：对 R3D / BRAW 这类私有格式，ffprobe 看到的流其实是文件里
    // 内嵌的预览图（R3D 会被当成一路 MJPEG）。此时流级的分辨率、帧率、时长
    // 全是预览图的性质，当成素材本身的技术参数写进报告就是错的。
    // 容器身份可以采信，流级参数不能。
    if (parsed !== null && decodable) {
      const video = parsed.video
      const durationRaw = parsed.format?.duration ?? video?.duration
      const duration = durationRaw === undefined ? Number.NaN : Number(durationRaw)
      const tags = { ...(parsed.format?.tags ?? {}), ...(video?.tags ?? {}) }

      probe.codec = video?.codec_name ?? parsed.format?.format_name ?? null
      probe.width = video?.width ?? null
      probe.height = video?.height ?? null
      probe.frameRate = pickFrameRate(video)
      probe.durationSeconds = Number.isFinite(duration) ? duration : null
      probe.timecode = normalizeTimecode(
        tags['timecode'] ?? tags['com.apple.quicktime.timecode'] ?? tags['TIMECODE']
      )
      const captured =
        tags['creation_time'] ?? tags['com.apple.quicktime.creationdate'] ?? tags['date'] ?? null
      probe.capturedAt = captured === null ? null : String(captured)
      probe.available = true
    } else if (parsed !== null) {
      // 只保留容器层面的身份，并说明技术参数去了哪里
      probe.codec = null
      probe.available = true
    }

    // ---- 3. 取首帧 ----
    const wantsFrame = options.extractFrames && isVideoLike(absPath)
    if (wantsFrame) {
      const frame = await this.acquireFirstFrame(absPath, decodable, options.signal)
      if (frame !== null) {
        probe.firstFrame = frame.fileName
        probe.frameSource = frame.source
        // 预览图的分辨率只在没有真实技术参数时用于填充，并在 note 里说明
        if (frame.width !== null && probe.width === null) probe.width = frame.width
        if (frame.height !== null && probe.height === null) probe.height = frame.height
        probe.available = true
        if (frame.source === 'embedded-preview') {
          probe.lastFrame = null
        }
      }
    }

    // ---- 4. 尾帧只在能真解码时才提 ----
    if (wantsFrame && decodable && this.ffmpegPath !== null) {
      probe.lastFrame = await this.extractFrameWithFfmpeg(absPath, 'last')
    }

    probe.note = buildNote(probe, format, wantsFrame)
    if (!probe.available && probe.reason === null) {
      probe.reason = '该素材没有可读取的元数据，也没有可用于提取首帧的内嵌预览图。'
    }

    return probe
  }

  /* ---------------------------------------------------------------- *
   * ffprobe
   * ---------------------------------------------------------------- */

  private async runFfprobe(
    absPath: string,
    signal?: AbortSignal
  ): Promise<{ video: FfprobeStream | undefined; format: FfprobeFormat | undefined } | null> {
    if (signal?.aborted === true) return null

    const result = await runCommand(
      this.ffprobePath as string,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', absPath],
      { timeoutMs: 20_000 }
    )

    if (result.spawnError !== null || result.timedOut || result.code !== 0) return null

    try {
      const parsed = JSON.parse(result.stdout) as FfprobeOutput
      const video = parsed.streams?.find((stream) => stream.codec_type === 'video')
      return { video, format: parsed.format }
    } catch {
      return null
    }
  }

  /** 读文件头做特征识别（ffprobe 不可用或认不出来时）。 */
  private async readHeaderDescriptor(absPath: string): Promise<FormatDescriptor | null> {
    try {
      const handle = await open(absPath, 'r')
      try {
        const size = (await handle.stat()).size
        const length = Math.min(4 * 1024 * 1024, size)
        if (length <= 0) return null
        const buffer = Buffer.allocUnsafe(length)
        await handle.read(buffer, 0, length, 0)
        return formatFromMagic(buffer, absPath)
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  }

  /* ---------------------------------------------------------------- *
   * 首帧获取：先试真解码，不行再读内嵌预览
   * ---------------------------------------------------------------- */

  private async acquireFirstFrame(
    absPath: string,
    decodable: boolean,
    signal?: AbortSignal
  ): Promise<{ fileName: string; source: FrameSource; width: number | null; height: number | null } | null> {
    const canDecode = decodable && this.ffmpegPath !== null

    if (canDecode) {
      const decoded = await this.extractFrameWithFfmpeg(absPath, 'first')
      if (decoded !== null) {
        return { fileName: decoded, source: 'decoded', width: null, height: null }
      }
      // 解码失败（文件损坏 / 编码不支持）时，仍然值得试试内嵌预览
    }

    if (signal?.aborted === true || this.frameOutputDir === null) return null

    // 读文件失败必须吃掉 —— probe() 的契约是"永不抛错"，
    // 一条读不动的素材不该让整个任务的分析阶段炸掉。
    let preview: EmbeddedPreview | null = null
    try {
      preview = await extractEmbeddedPreview(absPath, signal === undefined ? {} : { signal })
    } catch (error) {
      this.deps.logger.warn('media', `读取内嵌预览失败：${absPath} —— ${String(error)}`)
      return null
    }
    if (preview === null) return null

    try {
      await ensureDir(this.frameOutputDir)
      const fileName = `${safeStem(basename(absPath))}-first.jpg`
      await writeFile(join(this.frameOutputDir, fileName), preview.jpeg)
      return { fileName, source: 'embedded-preview', width: preview.width, height: preview.height }
    } catch (error) {
      this.deps.logger.warn('media', `内嵌预览图写入失败：${String(error)}`)
      return null
    }
  }

  /**
   * 用 ffmpeg 解码出一帧。
   *
   * 首帧用 `-ss 0`；尾帧用 `-sseof -1` 从结尾回退取样 ——
   * 比 seek 到 duration 更稳，VFR 与截断文件都能取到。
   */
  private async extractFrameWithFfmpeg(absPath: string, which: 'first' | 'last'): Promise<string | null> {
    if (this.ffmpegPath === null || this.frameOutputDir === null) return null

    try {
      await ensureDir(this.frameOutputDir)
    } catch {
      return null
    }

    const fileName = `${safeStem(basename(absPath))}-${which}.jpg`
    const output = join(this.frameOutputDir, fileName)
    const seek = which === 'first' ? [] : ['-sseof', '-1']

    const result = await runCommand(
      this.ffmpegPath,
      [
        '-nostdin',
        '-y',
        ...seek,
        '-i',
        absPath,
        '-frames:v',
        '1',
        '-vf',
        'scale=640:-2',
        '-q:v',
        '4',
        output
      ],
      { timeoutMs: 60_000 }
    )

    if (result.spawnError !== null || result.timedOut || result.code !== 0) return null

    // ffmpeg 有可能"退出码为 0 但没写出文件"，必须实际确认
    try {
      const written = await readFile(output)
      if (written.length < 512) return null
    } catch {
      return null
    }

    return fileName
  }
}

/**
 * 生成面向用户的说明。
 *
 * 只在**确实有需要解释的事情**时才写 —— 一切正常时不要塞废话，
 * 报告里满屏的"正常"会把人训练成不看备注。
 */
function buildNote(probe: MediaProbe, format: FormatDescriptor, wantedFrame: boolean): string | null {
  const parts: string[] = []
  const decodable = canDecodeWithFfmpeg(format.family)

  if (!decodable) {
    parts.push(
      `${format.label} 使用厂商私有编码，FFmpeg 没有对应解码器，无法直接解码画面。`
    )
    if (usuallyHasEmbeddedPreview(format.family)) {
      parts.push(
        '首帧取自摄影机写在文件内部的预览图；表格中的分辨率同样来自该预览图，' +
          '通常低于实际记录分辨率，请以原件参数为准。'
      )
    }
    if (format.vendorTool !== null) {
      parts.push(`如需完整技术参数与逐帧提取，请使用官方工具：${format.vendorTool}。`)
    }
  }

  if (probe.frameSource === 'embedded-preview' && decodable) {
    parts.push('首帧来自文件内嵌的预览图（直接解码失败后的回退路径）。')
  }

  if (wantedFrame && probe.firstFrame === null) {
    parts.push('本次未能取到首帧画面，该文件仅记录哈希与体积。')
  }

  if (!wantedFrame && probe.formatFamily !== 'audio') {
    parts.push('本次未提取首帧（可在设置中开启「为视频素材提取首帧」）。')
  }

  return parts.length === 0 ? null : parts.join(' ')
}
