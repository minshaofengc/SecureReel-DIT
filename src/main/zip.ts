/**
 * 最小的 ZIP 写入器（纯 Node，零依赖）。
 *
 * 为什么自己写而不是调系统的打包命令：
 *   · macOS 上是 `/usr/bin/zip`，Windows 上**没有这个文件**；
 *   · Windows 上能替代的只有 PowerShell 的 `Compress-Archive`，但那个东西
 *     在引号、中文、以 `-` 开头的文件名上都有坑，而诊断包里装的正是
 *     日志文件名（`securereel-2026-10-01.jsonl` 这种还算干净，但 staged
 *     目录来自临时目录，不能赌）；
 *   · 自己写还有两个好处：**两个平台行为完全一致**，以及**可以被单元测试**。
 *
 * 实现范围刻意收窄：只用 deflate 一种压缩方法、不做 ZIP64、不做加密。
 * 诊断包的内容是日志与一份文本，单文件远小于 4 GB —— 一旦越界，
 * 宁可抛错也不要生成一个能看但打不开的包。
 */
import { createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { deflateRawSync } from 'node:zlib'

/* ------------------------------------------------------------------ *
 * CRC-32
 * ------------------------------------------------------------------ */

/**
 * CRC-32（IEEE 802.3）查找表。
 *
 * 不用 `zlib.crc32`：那个 API 是 Node 22.2 才有的，而我们是跑在
 * Electron 自带的 Node 上 —— 为了一个诊断包去依赖宿主的次版本号不值得，
 * 何况这张表的实现只有十几行，还能被单元测试盯住。
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** 算一段字节的 CRC-32，返回无符号 32 位整数。 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < data.length; index++) {
    const byte = data[index] as number
    crc = ((crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

/* ------------------------------------------------------------------ *
 * DOS 时间戳
 * ------------------------------------------------------------------ */

/** ZIP 用的是 1980 纪元的 DOS 时间，两个 16 位字段。 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getFullYear(), 1980)
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

export interface ZipEntry {
  /** 包内路径（用 `/` 分隔）。诊断包只需要文件名，所以调用方传 basename。 */
  name: string
  /** 要打进去的文件绝对路径。与 `data` 二选一。 */
  absPath?: string
  /** 直接给内容（例如现生成的文本）。与 `absPath` 二选一。 */
  data?: Buffer
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
/** 通用标志位第 11 位：文件名是 UTF-8。日志文件名可能含非 ASCII，必须置上。 */
const FLAG_UTF8 = 0x0800
const METHOD_DEFLATE = 8
const MAX_ZIP32_SIZE = 0xffffffff

interface CentralRecord {
  nameBytes: Buffer
  crc: number
  compressedSize: number
  uncompressedSize: number
  offset: number
  time: number
  date: number
}

/**
 * 把若干文件写成一个 zip。
 *
 * 逐个文件读取 + 压缩 + 立刻落盘，所以峰值内存是「单个文件」，而不是整包大小 ——
 * 诊断包里可能有几十 MB 的日志，不该整个塞进内存再写。
 */
export async function writeZip(outputPath: string, entries: readonly ZipEntry[]): Promise<void> {
  const stream = createWriteStream(outputPath)
  const write = (chunk: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      stream.write(chunk, (error) => (error != null ? reject(error) : resolve()))
    })

  const central: CentralRecord[] = []
  let offset = 0

  try {
    for (const entry of entries) {
      const data =
        entry.data ?? (entry.absPath !== undefined ? await readFile(entry.absPath) : null)
      if (data === null) {
        throw new Error(`打包失败：条目 ${entry.name} 既没有 absPath 也没有 data`)
      }
      const compressed = deflateRawSync(data)
      // 压缩反而变大时（已压缩的日志）用「存储」更合适，但为了保持实现单一，
      // 这里统一 deflate —— 诊断包对体积不敏感，可预测性更重要。
      const crc = crc32(data)
      const stamp = dosDateTime(new Date())
      const nameBytes = Buffer.from(entry.name, 'utf8')

      if (data.length > MAX_ZIP32_SIZE || compressed.length > MAX_ZIP32_SIZE) {
        throw new Error(`打包失败：${entry.name} 超过 ZIP32 单文件上限（4 GiB）`)
      }

      const local = Buffer.alloc(30)
      local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0)
      local.writeUInt16LE(20, 4) // 解压所需版本 2.0
      local.writeUInt16LE(FLAG_UTF8, 6)
      local.writeUInt16LE(METHOD_DEFLATE, 8)
      local.writeUInt16LE(stamp.time, 10)
      local.writeUInt16LE(stamp.date, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(compressed.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(nameBytes.length, 26)
      local.writeUInt16LE(0, 28) // 无扩展字段

      await write(local)
      await write(nameBytes)
      await write(compressed)

      central.push({
        nameBytes,
        crc,
        compressedSize: compressed.length,
        uncompressedSize: data.length,
        offset,
        time: stamp.time,
        date: stamp.date
      })
      offset += local.length + nameBytes.length + compressed.length
    }

    const centralStart = offset
    for (const record of central) {
      const header = Buffer.alloc(46)
      header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0)
      header.writeUInt16LE(20, 4) // 生成程序版本
      header.writeUInt16LE(20, 6) // 解压所需版本
      header.writeUInt16LE(FLAG_UTF8, 8)
      header.writeUInt16LE(METHOD_DEFLATE, 10)
      header.writeUInt16LE(record.time, 12)
      header.writeUInt16LE(record.date, 14)
      header.writeUInt32LE(record.crc, 16)
      header.writeUInt32LE(record.compressedSize, 20)
      header.writeUInt32LE(record.uncompressedSize, 24)
      header.writeUInt16LE(record.nameBytes.length, 28)
      header.writeUInt16LE(0, 30) // 扩展字段长度
      header.writeUInt16LE(0, 32) // 注释长度
      header.writeUInt16LE(0, 34) // 起始磁盘号
      header.writeUInt16LE(0, 36) // 内部属性
      header.writeUInt32LE(0, 38) // 外部属性
      header.writeUInt32LE(record.offset, 42)

      await write(header)
      await write(record.nameBytes)
      offset += header.length + record.nameBytes.length
    }

    const centralSize = offset - centralStart
    const end = Buffer.alloc(22)
    end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0)
    end.writeUInt16LE(0, 4) // 本磁盘号
    end.writeUInt16LE(0, 6) // 中央目录起始磁盘号
    end.writeUInt16LE(central.length, 8)
    end.writeUInt16LE(central.length, 10)
    end.writeUInt32LE(centralSize, 12)
    end.writeUInt32LE(centralStart, 16)
    end.writeUInt16LE(0, 20) // 注释长度
    await write(end)

    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => (error != null ? reject(error) : resolve()))
    })
  } catch (error) {
    stream.destroy()
    throw error
  }
}

/** 把一组文件路径打成 zip，包内只保留文件名（等价于 zip 的 `-j`）。 */
export async function writeZipFromFiles(outputPath: string, files: readonly string[]): Promise<void> {
  await writeZip(
    outputPath,
    files.map((absPath) => ({ name: basename(absPath), absPath }))
  )
}
