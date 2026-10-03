/**
 * Windows 专属的卷操作。
 *
 * 为什么单独一个文件：Windows 上「枚举有哪些盘」和「弹出某个盘」这两件事
 * **没有** macOS 那种干净的系统原语 ——
 *   · 枚举要 PowerShell（`Get-Volume` / `Win32_LogicalDisk`）才拿得到卷标；
 *   · 弹出更是根本没有 `diskutil eject` 的等价物，只能靠 Shell 的 Eject 动词，
 *     而那个动词是「发出去就不管结果」的，多槽位读卡器还常常不实现它。
 *
 * 所以这里的策略是：**能拿到多少就给多少，拿不到就老实降级并说明原因**，
 * 绝不谎报成功（本项目对「弹出磁盘」的硬性要求）。
 *
 * 依赖方向：本文件 → `exec.ts`（外部命令唯一出口）→ `fs-utils.ts`。
 * `fs-utils.ts` 不反向依赖本文件，避免循环。
 */
import { statfs, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { Language } from '@shared/types'
import { msg } from '@shared/messages'
import { runCommand } from './exec'
import { whichInPath } from './fs-utils'

/** 一个 Windows 卷的原始信息。 */
export interface WindowsVolume {
  /** 盘符根，形如 `E:\` */
  root: string
  /** 卷标；拿不到或为空时为 null */
  label: string | null
  fileSystem: string | null
  /** Win32_LogicalDisk 的 DriveType：2=可移动 3=本地 4=网络 5=光驱 */
  driveType: number | null
}

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/** 光驱（DriveType 5）里没放盘时不该出现在源盘列表里。 */
const DRIVE_TYPE_OPTICAL = 5

/** 把任意路径归一成盘符根：`E:\Cards\A001` → `E:\`。 */
export function windowsDriveRoot(path: string): string | null {
  const match = /^([A-Za-z]):/.exec(path)
  return match === null ? null : `${match[1]!.toUpperCase()}:\\`
}

/**
 * 找出 PowerShell 的绝对路径。
 *
 * 优先用系统自带的 Windows PowerShell 5.1（`%SystemRoot%\System32\WindowsPowerShell\v1.0\`）——
 * 它从 Windows 7 起就在，比 PowerSell 7（`pwsh`）可靠得多。
 * 只有系统路径也不存在时才去 PATH 里碰运气。
 */
async function resolvePowerShell(): Promise<string | null> {
  const systemRoot = process.env['SystemRoot'] ?? process.env['windir']
  if (systemRoot !== undefined && systemRoot !== '') {
    const bundled = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    try {
      await access(bundled, constants.F_OK)
      return bundled
    } catch {
      /* 继续往下找 */
    }
  }
  return whichInPath('powershell', process.env, 'win32')
}

/** 跑一段 PowerShell 脚本，返回 stdout（失败时返回 null）。 */
async function runPowerShell(script: string, timeoutMs = 15_000): Promise<string | null> {
  const shell = await resolvePowerShell()
  if (shell === null) return null
  const result = await runCommand(
    shell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeoutMs }
  )
  if (result.spawnError !== null || result.timedOut || result.code !== 0) return null
  return result.stdout
}

/**
 * 用纯 Node 探一遍 A:–Z:，返回**确实存在**的盘符根。
 *
 * 这一步不需要任何子进程，所以即使 PowerShell 被企业策略禁掉，
 * 卷列表也不至于是空的 —— 只是少了个卷标而已。
 */
async function probeExistingRoots(): Promise<string[]> {
  const roots = await Promise.all(
    DRIVE_LETTERS.map(async (letter) => {
      const root = `${letter}:\\`
      try {
        await statfs(root)
        return root
      } catch {
        return null
      }
    })
  )
  return roots.filter((root): root is string => root !== null)
}

interface LogicalDiskRow {
  DeviceID?: unknown
  VolumeName?: unknown
  FileSystem?: unknown
  DriveType?: unknown
}

/** PowerShell 可能把单元素数组输出成对象、也可能带上 BOM，统一在这里掰直。 */
function parseLogicalDisks(raw: string): LogicalDiskRow[] {
  const text = raw.replace(/^\uFEFF/, '').trim()
  if (text === '') return []
  try {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed as LogicalDiskRow[]
    if (parsed !== null && typeof parsed === 'object') return [parsed as LogicalDiskRow]
    return []
  } catch {
    return []
  }
}

/**
 * 枚举 Windows 上的卷。
 *
 * 分两步：先纯 Node 探出存在的盘符（保底），再用一次 PowerShell 把卷标、
 * 文件系统、驱动器类型一次性补上（增强）。PowerShell 不可用时只丢卷标，
 * **不会**让整个列表变成空的。
 */
export async function listWindowsVolumes(): Promise<WindowsVolume[]> {
  const roots = await probeExistingRoots()
  if (roots.length === 0) return []

  const script = [
    '$d = @(Get-CimInstance -ClassName Win32_LogicalDisk |',
    '  Select-Object DeviceID,VolumeName,FileSystem,DriveType)',
    'ConvertTo-Json -InputObject $d -Compress -Depth 3'
  ].join(' ')
  const raw = await runPowerShell(script)

  const byRoot = new Map<string, LogicalDiskRow>()
  if (raw !== null) {
    for (const row of parseLogicalDisks(raw)) {
      const deviceId = typeof row.DeviceID === 'string' ? row.DeviceID.toUpperCase() : ''
      if (deviceId !== '') byRoot.set(deviceId, row)
    }
  }

  const volumes: WindowsVolume[] = []
  for (const root of roots) {
    const letter = root.slice(0, 2).toUpperCase()
    const row = byRoot.get(letter)
    const driveType = row !== undefined && typeof row.DriveType === 'number' ? row.DriveType : null
    const fileSystem = row !== undefined && typeof row.FileSystem === 'string' ? row.FileSystem : null
    // 空光驱：盘符在，但没有文件系统 —— 放进去只会让用户困惑
    if (driveType === DRIVE_TYPE_OPTICAL && (fileSystem === null || fileSystem === '')) continue
    const rawLabel = row !== undefined && typeof row.VolumeName === 'string' ? row.VolumeName.trim() : ''
    volumes.push({
      root,
      label: rawLabel === '' ? null : rawLabel,
      fileSystem: fileSystem === '' ? null : fileSystem,
      driveType
    })
  }
  return volumes
}

/** 轮询等待盘符消失，确认弹出真的发生了。 */
async function waitForVolumeGone(root: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await access(root, constants.F_OK)
    } catch {
      return true
    }
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * 弹出 Windows 上的可移动磁盘。
 *
 * Windows 没有 `diskutil eject` 的等价物，只能逐级降级：
 *   1. Shell 的 Eject 动词（最接近 macOS 的行为，但**发出去就没有返回值**）
 *   2. `Win32_Volume.Dismount()`（不强制，遇到占用会拒绝）
 * 每一步之后都**轮询盘符是否真的消失**才敢判成功 —— 这是唯一能确认的办法。
 * 全部失败时给出明确的手动操作指引，绝不谎报。
 */
export async function ejectWindowsVolume(
  mountPoint: string,
  language: Language = 'zh-CN'
): Promise<{ ok: boolean; message: string }> {
  const root = windowsDriveRoot(mountPoint) ?? mountPoint
  const driveLetter = root.replace(/[\\/]+$/, '')

  if ((await resolvePowerShell()) === null) {
    return { ok: false, message: msg(language, 'eject.noShell') }
  }

  // ① Shell 的 Eject 动词。
  //    动件的显示名会跟着系统语言变（英文 Eject / 中文「弹出」），而且带 & 助记符，
  //    所以先按名字找，找不到再退回英文动词名。
  const ejectScript = [
    `$shell = New-Object -ComObject Shell.Application`,
    `$item = $shell.Namespace(17).ParseName('${driveLetter}')`,
    `if ($item -ne $null) {`,
    `  $verb = $item.Verbs() | Where-Object { $_.Name -match 'Eject|弹出|取り出し|Auswerfen' } | Select-Object -First 1`,
    `  if ($verb -ne $null) { $verb.DoIt() } else { $item.InvokeVerb('Eject') }`,
    `}`
  ].join('; ')
  await runPowerShell(ejectScript, 20_000)
  if (await waitForVolumeGone(root, 10_000)) return { ok: true, message: msg(language, 'eject.done') }

  // ② 卸载卷（不强制）。对「Shell 动词没实现」的多槽位读卡器往往能把盘卸掉。
  const dismountScript = [
    `$v = Get-CimInstance -ClassName Win32_Volume -Filter "DriveLetter='${driveLetter}'"`,
    `if ($v -ne $null) { $v.Dismount($false, $false) }`
  ].join('; ')
  await runPowerShell(dismountScript, 20_000)
  if (await waitForVolumeGone(root, 8_000)) return { ok: true, message: msg(language, 'eject.done') }

  // 两步都没让盘符消失 —— 如实说失败，并给出可执行的手动步骤。
  return { ok: false, message: msg(language, 'eject.failedWindows') }
}
