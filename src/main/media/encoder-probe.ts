/**
 * 本机**可用**视频编码器的探测。
 *
 * ## 为什么不能只 `ffmpeg -encoders`
 *
 * `-encoders` 只反映**编译时**是否把这个编码器编进去，不等于**这台机器能用**。
 * 典型反例：Windows 版随包 ffmpeg 编译进了 `h264_nvenc`，但机器上要是没有
 * NVIDIA 显卡，一跑就报 `Cannot load nvcuda.dll` / `No capable devices found`。
 * 所以判据必须是**真的试编一帧**（见 `probeEncoder`），而不是看一眼列表。
 *
 * ## 合规前提（重要）
 *
 * 随包 ffmpeg 是 **LGPL** 构建：`--disable-libx264 --disable-libx265`，
 * 但**带着**系统/硬件编码器（macOS VideoToolbox、Windows 的 NVENC / QSV / AMF）
 * 与 `libopenh264`（BSD）。硬件编码用的是**用户自己的硬件**，与随包的软件
 * 编码器许可无关 —— 所以这条路**不引入任何 GPL 组件**。
 *
 * h265 没有软件兜底（软件 HEVC 就是 libx265，GPL），所以机器上没有可用硬件时
 * h265 直接**不可用**，由 UI 置灰、引擎跳过 —— 绝不假装能编。
 */
import { runCommand } from '@main/exec'
import type { ProxyCodec } from '@shared/types'

/** 一种编码在本机的可用情况。 */
export interface EncoderChoice {
  /** 实际要传给 ffmpeg `-c:v` 的名字；不可用时为 null */
  name: string | null
  /** 是否走硬件编码（用于报告与提示措辞） */
  hardware: boolean
}

export interface EncoderCapability {
  h264: EncoderChoice
  h265: EncoderChoice
  /** ProRes（prores_ks）恒定可用，不参与探测 */
  prores: true
}

/**
 * 候选编码器（按优先级，前面的更优）。
 *
 * 顺序理由：VideoToolbox 是 macOS 系统框架，零额外依赖、画质与速度都稳；
 * NVENC（N 卡）→ QSV（Intel 核显）→ AMF（A 卡）按各自生态的成熟度排；
 * `libopenh264` 是软件兜底，只在没有任何硬件可用时顶上（慢，但能用）。
 */
const H264_CANDIDATES: { name: string; hardware: boolean }[] = [
  { name: 'h264_videotoolbox', hardware: true },
  { name: 'h264_nvenc', hardware: true },
  { name: 'h264_qsv', hardware: true },
  { name: 'h264_amf', hardware: true },
  { name: 'libopenh264', hardware: false }
]

const H265_CANDIDATES: { name: string; hardware: boolean }[] = [
  { name: 'hevc_videotoolbox', hardware: true },
  { name: 'hevc_nvenc', hardware: true },
  { name: 'hevc_qsv', hardware: true },
  { name: 'hevc_amf', hardware: true }
]

/**
 * 试着用某个编码器编一帧 64×64 黑图。
 *
 * 用 `lavfi` 造源，不需要任何输入文件；`-f null -` 只编码不落盘，
 * 代价极小（正常几十毫秒）。失败（编不过 / 超时 / 起不来）一律判为不可用。
 */
async function probeEncoder(ffmpegPath: string, encoder: string): Promise<boolean> {
  const result = await runCommand(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'color=c=black:s=64x64:d=0.1',
      '-frames:v', '1',
      '-c:v', encoder,
      '-f', 'null',
      '-'
    ],
    { timeoutMs: 8_000 }
  )
  // spawnError / 超时 / 非零退出码，任一都说明这台机器用不了它。
  return result.spawnError === null && !result.timedOut && result.code === 0
}

/** 按优先级逐个试，返回第一个真正可用的。 */
async function pickAvailable(
  ffmpegPath: string,
  candidates: { name: string; hardware: boolean }[]
): Promise<EncoderChoice> {
  for (const candidate of candidates) {
    if (await probeEncoder(ffmpegPath, candidate.name)) {
      return { name: candidate.name, hardware: candidate.hardware }
    }
  }
  return { name: null, hardware: false }
}

/**
 * 探测本机可用的编码能力。
 *
 * 结果**按进程缓存**：探测要跑好几次 ffmpeg，没必要每次出代理都重来；
 * ffmpeg 路径在会话内基本不变。要强制重测传 `force`。
 */
const cache = new Map<string, Promise<EncoderCapability>>()

export function detectEncoders(ffmpegPath: string, force = false): Promise<EncoderCapability> {
  if (force) cache.delete(ffmpegPath)
  const cached = cache.get(ffmpegPath)
  if (cached !== undefined) return cached

  const pending = (async (): Promise<EncoderCapability> => {
    // 顺序探测即可：单次几百毫秒，且只在首次出代理时跑一遍。
    const h264 = await pickAvailable(ffmpegPath, H264_CANDIDATES)
    const h265 = await pickAvailable(ffmpegPath, H265_CANDIDATES)
    return { h264, h265, prores: true }
  })()

  cache.set(ffmpegPath, pending)
  return pending
}

/** 该编码在本机是否可用。 */
export function isCodecAvailable(capability: EncoderCapability, codec: ProxyCodec): boolean {
  if (codec === 'prores') return true
  return codec === 'h264' ? capability.h264.name !== null : capability.h265.name !== null
}

/**
 * 给定编码，取出要用的 `-c:v` 名字与其是否硬件。不可用时返回 null。
 *
 * 抽成纯函数，便于单测覆盖优先级与缺硬件的情况。
 */
export function pickEncoder(
  capability: EncoderCapability,
  codec: ProxyCodec
): { name: string; hardware: boolean } | null {
  if (codec === 'prores') return { name: 'prores_ks', hardware: false }
  const choice = codec === 'h264' ? capability.h264 : capability.h265
  return choice.name === null ? null : { name: choice.name, hardware: choice.hardware }
}
