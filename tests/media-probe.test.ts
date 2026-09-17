/**
 * 媒体探测器的行为契约测试。
 *
 * 最重要的一条契约是：**probe() 永不抛错**。
 * 一条读不动的素材、一个损坏的文件、一个格式诡异的卡 ——
 * 这些都只该让报告少几行元数据，绝不能让整个任务的素材分析阶段炸掉。
 *
 * 这些用例不依赖 ffmpeg 是否安装：合成素材是"魔数 + 内嵌预览图"的结构，
 * 装了 ffprobe 的机器上它会解析失败并走内嵌预览回退路径；
 * 没装的机器上直接走文件头识别 —— 两条路的结果应当一致。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FfprobeRunner, isProbeable, isVideoLike } from '../src/main/media/probe'
import { Logger } from '../src/main/logger'

let root = ''
let framesDir = ''
let runner: FfprobeRunner

/* ---------------- 合成素材 ---------------- */

const SOI = Buffer.from([0xff, 0xd8])
const EOI = Buffer.from([0xff, 0xd9])

function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head[0] = 0xff
  head[1] = marker
  head.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([head, payload])
}

function buildJpeg(width: number, height: number, dataBytes = 8000): Buffer {
  const sof = Buffer.alloc(9)
  sof[0] = 8
  sof.writeUInt16BE(height, 1)
  sof.writeUInt16BE(width, 3)
  sof[5] = 1
  sof[6] = 1
  sof[7] = 0x11
  const sos = Buffer.alloc(6)
  sos[0] = 1
  sos[1] = 1
  sos[5] = 0
  return Buffer.concat([
    SOI,
    segment(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(9)])),
    segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    segment(0xc0, sof),
    segment(0xda, sos),
    Buffer.alloc(dataBytes, 0x5a),
    EOI
  ])
}

function buildVendorFile(magic: string, jpeg: Buffer, pad: number): Buffer {
  return Buffer.concat([Buffer.from(magic, 'latin1'), Buffer.alloc(pad, 0x11), jpeg, Buffer.alloc(4096, 0x22)])
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'securereel-probe-'))
  framesDir = join(root, 'frames')
  await mkdir(framesDir, { recursive: true })
  runner = new FfprobeRunner({ logger: new Logger({ dir: '' }), userDir: null, bundledDir: null })
  await runner.refresh()
  runner.setFrameOutputDir(framesDir)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('探测范围判定', () => {
  it.each(['a.mov', 'a.mxf', 'a.R3D', 'a.braw', 'a.ari', 'a.arx', 'a.wav', 'a.mp4'])(
    '%s 会被探测',
    (name) => {
      expect(isProbeable(name)).toBe(true)
    }
  )

  it.each(['a.txt', 'a.pdf', 'a.xml', 'a', 'a.mhl'])('%s 不会被探测', (name) => {
    expect(isProbeable(name)).toBe(false)
  })

  it('音频不算视频，不会去提首帧', () => {
    expect(isVideoLike('a.wav')).toBe(false)
    expect(isVideoLike('a.mov')).toBe(true)
    expect(isVideoLike('a.R3D')).toBe(true)
  })
})

describe('私有格式（R3D / BRAW）：首帧取自内嵌预览', () => {
  it.each([
    ['A003C001.R3D', 'RED1', 'r3d'],
    ['A004C001.braw', '\u0000\u0000\u0000\u0008', 'braw']
  ])('%s 被识别为 %s 并取到首帧', async (fileName, magic, family) => {
    const jpeg = buildJpeg(512, 288)
    const file = join(root, fileName)
    await writeFile(file, buildVendorFile(magic, jpeg, 128 * 1024))

    const probe = await runner.probe(file, { extractFrames: true })

    expect(probe.available).toBe(true)
    expect(probe.formatFamily).toBe(family)
    expect(probe.frameSource).toBe('embedded-preview')
    expect(probe.firstFrame).not.toBeNull()
    // 预览图分辨率被当作画面尺寸填进去
    expect(probe.width).toBe(512)
    expect(probe.height).toBe(288)
    // 必须明确告知"这不是解码出来的"，并指出需要哪个官方工具
    expect(probe.note).toContain('预览图')
    expect(probe.vendorTool).not.toBeNull()

    // 写出来的必须是一张真 JPEG，而且与原始内嵌数据逐字节一致
    const written = await readFile(join(framesDir, probe.firstFrame as string))
    expect(written[0]).toBe(0xff)
    expect(written[1]).toBe(0xd8)
    expect(written.equals(jpeg)).toBe(true)
  })

  it('关闭首帧提取时不写文件，并说明原因', async () => {
    const jpeg = buildJpeg(320, 180)
    const file = join(root, 'off.R3D')
    await writeFile(file, buildVendorFile('RED1', jpeg, 64 * 1024))

    const probe = await runner.probe(file, { extractFrames: false })

    expect(probe.firstFrame).toBeNull()
    expect(probe.frameSource).toBe('none')
    expect(probe.note).toContain('未提取首帧')
  })

  it('文件里没有内嵌预览时不崩，只是取不到帧', async () => {
    const file = join(root, 'nopreview.R3D')
    await writeFile(file, Buffer.concat([Buffer.from('RED1', 'latin1'), Buffer.alloc(256 * 1024, 0x00)]))

    const probe = await runner.probe(file, { extractFrames: true })

    expect(probe.formatFamily).toBe('r3d')
    expect(probe.firstFrame).toBeNull()
    expect(probe.note).toContain('未能取到首帧')
  })
})

describe('不抛错的契约', () => {
  it('文件不存在时返回不可用，而不是抛错', async () => {
    const probe = await runner.probe(join(root, 'does-not-exist.mov'), { extractFrames: true })
    expect(probe.available).toBe(false)
    expect(probe.reason).not.toBeNull()
  })

  it('空文件不会让探测崩溃', async () => {
    const file = join(root, 'empty.mov')
    await writeFile(file, Buffer.alloc(0))
    const probe = await runner.probe(file, { extractFrames: true })
    expect(typeof probe.available).toBe('boolean')
  })

  it('内容是垃圾数据时不会崩溃', async () => {
    const file = join(root, 'garbage.mov')
    await writeFile(file, Buffer.alloc(512 * 1024, 0xab))
    const probe = await runner.probe(file, { extractFrames: true })
    expect(typeof probe.available).toBe('boolean')
  })

  it('目录当成文件探测时不崩溃', async () => {
    const dir = join(root, 'adir.mov')
    await mkdir(dir, { recursive: true })
    const probe = await runner.probe(dir, { extractFrames: true })
    // 有的平台会成功 stat，有的不会；两种都算合格，只要不抛错
    expect(typeof probe.available).toBe('boolean')
  })

  it('已取消时不去读文件', async () => {
    const jpeg = buildJpeg(320, 180)
    const file = join(root, 'cancel.R3D')
    await writeFile(file, buildVendorFile('RED1', jpeg, 64 * 1024))

    const controller = new AbortController()
    controller.abort()
    const probe = await runner.probe(file, { extractFrames: true, signal: controller.signal })
    expect(probe.firstFrame).toBeNull()
  })
})

describe('不可探测的类型', () => {
  it('文本文件直接返回说明，不做任何读取', async () => {
    const file = join(root, 'notes.txt')
    await writeFile(file, 'hello')
    const probe = await runner.probe(file, { extractFrames: true })
    expect(probe.available).toBe(false)
    expect(probe.reason).toContain('仅记录文件级哈希')
    expect(probe.formatFamily).toBe('generic')
  })
})

/**
 * 佳能 Cinema RAW Light（EOS R5 C / C70 / C300 III / C500 II / C200 等）。
 *
 * 现在的状态是：**会探测参数，但永远拿不到画面**。两条边界都要钉住：
 *   · 会探测：`.crm` 在可探测清单里 → 时长/时码/拍摄时间/分辨率能进报告
 *     （实测一条 1 GB 素材只要 0.01 秒）。
 *   · 没有画面：ffmpeg 无 CRAW 解码器，**且文件里也没有内嵌预览图**（实测：
 *     前 96 MiB + 尾部 16 MiB 内可解析 JPEG 为 0，moov 里没有图片轨）。
 *     所以它**不进** VIDEO_EXTENSIONS —— 明知解不出来，就不要去读那几个 GB。
 *
 * 注意这里用的是"伪造的 CRM"（只有 ftyp 头 + 填充），不是真实 MOV，
 * 所以 ffprobe 解不动、走文件头与扩展名那条兜底路 —— 这恰好是本用例要覆盖的路径。
 * 真实文件上的参数读取（4096×2160 / 9.009s / 时码 08:21:48:23）在 CHANGELOG 1.2.4 有记录。
 */
describe('Canon Cinema RAW Light（.CRM）：探测参数，但没有画面', () => {
  /** 造一个 CRM 的文件夹头：MOV 系容器，major_brand = 'crx'。 */
  function buildCrmFile(payloadBytes: number): Buffer {
    const ftyp = Buffer.alloc(24)
    ftyp.writeUInt32BE(24, 0)
    ftyp.write('ftyp', 4, 'latin1')
    ftyp.write('crx ', 8, 'latin1')
    ftyp.writeUInt32BE(1, 12)
    ftyp.write('crx ', 16, 'latin1')
    ftyp.write('isom', 20, 'latin1')
    return Buffer.concat([ftyp, Buffer.alloc(payloadBytes, 0x33)])
  }

  it('在可探测清单里，但**不**当成视频去提首帧（明知解不出来，别白读几个 GB）', () => {
    expect(isProbeable('CONTENTS/CLIPS001/A001C001.CRM')).toBe(true)
    expect(isVideoLike('CONTENTS/CLIPS001/A001C001.CRM')).toBe(false)
  })

  it('探测不抛错、格式名给对，且明确没有画面', async () => {
    const file = join(root, 'A001C001_260917AB_CANON.CRM')
    await writeFile(file, buildCrmFile(64 * 1024))

    const probe = await runner.probe(file, { extractFrames: true })

    // 格式名必须对
    expect(probe.formatFamily).toBe('canon-raw')
    expect(probe.format).toContain('Cinema RAW Light')
    expect(probe.vendorTool).toContain('Canon')
    // 这个伪造文件解不动，所以没有元数据 —— 但原因必须说清楚，不能是空白
    expect(probe.firstFrame).toBeNull()
    expect(probe.frameSource).toBe('none')
    expect(probe.reason).not.toBeNull()
    expect(probe.reason).not.toBe('')
  })

  it('大写扩展名同样处理（卡片里的文件名常常是全大写）', async () => {
    const file = join(root, 'A002C001.CRM')
    await writeFile(file, buildCrmFile(1024))
    const probe = await runner.probe(file, { extractFrames: true })
    expect(probe.formatFamily).toBe('canon-raw')
    expect(probe.frameSource).toBe('none')
  })
})

describe('工具状态', () => {
  it('两个工具状态都是布尔值，且原因说明可读', () => {
    expect(typeof runner.available).toBe('boolean')
    expect(typeof runner.frameToolAvailable).toBe('boolean')
    if (!runner.available) {
      expect(runner.unavailableReason).toContain('ffprobe')
    } else {
      expect(runner.unavailableReason).toBeNull()
    }
  })

  it('未设置输出目录时不会写出任何文件', async () => {
    const bare = new FfprobeRunner({ logger: new Logger({ dir: '' }), userDir: null, bundledDir: null })
    await bare.refresh()
    // 故意不调 setFrameOutputDir
    const jpeg = buildJpeg(256, 144)
    const file = join(root, 'nodir.R3D')
    await writeFile(file, buildVendorFile('RED1', jpeg, 64 * 1024))

    const probe = await bare.probe(file, { extractFrames: true })
    expect(probe.firstFrame).toBeNull()
  })
})
