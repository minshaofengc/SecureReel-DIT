/**
 * 内嵌预览图提取。
 *
 * 解决什么问题：R3D 和 BRAW 是厂商私有编码，ffmpeg 没有对应的解码器，
 * 所以**没法解码出画面**。但这两个格式的文件内部都嵌了一张 JPEG 预览图
 * （厂商给机内回放 / 缩略图用的）。把这帧读出来，就能在报告里给出首帧画面。
 *
 * 这不是逆向工程编码算法 —— 只是读取文件里本来就存在的一段标准 JPEG 数据。
 *
 * 实现要点：**必须按 JPEG 段结构遍历来定位结束位置**，不能简单地找
 * 下一个 `FFD9`。因为 EXIF 里经常内嵌缩略图，而缩略图本身也是完整 JPEG，
 * 简单扫描会在缩略图的 EOI 处提前截断，得到一个残缺的半张图。
 */
import { open } from 'node:fs/promises'

export interface JpegSpan {
  start: number
  end: number
}

export interface EmbeddedPreview {
  jpeg: Buffer
  width: number
  height: number
  /** 该预览图在文件中的偏移量，便于诊断 */
  offset: number
}

/** 第一遍扫描窗口：预览图基本都在文件最前面。 */
const FIRST_WINDOW_BYTES = 8 * 1024 * 1024
/** 第一遍没找到时再往后扫这么多（有些机型把预览放得靠后）。 */
const SECOND_WINDOW_BYTES = 24 * 1024 * 1024

/** 过滤掉 EXIF 缩略图这类小图。 */
const MIN_JPEG_BYTES = 4096
const MIN_DIMENSION = 64

/**
 * 从一个缓冲区里找出所有完整 JPEG 的区间。
 *
 * 用真实的段遍历确定结束位置，因此能正确处理内嵌 EXIF 缩略图的情况。
 */
export function findJpegSpans(buffer: Buffer, limit = 64): JpegSpan[] {
  const spans: JpegSpan[] = []
  const length = buffer.length
  let index = 0

  while (index + 3 < length && spans.length < limit) {
    // JPEG 起始：FFD8 后面必须紧跟另一个段标记的开头 FF
    if (buffer[index] !== 0xff || buffer[index + 1] !== 0xd8 || buffer[index + 2] !== 0xff) {
      index++
      continue
    }
    const end = findJpegEnd(buffer, index)
    if (end === -1) {
      index++
      continue
    }
    spans.push({ start: index, end })
    // 跳过整张图，避免把 EXIF 里的缩略图重复算成独立候选
    index = end
  }

  return spans
}

/** 遍历 JPEG 段，返回 EOI 之后的偏移；结构损坏返回 -1。 */
export function findJpegEnd(buffer: Buffer, start: number): number {
  let pos = start + 2
  const length = buffer.length

  while (pos + 1 < length) {
    if (buffer[pos] !== 0xff) {
      // 熵编码数据区（SOS 之后）里除了标记之外的普通字节
      pos++
      continue
    }

    const marker = buffer[pos + 1] as number

    if (marker === 0xff) {
      pos++ // 填充字节
      continue
    }
    if (marker === 0x00) {
      pos += 2 // 熵编码里的 FF00 转义，不是标记
      continue
    }
    if (marker === 0xd9) {
      return pos + 2 // EOI
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      pos += 2 // RSTn，无长度字段
      continue
    }
    if (marker === 0x01) {
      pos += 2 // TEM，无长度字段
      continue
    }
    if (marker === 0xd8) {
      pos += 2 // 异常情况下遇到嵌套 SOI，跳过
      continue
    }
    if (pos + 3 >= length) break

    const segmentLength = buffer.readUInt16BE(pos + 2)
    if (segmentLength < 2) return -1 // 长度字段非法，认定结构损坏
    pos += 2 + segmentLength
  }

  return -1
}

/** 从 SOFn 段里读出图像尺寸。 */
export function parseJpegSize(
  buffer: Buffer,
  span: JpegSpan
): { width: number; height: number } | null {
  let pos = span.start + 2

  while (pos + 8 < span.end) {
    if (buffer[pos] !== 0xff) {
      pos++
      continue
    }
    const marker = buffer[pos + 1] as number
    if (marker === 0xff || marker === 0x00) {
      pos++
      continue
    }
    if (marker === 0xd9 || marker === 0xda) break // 进入图像数据就说明没有 SOF 了

    // SOF0–SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(pos + 5),
        width: buffer.readUInt16BE(pos + 7)
      }
    }

    const segmentLength = buffer.readUInt16BE(pos + 2)
    if (segmentLength < 2) return null
    pos += 2 + segmentLength
  }

  return null
}

/** 从一段缓冲区里挑出最大的一张合格 JPEG。 */
export function pickBestPreview(buffer: Buffer, baseOffset = 0): EmbeddedPreview | null {
  let best: EmbeddedPreview | null = null

  for (const span of findJpegSpans(buffer)) {
    const size = span.end - span.start
    if (size < MIN_JPEG_BYTES) continue

    const dimensions = parseJpegSize(buffer, span)
    if (dimensions === null) continue
    if (dimensions.width < MIN_DIMENSION || dimensions.height < MIN_DIMENSION) continue

    if (best === null || size > best.jpeg.length) {
      best = {
        jpeg: buffer.subarray(span.start, span.end),
        width: dimensions.width,
        height: dimensions.height,
        offset: baseOffset + span.start
      }
    }
  }

  return best
}

/**
 * 从文件里读出内嵌的预览图。
 *
 * 两遍扫描：先看最前面 8 MiB（绝大多数机型），没找到再往后看 24 MiB。
 * 不一次读更大是因为目标盘上可能有几千条素材，每条多读几 MB 加起来
 * 就是几十 GB 的额外读盘量。
 */
export async function extractEmbeddedPreview(
  path: string,
  options: { signal?: AbortSignal } = {}
): Promise<EmbeddedPreview | null> {
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    let offset = 0

    for (const windowSize of [FIRST_WINDOW_BYTES, SECOND_WINDOW_BYTES]) {
      if (options.signal?.aborted === true) return null
      if (offset >= size) break

      const available = Math.min(windowSize, size - offset)
      if (available <= 0) break

      const buffer = Buffer.allocUnsafe(available)
      await handle.read(buffer, 0, available, offset)

      const found = pickBestPreview(buffer, offset)
      if (found !== null) {
        // 复制一份，避免返回指向大缓冲区的切片而把整块内存吊住
        return { ...found, jpeg: Buffer.from(found.jpeg) }
      }

      offset += available
    }

    return null
  } finally {
    await handle.close()
  }
}
