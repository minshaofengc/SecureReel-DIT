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
      ['a.ari', 'ARRI'],
      ['a.arx', 'CODEX']
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
  })
})
