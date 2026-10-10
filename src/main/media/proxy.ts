/**
 * 代理素材（ProRes）生成。
 *
 * ## 为什么自己做一薄层、而不是塞进 probe.ts
 *
 * probe 是"读"（元数据 + 首尾帧），产出很小、失败无所谓；代理是"重编码"，
 * 产出是一份和源同长的视频文件、要写目标盘、耗时以分钟计。两者的失败代价、
 * 并发策略、输出位置完全不同，混在一个类里会让 probe 不再"永不抛错"。
 * 所以单独一个模块，只依赖 `exec.ts`，可以被单元测试直接钉住参数组装。
 *
 * ## 编码选择：prores_ks
 *
 * 随包 ffmpeg 是 **LGPL** 构建（`--disable-gpl --disable-nonfree`），
 * 其中 `prores_ks` 是 FFmpeg 自研的 ProRes 编码器，属 LGPL 原生编码器集合，
 * **不引入任何 GPL/专利组件**。实测随包二进制的编码器列表里
 * `prores_ks / prores_aw / prores / prores_videotoolbox` 都在。
 *
 * 选 `prores_ks` 而不是 `prores_videotoolbox`：后者只在 macOS 上存在、
 * 输出 profile 行为不透明；`prores_ks` 两个平台行为一致，参数可控、可测。
 *
 * ## 规格 → profile
 *
 * ProRes 的规格由 `-profile:v` 决定（Apple 官方编号）：
 *   0 = 422 Proxy / 1 = 422 LT / 2 = 422（Standard）/ 3 = 422 HQ
 */
import { mkdir } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import type { ProxyCodec, ProxyProfile, ProxyResolution } from '@shared/types'
import { PROXY_RESOLUTION_HEIGHT } from '@shared/types'
import { runCommand } from '@main/exec'
import { extensionOf } from './formats'

/** ProRes 规格 → `-profile:v` 数值。 */
const PROFILE_NUMBER: Record<ProxyProfile, string> = {
  '422-proxy': '0',
  '422-lt': '1',
  '422': '2',
  '422-hq': '3'
}

/** 面向用户 / 报告里显示的规格名。 */
export const PROXY_PROFILE_LABEL: Record<ProxyProfile, string> = {
  '422-proxy': 'ProRes 422 Proxy',
  '422-lt': 'ProRes 422 LT',
  '422': 'ProRes 422',
  '422-hq': 'ProRes 422 HQ'
}

/** 面向用户 / 报告里显示的编码名。 */
export const PROXY_CODEC_LABEL: Record<ProxyCodec, string> = {
  prores: 'ProRes',
  h264: 'H.264',
  h265: 'H.265 / HEVC'
}

/** 各编码的输出容器扩展名（不带点）。ProRes 走 .mov，其余走 .mp4。 */
export function proxyExtensionFor(codec: ProxyCodec): string {
  return codec === 'prores' ? 'mov' : 'mp4'
}

/**
 * 目标盘上代理文件的顶层目录名。
 *
 * 与报告的 `SecureReel/` 分开：代理是"给剪辑用的素材"，
 * 报告是"交付记录"，混在一个目录里会让剪辑分不清哪是素材哪是记录。
 */
export const PROXY_FOLDER = 'Proxies'

/**
 * 一条素材的代理输出相对路径（相对某个目标盘根）。
 *
 * 结果形如 `Proxies/<源相对目录>/<去扩展名>.<扩展名>`：
 *   · 保留源目录结构，否则几百条同名 clip 会互相覆盖；
 *   · 扩展名随编码变：ProRes → `.mov`（标准容器），H.264/H.265 → `.mp4`。
 */
export function proxyRelPathFor(sourceRelPath: string, codec: ProxyCodec = 'prores'): string {
  const dir = posix.dirname(sourceRelPath)
  const base = posix.basename(sourceRelPath)
  const ext = extensionOf(base)
  const stem = ext === '' ? base : base.slice(0, -(ext.length + 1))
  const fileName = `${stem}.${proxyExtensionFor(codec)}`
  const parent = dir === '.' || dir === '' ? '' : dir
  return posix.join(PROXY_FOLDER, parent, fileName)
}

/**
 * 把文件路径转义成可在 ffmpeg 滤镜表达式里安全使用的形式。
 *
 * 滤镜串里 `:` 分隔参数、`,` 分隔滤镜、`'` 是引用符，所以路径里这些字符必须转义，
 * 否则 Windows 的 `C:\x\a.cube` 会被从盘符冒号处截断，滤镜参数直接解析失败。
 * 规则：反斜杠统一成正斜杠（FFmpeg 两平台都认 `/`）、`:` 转 `\:`、`'` 转 `\'`。
 *
 * 抽成纯函数便于单测 —— 这是最容易被想当然写错、又最难从报错里看出原因的一处。
 */
export function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/**
 * 组装 `-vf` 滤镜链：先缩放（省算力），再按需套 3D LUT。
 *
 * 顺序理由：`scale` 在前 —— 先降到目标分辨率再调色，像素少、LUT 计算省很多；
 * 反过来先调色再缩放会多算几倍像素，收益却为零。
 */
export function buildVideoFilter(resolution: ProxyResolution, lutPath: string | null | undefined): string {
  const scale = `scale=-2:'min(ih,${PROXY_RESOLUTION_HEIGHT[resolution]})'`
  if (lutPath === null || lutPath === undefined || lutPath.trim() === '') return scale
  /*
   * 参数名是 `file`，**不是** `filename` —— 实测（ffmpeg 7.1 随包版）
   * 写 `filename=` 会报 `Option not found` 直接失败。这是查 `-h filter=lut3d`
   * 才确认的，别凭印象写。
   */
  return `${scale},lut3d=file='${escapeFilterPath(lutPath)}'`
}

/**
 * 组装 ffmpeg 参数（**不含可执行文件本身**，方便单测直接断言）。
 *
 * 参数逐条写清楚（而不是拼一个字符串），与项目"外部命令一律参数数组"的约定一致。
 *
 * ## 分辨率：只降不升
 *
 * `scale=-2:'min(ih,H)'`：高度取"源高与目标高的较小值"，宽度用 `-2` 让它按源比例
 * 自动算并**取偶数**（多数编码器要求宽高为偶数）。源本来就比目标矮时不放大 ——
 * 放大不会凭空多出细节，只会把文件撑大、让剪辑白等。
 *
 * ## 编码分支
 *
 * - ProRes：`prores_ks` + profile + 422 10bit + PCM 音频（现状不变）。
 * - H.264 / H.265：走**本机硬件编码器**（由 encoder-probe 探测后传入）。
 *   硬件编码器不吃 `-profile:v`（那是 ProRes 的语义）、也不要 10bit 422，
 *   改用 `yuv420p` 与 `-b:v` 码率；音频统一转 AAC（mp4 容器的常规搭配）。
 *
 * ## LUT
 *
 * 传了 `lutPath` 就在滤镜链末尾挂 `lut3d`（3D LUT，`.cube`）。
 * 用 `lut3d` 而不是 `lut`：后者只处理 1D 查找表，套 3D `.cube` 会得不出正确结果。
 */
export function buildProxyArgs(
  input: string,
  output: string,
  options: {
    profile: ProxyProfile
    resolution: ProxyResolution
    codec: ProxyCodec
    /** 该编码实际要用的 `-c:v` 名字（由 encoder-probe 给出）；缺省按 ProRes 处理 */
    encoder?: string
    /** 要套的 3D LUT（`.cube` 绝对路径）；null/缺省 = 不套 */
    lutPath?: string | null
  }
): string[] {
  const { profile, resolution, codec } = options
  const vf = buildVideoFilter(resolution, options.lutPath)

  const shared = ['-nostdin', '-y', '-i', input, '-vf', vf, '-nostats']

  if (codec === 'prores') {
    return [
      ...shared,
      // 视频：ProRes，指定规格。yuv422p10le 是所有 422 规格的标准采样格式。
      '-c:v',
      options.encoder ?? 'prores_ks',
      '-profile:v',
      PROFILE_NUMBER[profile],
      '-pix_fmt',
      'yuv422p10le',
      '-vendor',
      'apl0',
      // 音频：PCM 16-bit，ProRes 的常规搭配，剪辑软件零解码负担。
      '-c:a',
      'pcm_s16le',
      output
    ]
  }

  // H.264 / H.265：硬件编码器。码率给一个"代理够用"的档位。
  return [
    ...shared,
    '-c:v',
    options.encoder ?? (codec === 'h265' ? 'hevc_videotoolbox' : 'h264_videotoolbox'),
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    '12M',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    output
  ]
}

export interface ProxyRunResult {
  ok: boolean
  /** 失败原因（面向用户）；成功时为 null */
  reason: string | null
}

/**
 * 为一条素材生成代理。
 *
 * 契约与 probe 相反：这里**可以失败**，失败信息会被如实写进报告
 * （哪条素材没出代理、为什么）。绝不静默留白，也绝不假装成功。
 *
 * 输出目录必须已经存在（由调用方按目标盘建好），本函数只负责编码。
 */
export async function generateProxy(options: {
  ffmpegPath: string
  inputAbsPath: string
  outputAbsPath: string
  profile: ProxyProfile
  resolution: ProxyResolution
  codec: ProxyCodec
  /** 该编码实际要用的 `-c:v` 名字（由 encoder-probe 给出） */
  encoder: string
  /** 要套的 3D LUT（`.cube` 绝对路径）；null = 不套 */
  lutPath?: string | null
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<ProxyRunResult> {
  const { ffmpegPath, inputAbsPath, outputAbsPath } = options

  try {
    await mkdir(dirname(outputAbsPath), { recursive: true })
  } catch (error) {
    return { ok: false, reason: `无法创建代理输出目录：${describe(error)}` }
  }

  const result = await runCommand(
    ffmpegPath,
    buildProxyArgs(inputAbsPath, outputAbsPath, {
      profile: options.profile,
      resolution: options.resolution,
      codec: options.codec,
      encoder: options.encoder,
      lutPath: options.lutPath ?? null
    }),
    {
      // 一条素材的编码可能十几分钟，给足超时；用户取消时靠 signal 中断。
      timeoutMs: options.timeoutMs ?? 60 * 60 * 1000,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }
  )

  if (result.spawnError !== null) {
    return { ok: false, reason: `无法启动 ffmpeg：${result.spawnError}` }
  }
  if (result.timedOut) {
    return { ok: false, reason: '代理编码超时。' }
  }
  if (result.code !== 0) {
    const tail = result.stderr.trim().split('\n').slice(-3).join(' ').trim()
    return { ok: false, reason: tail === '' ? `ffmpeg 退出码 ${result.code ?? '?'}` : tail }
  }
  if (options.signal?.aborted === true) {
    return { ok: false, reason: '任务已取消。' }
  }
  return { ok: true, reason: null }
}

/** 目标盘上某个代理文件所在的**目录**（相对目标盘根）。 */
export function proxyDirFor(sourceRelPath: string, codec: ProxyCodec = 'prores'): string {
  return posix.dirname(proxyRelPathFor(sourceRelPath, codec))
}

/** 绝对路径形式的代理输出位置。 */
export function proxyAbsPathFor(
  targetRoot: string,
  sourceRelPath: string,
  codec: ProxyCodec = 'prores'
): string {
  return join(targetRoot, proxyRelPathFor(sourceRelPath, codec))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
