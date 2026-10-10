/**
 * 清单（manifest）生成。
 *
 * 支持四种格式：
 *   · asc-mhl-2.0 —— 默认。严格遵循 ASC 官方 XSD
 *     （targetNamespace `urn:ASC:MHL:v2.0`，根元素 `<hashlist version="2.0">`），
 *     元素顺序、哈希元素命名、文件命名规范都与官方参考实现一致。
 *   · mhl-v1 —— 传统 MHL 格式，用于对接仍在使用旧格式的流程。
 *   · csv —— 一张表，Excel / Numbers 直接打开，现场交付与跨部门核对最快。
 *   · json —— 给脚本和自动化流程用，字段最全。
 *
 * 关于官方 XSD 里 `roothash` 与 `directoryhash` 的处理：
 * 这两个元素在架构中是可选的，但它们的语义是"目录内容哈希 / 目录结构哈希"，
 * 具体算法未在公开架构中给出。本实现**刻意不输出**它们 ——
 * 与其写一个看起来像那么回事、实际对不上的哈希值，
 * 不如不写。缺字段是明确的，错字段是危险的。
 *
 * ⚠️ 哪些算法能进哪种格式，判据是 `ASC_MHL_HASH_ELEMENTS` 那张表
 * （从官方 XSD 抄的，有 XSD 测试兜底）。写 XML 前必须过 `supportsAlgorithm()`，
 * 否则会产出**架构校验不过的清单** —— 对方工具读不进来却不报错，只是少一半条目。
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CopyJob, CopyJobFile, HashAlgorithm, ProjectInfo } from '@shared/types'
import {
  ASC_MHL_HASH_ELEMENTS,
  MHL_V1_HASH_ELEMENTS,
  HASH_ALGORITHM_LABELS
} from '@shared/types'
import { describeLenses } from '@shared/project'
import { encodeC4Digest } from '@main/hashing/c4'
import { StreamWriter } from '@main/stream-writer'

export const ASC_MHL_NAMESPACE = 'urn:ASC:MHL:v2.0'
export const MHL_V1_NAMESPACE = 'http://mediahashlist.org/ns/1.0'
export const ASC_MHL_FOLDER_NAME = 'ascmhl'

/**
 * 取某个算法在指定格式里的元素名。取不到就是"这个组合本来就不该被选中"。
 *
 * 为什么在这里再拦一道：设置页已经会禁用非法组合，但两份配置（设置里的默认值、
 * 任务里冻结的那一份）都可能来自旧版本数据库或外部传入的 IPC 参数。
 * 界面能骗过，架构校验骗不过 —— 所以在真正落笔之前再确认一次。
 */
function requireHashElement(
  table: Partial<Record<HashAlgorithm, string>>,
  format: string,
  algorithm: HashAlgorithm
): string {
  const element = table[algorithm]
  if (element === undefined) {
    throw new Error(
      `${format} 清单不支持 ${HASH_ALGORITHM_LABELS[algorithm]} 校验值（该格式的官方架构里没有对应的哈希元素）`
    )
  }
  return element
}

/**
 * 取源盘展示名做文件名的安全基名。
 *
 * ⚠️ 不能只做字符替换：中文卷名（例如「启动磁盘」）会被整个过滤掉，
 * 结果是一串下划线，既难看又完全认不出这是哪张卡。所以过滤后要去掉首尾
 * 分隔符，空了就回退 root。
 */
function safeBaseName(sourceLabel: string): string {
  const cleaned = sourceLabel.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '')
  return cleaned === '' ? 'root' : cleaned
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
  return `${String(generation).padStart(4, '0')}_${safeBaseName(sourceLabel)}_${date}_${time}Z.mhl`
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

  const hashElement = requireHashElement(
    ASC_MHL_HASH_ELEMENTS,
    'ASC MHL 2.0',
    context.job.hashAlgorithm
  )
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
  const filename = `${safeBaseName(context.sourceLabel)}_${context.revision}.mhl`
  const absolute = join(rootDir, filename)

  const hashElement = requireHashElement(
    MHL_V1_HASH_ELEMENTS,
    'MHL v1',
    context.job.hashAlgorithm
  )
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

/* ------------------------------------------------------------------ *
 * CSV / JSON —— 给人和脚本看的表格清单
 * ------------------------------------------------------------------ */

/** 清单里的一行。CSV 与 JSON 共用同一套抽取规则，也共用同一个字段名。 */
interface HashRow {
  /** 目标盘上的相对路径（POSIX 风格） */
  path: string
  sizeBytes: number
  hash: string
  verifiedTargets: number
}

/**
 * 从一个文件记录里抽出可写进清单的一行。
 *
 * 收录条件与两种 XML 格式**完全一致**：源哈希算出来了、且至少有一个目标
 * 通过了独立重读校验。校验没过的一律不进清单 ——
 * 清单是"这批素材原本是什么样"的记录，掺进没通过的行等于谎报。
 * 失败的条目在报告里单独呈现，那里才有失败原因。
 */
function collectHashRow(file: CopyJobFile): HashRow | null {
  if (file.sourceHash === null) return null
  const verifiedTargets = file.results.filter((result) => result.state === 'verified').length
  if (verifiedTargets === 0) return null
  return {
    path: file.relPath,
    sizeBytes: file.sizeBytes,
    hash: file.sourceHash,
    verifiedTargets
  }
}

/**
 * CSV 单元格转义。两件事都要做，缺一不可：
 *
 *   1. 含逗号 / 引号 / 换行的值用双引号包起来，内部引号翻倍 —— RFC 4180
 *   2. 以 `=` `+` `-` `@` 开头的值前面补一个单引号 —— 挡**公式注入**。
 *      素材文件名是外部输入（相机卡上的名字、别人递过来的盘），
 *      一份以 `=cmd|...` 开头的 CSV 被 Excel 打开会直接按公式执行。
 *      加个前缀它就不执行了，而 Excel 也不会把那个单引号显示出来。
 */
function csvCell(value: string): string {
  let text = value
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

/**
 * 写入 CSV 清单。
 *
 * 一行一个文件，表头固定英文 ASCII（这份东西会被别的工具解析，
 * 中文表头在某些老解析器上会出问题）；路径里可以有中文，所以带 BOM。
 */
export async function writeCsvManifest(
  rootDir: string,
  context: ManifestContext,
  files: AsyncIterable<CopyJobFile>
): Promise<ManifestResult> {
  await mkdir(rootDir, { recursive: true })
  const filename = `${safeBaseName(context.sourceLabel)}_${context.revision}.csv`
  const absolute = join(rootDir, filename)

  const algorithm = context.job.hashAlgorithm
  const stream = createWriteStream(absolute, { encoding: 'utf8' })
  const writer = new StreamWriter(stream)
  let entries = 0

  try {
    /*
     * UTF-8 BOM 不能省。
     * Windows 版 Excel 打开不带 BOM 的 UTF-8 CSV 时按本地代码页解码，
     * 中文路径会变成乱码 —— 而现场素材路径里出现中文是常态
     * （「录音」「花絮」「第二机」「空镜」）。BOM 是这一个小字节唯一的解法。
     */
    await writer.write('\uFEFF')
    // 行尾用 CRLF：RFC 4180 的规定，也是 Excel 最省事的那一种
    await writer.write('path,size_bytes,algorithm,hash,verified_targets\r\n')
    for await (const file of files) {
      const row = collectHashRow(file)
      if (row === null) continue
      entries++
      await writer.write(
        [
          csvCell(row.path),
          String(row.sizeBytes),
          csvCell(HASH_ALGORITHM_LABELS[algorithm]),
          csvCell(row.hash),
          String(row.verifiedTargets)
        ].join(',') + '\r\n'
      )
    }
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

/**
 * 写入 JSON 清单。
 *
 * 与 CSV 的差别不只是"格式不同"：这里带**作业上下文**（任务名、拍摄日、
 * 机型镜头、主创、目标盘、算法、备注），所以单独发一份出去也能自证来源。
 * CSV 没有这一层，它只承担"一张能直接看的表"。
 *
 * 同样是流式：十万条素材的 JSON 一次性拼出来会有几十 MB 的内存峰值。
 */
export async function writeJsonManifest(
  rootDir: string,
  context: ManifestContext,
  files: AsyncIterable<CopyJobFile>
): Promise<ManifestResult> {
  await mkdir(rootDir, { recursive: true })
  const filename = `${safeBaseName(context.sourceLabel)}_${context.revision}.json`
  const absolute = join(rootDir, filename)

  const algorithm = context.job.hashAlgorithm
  const stream = createWriteStream(absolute, { encoding: 'utf8' })
  const writer = new StreamWriter(stream)
  let entries = 0

  try {
    const head = {
      format: 'securereel-hashlist',
      formatVersion: 1,
      created: context.now.toISOString(),
      revision: context.revision,
      tool: { name: context.toolName, version: context.toolVersion },
      hostname: context.hostname,
      source: context.sourceLabel,
      hashAlgorithm: algorithm,
      hashAlgorithmLabel: HASH_ALGORITHM_LABELS[algorithm],
      targets: context.targetLabels,
      job: { id: context.job.id, name: context.job.name },
      project: {
        name: context.project.projectName,
        shootDay: context.project.shootDay,
        camera: context.project.camera,
        lenses: describeLenses(context.project),
        crew: context.project.crew.map((member) => ({
          role: member.role,
          name: member.name
        }))
      },
      comment: buildComment(context)
    }

    // 头部整体序列化后切掉收尾的 `}`，再手工接上 files 数组 ——
    // 这样每个字段仍然由 JSON.stringify 转义，不必自己处理引号。
    const headJson = JSON.stringify(head, null, 2)
    await writer.write(`${headJson.slice(0, headJson.lastIndexOf('}')).trimEnd()},\n`)
    await writer.write('  "files": [')

    let first = true
    for await (const file of files) {
      const row = collectHashRow(file)
      if (row === null) continue
      entries++
      const body = JSON.stringify(row, null, 2)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')
      await writer.write(`${first ? '\n' : ',\n'}${body}`)
      first = false
    }

    await writer.write('\n  ]\n}\n')
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
  const parent = context.project.parentProjectName
  const hasParent = parent !== null && parent !== ''
  if (hasParent) {
    parts.push(`母项目：${parent}`)
  }
  /*
   * 「项目」这一条只在它**不与母项目重复**时才打。
   *
   * 选了母项目之后，项目名往往就是母项目的名字 —— 两条都打出来会变成
   * 「母项目：母亲 / 项目：母亲」这种同行重复。既然母项目名已经在了，
   * 项目名相同或为空就没有再写的必要；只有用户确实单独填过不同的项目名
   * （母项目为空、或两者不同）时才打第二条。
   */
  const duplicateOfParent = hasParent && (context.project.projectName === '' || context.project.projectName === parent)
  if (context.project.projectName !== '' && !duplicateOfParent) {
    parts.push(`项目：${context.project.projectName}`)
  }
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
