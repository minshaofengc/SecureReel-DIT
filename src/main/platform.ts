/**
 * 平台差异的「决策层」。
 *
 * 为什么单独抽一层，而不是到处写 `if (process.platform === 'win32')`：
 *
 *   1. **可测试**。下面每个函数都把平台作为显式可选参数（默认取本机）。
 *      于是「Windows 分支对不对」这件事，在 macOS 上就能用 vitest 直接断言 ——
 *      不需要一台 Windows 机器，也不需要去 mock `process.platform`。
 *      就地写 if 分支的话，Windows 那半边永远是「没跑过」的代码。
 *
 *   2. **mac 端零变化**。默认参数就是本机平台，且每个 Windows 分支都只在
 *      `platform === 'win32'` 时才生效，darwin 分支逐字保留原实现。
 *
 *   3. **不破坏分层**。本文件只 import `node:path`，没有 IO、不碰 Electron，
 *      因此它属于 `main/`；**绝不能**挪进 `shared/`（那一层必须无 Node）。
 */
import { posix, win32 } from 'node:path'

export type HostPlatform = 'darwin' | 'win32' | 'linux'

/** 本机平台。只区分我们实际要处理的三类，其余一律归入 linux。 */
export const HOST: HostPlatform =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'

export const IS_MAC = HOST === 'darwin'
export const IS_WINDOWS = HOST === 'win32'

/**
 * 按**目标**平台选 path 模块。
 *
 * 这里必须显式选，不能用宿主机的 `node:path`：
 * 在 macOS 上 `path.parse('D:\\')` 会把它当成一个「没有根」的相对名字，
 * 而 Windows 上同一个调用的 root 是 `'D:\'` —— 盘符根会算错，进而
 * 让「削尾分隔符」把 `D:\` 削成 `D:`（盘符相对路径，语义完全变了）。
 */
function pathOf(platform: HostPlatform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/** PATH 类环境变量的分隔符：POSIX 是 `:`，Windows 是 `;`。 */
export function pathListSeparator(platform: HostPlatform = HOST): string {
  return platform === 'win32' ? ';' : ':'
}

/**
 * 什么后缀算「可执行文件」。
 *
 * POSIX 靠文件模式位（返回 `['']` 表示不加后缀）；
 * Windows 没有执行位，靠 `PATHEXT` 约定的扩展名判断。
 */
export function executableExtensions(
  platform: HostPlatform = HOST,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (platform !== 'win32') return ['']
  // Windows 上环境变量的键名大小写不固定，两个都认一下
  const raw = env['PATHEXT'] ?? env['PathExt'] ?? '.COM;.EXE;.BAT;.CMD'
  const list = raw
    .split(';')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
  return list.length > 0 ? list : ['.exe']
}

/** 给裸名字补上平台的可执行后缀：`ffprobe` → Windows 上是 `ffprobe.exe`。 */
export function executableName(base: string, platform: HostPlatform = HOST): string {
  return platform === 'win32' ? `${base}.exe` : base
}

/**
 * 两个路径字符串是否指向「同一个东西」。
 *
 * NTFS 大小写不敏感，APFS/HFS+ 默认大小写敏感 —— 这条差异绝不能搞反，
 * 否则要么在 Windows 上误判「路径逃逸」，要么在 macOS 上漏判。
 */
export function samePathName(a: string, b: string, platform: HostPlatform = HOST): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 路径的「根」长度 —— 也就是削尾分隔符时的长度下限。
 *
 * `'/'` → 1，`'D:\'` → 3，`'\\srv\share\'` → 13。
 * 低于这个长度再削就会把根本身削掉（`D:\` 变 `D:`），那是另一种路径语义。
 */
export function pathRootLength(path: string, platform: HostPlatform = HOST): number {
  return pathOf(platform).parse(path).root.length
}

/** 系统盘在界面上叫什么。macOS 上一直是「启动磁盘」，沿用旧文案。 */
export function systemVolumeLabel(platform: HostPlatform = HOST): string {
  return platform === 'win32' ? '系统盘' : '启动磁盘'
}

/** 给渲染层挂 `data-platform` 用的标记。 */
export function platformTag(platform: HostPlatform = HOST): string {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux'
}

/**
 * Windows 无边框标题栏（`titleBarOverlay`）总开关 —— 降级逃生口。
 *
 * 万一真机上出现「窗口拖不动 / 按钮点不到 / 高对比度模式下按钮看不清」，
 * 把这里改成 `false` 重新打包即可退回 Windows 原生标题栏，
 * 界面其余部分不需要任何改动（见 index.ts 的 titleBar 分支）。
 */
export const USE_OVERLAY_TITLEBAR = true

/**
 * Windows 标题栏叠加层的高度。
 *
 * 取 40 不是随手定的：渲染层的 `.sidebar` 顶部留白与 `.main` 的上内边距
 * 本来就都是 40px（那是给 macOS 红绿灯留的位置），把叠加层也做成 40
 * 就能让两侧的留白**共用同一套数值**，一行 CSS 都不用为 Windows 改动。
 */
export const TITLE_BAR_HEIGHT = 40
