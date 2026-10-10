/**
 * 卷的枚举与弹出 —— 两个平台上实现方式完全不同的那一层。
 *
 * 为什么不放在 `fs-utils.ts` 里：那一层是「纯原语」（路径、遍历、容量、原子改名），
 * 只依赖 Node，可以被大量单元测试直接调用；而这里的 Windows 分支要起 PowerShell
 * 子进程，还要经过 `exec.ts`。把它单独放一层，既避免 `fs-utils → volume-win → exec → fs-utils`
 * 的循环依赖，也让「哪些代码在测试里是可以不放子进程就跑的」这条界线保持清楚。
 *
 * macOS 的两个实现**逐字保留**了原先写在 `fs-utils.ts` 里的行为（`/Volumes` 枚举 + `diskutil eject`），
 * 目的只有一个：本次跨平台改造对 macOS 端必须是零变化。
 */
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Language } from '@shared/types'
import { msg } from '@shared/messages'
import { describeError, invalidateVolumeCache } from './fs-utils'
import { HOST, type HostPlatform } from './platform'
import { ejectWindowsVolume, listWindowsVolumes, windowsDriveRoot } from './volume-win'

export interface VolumeEntry {
  /** 卷根：macOS 是 `/Volumes/A001`，Windows 是 `E:\` */
  root: string
  /** 卷标；拿不到时为 null，调用方回退到盘符 */
  label: string | null
}

/**
 * 枚举当前机器上可用的卷。
 *
 * - macOS：`/Volumes` 下的挂载目录（读了读不到就返回空列表，与旧行为一致）
 * - Windows：存在的盘符（纯 Node 探测保底，再用 PowerShell 补卷标）
 *
 * 每次调用都会清一次挂载点缓存 —— 盘符会被系统复用（拔掉 E: 再插一块新盘还是 E:），
 * 缓存不清就会拿着上一块盘的挂载点去操作新盘。
 */
export async function listVolumeEntries(platform: HostPlatform = HOST): Promise<VolumeEntry[]> {
  invalidateVolumeCache()

  if (platform === 'win32') {
    return (await listWindowsVolumes()).map((volume) => ({ root: volume.root, label: volume.label }))
  }

  const entries: VolumeEntry[] = []
  try {
    const children = await readdir('/Volumes', { withFileTypes: true })
    for (const child of children) {
      if (!child.isDirectory() && !child.isSymbolicLink()) continue
      entries.push({ root: join('/Volumes', child.name), label: child.name })
    }
  } catch {
    /* /Volumes 读不到就返回空列表 */
  }
  return entries
}

/**
 * Windows 卷标的短时缓存。
 *
 * 每次取卷标都要起一次 PowerShell（几百毫秒），而一次界面刷新里
 * 「列卷 + 逐个 inspect」会问好几遍，所以这里压 2 秒。
 */
let windowsLabelCache: { at: number; labels: Map<string, string> } | null = null
const WINDOWS_LABEL_TTL_MS = 2_000

/**
 * 取某个挂载点的**卷标**（像 `A001` 这种），拿不到返回 null。
 *
 * macOS 上不需要：`describeVolume` 用挂载目录名就能给出正确的名字。
 * Windows 上 Node 拿不到卷标，要 PowerShell —— 拿不到就让调用方回退到盘符（`E:`），
 * 绝不让整个卷列表因此变成空的。
 */
export async function volumeLabelFor(
  mountPoint: string,
  platform: HostPlatform = HOST
): Promise<string | null> {
  if (platform !== 'win32') return null
  const root = windowsDriveRoot(mountPoint)
  if (root === null) return null

  const now = Date.now()
  if (windowsLabelCache === null || now - windowsLabelCache.at >= WINDOWS_LABEL_TTL_MS) {
    const labels = new Map<string, string>()
    for (const volume of await listWindowsVolumes()) {
      if (volume.label !== null) labels.set(volume.root.toUpperCase(), volume.label)
    }
    windowsLabelCache = { at: now, labels }
  }
  return windowsLabelCache.labels.get(root.toUpperCase()) ?? null
}

/**
 * 弹出目标盘（macOS）。
 *
 * 只用参数数组 + `shell: false` —— 路径里出现空格、引号、`$(...)` 都不会被解释。
 * 这是本项目对所有外部命令调用的统一姿势。
 */
function ejectMacVolume(
  mountPoint: string,
  language: Language
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const child = spawn('/usr/sbin/diskutil', ['eject', mountPoint], { shell: false })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      resolve({
        ok: false,
        message: msg(language, 'eject.commandFailed', { reason: describeError(error) })
      })
    })
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, message: msg(language, 'eject.done') })
      else {
        resolve({
          ok: false,
          message: stderr.trim() || msg(language, 'eject.exitCode', { code: code ?? '?' })
        })
      }
    })
  })
}

/**
 * 弹出卷，按平台分派。
 *
 * Windows 那一侧没有 `diskutil eject` 的等价物，只能在 `volume-win.ts` 里
 * 逐级降级并**用「盘符是否真的消失」来确认结果** —— 绝不谎报成功。
 */
export async function ejectVolume(
  mountPoint: string,
  language: Language = 'zh-CN',
  platform: HostPlatform = HOST
): Promise<{ ok: boolean; message: string }> {
  if (platform === 'win32') return ejectWindowsVolume(mountPoint, language)
  if (platform !== 'darwin') return { ok: false, message: msg(language, 'eject.unsupported') }
  return ejectMacVolume(mountPoint, language)
}

/**
 * 关机延迟（秒）。
 *
 * 刻意**不立即关**：给用户一段可以反悔的窗口 —— 一个跑了整夜的任务在
 * 凌晨三点关机前，人可能刚好回到桌前。60 秒足够看清是哪个任务完成、
 * 也足够去系统里取消（macOS 会弹一个带倒计时的对话框，可直接取消）。
 */
export const SHUTDOWN_DELAY_SECONDS = 60

/**
 * 安排关机（跨平台分派）。
 *
 * ⚠️ 这是**破坏性操作**，调用方必须自己保证：只在任务**成功完成**时调用，
 * 且排在所有目标弹出**之后**（先安全卸载磁盘再断电，顺序反了会丢盘）。
 *
 * - macOS：`osascript` 让 System Events 关机。系统会自己弹一个带倒计时的
 *   确认框，用户可取消；不需要 sudo。
 * - Windows：`shutdown /s /t <delay>`，系统自带的缓冲倒计时，`shutdown /a` 可取消。
 * - 其他平台：明确返回不支持，绝不假装成功。
 *
 * 命令行参数全部走参数数组（`shell: false`），与弹出卷保持同一姿势。
 */
export function scheduleShutdown(
  language: Language = 'zh-CN',
  delaySeconds: number = SHUTDOWN_DELAY_SECONDS,
  platform: HostPlatform = HOST
): Promise<{ ok: boolean; message: string }> {
  if (platform === 'darwin') {
    return runShutdown(
      '/usr/bin/osascript',
      ['-e', 'tell application "System Events" to shut down'],
      language
    )
  }
  if (platform === 'win32') {
    // shutdown.exe 在 System32 下；与 volume-win.ts 一样优先用系统路径，PATH 兜底。
    const systemRoot = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows'
    const exe = join(systemRoot, 'System32', 'shutdown.exe')
    return runShutdown(exe, ['/s', '/t', String(Math.max(0, Math.floor(delaySeconds)))], language)
  }
  return Promise.resolve({ ok: false, message: msg(language, 'shutdown.unsupported') })
}

function runShutdown(
  executable: string,
  args: string[],
  language: Language
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { shell: false })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      resolve({
        ok: false,
        message: msg(language, 'shutdown.commandFailed', { reason: describeError(error) })
      })
    })
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, message: msg(language, 'shutdown.scheduled') })
      else {
        resolve({
          ok: false,
          message: stderr.trim() || msg(language, 'shutdown.exitCode', { code: code ?? '?' })
        })
      }
    })
  })
}
