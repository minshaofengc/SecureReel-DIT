import { createHash } from 'node:crypto'
import { realpath, stat, statfs } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { z } from 'zod'
import { resolveExecutable, runCommand } from '@main/exec'
import { HOST } from '@main/platform'
import type {
  PreflightConfirmation,
  StorageIdentity,
  StorageRisk,
  TargetPreflightResult
} from '@shared/storage-safety'

const pathSchema = z
  .string()
  .min(1)
  .max(32768)
  .refine(
    (value) => !value.includes('\0') && (HOST === 'win32' ? win32 : posix).isAbsolute(value),
    '请选择有效的绝对目录路径'
  )
const inputSchema = z.object({
  sourcePath: pathSchema,
  targets: z.array(pathSchema).min(1).max(64),
  requiredBytes: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER / 64),
  mode: z.enum(['copy', 'verify']),
  proxyEnabled: z.boolean().optional()
})
type Input = z.infer<typeof inputSchema>
type Dict = Record<string, unknown>
const asDict = (value: unknown): Dict =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : {}
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null
const bytes = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const unique = (values: string[]): string[] => [...new Set(values)].sort()
const overlap = (a: StorageIdentity, b: StorageIdentity): boolean =>
  a.physicalDeviceIds.some((id) => b.physicalDeviceIds.includes(id))
// Per-snapshot metadata only; never a cache of previously mounted devices.
const filesystemDevices = new WeakMap<StorageIdentity, number>()
const sameFilesystem = (a: StorageIdentity, b: StorageIdentity): boolean =>
  (a.filesystemId !== null && a.filesystemId === b.filesystemId) ||
  (filesystemDevices.has(a) && filesystemDevices.get(a) === filesystemDevices.get(b)) ||
  (HOST === 'win32' ? a.path.toLowerCase() === b.path.toLowerCase() : a.path === b.path)

/** A deliberately limited plist reader: no DTD/entity resolution, bounded nesting and output. */
function readPlist(xml: string): Dict {
  if (xml.length > 1024 * 1024 || /<!ENTITY|\[\s*<!/i.test(xml)) throw new Error('无法读取存储信息')
  const body = xml
    .replace(/<\?xml[^?]*\?>/g, '')
    .replace(/<!DOCTYPE\s+plist\s+PUBLIC\s+"[^"]*"\s+"[^"]*"\s*>/g, '')
    .trim()
  const tokens = body.match(/<[^>]+>|[^<]+/g) ?? []
  let index = 0
  const skipSpace = (): void => {
    while (tokens[index]?.trim() === '') index++
  }
  const take = (): string => {
    skipSpace()
    return tokens[index++] ?? ''
  }
  const decode = (value: string): string =>
    value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
      if (entity.startsWith('#')) {
        const code =
          entity[1]?.toLowerCase() === 'x'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10)
        if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) throw new Error('无效存储信息')
        return String.fromCodePoint(code)
      }
      return (
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity] ??
        ''
      )
    })
  const parse = (depth: number): unknown => {
    if (depth > 64) throw new Error('存储信息过深')
    const token = take()
    if (token === '<true/>' || token === '<true />') return true
    if (token === '<false/>' || token === '<false />') return false
    if (token === '<dict/>' || token === '<dict />') return Object.create(null) as Dict
    if (token === '<array/>' || token === '<array />') return []
    if (token === '<dict>') {
      const result: Dict = Object.create(null) as Dict
      for (;;) {
        skipSpace()
        if (tokens[index] === '</dict>') {
          index++
          return result
        }
        if (take() !== '<key>') throw new Error('无效存储信息')
        const key = decode(tokens[index++] ?? '')
        if (take() !== '</key>') throw new Error('无效存储信息')
        result[key] = parse(depth + 1)
      }
    }
    if (token === '<array>') {
      const result: unknown[] = []
      for (;;) {
        skipSpace()
        if (tokens[index] === '</array>') {
          index++
          return result
        }
        result.push(parse(depth + 1))
      }
    }
    const type = token.match(/^<(string|integer|real|date|data)>$/)?.[1]
    if (type) {
      let value = ''
      if (tokens[index] !== `</${type}>`) value = tokens[index++] ?? ''
      if (take() !== `</${type}>`) throw new Error('无效存储信息')
      return type === 'integer' || type === 'real' ? Number(value) : decode(value)
    }
    if (/^<(string|data)\s*\/>$/.test(token)) return ''
    throw new Error('无效存储信息')
  }
  if (!/^<plist\s+version="1\.0">$/.test(take())) throw new Error('无效存储信息')
  const result = asDict(parse(0))
  if (take() !== '</plist>' || take() !== '') throw new Error('无效存储信息')
  return result
}

async function macInfo(path: string): Promise<Dict> {
  const executable = await resolveExecutable('/usr/sbin/diskutil')
  if (!executable) return {}
  const result = await runCommand(executable, ['info', '-plist', path], {
    timeoutMs: 5000,
    maxStdoutBytes: 1024 * 1024
  })
  if (result.code !== 0 || result.timedOut || result.spawnError) return {}
  return readPlist(result.stdout)
}

async function macTopology(path: string): Promise<Partial<StorageIdentity>> {
  let info = await macInfo(path)
  // diskutil accepts mount points/device nodes, but not arbitrary child directories.
  // df resolves the live mounted device without relying on a mount-point cache.
  if (Object.keys(info).length === 0) {
    const df = await resolveExecutable('/bin/df')
    if (df) {
      const result = await runCommand(df, ['-P', path], { timeoutMs: 5000, maxStdoutBytes: 65536 })
      const device =
        result.code === 0 && !result.timedOut && !result.spawnError
          ? result.stdout.match(/(?:^|\n)(\/dev\/disk\d+(?:s\d+)*)\s/)?.[1]
          : undefined
      if (device) info = await macInfo(device)
    }
  }
  const container = text(info.APFSContainerReference)
  const isApfs = container !== null || text(info.FilesystemType)?.toLowerCase() === 'apfs'
  // Container UUID and physical stores may only be present on the container node.
  const containerInfo = container && /^disk\d+$/.test(container) ? await macInfo(container) : {}
  const pool = text(containerInfo.DiskUUID) ?? container
  const stores =
    Array.isArray(info.APFSPhysicalStores) && info.APFSPhysicalStores.length
      ? info.APFSPhysicalStores
      : Array.isArray(containerInfo.APFSPhysicalStores)
        ? containerInfo.APFSPhysicalStores
        : []
  let physical = unique(
    stores.flatMap((store) => {
      const id = text(asDict(store).APFSPhysicalStore)?.match(/^(disk\d+)(?:s\d+)+$/)?.[1]
      return id ? [`mac:physical:${id}`] : []
    })
  )
  if (
    physical.length === 0 &&
    !isApfs &&
    info.SystemImage !== true &&
    info.VirtualOrPhysical !== 'Virtual'
  ) {
    const parent = text(info.ParentWholeDisk)
    if (parent && /^disk\d+$/.test(parent)) {
      const whole = info.VirtualOrPhysical === 'Physical' ? info : await macInfo(parent)
      // Never promote a synthesized disk or disk image to a physical backup.
      if (whole.VirtualOrPhysical === 'Physical' && whole.SystemImage !== true)
        physical = [`mac:physical:${parent}`]
    }
  }
  const volume = text(info.VolumeUUID) ?? text(info.DiskUUID)
  return {
    ...(text(info.VolumeName) ? { label: text(info.VolumeName)! } : {}),
    ...(volume ? { filesystemId: `mac:volume:${volume}` } : {}),
    physicalDeviceIds: physical,
    capacityPoolId: pool ? `mac:apfs:${pool}` : null
  }
}

// All path text travels in the environment, never in the PowerShell program.
// Unsupported/virtual/network devices deliberately return incomplete topology.
const WINDOWS_PROBE = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$v=Get-Volume -FilePath $env:SECUREREEL_STORAGE_PATH
$d=@(Get-Partition -Volume $v | Get-Disk)
$ids=@(); $pool=$null; $poolFree=$null
foreach($disk in $d) {
  if($disk.BusType -eq 'Spaces') {
    $vd=@(Get-VirtualDisk -Disk $disk)
    $p=@($vd | Get-StoragePool | Where-Object {-not $_.IsPrimordial})
    if($p.Count -eq 1) {
      $pool=[string]$p[0].UniqueId
      $poolFree=[double]($p[0].Size-$p[0].AllocatedSize)
      $ids+=@($p[0] | Get-PhysicalDisk | ForEach-Object {[string]$_.UniqueId})
    }
  } elseif($disk.BusType -in @('SATA','SAS','USB','NVMe','ATA','SD','MMC','1394')) {
    if($disk.UniqueId) {$ids+=[string]$disk.UniqueId}
  }
}
@{filesystemId=[string]$v.UniqueId;label=[string]$v.FileSystemLabel;physicalDeviceIds=@($ids | Sort-Object -Unique);capacityPoolId=$pool;availableBytes=[double]$v.SizeRemaining;poolAvailableBytes=$poolFree} | ConvertTo-Json -Depth 5 -Compress
`
async function windowsTopology(path: string): Promise<Partial<StorageIdentity>> {
  if (path.startsWith('\\\\')) return {}
  const executable = await resolveExecutable(
    win32.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
  )
  if (!executable) return {}
  const result = await runCommand(
    executable,
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROBE],
    {
      timeoutMs: 8000,
      maxStdoutBytes: 1024 * 1024,
      env: { ...process.env, SECUREREEL_STORAGE_PATH: path }
    }
  )
  if (result.code !== 0 || result.timedOut || result.spawnError) return {}
  const info = asDict(JSON.parse(result.stdout.replace(/^\uFEFF/, '')))
  const free = [bytes(info.availableBytes), bytes(info.poolAvailableBytes)].filter(
    (value): value is number => value !== null
  )
  return {
    ...(text(info.label) ? { label: text(info.label)! } : {}),
    ...(text(info.filesystemId) ? { filesystemId: `win:volume:${text(info.filesystemId)!}` } : {}),
    physicalDeviceIds: unique(
      (Array.isArray(info.physicalDeviceIds) ? info.physicalDeviceIds : []).flatMap((id) =>
        text(id) ? [`win:physical:${text(id)!}`] : []
      )
    ),
    capacityPoolId: text(info.capacityPoolId) ? `win:pool:${text(info.capacityPoolId)!}` : null,
    ...(free.length ? { availableBytes: Math.min(...free) } : {})
  }
}

/** Fresh probes only. A reused mount path must never inherit a previous disk's identity. */
async function identify(path: string): Promise<StorageIdentity> {
  const pathModule = HOST === 'win32' ? win32 : posix
  const normalized = pathModule.normalize(path)
  const identity: StorageIdentity = {
    path: normalized,
    label: pathModule.basename(normalized) || pathModule.parse(normalized).root,
    filesystemId: null,
    physicalDeviceIds: [],
    capacityPoolId: null,
    availableBytes: null,
    present: false
  }
  try {
    const canonical = await realpath(normalized)
    const info = await stat(canonical)
    if (!info.isDirectory()) return identity
    identity.path = canonical
    identity.present = true
    // st_dev is useful for same-filesystem safety when native probing is unavailable;
    // it never establishes physical independence by itself.
    if (HOST !== 'win32' && Number.isSafeInteger(info.dev)) {
      identity.filesystemId = `stat:dev:${info.dev}`
      filesystemDevices.set(identity, info.dev)
    }
  } catch {
    return identity
  }
  try {
    const space = await statfs(identity.path)
    identity.availableBytes = bytes(Number(space.bavail) * Number(space.bsize))
  } catch {
    /* Unknown capacity stays unknown and blocks writing. */
  }
  try {
    const topology =
      HOST === 'darwin'
        ? await macTopology(identity.path)
        : HOST === 'win32'
          ? await windowsTopology(identity.path)
          : {}
    const free = [identity.availableBytes, topology.availableBytes].filter(
      (value): value is number => value !== null && value !== undefined
    )
    Object.assign(identity, topology)
    identity.availableBytes = free.length ? Math.min(...free) : null
  } catch {
    /* Unsupported native topology is reported as unknown, never guessed. */
  }
  return identity
}

/** Connected components handle both shared capacity and transitive physical overlaps. */
function components(
  items: StorageIdentity[],
  related: (a: StorageIdentity, b: StorageIdentity) => boolean
): StorageIdentity[][] {
  const groups: StorageIdentity[][] = []
  for (const item of items) {
    const matching = groups.filter((group) => group.some((other) => related(item, other)))
    if (!matching.length) groups.push([item])
    else {
      const first = matching[0]!
      first.push(item)
      for (const other of matching.slice(1)) {
        first.push(...other)
        groups.splice(groups.indexOf(other), 1)
      }
    }
  }
  return groups
}
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fingerprintIdentity(identity: StorageIdentity): unknown {
  return {
    path: HOST === 'win32' ? identity.path.toLowerCase() : identity.path,
    filesystemId: identity.filesystemId,
    physicalDeviceIds: identity.physicalDeviceIds,
    capacityPoolId: identity.capacityPoolId,
    present: identity.present
  }
}

export async function preflightStorage(input: Input): Promise<TargetPreflightResult> {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) throw new Error('存储预检参数无效，请重新选择目录并检查素材大小')
  const request = parsed.data
  const [source, ...targets] = await Promise.all(
    [request.sourcePath, ...request.targets].map(identify)
  )
  const origin = source!
  const blockingReasons: string[] = []
  const risks: StorageRisk[] = []
  if (!origin.present) blockingReasons.push('源目录不可访问，请重新连接源盘')
  if (targets.some((target) => !target.present))
    blockingReasons.push('目标目录不可访问，请重新连接目标盘或重新选择已有目录')
  const copying = request.mode === 'copy'
  const capacityGroups = components(
    targets,
    (a, b) =>
      sameFilesystem(a, b) || (a.capacityPoolId !== null && a.capacityPoolId === b.capacityPoolId)
  )
  const groups = capacityGroups.map((group) => {
    const available = group.map((identity) => identity.availableBytes)
    const availableBytes = available.some((value) => value === null)
      ? null
      : Math.min(...(available as number[]))
    const requiredBytes = copying ? request.requiredBytes * group.length : 0
    return {
      id: digest(
        group.map((identity) => [identity.filesystemId, identity.capacityPoolId, identity.path])
      ),
      paths: group.map((identity) => identity.path),
      requiredBytes,
      availableBytes,
      sufficient: copying
        ? availableBytes === null
          ? null
          : availableBytes >= requiredBytes
        : true
    }
  })
  if (copying) {
    if (targets.some((target) => sameFilesystem(origin, target)))
      blockingReasons.push('源目录与目标目录位于同一文件系统，不能作为素材备份目标')
    if (groups.some((group) => group.availableBytes === null))
      blockingReasons.push('无法确认目标可用空间，请恢复设备访问后重试')
    for (const group of groups)
      if (group.sufficient === false) risks.push({ code: 'insufficient-space', paths: group.paths })
    for (const group of components(targets, sameFilesystem))
      if (group.length > 1)
        risks.push({ code: 'shared-filesystem', paths: group.map((identity) => identity.path) })
    for (const group of components(targets, overlap))
      if (group.length > 1)
        risks.push({ code: 'shared-device', paths: group.map((identity) => identity.path) })
    for (const target of targets)
      if (overlap(origin, target))
        risks.push({ code: 'source-device', paths: [origin.path, target.path] })
    const unknown = [origin, ...targets].filter(
      (identity) => identity.physicalDeviceIds.length === 0 || identity.filesystemId === null
    )
    if (unknown.length)
      risks.push({ code: 'independence-unknown', paths: unknown.map((identity) => identity.path) })
  }
  const topologyKnown = [origin, ...targets].every(
    (identity) => identity.present && identity.physicalDeviceIds.length > 0
  )
  const independentDeviceGroups = topologyKnown
    ? components(targets, overlap).filter(
        (group) => !group.some((identity) => overlap(origin, identity))
      ).length
    : null
  return {
    fingerprint: digest({
      version: 1,
      mode: request.mode,
      proxyEnabled: request.proxyEnabled ?? false,
      requiredBytes: request.requiredBytes,
      source: fingerprintIdentity(origin),
      targets: targets.map(fingerprintIdentity),
      risks,
      capacityStates: groups.map((group) => ({ paths: group.paths, sufficient: group.sufficient }))
    }),
    checkedAt: new Date().toISOString(),
    source: origin,
    targets,
    groups,
    risks,
    blockingReasons,
    requiredBytes: request.requiredBytes,
    independentDeviceGroups
  }
}

export function checkPreflightConfirmation(
  result: TargetPreflightResult,
  confirmation?: PreflightConfirmation
): void {
  if (result.blockingReasons.length)
    throw new Error(`存储预检未通过：${result.blockingReasons.join('；')}`)
  if (confirmation && confirmation.fingerprint !== result.fingerprint)
    throw new Error('源盘、目标设备或任务要求已变化，请重新检查并确认存储风险')
  if (result.risks.length && (!confirmation || confirmation.acceptRisks !== true))
    throw new Error('请先检查并明确确认存储风险后再继续')
}
