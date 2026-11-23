/**
 * 首帧颜色还原的数学部分。
 *
 * 这些断言的作用不是"证明公式抄对了"（那要靠厂商文档），而是钉住三件
 * 容易在重构中悄悄坏掉的事：
 *   1. 编码/解码是互逆的 —— 写反一个符号，画面会整片发灰或死黑；
 *   2. 18% 中灰落在该曲线公认的码值上 —— 曲线张冠李戴时这里最先红；
 *   3. 色域矩阵是白点保持的（每行和为 1）—— 否则中性灰会被染色。
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOG_PROFILES } from '@shared/types'
import {
  autoLutFileName,
  buildCubeLut,
  detectLogProfile,
  encodeRec709,
  ensureAutoLut,
  frameVideoFilter,
  LOG_CURVES,
  looksLikeCube,
  lutFilter,
  matchLogKeyword,
  restoreChannel
} from '@main/media/color-restore'

describe('Log 曲线', () => {
  it.each(LOG_PROFILES)('%s 的 18%% 中灰落在公认码值上', (profile) => {
    const curve = LOG_CURVES[profile]
    expect(curve.encode(0.18)).toBeCloseTo(curve.middleGrayCode, 3)
  })

  it.each(LOG_PROFILES)('%s 的编码与解码互逆', (profile) => {
    const curve = LOG_CURVES[profile]
    for (const linear of [0.02, 0.18, 0.5, 0.9]) {
      expect(curve.decode(curve.encode(linear))).toBeCloseTo(linear, 5)
    }
  })

  it.each(LOG_PROFILES)('%s 的色域矩阵是白点保持的（每行和为 1）', (profile) => {
    const matrix = LOG_CURVES[profile].matrix
    for (let row = 0; row < 3; row++) {
      const sum =
        (matrix[row * 3] ?? 0) + (matrix[row * 3 + 1] ?? 0) + (matrix[row * 3 + 2] ?? 0)
      expect(sum).toBeCloseTo(1, 3)
    }
  })

  it('S-Log3 的 41 IRE 灰解码回 18% 线性', () => {
    expect(LOG_CURVES.slog3.decode(0.4106)).toBeCloseTo(0.18, 3)
  })
})

describe('Rec.709 OETF', () => {
  it('端点与单调性', () => {
    expect(encodeRec709(0)).toBe(0)
    expect(encodeRec709(1)).toBe(1)
    expect(encodeRec709(0.5)).toBeGreaterThan(encodeRec709(0.2))
    expect(encodeRec709(-1)).toBe(0)
    expect(encodeRec709(2)).toBe(1)
  })

  it('18% 线性映射到约 40.9% 的编码值', () => {
    // 这就是 Rec.709 的"中灰"：Log 灰片还原后应该落在这里
    expect(encodeRec709(0.18)).toBeCloseTo(0.409, 3)
  })
})

describe('还原链路', () => {
  it('S-Log3 的 18% 灰还原后仍是 709 中灰（不会越还原越灰）', () => {
    expect(restoreChannel('slog3', 0.4106)).toBeCloseTo(0.409, 2)
  })

  it('暗部被压下去 —— 这正是 Log 画面看起来"平"的原因', () => {
    // S-Log3 里 1% 反射率约在 0.24 码值，还原后应该明显低于 24%
    expect(restoreChannel('slog3', 0.24)).toBeLessThan(0.2)
  })
})

describe('.cube 生成', () => {
  it('头部字段齐全，数据行数 = size³', () => {
    const text = buildCubeLut('slog3', 3)
    const lines = text.trimEnd().split('\n')
    expect(lines[0]).toContain('TITLE')
    expect(lines[1]).toBe('LUT_3D_SIZE 3')
    expect(lines[2]).toBe('DOMAIN_MIN 0.0 0.0 0.0')
    expect(lines[3]).toBe('DOMAIN_MAX 1.0 1.0 1.0')
    expect(lines.length - 5).toBe(27)
  })

  it('中性灰输入输出三通道相等（矩阵不染色）', () => {
    const size = 3
    const text = buildCubeLut('slog3', size)
    const lines = text.trimEnd().split('\n')
    const mid = 1
    const row = lines[5 + mid * size * size + mid * size + mid] as string
    const [r, g, b] = row.split(' ').map(Number) as [number, number, number]
    expect(g).toBeCloseTo(r, 6)
    expect(b).toBeCloseTo(r, 6)
    // 与单通道还原结果一致：矩阵行和为 1，等值输入必然等值输出
    expect(r).toBeCloseTo(restoreChannel('slog3', 0.5), 4)
  })

  it('纯黑仍然是纯黑，纯白仍然是纯白', () => {
    const lines = buildCubeLut('logc3', 2).trimEnd().split('\n')
    const black = lines[5] as string
    const white = lines[lines.length - 1] as string
    expect(black.split(' ').map(Number)).toEqual([0, 0, 0])
    expect(white.split(' ').map(Number)).toEqual([1, 1, 1])
  })

  it('拒绝荒谬的尺寸', () => {
    expect(() => buildCubeLut('slog3', 1)).toThrow()
    expect(() => buildCubeLut('slog3', 65)).toThrow()
    expect(() => buildCubeLut('slog3', 3.5)).toThrow()
  })
})

describe('自动 LUT 缓存', () => {
  it('生成一次后复用同一个文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sr-lut-'))
    try {
      const first = await ensureAutoLut('vlog', dir, 5)
      expect(first).toBe(join(dir, autoLutFileName('vlog', 5)))
      const size = (await stat(first)).size
      expect(size).toBeGreaterThan(1024)

      const second = await ensureAutoLut('vlog', dir, 5)
      expect(second).toBe(first)
      expect((await stat(second)).size).toBe(size)
      expect(await looksLikeCube(first)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('非 .cube 文件不会被误认', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sr-lut-'))
    try {
      const notCube = join(dir, 'not-a-lut.cube')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(notCube, 'this is just a text file\n')
      expect(await looksLikeCube(notCube)).toBe(false)
      expect(await looksLikeCube(join(dir, 'missing.cube'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('Log 曲线识别', () => {
  it('从目录名与文件名里认曲线', () => {
    expect(matchLogKeyword('A001_SLOG3/C0001.mov')).toBe('slog3')
    expect(matchLogKeyword('VLOG_test.mp4')).toBe('vlog')
    expect(matchLogKeyword('CLIP_C-LOG3.mov')).toBe('clog3')
    expect(matchLogKeyword('B001_LOG3G10.mov')).toBe('log3g10')
    expect(matchLogKeyword('LOGC/ARRI_A001.mxf')).toBe('logc3')
  })

  it('C-Log3 不会被认成 LogC3（顺序错了就会）', () => {
    expect(matchLogKeyword('C-LOG3')).toBe('clog3')
    expect(matchLogKeyword('LOG-C3')).toBe('logc3')
  })

  it('认不出就返回 null，绝不瞎猜', () => {
    expect(matchLogKeyword('A001C001_240101.mov')).toBeNull()
    expect(matchLogKeyword('')).toBeNull()
  })

  it('路径优先于元数据；元数据 bt709 不构成 Log 线索', () => {
    expect(
      detectLogProfile({
        relPath: 'SLOG3/C0001.mov',
        colorTransfer: 'bt709',
        colorPrimaries: 'bt709'
      })
    ).toBe('slog3')
    expect(
      detectLogProfile({ relPath: 'A001/C0001.mov', colorTransfer: 'bt709', colorPrimaries: 'bt709' })
    ).toBeNull()
  })

  it('BT.2020 的 HDR 素材不当作 Log 还原', () => {
    expect(
      detectLogProfile({
        relPath: 'HDR_clip.mov',
        colorTransfer: 'arib-std-b67',
        colorPrimaries: 'bt2020'
      })
    ).toBeNull()
  })
})

describe('ffmpeg 滤镜', () => {
  it('Windows 盘符里的冒号必须转义，否则参数被截断', () => {
    expect(lutFilter('C:\\luts\\a.cube')).toBe("lut3d=file='C\\:/luts/a.cube'")
  })

  it('单引号也要转义', () => {
    expect(lutFilter("/tmp/it's.cube")).toBe("lut3d=file='/tmp/it\\'s.cube'")
  })

  it('不还原时只缩放，不挂 lut3d', () => {
    expect(frameVideoFilter({ width: 640, lutPath: null })).toBe('scale=640:-2')
    expect(frameVideoFilter({ width: 640, lutPath: '' })).toBe('scale=640:-2')
    expect(frameVideoFilter({ width: 640, lutPath: '/a.cube' })).toBe(
      "scale=640:-2,lut3d=file='/a.cube'"
    )
  })
})
