/**
 * 素材格式识别测试。
 *
 * 这里的每一条断言都对应一个真实存在的格式变体。
 * ProRes 家族有 7 种 profile，报告上把 "422 HQ" 标成 "4444" 是专业错误 ——
 * 后期拿到报告会按错误的码率规划存储。
 */
import { describe, expect, it } from 'vitest'
import {
  canDecodeWithFfmpeg,
  extensionOf,
  fallbackByExtension,
  formatFromFfprobe,
  formatFromMagic,
  usuallyHasEmbeddedPreview
} from '../src/main/media/formats'

describe('扩展名解析', () => {
  it.each([
    ['Clips/A001C001.mov', 'mov'],
    ['Clips/A001C001.R3D', 'r3d'],
    ['Clips/A001C001.braw', 'braw'],
    ['Clips/A001C001.BRAW', 'braw'],
    ['Sub.dir/name.with.dots.mxf', 'mxf'],
    ['no-extension', ''],
    ['dotfile', ''],
    ['.hidden', '']
  ])('%s → %s', (path, expected) => {
    expect(extensionOf(path)).toBe(expected)
  })

  it('点号在目录名里时不会误判', () => {
    expect(extensionOf('Sub.dir/noext')).toBe('')
  })
})

describe('ProRes 家族识别（依据 ffprobe 的 codec + profile）', () => {
  it.each([
    ['Proxy', 'ProRes 422 Proxy'],
    ['LT', 'ProRes 422 LT'],
    ['Standard', 'ProRes 422'],
    ['HQ', 'ProRes 422 HQ'],
    ['4444', 'ProRes 4444'],
    ['4444 XQ', 'ProRes 4444 XQ']
  ])('prores + %s → %s', (profile, expected) => {
    const result = formatFromFfprobe('prores', profile, '/x/clip.mov')
    expect(result.label).toBe(expected)
    expect(result.family).toBe('prores')
    expect(result.ffmpegCanDecode).toBe(true)
    expect(result.vendorTool).toBeNull()
  })

  it('4444 XQ 不会被误判成 4444', () => {
    expect(formatFromFfprobe('prores', '4444 XQ', '/x/a.mov').label).toBe('ProRes 4444 XQ')
  })

  it('HQ 不会被误判成 4444', () => {
    expect(formatFromFfprobe('prores', 'HQ', '/x/a.mov').label).toBe('ProRes 422 HQ')
  })
})

describe('ProRes RAW 识别', () => {
  it('prores_raw + RAW → ProRes RAW', () => {
    const result = formatFromFfprobe('prores_raw', 'RAW', '/x/clip.mov')
    expect(result.label).toBe('ProRes RAW')
    expect(result.family).toBe('prores-raw')
    expect(result.ffmpegCanDecode).toBe(true)
  })

  it('prores_raw + RAW HQ → ProRes RAW HQ', () => {
    const result = formatFromFfprobe('prores_raw', 'RAW HQ', '/x/clip.mov')
    expect(result.label).toBe('ProRes RAW HQ')
    expect(result.family).toBe('prores-raw')
  })

  it('某些 ffmpeg 版本把 RAW 报成 prores + RAW profile，也要认出来', () => {
    const result = formatFromFfprobe('prores', 'RAW', '/x/clip.mov')
    expect(result.family).toBe('prores-raw')
    expect(result.label).toContain('RAW')
  })
})

describe('其它编码', () => {
  it('H.264 / HEVC / DNxHD 都能给出可读名称', () => {
    expect(formatFromFfprobe('h264', 'High', '/x/a.mp4').label).toBe('H.264')
    expect(formatFromFfprobe('hevc', 'Main', '/x/a.mp4').label).toBe('HEVC / H.265')
    expect(formatFromFfprobe('dnxhd', 'DNxHR HQX', '/x/a.mxf').label).toBe('DNxHD / DNxHR')
  })

  it('PCM 音频被归到音频族', () => {
    expect(formatFromFfprobe('pcm_s24le', null, '/x/a.wav').family).toBe('audio')
  })

  it('未知编码原样使用 codec 名，不编造格式', () => {
    const result = formatFromFfprobe('some_new_codec', null, '/x/a.mov')
    expect(result.label).toBe('some_new_codec')
  })

  it('codec 为空时回退到扩展名', () => {
    const result = formatFromFfprobe(null, null, '/x/A003C001.R3D')
    expect(result.family).toBe('r3d')
    expect(result.label).toContain('REDCODE')
  })
})

describe('容器优先（这是踩过的真坑）', () => {
  it('R3D：ffprobe 报 mjpeg，但容器是 r3d，必须认成 R3D', () => {
    // ffmpeg 的 r3d 解复用器把文件内嵌的预览图当成 MJPEG 流暴露出来，
    // 只看 codec 会把一条 R3D 素材标成「MJPG 视频」
    const result = formatFromFfprobe('mjpeg', 'Baseline', '/x/A003C001.R3D', 'r3d')
    expect(result.family).toBe('r3d')
    expect(result.ffmpegCanDecode).toBe(false)
  })

  it('BRAW：ffprobe 认不出容器、只在里面翻到一张 JPEG 时，以扩展名为准', () => {
    const result = formatFromFfprobe('mjpeg', 'Baseline', '/x/A004C001.braw', 'mjpeg')
    expect(result.family).toBe('braw')
    expect(result.vendorTool).toContain('Blackmagic')
  })

  it('ARRI / HDE 扩展名同样享受高置信度', () => {
    expect(formatFromFfprobe('mjpeg', null, '/x/a.ari', 'image2').family).toBe('arriraw')
    expect(formatFromFfprobe(null, null, '/x/a.arx', null).family).toBe('hde')
  })

  it('ffprobe 认出真实容器时，不被扩展名带偏', () => {
    // 一个被误命名成 .braw 的普通 MOV：容器是 mov，应当信 ffprobe
    const result = formatFromFfprobe('h264', 'High', '/x/mislabeled.braw', 'mov,mp4,m4a,3gp,3g2,mj2')
    expect(result.family).toBe('generic')
    expect(result.label).toBe('H.264')
  })

  it('普通 MOV 里的 ProRes 不受扩展名逻辑影响', () => {
    const result = formatFromFfprobe('prores', 'HQ', '/x/clip.mov', 'mov,mp4,m4a,3gp,3g2,mj2')
    expect(result.label).toBe('ProRes 422 HQ')
  })
})

describe('文件头特征识别', () => {
  it('RED1 魔数被认成 R3D', () => {
    const header = Buffer.concat([Buffer.from('RED1', 'latin1'), Buffer.alloc(64, 0)])
    const result = formatFromMagic(header, '/x/whatever.bin')
    expect(result?.family).toBe('r3d')
    expect(result?.ffmpegCanDecode).toBe(false)
    expect(result?.vendorTool).toContain('REDCINE')
  })

  it('RED2 魔数同样被认成 R3D', () => {
    const header = Buffer.concat([Buffer.from('RED2', 'latin1'), Buffer.alloc(64, 0)])
    expect(formatFromMagic(header, '/x/a.R3D')?.family).toBe('r3d')
  })

  it('icpf 标记被认成 ProRes', () => {
    const header = Buffer.concat([Buffer.alloc(1024, 0), Buffer.from('icpf', 'latin1'), Buffer.alloc(64, 0)])
    const result = formatFromMagic(header, '/x/clip.mov')
    expect(result?.family).toBe('prores')
    expect(result?.ffmpegCanDecode).toBe(true)
  })

  it('认不出来时退回扩展名判断', () => {
    const header = Buffer.alloc(4096, 0)
    const result = formatFromMagic(header, '/x/A004C001.braw')
    expect(result?.family).toBe('braw')
    expect(result?.vendorTool).toContain('Blackmagic')
  })

  it('扩展名也认不出时返回 null，而不是编一个格式', () => {
    expect(formatFromMagic(Buffer.alloc(64, 0), '/x/mystery.dat')).toBeNull()
  })
})

describe('扩展名兜底表', () => {
  it('私有格式被明确标为「FFmpeg 无法解码」并给出官方工具', () => {
    for (const [file, tool] of [
      ['a.R3D', 'RED'],
      ['a.braw', 'Blackmagic'],
      ['a.ari', 'ARRIRAW'],
      ['a.arx', 'CODEX'],
      ['a.CRM', 'Canon']
    ] as const) {
      const result = fallbackByExtension(`/x/${file}`)
      expect(result.ffmpegCanDecode).toBe(false)
      expect(result.vendorTool).toContain(tool)
    }
  })

  it('常见交付格式标记为可解码', () => {
    for (const file of ['a.mov', 'a.mp4', 'a.mxf', 'a.wav', 'a.mkv']) {
      expect(fallbackByExtension(`/x/${file}`).ffmpegCanDecode).toBe(true)
    }
  })

  it('完全未知的扩展名落到 generic', () => {
    expect(fallbackByExtension('/x/a.xyz').family).toBe('generic')
  })
})

describe('能力查询', () => {
  it('私有格式不能靠 ffmpeg 解码', () => {
    expect(canDecodeWithFfmpeg('r3d')).toBe(false)
    expect(canDecodeWithFfmpeg('braw')).toBe(false)
    expect(canDecodeWithFfmpeg('arriraw')).toBe(false)
    expect(canDecodeWithFfmpeg('canon-raw')).toBe(false)
    expect(canDecodeWithFfmpeg('hde')).toBe(false)
  })

  it('ProRes 家族可以解码', () => {
    expect(canDecodeWithFfmpeg('prores')).toBe(true)
    expect(canDecodeWithFfmpeg('prores-raw')).toBe(true)
  })

  it('只有私有格式才预期带内嵌预览图', () => {
    expect(usuallyHasEmbeddedPreview('r3d')).toBe(true)
    expect(usuallyHasEmbeddedPreview('braw')).toBe(true)
    expect(usuallyHasEmbeddedPreview('prores')).toBe(false)
    // 佳能 CRM 的预览图结构未核实过，所以**不**声称有 —— 宁缺勿错
    expect(usuallyHasEmbeddedPreview('canon-raw')).toBe(false)
  })
})

/**
 * 佳能 Cinema RAW Light（.CRM）—— 已登记命名，**也探测参数，但不解画面**。
 *
 * 边界要说清楚（实测自一条 1 GB 的 R5 C 素材）：
 *   有：格式名、分辨率、时长、时码、拍摄时间（ffprobe 读容器，0.01 秒）
 *   没有：画面 —— ffmpeg 无 CRAW 解码器，且文件里也没有内嵌预览图
 *
 * ⚠️ 两条容易踩的边界：
 *   1. 不能只靠扩展名兜底认它。ffprobe 对 CRAW **连 codec_name 都不输出**，
 *      靠扩展名拿到对答案是巧合；必须显式认 fourcc。
 *   2. 认不出编码时，ffprobe 可能给 `none` / `unknown` —— 那不是格式名，
 *      直接写进报告会变成「格式：none」，比留空更误导。
 */
describe('Canon Cinema RAW Light（.CRM）', () => {
  it('兜底表认识 crm，给出可读格式名与官方工具', () => {
    const format = fallbackByExtension('/x/CONTENTS/CLIPS001/A001C001.CRM')
    expect(format.family).toBe('canon-raw')
    expect(format.label).toContain('Cinema RAW Light')
    expect(format.vendorTool).toContain('Canon')
    // 没有解码器 —— 这一条决定了它永远不会有首帧
    expect(format.ffmpegCanDecode).toBe(false)
  })

  it('大写扩展名同样识别（卡片里的文件名常常是全大写）', () => {
    expect(fallbackByExtension('/x/A001C001.CRM').family).toBe('canon-raw')
  })

  it('靠画面轨 fourcc（CRAW）识别，不依赖 codec_name 恰好缺席', () => {
    // 真实 CRM：容器是 MOV，画面轨 fourcc 是 CRAW，ffprobe 不给 codec_name
    const missing = formatFromFfprobe(
      undefined,
      null,
      '/x/A001C001.CRM',
      'mov,mp4,m4a,3gp,3g2,mj2',
      'CRAW'
    )
    expect(missing.family).toBe('canon-raw')
    // 就算某个 ffmpeg 版本把它写成 "none"，也必须认对
    const named = formatFromFfprobe('none', null, '/x/A001C001.CRM', 'mov,mp4,m4a,3gp,3g2,mj2', 'CRAW')
    expect(named.family).toBe('canon-raw')
    expect(named.label).toContain('Cinema RAW Light')
  })

  it('认不出编码时，不会把 none / unknown 当成格式名写进报告', () => {
    for (const bogus of ['none', 'unknown']) {
      const format = formatFromFfprobe(bogus, null, '/x/strange.xyz', 'mov,mp4,m4a,3gp,3g2,mj2')
      expect(format.label).not.toBe('none')
      expect(format.label).not.toBe('unknown')
    }
  })

  it('是 MOV 容器但编码认不出来时，也不会误判成 ProRes', () => {
    // 猜错码率会让后期按错误规格规划存储
    const format = formatFromFfprobe('none', null, '/x/A001C001.CRM', 'mov,mp4,m4a,3gp,3g2,mj2')
    expect(format.family).not.toBe('prores')
    expect(format.family).not.toBe('prores-raw')
  })

  it('文件头里没有 RED 魔数也没有 ProRes 的 icpf —— 认不出编码，于是靠扩展名兜底', () => {
    const header = Buffer.alloc(64, 0x11)
    header.write('ftypcrx ', 0, 'latin1')
    const format = formatFromMagic(header, '/x/A001C001.CRM')
    // 落到扩展名兜底，而 crm 已登记 —— 这是登记过的名字，不是猜出来的
    expect(format?.family).toBe('canon-raw')
  })

  it('真·未知的扩展名才返回 null —— 宁可空着，也不编一个格式名', () => {
    const header = Buffer.alloc(64, 0x11)
    expect(formatFromMagic(header, '/x/A001C001.xyz')).toBeNull()
  })
})
