/**
 * 清单（manifest）生成。
 *
 * 支持两种格式：
 *   · asc-mhl-2.0 —— 默认。严格遵循 ASC 官方 XSD
 *     （targetNamespace `urn:ASC:MHL:v2.0`，根元素 `<hashlist version="2.0">`），
 *     元素顺序、哈希元素命名、文件命名规范都与官方参考实现一致。
 *   · mhl-v1 —— 传统 MHL 格式，用于对接仍在使用旧格式的流程。
 *
 * 关于官方 XSD 里 `roothash` 与 `directoryhash` 的处理：
 * 这两个元素在架构中是可选的，但它们的语义是"目录内容哈希 / 目录结构哈希"，
 * 具体算法未在公开架构中给出。本实现**刻意不输出**它们 ——
 * 与其写一个看起来像那么回事、实际对不上的哈希值，
 * 不如不写。缺字段是明确的，错字段是危险的。
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CopyJob, CopyJobFile, HashAlgorithm, ProjectInfo } from '@shared/types'
import { describeLenses } from '@shared/project'
import { encodeC4Digest } from '@main/hashing/c4'
import { StreamWriter } from '@main/stream-writer'

export const ASC_MHL_NAMESPACE = 'urn:ASC:MHL:v2.0'
export const MHL_V1_NAMESPACE = 'http://mediahashlist.org/ns/1.0'
export const ASC_MHL_FOLDER_NAME = 'ascmhl'

/** 各校验算法在清单里的元素名。 */
const ASC_HASH_ELEMENT: Record<HashAlgorithm, string> = {
  xxhash64: 'xxh64',
  md5: 'md5',
  'asc-c4': 'c4'
}

const MHL_V1_HASH_ELEMENT: Record<HashAlgorithm, string> = {
  xxhash64: 'xxhash64',
  md5: 'md5',
  'asc-c4': 'c4'
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** xsd:dateTime，去掉毫秒以贴近官方参考实现的输出。 */
export function xmlDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export interface ManifestContext {
  job: CopyJob
  project: ProjectInfo
  /** 源盘展示名，用于生成清单文件名 */
  sourceLabel: string
  /** 修订号，如 R001 */
  revision: string
  hostname: string
  toolName: string
  toolVersion: string
  /** 由外部提供的时间，便于测试 */
  now: Date
  /** 目标盘展示标签，写进 creatorinfo 的 location */
  targetLabels: string[]
}

export interface ManifestResult {
  /** 清单文件的绝对路径 */
  path: string
  /** 相对源根目录的 POSIX 路径，例如 ascmhl/0001_A002_2026-09-15_120000Z.mhl */
  relPath: string
  /** 清单自身内容的 C4 标识（ASC 链用它做身份） */
  c4: string
  /** 写入的文件条目数 */
  entries: number
}

/**
 * 生成 ASC MHL 2.0 清单文件名。
 *
 * 官方规范：`<四位代次>_<自定义基名>.mhl`，默认基名是
 * `<根目录名>_<YYYY-MM-DD>_<HHMMSS>Z`。参见官方示例
 * `0001_A002R2EC_2020-01-16_091500Z.mhl`。
 */
export function ascMhlFilename(generation: number, sourceLabel: string, now: Date): string {
  const stamp = now.toISOString()
  const date = stamp.slice(0, 10)
  const time = stamp.slice(11, 19).replace(/:/g, '')
  /*
   * 基名只保留 ASCII 字母数字与 `._-`：清单文件名会被各家工具当路径解析，
   * 混入中文与空格的风险不值得冒。
   *
   * ⚠️ 但**不能只做替换**。中文卷名（例如「启动磁盘」）会被整个过滤掉，
   * 结果是 `0001___2026-09-19_152426Z.mhl` —— 一串下划线，既难看又完全
   * 认不出这是哪张卡的清单。所以过滤后要再去掉首尾分隔符，空了就回退 root。
   */
  const safeLabel = sourceLabel.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '')
  return `${String(generation).padStart(4, '0')}_${safeLabel === '' ? 'root' : safeLabel}_${date}_${time}Z.mhl`
}

/**
 * 写入 ASC MHL 2.0 清单。
 *
 * 采用流式写入：十万级文件的清单可能有几十 MB，一次性拼字符串
 * 会在内存里留下一个巨大的峰值。
 */
export async function writeAscMhlManifest(
  rootDir: string,
  context: ManifestContext,
  files: AsyncIterable<CopyJobFile>
): Promise<ManifestResult> {
  const folder = join(rootDir, ASC_MHL_FOLDER_NAME)
  await mkdir(folder, { recursive: true })

  const generation = await detectAscMhlGeneration(folder)
  const filename = ascMhlFilename(generation, context.sourceLabel, context.now)
  const absolute = join(folder, filename)

  const hashElement = ASC_HASH_ELEMENT[context.job.hashAlgorithm]
  const hashdate = xmlDateTime(context.now)

  const stream = createWriteStream(absolute, { encoding: 'utf8' })
  const writer = new StreamWriter(stream)
  let entries = 0

  try {
    await writer.write('<?xml version="1.0" encoding="UTF-8"?>\n')
    await writer.write(`<hashlist version="2.0" xmlns="${ASC_MHL_NAMESPACE}">\n`)
    await writer.write('  <creatorinfo>\n')
    await writer.write(`    <creationdate>${xmlDateTime(context.now)}</creationdate>\n`)
    await writer.write(`    <hostname>${escapeXml(context.hostname)}</hostname>\n`)
    await writer.write(
      `    <tool version="${escapeXml(context.toolVersion)}">${escapeXml(context.toolName)}</tool>\n`
    )
    if (context.project.crew.length > 0) {
      for (const member of context.project.crew) {
        const role = member.role.trim()
        const name = member.name.trim()
        if (name === '' && role === '') continue
        await writer.write(
          `    <author role="${escapeXml(role)}">${escapeXml(name === '' ? role : name)}</author>\n`
        )
      }
    }
    await writer.write(`    <location>${escapeXml(context.targetLabels.join(', '))}</location>\n`)
    const comment = buildComment(context)
    if (comment !== '') {
      await writer.write(`    <comment>${escapeXml(comment)}</comment>\n`)
    }
    await writer.write('  </creatorinfo>\n')

    await writer.write('  <processinfo>\n')
    // 本应用的动作是"把素材从源盘转移到目标盘"，对应官方枚举 transfer
    await writer.write('    <process>transfer</process>\n')
    await writer.write('    <ignore>\n')
    for (const pattern of ['.DS_Store', ASC_MHL_FOLDER_NAME, `${ASC_MHL_FOLDER_NAME}/`, '*.securereel-partial']) {
      await writer.write(`      <pattern>${escapeXml(pattern)}</pattern>\n`)
    }
    await writer.write('    </ignore>\n')
    await writer.write('  </processinfo>\n')

    await writer.write('  <hashes>\n')
    for await (const file of files) {
      const hash = file.sourceHash
      if (hash === null) continue
      // 只记录真正完成并通过校验的文件；失败条目在报告里单独呈现
      const verified = file.results.some((result) => result.state === 'verified')
      if (!verified) continue

      entries++
      await writer.write('    <hash>\n')
      await writer.write(`      <path size="${file.sizeBytes}">${escapeXml(file.relPath)}</path>\n`)
      await writer.write(
        `      <${hashElement} action="original" hashdate="${hashdate}">${escapeXml(hash)}</${hashElement}>\n`
      )
      await writer.write('    </hash>\n')
    }
    await writer.write('  </hashes>\n')
    await writer.write('</hashlist>\n')
  } finally {
    await writer.end()
  }

  return {
    path: absolute,
    relPath: join(ASC_MHL_FOLDER_NAME, filename).split(/[/\\]/).join('/'),
    c4: await computeFileC4(absolute),
    entries
  }
}

/** 写入传统 MHL v1 清单。 */
export async function writeMhlV1Manifest(
  rootDir: string,
  context: ManifestContext,
  files: AsyncIterable<CopyJobFile>
): Promise<ManifestResult> {
  await mkdir(rootDir, { recursive: true })
  const filename = `${context.sourceLabel.replace(/[^A-Za-z0-9._-]+/g, '_') || 'root'}_${context.revision}.mhl`
  const absolute = join(rootDir, filename)

  const hashElement = MHL_V1_HASH_ELEMENT[context.job.hashAlgorithm]
  const hashdate = xmlDateTime(context.now)

  const stream = createWriteStream(absolute, { encoding: 'utf8' })
  const writer = new StreamWriter(stream)
  let entries = 0

  try {
    await writer.write('<?xml version="1.0" encoding="UTF-8"?>\n')
    await writer.write(`<mhl xmlns="${MHL_V1_NAMESPACE}">\n`)
    await writer.write('  <creator>\n')
    await writer.write(`    <name>${escapeXml(context.toolName)}</name>\n`)
    await writer.write(`    <username>${escapeXml(context.hostname)}</username>\n`)
    await writer.write(`    <version>${escapeXml(context.toolVersion)}</version>\n`)
    await writer.write(`    <location>${escapeXml(context.targetLabels.join(', '))}</location>\n`)
    const comment = buildComment(context)
    if (comment !== '') await writer.write(`    <comment>${escapeXml(comment)}</comment>\n`)
    await writer.write('  </creator>\n')
    await writer.write('  <hashes>\n')

    for await (const file of files) {
      if (file.sourceHash === null) continue
      if (!file.results.some((result) => result.state === 'verified')) continue
      entries++
      await writer.write('    <hash>\n')
      await writer.write(`      <path>${escapeXml(file.relPath)}</path>\n`)
      await writer.write(`      <size>${file.sizeBytes}</size>\n`)
      await writer.write(`      <${hashElement}>${escapeXml(file.sourceHash)}</${hashElement}>\n`)
      await writer.write(`      <hashdate>${hashdate}</hashdate>\n`)
      await writer.write('    </hash>\n')
    }

    await writer.write('  </hashes>\n')
    await writer.write('</mhl>\n')
  } finally {
    await writer.end()
  }

  return {
    path: absolute,
    relPath: filename,
    c4: await computeFileC4(absolute),
    entries
  }
}

function buildComment(context: ManifestContext): string {
  const parts: string[] = []
  if (context.project.parentProjectName !== null && context.project.parentProjectName !== '') {
    parts.push(`母项目：${context.project.parentProjectName}`)
  }
  if (context.project.projectName !== '') parts.push(`项目：${context.project.projectName}`)
  if (context.project.shootDay !== '') parts.push(`拍摄日：${context.project.shootDay}`)
  if (context.project.camera !== '') parts.push(`机型：${context.project.camera}`)
  const lenses = describeLenses(context.project)
  if (lenses !== '') parts.push(`镜头：${lenses}`)
  if (context.project.cardLabel !== '') parts.push(`卡号：${context.project.cardLabel}`)
  parts.push(`来源：${context.job.sourcePath}`)
  parts.push(`修订：${context.revision}`)
  return parts.join(' / ')
}

/** 读取已写好的清单文件并算出它的 C4 标识。 */
async function computeFileC4(path: string): Promise<string> {
  const handle = await open(path, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  const inner = createHash('sha512')
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      inner.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return encodeC4Digest(new Uint8Array(inner.digest()))
}

/**
 * 探测 ascmhl 目录里已有的最大代次，新清单取 +1。
 *
 * 这一步是"旧清单永不被覆盖"在清单层面的保证。
 */
export async function detectAscMhlGeneration(folder: string): Promise<number> {
  try {
    const entries = await readdir(folder)
    let max = 0
    for (const entry of entries) {
      const match = /^(\d{4,})_/.exec(entry)
      if (match === null) continue
      const value = Number(match[1])
      if (Number.isFinite(value) && value > max) max = value
    }
    return max + 1
  } catch {
    return 1
  }
}

/** 目标根目录下清单所在的位置，供报告里展示。 */
export function manifestDisplayPath(context: ManifestContext, folderName: string): string {
  return join(dirname(context.job.sourcePath), folderName)
}
