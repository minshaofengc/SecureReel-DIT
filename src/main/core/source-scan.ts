/**
 * 源盘识别与扫描。
 *
 * 这里回答三个问题：
 *   1. 这是个什么盘（普通盘 / HDE 卷 / ARRIRAW 卡）？
 *   2. 上面有多少素材、多大体积？
 *   3. 目标盘放得下吗？
 */
import { basename } from 'node:path'
import type { DriveUsage, ScanResult, SourceDrive, VolumeKind } from '@shared/types'
import { describeVolume, stripTrailingSeparators, volumeUsage, walkFiles } from '@main/fs-utils'
import { HOST } from '@main/platform'
import { volumeLabelFor } from '@main/volumes'

/** 取第一个「有内容」的字符串。空串与 null 一样算没有。 */
function firstNonEmpty(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (value !== null && value !== undefined && value.trim() !== '') return value
  }
  return null
}

/** 出现这些扩展名，就认为卷上带 HDE 特征。 */
const HDE_EXTENSIONS = new Set(['arx'])
const ARRIRAW_EXTENSIONS = new Set(['ari'])
const MXF_EXTENSIONS = new Set(['mxf'])

const NAME_HINTS = ['hde', 'codex']

function classify(root: string, extensions: Map<string, number>): VolumeKind {
  const lower = root.toLowerCase()
  const hasHdeName = NAME_HINTS.some((hint) => lower.includes(hint))

  for (const ext of HDE_EXTENSIONS) {
    if (extensions.has(ext)) return 'hde-vfs'
  }
  for (const ext of MXF_EXTENSIONS) {
    if (extensions.has(ext) && hasHdeName) return 'hde-mxf'
  }
  for (const ext of ARRIRAW_EXTENSIONS) {
    if (extensions.has(ext)) return 'arriraw'
  }
  return 'generic'
}

/**
 * 识别一个卷。
 *
 * `labelOverride` 是调用方已经知道的更好名字（枚举卷列表时的卷标）。
 * Windows 上 Node 拿不到卷标，`describeVolume` 只能给出盘符（`E:`），
 * 所以那个场景下要额外问一次 PowerShell；拿不到就老实显示盘符，
 * 绝不因为「卷标取不到」而让整个列表出不来。
 */
export async function inspectSource(path: string, labelOverride?: string | null): Promise<SourceDrive> {
  const description = await describeVolume(path)
  const usage = await volumeUsage(path)

  let label = firstNonEmpty(labelOverride, description?.label)
  if (HOST === 'win32' && labelOverride === undefined) {
    label = firstNonEmpty(await volumeLabelFor(description?.mountPoint ?? path), label)
  }

  return {
    path,
    label: label ?? basename(path),
    kind: 'generic',
    isCodExVfs: false,
    totalBytes: usage?.totalBytes ?? null,
    freeBytes: usage?.availableBytes ?? null,
    fileSystem: null,
    readOnly: description?.readOnly ?? false,
    mediaFileCount: null
  }
}

export interface ScanOptions {
  /** 收集文件明细上限（预览用） */
  previewLimit?: number
  signal?: AbortSignal
}

export async function scanSource(path: string, options: ScanOptions = {}): Promise<ScanResult> {
  const { previewLimit = 200, signal } = options
  // 尾斜杠会让同一个目录产生两种写法，进而让 relPath / 卷名判定出现分歧 —— 统一在这里归口
  const root = stripTrailingSeparators(path)
  const walk = await walkFiles(root, { signal })

  const extensionTally = new Map<string, { count: number; bytes: number }>()
  for (const file of walk.files) {
    const dot = file.relPath.lastIndexOf('.')
    const slash = file.relPath.lastIndexOf('/')
    const ext = dot > slash && dot >= 0 ? file.relPath.slice(dot + 1).toLowerCase() : '(无扩展名)'
    const entry = extensionTally.get(ext) ?? { count: 0, bytes: 0 }
    entry.count++
    entry.bytes += file.sizeBytes
    extensionTally.set(ext, entry)
  }

  const kind = classify(root, new Map([...extensionTally.keys()].map((ext) => [ext, 1])))
  const description = await describeVolume(root)

  const preview = [...walk.files]
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, previewLimit)
    .map((file) => ({ relPath: file.relPath, sizeBytes: file.sizeBytes }))

  return {
    root,
    kind,
    isCodExVfs: kind === 'hde-vfs',
    fileCount: walk.files.length,
    totalBytes: walk.totalBytes,
    preview,
    extensions: [...extensionTally.entries()]
      .map(([ext, tally]) => ({ ext, count: tally.count, bytes: tally.bytes }))
      .sort((a, b) => b.bytes - a.bytes),
    warnings: [
      ...walk.warnings,
      ...(description?.readOnly === true ? [`该来源卷当前为只读挂载。`] : [])
    ]
  }
}

/** 逐个目标盘算容量。requiredBytes 用于判断"放得下吗"。 */
export async function usageForTargets(
  targets: { path: string; label?: string }[],
  requiredBytes: number | null
): Promise<DriveUsage[]> {
  const results: DriveUsage[] = []
  for (const target of targets) {
    const usage = await volumeUsage(target.path)
    const description = await describeVolume(target.path)
    const freeBytes = usage?.availableBytes ?? 0
    results.push({
      path: target.path,
      label: target.label ?? description?.label ?? basename(target.path),
      totalBytes: usage?.totalBytes ?? 0,
      freeBytes,
      requiredBytes,
      sufficient: requiredBytes === null ? null : freeBytes >= requiredBytes
    })
  }
  return results
}
