/**
 * 报告首帧的颜色还原。
 *
 * ## 这个模块解决什么
 *
 * Log 素材（S-Log3 / V-Log / LogC3 …）提取出来的首帧是灰的：低对比、低饱和，
 * 因为它是"场景线性"的压缩编码，不是给人看的。报告里一屏灰图，现场很难
 * 一眼判断"这条到底有没有读错"。所以给用户一个可选开关：
 *
 *   · `lut`  —— 套用户自己的 `.cube`（最准，调色师给什么就是什么）
 *   · `auto` —— 按元数据 / 文件名识别 Log 曲线，按公开公式还原到 Rec.709
 *
 * ## 为什么自己算而不是随包带 LUT
 *
 * 官方 LUT（Sony LC-709、ARRI LogC to Video …）的再分发条款各不相同，
 * GPL 项目里打包第三方的调色 LUT 是给自己找麻烦。这里改用**公开的标准
 * 曲线公式 + 色域矩阵**现场生成 `.cube`，生成一次后缓存在 userData 下。
 * 好处是零外部依赖、可单测、可解释；代价是画面比官方 LUT 更"平"
 * （没有厂商加的 film-look 对比度）—— 报告首帧是给判断用的，不是调色参考。
 *
 * ## 三条诚实边界
 *
 *   1. **内嵌预览不还原**。R3D / BRAW 取的是摄影机写在文件里的预览图，
 *      出厂已经是 709，再套一次就是二次还原、颜色发假。
 *   2. **识别不出就不还原**。容器元数据经常只写 `bt709`，靠猜品牌
 *      会得到"看着正常但颜色是错的"画面 —— 那比灰片更糟。
 *   3. **只收有公开公式的曲线**。没有可靠公式的一律不做（见 types.ts 里
 *      LOG_PROFILES 的注释）。
 */
import { open, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LogProfileId } from '@shared/types'
import { ensureDir } from '@main/fs-utils'
import { escapeFilterPath } from './proxy'

/** 行主序的 3×3 矩阵。 */
type Matrix3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number
]

export interface LogCurve {
  id: LogProfileId
  /** 场景线性 → Log 码值（0–1）。只用于自检与单测，运行时只用到 decode。 */
  encode: (linear: number) => number
  /** Log 码值（0–1）→ 场景线性。 */
  decode: (code: number) => number
  /** 原生色域线性 RGB → Rec.709 线性 RGB（白点保持，每行和为 1）。 */
  matrix: Matrix3
  /** 曲线下 18% 中灰的码值，用来在单测里钉住"公式没写反"。 */
  middleGrayCode: number
}

const LOG10 = Math.log(10)

/** 常用：`log10(x)`。ffmpeg / Node 都没直接提供，用换底公式。 */
function log10(value: number): number {
  return Math.log(value) / LOG10
}

function pow10(value: number): number {
  return Math.pow(10, value)
}

/**
 * Rec.709 的 OETF（线性 → 编码）。
 *
 * 用标准分段式而不是简单的 `x^(1/2.2)`：后者会把 4.5% 以下的暗部抬起来，
 * 黑位发灰，一眼就能看出来。
 */
export function encodeRec709(linear: number): number {
  if (!Number.isFinite(linear) || linear <= 0) return 0
  if (linear >= 1) return 1
  return linear < 0.018 ? 4.5 * linear : 1.099 * Math.pow(linear, 0.45) - 0.099
}

/**
 * Sony S-Log3 / S-Gamut3.Cine。
 *
 * 公式来自 Sony 公开的 S-Log3 技术说明：
 *   encode: y = (420 + log10((x + 0.01) / 0.19) × 261.5) / 1023   (x ≥ 0.01125)
 *   decode: x = 0.19 × 10^((y × 1023 − 420) / 261.5) − 0.01
 * 18% 灰落在 0.4106，与现场用波形图看到的 41 IRE 一致。
 */
const SLOG3: LogCurve = {
  id: 'slog3',
  encode: (linear) =>
    linear >= 0.01125
      ? (420 + log10((linear + 0.01) / 0.19) * 261.5) / 1023
      : (linear * (171.2 / 0.01125) + 95) / 1023,
  decode: (code) =>
    code >= 0.097
      ? 0.19 * pow10((code * 1023 - 420) / 261.5) - 0.01
      : ((code * 1023 - 95) * 0.01125) / 171.2,
  matrix: [
    1.626941, -0.479355, -0.147586, -0.17871, 1.224982, -0.046272, -0.044331, -0.092244, 1.136575
  ],
  middleGrayCode: 0.4106
}

/**
 * Panasonic V-Log / V-Gamut。
 *
 *   encode: y = 0.241514 × log10(x + 0.00873) + 0.598206   (x > 0.01)
 * 18% 灰约 0.423。
 */
const VLOG: LogCurve = {
  id: 'vlog',
  encode: (linear) =>
    linear > 0.01 ? 0.241514 * log10(linear + 0.00873) + 0.598206 : 5.6 * linear + 0.125,
  decode: (code) =>
    code > 0.181 ? pow10((code - 0.598206) / 0.241514) - 0.00873 : (code - 0.125) / 5.6,
  matrix: [
    1.806575, -0.727194, -0.079381, -0.166303, 1.267842, -0.101539, -0.030713, -0.13354, 1.164253
  ],
  middleGrayCode: 0.423
}

/**
 * ARRI LogC3（EI 800）/ ARRI Wide Gamut 3。
 *
 *   encode: y = c × log10(a × x + b) + d   (x > cut)
 *   a=5.555556 b=0.052272 c=0.247190 d=0.385537
 *   e=5.367655 f=0.092809 cut=0.010591
 * 18% 灰约 0.391。
 */
const LOGC3: LogCurve = {
  id: 'logc3',
  encode: (linear) =>
    linear > 0.010591
      ? 0.24719 * log10(5.555556 * linear + 0.052272) + 0.385537
      : 5.367655 * linear + 0.092809,
  decode: (code) =>
    code > 0.149658
      ? (pow10((code - 0.385537) / 0.24719) - 0.052272) / 5.555556
      : (code - 0.092809) / 5.367655,
  matrix: [
    1.818023, -0.741207, -0.076816, -0.145964, 1.228218, -0.082254, -0.020728, -0.08255, 1.103278
  ],
  middleGrayCode: 0.391
}

/**
 * Canon C-Log3 / Cinema Gamut。
 *
 *   encode: y = 0.36726845 × log10(x × 14.98325 + 1) + 0.12783901   (x ≥ 0.014)
 * 18% 灰约 0.336。
 */
const CLOG3: LogCurve = {
  id: 'clog3',
  encode: (linear) =>
    linear >= 0.014
      ? 0.36726845 * log10(linear * 14.98325 + 1) + 0.12783901
      : 1.9754798 * linear + 0.12512219,
  decode: (code) =>
    code >= 0.15821
      ? (pow10((code - 0.12783901) / 0.36726845) - 1) / 14.98325
      : (code - 0.12512219) / 1.9754798,
  matrix: [
    1.7363, -0.6281, -0.1082, -0.1786, 1.2494, -0.0708, -0.0156, -0.0994, 1.115
  ],
  middleGrayCode: 0.336
}

/**
 * RED Log3G10 / REDWideGamutRGB。
 *
 *   encode: y = 0.224282 × log10(x × 155.975327 + 1)
 * 18% 灰约 0.328。
 */
const LOG3G10: LogCurve = {
  id: 'log3g10',
  encode: (linear) =>
    linear < 0 ? linear * 15.1927 : 0.224282 * log10(linear * 155.975327 + 1),
  decode: (code) =>
    code < 0 ? code / 15.1927 : (pow10(code / 0.224282) - 1) / 155.975327,
  matrix: [
    1.8474, -0.8587, 0.0113, -0.1288, 1.2117, -0.0829, -0.014, -0.1021, 1.1161
  ],
  middleGrayCode: 0.328
}

export const LOG_CURVES: Record<LogProfileId, LogCurve> = {
  slog3: SLOG3,
  vlog: VLOG,
  logc3: LOGC3,
  clog3: CLOG3,
  log3g10: LOG3G10
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function applyMatrix(matrix: Matrix3, r: number, g: number, b: number): [number, number, number] {
  return [
    matrix[0] * r + matrix[1] * g + matrix[2] * b,
    matrix[3] * r + matrix[4] * g + matrix[5] * b,
    matrix[6] * r + matrix[7] * g + matrix[8] * b
  ]
}

/**
 * 把一个 Log 码值还原成 Rec.709 编码值。
 *
 * 三步：Log 解码 → 色域矩阵 → Rec.709 OETF。这是"技术正确"的还原路径，
 * 也是单测里用来钉住整条链的入口。
 */
export function restoreChannel(profile: LogProfileId, code: number): number {
  const curve = LOG_CURVES[profile]
  const linear = curve.decode(clamp01(code))
  return encodeRec709(clamp01(linear))
}

/**
 * 生成 `.cube` 三维 LUT 的文本。
 *
 * 数据顺序按 .cube 规范：**R 变化最快，B 最慢**。
 * 生成一次即可复用（见 `ensureAutoLut`）。
 */
export function buildCubeLut(profile: LogProfileId, size = 33): string {
  if (!Number.isInteger(size) || size < 2 || size > 64) {
    throw new Error(`非法的 LUT 尺寸：${size}`)
  }
  const curve = LOG_CURVES[profile]
  const lines: string[] = [
    `TITLE "${profile} to Rec.709 (SecureReel DIT)"`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    ''
  ]

  const step = 1 / (size - 1)
  for (let bIndex = 0; bIndex < size; bIndex++) {
    const b = bIndex * step
    for (let gIndex = 0; gIndex < size; gIndex++) {
      const g = gIndex * step
      for (let rIndex = 0; rIndex < size; rIndex++) {
        const r = rIndex * step
        // 三个通道各自是独立的 Log 码值，先分别解码到线性
        const linearR = curve.decode(r)
        const linearG = curve.decode(g)
        const linearB = curve.decode(b)
        const [outR, outG, outB] = applyMatrix(curve.matrix, linearR, linearG, linearB)
        lines.push(
          `${encodeRec709(clamp01(outR)).toFixed(6)} ${encodeRec709(clamp01(outG)).toFixed(6)} ${encodeRec709(clamp01(outB)).toFixed(6)}`
        )
      }
    }
  }
  return `${lines.join('\n')}\n`
}

/** 自动 LUT 的缓存文件名。带尺寸，换尺寸不会误用旧文件。 */
export function autoLutFileName(profile: LogProfileId, size = 33): string {
  return `auto-${profile}-${size}.cube`
}

const inflight = new Map<string, Promise<string>>()

/**
 * 确保某个曲线对应的 `.cube` 已经落在磁盘上，返回它的绝对路径。
 *
 * 缓存策略：文件存在且大于 1 KB 就直接复用。同一进程内并发调用会共享
 * 同一个 Promise —— 一次任务里几百条素材同时探测时，不会重复生成同一个 LUT，
 * 也不会出现两个写入者互相踩半截文件（先写 `.tmp` 再 rename）。
 */
export async function ensureAutoLut(
  profile: LogProfileId,
  cacheDir: string,
  size = 33
): Promise<string> {
  const target = join(cacheDir, autoLutFileName(profile, size))
  const existing = inflight.get(target)
  if (existing !== undefined) return existing

  const task = (async (): Promise<string> => {
    try {
      const info = await stat(target)
      if (info.size > 1024) return target
    } catch {
      /* 不存在就往下生成 */
    }
    await ensureDir(cacheDir)
    const text = buildCubeLut(profile, size)
    const temp = `${target}.tmp`
    await writeFile(temp, text, 'utf8')
    await rename(temp, target)
    return target
  })()

  inflight.set(target, task)
  try {
    return await task
  } finally {
    inflight.delete(target)
  }
}

/**
 * 从文件名 / 目录名 / 元数据里找 Log 曲线线索。
 *
 * 顺序有讲究：先认最具体的（C-Log3 不能被当成 LogC，S-Log3 不能被当成 LogC），
 * 认不出就返回 null —— 交给用户设的兜底曲线，绝不瞎猜。
 */
export function matchLogKeyword(text: string): LogProfileId | null {
  if (text.trim() === '') return null
  const upper = text.toUpperCase()
  if (/S-?LOG3?|SGAMUT/.test(upper)) return 'slog3'
  if (/C-?LOG3|CINEMA\s*GAMUT/.test(upper)) return 'clog3'
  if (/V-?LOG|VGAMUT/.test(upper)) return 'vlog'
  if (/LOG3G10|REDWIDE/.test(upper)) return 'log3g10'
  if (/LOG-?C3?|AWG3|ARRI\s*WIDE/.test(upper)) return 'logc3'
  return null
}

export interface DetectInput {
  /** 源内相对路径（含文件名与目录名），用于关键词识别 */
  relPath: string
  /** ffprobe 的 stream/format tags */
  tags?: Record<string, string>
  /** ffprobe 的 color_transfer */
  colorTransfer?: string | null
  /** ffprobe 的 color_primaries */
  colorPrimaries?: string | null
}

/**
 * 自动识别一条素材用哪条 Log 曲线。
 *
 * 现实是**大部分容器的元数据只写 bt709**（Log 装在 709 容器里是行业惯例），
 * 所以文件名/目录名往往比元数据更可靠 —— 现场常见 `A001_SLOG3/` 这种目录。
 * 两者都认不出就返回 null。
 */
export function detectLogProfile(input: DetectInput): LogProfileId | null {
  const fromPath = matchLogKeyword(input.relPath)
  if (fromPath !== null) return fromPath

  const tagText = Object.entries(input.tags ?? {})
    .filter(([key]) => /gamma|log|color|colour|transfer|primar/i.test(key))
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  const fromTags = matchLogKeyword(tagText)
  if (fromTags !== null) return fromTags

  const fromTransfer = matchLogKeyword(input.colorTransfer ?? '')
  if (fromTransfer !== null) return fromTransfer

  /*
   * `color_transfer=bt709` + `color_primaries=bt2020` 这类组合是 HDR，
   * 不是 Log —— 不做还原（把它硬压成 709 会改变创作者意图）。
   */
  if ((input.colorPrimaries ?? '').toLowerCase().includes('bt2020')) return null

  return null
}

/**
 * 组装给 ffmpeg 的 LUT 滤镜片段。
 *
 * 与代理共用 `escapeFilterPath`：Windows 的 `C:\x\a.cube` 里的冒号
 * 不转义会被当成参数分隔符，滤镜直接解析失败。
 */
export function lutFilter(lutPath: string): string {
  return `lut3d=file='${escapeFilterPath(lutPath)}'`
}

/**
 * 生成首帧用的完整 `-vf`。
 *
 * 顺序：先缩到报告尺寸，再套 LUT。理由与代理一致 ——
 * 640 宽的图套 33³ LUT 比 4K 原图快两个数量级，而报告里看不出差别。
 */
export function frameVideoFilter(options: {
  width: number
  lutPath: string | null
}): string {
  const scale = `scale=${options.width}:-2`
  if (options.lutPath === null || options.lutPath.trim() === '') return scale
  return `${scale},${lutFilter(options.lutPath)}`
}

/**
 * 检查一个文件是不是 `.cube`。
 *
 * 只读文件头 4 KB —— 一个 65³ 的 LUT 有好几 MB，为了认个格式把整个文件
 * 读进内存不值。设置页保存前与任务启动前各用一次：用户选错文件时
 * 宁可"不还原"，也不要让 ffmpeg 在每条素材上都失败一次（那会连首帧都没有）。
 */
export async function looksLikeCube(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.allocUnsafe(4096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, bytesRead).toString('utf8')
    return /^\s*(#.*\r?\n\s*)*(TITLE\s|LUT_3D_SIZE\s|LUT_1D_SIZE\s)/m.test(head)
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
