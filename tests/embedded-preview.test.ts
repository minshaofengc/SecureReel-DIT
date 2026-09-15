/**
 * 内嵌预览图提取测试。
 *
 * 这里的核心不是"能不能找到一张 JPEG"，而是**能不能找对边界**。
 * 朴素做法是扫描到 `FFD9` 就认为图结束 —— 但 EXIF 里经常内嵌缩略图，
 * 缩略图本身也是完整 JPEG，朴素扫描会在缩略图的 EOI 处提前截断，
 * 得到一个残缺的半张图，而且**看起来还能"提取成功"**，特别难发现。
 *
 * 所以第一个用例就是专门针对这个陷阱的。
 *
 * 注意：本文件里的 JPEG 是**按结构手工拼出来的**，用于验证解析逻辑
 * （段遍历、尺寸解析、候选挑选）。真实解码由端到端验证负责，
 * 那边用的是 Electron 图像编码器产出的真 JPEG。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractEmbeddedPreview,
  findJpegEnd,
  findJpegSpans,
  parseJpegSize,
  pickBestPreview
} from '../src/main/media/embedded-preview'

/* ------------------------------------------------------------------ *
 * 测试用 JPEG 构造器
 * ------------------------------------------------------------------ */

const SOI = Buffer.from([0xff, 0xd8])
const EOI = Buffer.from([0xff, 0xd9])

/** 一个带长度字段的段：FF marker len(2) payload。 */
function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head[0] = 0xff
  head[1] = marker
  head.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([head, payload])
}

/** SOF0 段：precision(1) height(2) width(2) components(1) [id, sampling, qtable]。 */
function sof0(width: number, height: number): Buffer {
  const payload = Buffer.alloc(6 + 3)
  payload[0] = 8
  payload.writeUInt16BE(height, 1)
  payload.writeUInt16BE(width, 3)
  payload[5] = 1
  payload[6] = 1
  payload[7] = 0x11
  payload[8] = 0
  return segment(0xc0, payload)
}

/** SOS 段，后面接熵编码数据。 */
function sos(): Buffer {
  const payload = Buffer.from([1, 1, 0, 0, 63, 0])
  return segment(0xda, payload)
}

/** 熵编码数据：不含 0xFF，避免被误认成标记。 */
function entropy(bytes: number): Buffer {
  return Buffer.alloc(bytes, 0x5a)
}

interface BuildOptions {
  /** 在 APP1 里内嵌一张完整的小 JPEG（模拟 EXIF 缩略图） */
  withExifThumbnail?: boolean
  /** 熵编码数据长度 */
  dataBytes?: number
}

function buildJpeg(width: number, height: number, options: BuildOptions = {}): Buffer {
  const parts: Buffer[] = [SOI]

  // APP0 JFIF
  parts.push(
    segment(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]))
  )

  if (options.withExifThumbnail === true) {
    // APP1 里塞一张完整的 160×120 缩略图（自己带 SOI/EOI）——
    // 这就是会骗过朴素扫描的结构
    const thumb = Buffer.concat([SOI, sof0(160, 120), sos(), entropy(256), EOI])
    const exifHeader = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from([0, 0])])
    parts.push(segment(0xe1, Buffer.concat([exifHeader, thumb])))
  }

  // DQT
  parts.push(segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])))

  parts.push(sof0(width, height))
  parts.push(sos())
  parts.push(entropy(options.dataBytes ?? 6000))
  parts.push(EOI)

  return Buffer.concat(parts)
}

/* ------------------------------------------------------------------ */

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'securereel-preview-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('JPEG 段遍历', () => {
  it('结束位置落在真正的 EOI 上', () => {
    const jpeg = buildJpeg(1920, 1080)
    expect(findJpegEnd(jpeg, 0)).toBe(jpeg.length)
  })

  it('EXIF 里内嵌缩略图时，不会在缩略图的 EOI 处提前截断', () => {
    const plain = buildJpeg(1920, 1080)
    const withThumb = buildJpeg(1920, 1080, { withExifThumbnail: true })

    const end = findJpegEnd(withThumb, 0)
    expect(end).toBe(withThumb.length)

    // 缩略图的 EOI 位置应当明显早于整张图的结束位置
    const thumbEoi = withThumb.indexOf(EOI, 20)
    expect(thumbEoi).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(thumbEoi + 100)

    // 朴素做法的结果会明显偏小 —— 用这个差值把陷阱钉住
    expect(end - plain.length).toBeGreaterThan(200)
  })

  it('结构损坏时返回 -1 而不是瞎猜一个位置', () => {
    const broken = Buffer.concat([SOI, Buffer.from([0xff, 0xc0, 0x00, 0x01])])
    expect(findJpegEnd(broken, 0)).toBe(-1)
  })

  it('能从一坨垃圾数据里找出所有完整 JPEG', () => {
    const junk = Buffer.alloc(1024, 0x33)
    const a = buildJpeg(640, 480, { dataBytes: 5000 })
    const b = buildJpeg(800, 600, { dataBytes: 5000 })
    const buffer = Buffer.concat([junk, a, junk, b, junk])

    const spans = findJpegSpans(buffer)
    expect(spans).toHaveLength(2)
    const s0 = spans[0]!
    const s1 = spans[1]!
    expect(s0.end - s0.start).toBe(a.length)
    expect(s1.end - s1.start).toBe(b.length)
  })
})

describe('尺寸解析', () => {
  it.each([
    [1920, 1080],
    [640, 360],
    [4096, 2160],
    [64, 64]
  ])('正确读出 %i×%i', (width, height) => {
    const jpeg = buildJpeg(width, height)
    const spans = findJpegSpans(jpeg)
    expect(spans).toHaveLength(1)
    expect(parseJpegSize(jpeg, spans[0]!)).toEqual({ width, height })
  })

  it('读到的是外层图的尺寸，不是内嵌缩略图的尺寸', () => {
    const jpeg = buildJpeg(3840, 2160, { withExifThumbnail: true })
    const spans = findJpegSpans(jpeg)
    // 外层是唯一的候选（缩略图整段都在 APP1 里被跳过了）
    expect(spans).toHaveLength(1)
    expect(parseJpegSize(jpeg, spans[0]!)).toEqual({ width: 3840, height: 2160 })
  })
})

describe('候选挑选', () => {
  it('多张图时挑最大的那张', () => {
    const small = buildJpeg(320, 180, { dataBytes: 4200 })
    const large = buildJpeg(1920, 1080, { dataBytes: 40000 })
    const buffer = Buffer.concat([small, Buffer.alloc(64, 0), large])

    const best = pickBestPreview(buffer)
    expect(best).not.toBeNull()
    expect(best?.width).toBe(1920)
    expect(best?.height).toBe(1080)
  })

  it('尺寸过小的图被过滤掉（EXIF 缩略图这类）', () => {
    const tiny = buildJpeg(32, 32, { dataBytes: 5000 })
    expect(pickBestPreview(tiny)).toBeNull()
  })

  it('体积过小的图被过滤掉', () => {
    const tooSmall = buildJpeg(1920, 1080, { dataBytes: 100 })
    expect(pickBestPreview(tooSmall)).toBeNull()
  })

  it('完全没有 JPEG 时返回 null', () => {
    expect(pickBestPreview(Buffer.alloc(8192, 0x7f))).toBeNull()
  })
})

describe('从文件读取内嵌预览', () => {
  it('从带魔数头的文件里取出预览图', async () => {
    const jpeg = buildJpeg(512, 288, { dataBytes: 8000 })
    const file = join(root, 'A003C001.R3D')
    await writeFile(
      file,
      Buffer.concat([Buffer.from('RED1', 'latin1'), Buffer.alloc(128 * 1024, 0x11), jpeg, Buffer.alloc(4096, 0x22)])
    )

    const preview = await extractEmbeddedPreview(file)
    expect(preview).not.toBeNull()
    expect(preview?.width).toBe(512)
    expect(preview?.height).toBe(288)
    expect(preview?.offset).toBe(4 + 128 * 1024)
    // 取出来的必须逐字节等于原始那张图
    expect(preview?.jpeg.equals(jpeg)).toBe(true)
  })

  it('预览图放在靠后位置时，第二遍扫描能捞到', async () => {
    const jpeg = buildJpeg(384, 216, { dataBytes: 8000 })
    const file = join(root, 'far.braw')
    // 放在 10 MiB 之后 —— 超出第一遍 8 MiB 的窗口
    await writeFile(file, Buffer.concat([Buffer.alloc(10 * 1024 * 1024, 0x33), jpeg]))

    const preview = await extractEmbeddedPreview(file)
    expect(preview).not.toBeNull()
    expect(preview?.width).toBe(384)
  }, 30_000)

  it('文件里没有预览图时返回 null', async () => {
    const file = join(root, 'empty.braw')
    await writeFile(file, Buffer.alloc(256 * 1024, 0x00))
    expect(await extractEmbeddedPreview(file)).toBeNull()
  })

  it('文件小于一个扫描窗口也能正常工作', async () => {
    const jpeg = buildJpeg(256, 144, { dataBytes: 5000 })
    const file = join(root, 'tiny.r3d')
    await writeFile(file, Buffer.concat([Buffer.from('RED1', 'latin1'), jpeg]))

    const preview = await extractEmbeddedPreview(file)
    expect(preview).not.toBeNull()
    expect(preview?.jpeg.equals(jpeg)).toBe(true)
  })

  it('返回的缓冲区不指向大文件缓冲（避免整块内存被吊住）', async () => {
    const jpeg = buildJpeg(640, 360, { dataBytes: 8000 })
    const file = join(root, 'detached.R3D')
    await writeFile(file, Buffer.concat([Buffer.alloc(1024 * 1024, 0x44), jpeg]))

    const preview = await extractEmbeddedPreview(file)
    expect(preview).not.toBeNull()
    // 复制过的话 byteOffset 必然为 0，而切片会带一个非零偏移
    expect(preview?.jpeg.byteOffset).toBe(0)
    expect(preview?.jpeg.equals(jpeg)).toBe(true)
  })

  it('读不存在的文件时抛错而不是静默返回 null', async () => {
    await expect(extractEmbeddedPreview(join(root, 'missing.r3d'))).rejects.toThrow()
  })

  it('已取消时立刻返回 null', async () => {
    const file = join(root, 'cancel.r3d')
    await writeFile(file, Buffer.alloc(64 * 1024, 0x00))
    const controller = new AbortController()
    controller.abort()
    expect(await extractEmbeddedPreview(file, { signal: controller.signal })).toBeNull()
  })
})

describe('句柄清理', () => {
  it('多次调用不会泄漏文件句柄', async () => {
    const jpeg = buildJpeg(320, 180, { dataBytes: 5000 })
    const file = join(root, 'handles.r3d')
    await writeFile(file, jpeg)

    for (let i = 0; i < 40; i++) {
      await extractEmbeddedPreview(file)
    }

    // 能重新独占打开说明前面的句柄都关了
    const handle = await open(file, 'r')
    await handle.close()
    expect(true).toBe(true)
  })
})
