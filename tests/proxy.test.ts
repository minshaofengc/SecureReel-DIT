/**
 * 代理生成的纯函数契约。
 *
 * 这里钉几件最容易悄悄坏掉、又不需要真跑 ffmpeg 的事：
 *   1. **规格 → profile 数值的映射**（写错一个数就会出成别的规格，
 *      而且是"能跑通、结果不对"那种坏法）；
 *   2. **分辨率 → scale 表达式**（只降不升是**需求**，不是实现细节）；
 *   3. **编码 → `-c:v` 与 pix_fmt**（ProRes 与硬件编码器参数不能混用）；
 *   4. **输出路径的推导**（同名素材不能互相覆盖、扩展名随编码变）。
 *
 * 真正的编码不在这里测 —— 那是 verify:pipeline 端到端的事。
 */
import { describe, expect, it } from 'vitest'
import {
  buildProxyArgs,
  buildVideoFilter,
  escapeFilterPath,
  PROXY_CODEC_LABEL,
  PROXY_FOLDER,
  PROXY_PROFILE_LABEL,
  proxyAbsPathFor,
  proxyExtensionFor,
  proxyRelPathFor
} from '../src/main/media/proxy'
import { PROXY_CODECS, PROXY_PROFILES, PROXY_RESOLUTIONS, type ProxyProfile } from '../src/shared/types'

/** 默认参数：ProRes + 1080p，方便各用例只覆盖自己关心的那一维。 */
const base = { profile: '422-proxy' as ProxyProfile, resolution: '1080p' as const, codec: 'prores' as const }

describe('代理规格 → profile 数值', () => {
  const expected: Record<ProxyProfile, string> = {
    '422-proxy': '0',
    '422-lt': '1',
    '422': '2',
    '422-hq': '3'
  }

  it('每一种规格都映射到 Apple 官方的 profile 编号', () => {
    for (const profile of PROXY_PROFILES) {
      const args = buildProxyArgs('/in.mov', '/out.mov', { ...base, profile })
      const idx = args.indexOf('-profile:v')
      expect(idx).toBeGreaterThan(-1)
      expect(args[idx + 1]).toBe(expected[profile])
    }
  })

  it('每一种规格都有面向用户的标签', () => {
    for (const profile of PROXY_PROFILES) {
      expect(PROXY_PROFILE_LABEL[profile]).toMatch(/ProRes 422/)
    }
  })

  it('用 prores_ks 编码器、pix_fmt 是 10 位 422', () => {
    const args = buildProxyArgs('/in.mov', '/out.mov', base)
    const codecIdx = args.indexOf('-c:v')
    expect(args[codecIdx + 1]).toBe('prores_ks')
    const pixIdx = args.indexOf('-pix_fmt')
    expect(args[pixIdx + 1]).toBe('yuv422p10le')
  })

  it('音频转成 PCM 16-bit，且输入输出都是独立参数（不会被 shell 解释）', () => {
    const args = buildProxyArgs('/path with spaces/in.mov', '/out dir/out.mov', { ...base, profile: '422' })
    const audioIdx = args.indexOf('-c:a')
    expect(args[audioIdx + 1]).toBe('pcm_s16le')
    // 带空格的路径作为**单个数组元素**出现，不拼接、不引号
    expect(args).toContain('/path with spaces/in.mov')
    expect(args).toContain('/out dir/out.mov')
  })
})

describe('分辨率 → scale 表达式（只降不升）', () => {
  const heightOf: Record<(typeof PROXY_RESOLUTIONS)[number], number> = {
    '1080p': 1080,
    '1440p': 1440,
    '4k': 2160
  }

  it('每种分辨率都给出 min(ih,H) 的 scale 表达式', () => {
    for (const resolution of PROXY_RESOLUTIONS) {
      const args = buildProxyArgs('/in.mov', '/out.mov', { ...base, resolution })
      const idx = args.indexOf('-vf')
      expect(idx).toBeGreaterThan(-1)
      expect(args[idx + 1]).toBe(`scale=-2:'min(ih,${heightOf[resolution]})'`)
    }
  })

  it('宽用 -2 让它按比例取偶', () => {
    const args = buildProxyArgs('/in.mov', '/out.mov', base)
    const filter = args[args.indexOf('-vf') + 1] ?? ''
    expect(filter.startsWith('scale=-2:')).toBe(true)
  })
})

describe('LUT（lut3d 滤镜链）', () => {
  it('不传 LUT 时 -vf 只有 scale', () => {
    const args = buildProxyArgs('/in.mov', '/out.mov', base)
    expect(args[args.indexOf('-vf') + 1]).toBe("scale=-2:'min(ih,1080)'")
  })

  it('传了 LUT 时在 scale 之后挂 lut3d', () => {
    const args = buildProxyArgs('/in.mov', '/out.mov', { ...base, lutPath: '/Users/x/Show.cube' })
    const filter = args[args.indexOf('-vf') + 1] ?? ''
    // 参数名是 file=（实测 filename= 会报 Option not found）
    expect(filter).toContain("lut3d=file='")
    expect(filter).toContain('/Users/x/Show.cube')
    // 顺序：scale 在前、lut3d 在后
    expect(filter.indexOf('scale=')).toBeLessThan(filter.indexOf('lut3d='))
  })

  it('空串 LUT 视为不套', () => {
    const args = buildProxyArgs('/in.mov', '/out.mov', { ...base, lutPath: '   ' })
    expect(args[args.indexOf('-vf') + 1]).not.toContain('lut3d')
  })
})

describe('escapeFilterPath（滤镜路径转义）', () => {
  it('Windows 盘符的冒号被转义，否则会被当成滤镜参数分隔符', () => {
    expect(escapeFilterPath('C:\\LUTs\\a.cube')).toBe("C\\:/LUTs/a.cube")
  })

  it('反斜杠统一成正斜杠', () => {
    expect(escapeFilterPath('a\\b\\c.cube')).toBe('a/b/c.cube')
  })

  it('单引号被转义', () => {
    expect(escapeFilterPath("/x/it's.cube")).toBe("/x/it\\'s.cube")
  })

  it('POSIX 路径原样保留（仅正斜杠）', () => {
    expect(escapeFilterPath('/Users/x/Show.cube')).toBe('/Users/x/Show.cube')
  })
})

describe('buildVideoFilter（-vf 链）', () => {
  it('无 LUT 时只返回 scale', () => {
    expect(buildVideoFilter('1080p', null)).toBe("scale=-2:'min(ih,1080)'")
    expect(buildVideoFilter('4k', undefined)).toBe("scale=-2:'min(ih,2160)'")
  })

  it('有 LUT 时把转义后的路径拼进 lut3d', () => {
    const filter = buildVideoFilter('1080p', 'C:\\LUTs\\a.cube')
    expect(filter).toBe("scale=-2:'min(ih,1080)',lut3d=file='C\\:/LUTs/a.cube'")
  })
})

describe('编码分支', () => {
  it('H.264 用传入的硬件编码器，pix_fmt 走 yuv420p', () => {
    const args = buildProxyArgs('/in.mov', '/out.mp4', {
      ...base,
      codec: 'h264',
      encoder: 'h264_nvenc'
    })
    expect(args[args.indexOf('-c:v') + 1]).toBe('h264_nvenc')
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p')
    // 硬件编码器不该出现 ProRes 的 profile 参数
    expect(args).not.toContain('-profile:v')
  })

  it('H.265 用传入的硬件编码器', () => {
    const args = buildProxyArgs('/in.mov', '/out.mp4', {
      ...base,
      codec: 'h265',
      encoder: 'hevc_qsv'
    })
    expect(args[args.indexOf('-c:v') + 1]).toBe('hevc_qsv')
  })

  it('每种编码都有面向用户的标签', () => {
    for (const codec of PROXY_CODECS) {
      expect(PROXY_CODEC_LABEL[codec].length).toBeGreaterThan(0)
    }
  })

  it('ProRes 走 .mov，H.264/H.265 走 .mp4', () => {
    expect(proxyExtensionFor('prores')).toBe('mov')
    expect(proxyExtensionFor('h264')).toBe('mp4')
    expect(proxyExtensionFor('h265')).toBe('mp4')
  })
})

describe('代理输出路径推导', () => {
  it('落在 Proxies/ 下并保留源目录结构', () => {
    expect(proxyRelPathFor('Clips/A001/C001.mov')).toBe('Proxies/Clips/A001/C001.mov')
  })

  it('ProRes 扩展名统一成 .mov', () => {
    expect(proxyRelPathFor('a.mxf')).toBe('Proxies/a.mov')
    expect(proxyRelPathFor('a.mp4')).toBe('Proxies/a.mov')
  })

  it('H.264/H.265 扩展名是 .mp4', () => {
    expect(proxyRelPathFor('a.mxf', 'h264')).toBe('Proxies/a.mp4')
    expect(proxyRelPathFor('a.mov', 'h265')).toBe('Proxies/a.mp4')
  })

  it('没有扩展名的素材也给出合法路径', () => {
    expect(proxyRelPathFor('raw/clip')).toBe('Proxies/raw/clip.mov')
  })

  it('同名不同目录的素材不会互相覆盖', () => {
    const a = proxyRelPathFor('A001/C001.mov')
    const b = proxyRelPathFor('A002/C001.mov')
    expect(a).not.toBe(b)
  })

  it('目标盘绝对路径 = 盘根 + 相对路径', () => {
    const abs = proxyAbsPathFor('/Volumes/A001', 'Clips/C001.mov')
    expect(abs).toBe(`/Volumes/A001/${PROXY_FOLDER}/Clips/C001.mov`)
  })

  it('按编码给出不同的绝对路径扩展名', () => {
    expect(proxyAbsPathFor('/Volumes/A001', 'Clips/C001.mov', 'h264')).toBe(
      `/Volumes/A001/${PROXY_FOLDER}/Clips/C001.mp4`
    )
  })
})
