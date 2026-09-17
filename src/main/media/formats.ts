/**
 * 素材格式识别。
 *
 * 三层判断，优先级从高到低：
 *   1. **ffprobe 的解析结果** —— 最权威。codec_name + profile 能精确区分
 *      ProRes 422 / 422 HQ / 4444 / 4444 XQ / ProRes RAW / RAW HQ
 *   2. **文件头特征** —— ffprobe 不可用时兜底。MOV 里的 `icpf` 帧头是 ProRes
 *      的可靠标志；R3D 的 `RED1` / `RED2` 魔数同理
 *   3. **扩展名** —— 最后兜底，对 BRAW 这类连解复用器都没有的格式只能靠它
 *
 * 这里刻意**不猜**。判不出来就老实写"未识别"，而不是给一个看起来很懂的
 * 格式名 —— 报告上的格式标注错了，比空着更容易误导人。
 */
import type { MaterialFormat } from '@shared/types'

export interface FormatDescriptor {
  family: MaterialFormat
  /** 面向用户的可读名称，例如 "ProRes 422 HQ" */
  label: string
  /**
   * 要拿到完整技术参数（传感器分辨率、时码、帧率）所需的厂商官方工具。
   * null 表示不需要，ffmpeg 足够。
   */
  vendorTool: string | null
  /** ffmpeg 能否解码出画面帧 */
  ffmpegCanDecode: boolean
}

const GENERIC: FormatDescriptor = {
  family: 'generic',
  label: '普通文件',
  vendorTool: null,
  ffmpegCanDecode: true
}

/*
 * 佳能 Cinema RAW Light —— EOS R5 C / C70 / C300 III / C500 II / C200 等
 * 机内 RAW 录制的容器，扩展名 `.CRM`，画面 12-bit，机内有 LT / ST / HQ 三档。
 *
 * 关于它，三件事是**实测**出来的（一条 1 GB 的 R5 C 素材，2026-09）：
 *   1. 容器是 MOV 系（`major_brand = 'crx'`），画面轨 fourcc 是 `CRAW`；
 *      ffprobe 能读出**真实**的时长、时码、拍摄时间、分辨率。
 *   2. 但 ffmpeg **没有 CRAW 解码器**（trac #6765 自 2017 年至今 open），
 *      解不出画面；而且**文件里也没有内嵌预览图** ——
 *      前 96 MiB + 尾部 16 MiB 里可解析的 JPEG 为 0，moov 里只有画面/音频/时码轨，
 *      **没有图片轨**。所以 R3D/BRAW 那条"读内嵌预览图"的路子在这里也走不通。
 *   3. ffprobe 读它**只要 0.01 秒**（moov 在文件头部），拿参数的成本可以忽略。
 *
 * 结论：这个格式**有参数、没有画面**。要画面只能用 Canon 官方工具。
 * 因此取缩略图那条路（embedded-preview）对它无效。
 */
const CANON_RAW: FormatDescriptor = {
  family: 'canon-raw',
  label: 'CRM（Canon Cinema RAW Light）',
  vendorTool: 'Canon Cinema RAW Development / DaVinci Resolve',
  ffmpegCanDecode: false
}

/**
 * 佳能 CRM 画面轨的 fourcc。
 *
 * ⚠️ 为什么必须显式认它，而不是靠"扩展名兜底"：
 * ffprobe 认不出这个编码时**连 `codec_name` 字段都不输出**（实测如此，不是输出 "none"），
 * 于是 formatFromFfprobe 会一路落到最后那条"拿 codec 名当格式名"的兜底之外、
 * 靠扩展名才拿到对的答案 —— 那是**巧合**，不是设计。
 * 一旦某个 ffmpeg 版本改成像 `codec_name: "none"` 这样输出，报告上就会写出 `none`。
 */
const CANON_RAW_CODEC_TAG = 'craw'

/** 扩展名 → 兜底格式（仅在 ffprobe 无结论、文件头也认不出来时使用）。 */
const EXTENSION_FALLBACK: Record<string, FormatDescriptor> = {
  mov: { family: 'prores', label: 'QuickTime 素材（编码未识别）', vendorTool: null, ffmpegCanDecode: true },
  mxf: { family: 'mxf', label: 'MXF 素材', vendorTool: null, ffmpegCanDecode: true },
  r3d: {
    family: 'r3d',
    label: 'R3D（REDCODE RAW）',
    vendorTool: 'REDCINE-X PRO / REDline',
    ffmpegCanDecode: false
  },
  braw: {
    family: 'braw',
    label: 'BRAW（Blackmagic RAW）',
    vendorTool: 'Blackmagic RAW SDK / DaVinci Resolve',
    ffmpegCanDecode: false
  },
  ari: {
    family: 'arriraw',
    label: 'ARRIRAW',
    vendorTool: 'ARRIRAW Converter / ARRIRAW HDE Transcoder',
    ffmpegCanDecode: false
  },
  /* 佳能 Cinema RAW Light：扩展名无歧义，直接指向上面那份描述。
     它同样在可探测清单里 —— 探测能拿到时长/时码/分辨率，拿不到画面。 */
  crm: CANON_RAW,
  arx: {
    family: 'hde',
    label: 'HDE（ARRIRAW 高密度编码）',
    vendorTool: 'CODEX Device Manager / ARRIRAW HDE Transcoder',
    ffmpegCanDecode: false
  },
  dng: { family: 'cinema-dng', label: 'CinemaDNG', vendorTool: null, ffmpegCanDecode: true },
  cine: { family: 'cinema-dng', label: 'Cine 序列帧', vendorTool: null, ffmpegCanDecode: true },
  wav: { family: 'audio', label: 'WAV 音频', vendorTool: null, ffmpegCanDecode: true },
  bwf: { family: 'audio', label: 'BWF 音频', vendorTool: null, ffmpegCanDecode: true },
  aif: { family: 'audio', label: 'AIFF 音频', vendorTool: null, ffmpegCanDecode: true },
  aiff: { family: 'audio', label: 'AIFF 音频', vendorTool: null, ffmpegCanDecode: true },
  mp3: { family: 'audio', label: 'MP3 音频', vendorTool: null, ffmpegCanDecode: true },
  flac: { family: 'audio', label: 'FLAC 音频', vendorTool: null, ffmpegCanDecode: true },
  mp4: { family: 'generic', label: 'MP4 视频', vendorTool: null, ffmpegCanDecode: true },
  m4v: { family: 'generic', label: 'MP4 视频', vendorTool: null, ffmpegCanDecode: true },
  mkv: { family: 'generic', label: 'Matroska 视频', vendorTool: null, ffmpegCanDecode: true },
  webm: { family: 'generic', label: 'WebM 视频', vendorTool: null, ffmpegCanDecode: true },
  avi: { family: 'generic', label: 'AVI 视频', vendorTool: null, ffmpegCanDecode: true },
  mts: { family: 'generic', label: 'AVCHD 视频', vendorTool: null, ffmpegCanDecode: true },
  m2ts: { family: 'generic', label: 'AVCHD 视频', vendorTool: null, ffmpegCanDecode: true }
}

export function extensionOf(path: string): string {
  const lower = path.toLowerCase()
  const slash = lower.lastIndexOf('/')
  const dot = lower.lastIndexOf('.')
  // 点号位于路径开头（`.hidden`）或紧跟在目录分隔符之后（`Clips/.hidden`）时，
  // 它标记的是"隐藏文件"而不是扩展名。
  if (dot <= slash + 1) return ''
  return lower.slice(dot + 1)
}

/** 已知的容器 → 格式族。容器比流编码更能说明"这是什么素材"。 */
const CONTAINER_FAMILIES: [string, FormatDescriptor][] = [
  [
    'r3d',
    {
      family: 'r3d',
      label: 'R3D（REDCODE RAW）',
      vendorTool: 'REDCINE-X PRO / REDline',
      ffmpegCanDecode: false
    }
  ],
  [
    'braw',
    {
      family: 'braw',
      label: 'BRAW（Blackmagic RAW）',
      vendorTool: 'Blackmagic RAW SDK / DaVinci Resolve',
      ffmpegCanDecode: false
    }
  ]
]

/**
 * 高置信度扩展名。
 *
 * 这几个扩展名没有歧义 —— `.braw` 就是 Blackmagic RAW，`.R3D` 就是 REDCODE。
 * 但 ffprobe 会在这些文件里翻出**内嵌的预览 JPEG**并把它当成一路 MJPEG，
 * 于是报出 `format_name: mjpeg`。此时扩展名比 ffprobe 的结论更可信。
 */
const HIGH_CONFIDENCE_EXTENSIONS: Record<string, FormatDescriptor> = {
  r3d: EXTENSION_FALLBACK['r3d'] as FormatDescriptor,
  braw: EXTENSION_FALLBACK['braw'] as FormatDescriptor,
  ari: EXTENSION_FALLBACK['ari'] as FormatDescriptor,
  arx: EXTENSION_FALLBACK['arx'] as FormatDescriptor
}

/** 这些容器一旦被 ffprobe 认出来，就说明扩展名可能名不副实。 */
const STRONG_CONTAINERS = ['mov', 'mp4', 'm4a', 'mxf', 'matroska', 'avi', 'mpegts', 'asf']

/**
 * 依据 ffprobe 结果判定格式。
 *
 * **容器优先于流编码**，这一点非必需但不能错：
 * ffmpeg 的 r3d 解复用器会把文件里内嵌的预览图当成一路 MJPEG 流暴露出来，
 * 于是 `codec_name` 报的是 `mjpeg`、分辨率报的是预览图分辨率。
 * 只看流编码就会把一条 R3D 素材标成"MJPG 视频"，后期拿到报告会直接懵。
 *
 * ProRes 的 profile 名称来自 ffmpeg 的 `avcodec_profile_name`：
 * Proxy / LT / Standard / HQ / 4444 / 4444 XQ，以及 RAW / RAW HQ。
 */
export function formatFromFfprobe(
  codecName: string | null | undefined,
  profile: string | null | undefined,
  fallbackPath: string,
  formatName?: string | null,
  codecTag?: string | null
): FormatDescriptor {
  const container = (formatName ?? '').toLowerCase()
  for (const [needle, descriptor] of CONTAINER_FAMILIES) {
    if (container.includes(needle)) return descriptor
  }

  /*
   * 佳能 Cinema RAW Light：容器是 MOV（不会出现在上面的专用容器表里），
   * 所以必须靠画面轨的 fourcc 认它。
   *
   * 为什么不靠扩展名兜底代替：ffprobe 对 CRAW 连 `codec_name` 都不输出，
   * 于是下面的 codec 分支全部落空、最后靠扩展名拿到对的答案 —— 那是巧合。
   * 有了这条判定，无论 ffprobe 输出什么（缺字段、还是写成 "none"）都能认对。
   */
  if ((codecTag ?? '').toLowerCase() === CANON_RAW_CODEC_TAG) return CANON_RAW

  // 扩展名是高置信度私有格式，且 ffprobe 没认出任何"像样"的容器时，
  // 以扩展名为准：它翻到的多半只是文件里那张预览图。
  const highConfidence = HIGH_CONFIDENCE_EXTENSIONS[extensionOf(fallbackPath)]
  if (highConfidence !== undefined && !STRONG_CONTAINERS.some((name) => container.includes(name))) {
    return highConfidence
  }

  const rawCodec = (codecName ?? '').toLowerCase()
  /*
   * ffprobe 有时把"认不出编码"写成 `none` / `unknown` —— 那不是编码名。
   * 直接当编码名用会让报告上出现 `格式：none`，比留空更容易误导人，
   * 所以这里当成"没有信息"处理，交给后面的扩展名兜底。
   */
  const codec = rawCodec === 'none' || rawCodec === 'unknown' ? '' : rawCodec
  const prof = (profile ?? '').toLowerCase()

  if (codec === 'prores_raw') {
    return {
      family: 'prores-raw',
      label: prof.includes('hq') ? 'ProRes RAW HQ' : 'ProRes RAW',
      vendorTool: null,
      ffmpegCanDecode: true
    }
  }

  if (codec === 'prores') {
    // 防御性处理：某些版本会把 RAW 报成 prores + "RAW" profile
    if (prof.includes('raw')) {
      return {
        family: 'prores-raw',
        label: prof.includes('hq') ? 'ProRes RAW HQ' : 'ProRes RAW',
        vendorTool: null,
        ffmpegCanDecode: true
      }
    }
    const variants: [string, string][] = [
      ['proxy', 'ProRes 422 Proxy'],
      ['lt', 'ProRes 422 LT'],
      ['xq', 'ProRes 4444 XQ'],
      ['4444', 'ProRes 4444'],
      ['hq', 'ProRes 422 HQ'],
      ['standard', 'ProRes 422'],
      ['422', 'ProRes 422']
    ]
    for (const [needle, label] of variants) {
      if (prof.includes(needle)) {
        return { family: 'prores', label, vendorTool: null, ffmpegCanDecode: true }
      }
    }
    return {
      family: 'prores',
      label: profile == null || profile === '' ? 'ProRes（profile 未知）' : `ProRes（profile: ${profile}）`,
      vendorTool: null,
      ffmpegCanDecode: true
    }
  }

  if (codec === 'dnxhd') return { family: 'mxf', label: 'DNxHD / DNxHR', vendorTool: null, ffmpegCanDecode: true }
  if (codec === 'h264') return { family: 'generic', label: 'H.264', vendorTool: null, ffmpegCanDecode: true }
  if (codec === 'hevc') return { family: 'generic', label: 'HEVC / H.265', vendorTool: null, ffmpegCanDecode: true }
  if (codec === 'arriraw') return { family: 'arriraw', label: 'ARRIRAW', vendorTool: null, ffmpegCanDecode: true }
  if (codec === 'pcm_s16le' || codec === 'pcm_s24le') {
    return { family: 'audio', label: 'PCM 音频', vendorTool: null, ffmpegCanDecode: true }
  }
  if (codec !== '') {
    return { family: 'generic', label: codec, vendorTool: null, ffmpegCanDecode: true }
  }

  return fallbackByExtension(fallbackPath)
}

/**
 * 文件头特征识别（ffprobe 不可用时使用）。
 *
 * `icpf` 是 ProRes 帧头里固定的 4 字节标记，出现在 MOV/MXF 的最前面若干 MB 内；
 * R3D 文件以 `RED1` / `RED2` 开头。两者都是可靠信号，不是猜测。
 */
export function formatFromMagic(header: Buffer, path: string): FormatDescriptor | null {
  if (header.length >= 4) {
    const magic = header.subarray(0, 4).toString('latin1')
    if (magic === 'RED1' || magic === 'RED2') {
      return {
        family: 'r3d',
        label: 'R3D（REDCODE RAW）',
        vendorTool: 'REDCINE-X PRO / REDline',
        ffmpegCanDecode: false
      }
    }
  }

  // ProRes 帧头：4 字节长度 + 'icpf'
  const scanLimit = Math.min(header.length - 4, 4 * 1024 * 1024)
  for (let i = 0; i < scanLimit; i++) {
    if (
      header[i] === 0x69 && // i
      header[i + 1] === 0x63 && // c
      header[i + 2] === 0x70 && // p
      header[i + 3] === 0x66 // f
    ) {
      return { family: 'prores', label: 'ProRes', vendorTool: null, ffmpegCanDecode: true }
    }
  }

  return formatByExtensionOnly(path)
}

function formatByExtensionOnly(path: string): FormatDescriptor | null {
  const ext = extensionOf(path)
  return EXTENSION_FALLBACK[ext] ?? null
}

export function fallbackByExtension(path: string): FormatDescriptor {
  return formatByExtensionOnly(path) ?? GENERIC
}

/** 这个格式能不能用 ffmpeg 真解出画面帧。 */
export function canDecodeWithFfmpeg(family: MaterialFormat): boolean {
  switch (family) {
    case 'r3d':
    case 'braw':
    case 'arriraw':
    case 'canon-raw':
    case 'hde':
      return false
    default:
      return true
  }
}

/** 这个格式的文件内部通常内嵌了预览图（厂商给机内回放用的）。 */
export function usuallyHasEmbeddedPreview(family: MaterialFormat): boolean {
  return family === 'r3d' || family === 'braw' || family === 'arriraw'
}
