/**
 * 可配置的数据目录。
 *
 * 背景：业务数据默认都在 `app.getPath('userData')` 下，现场经常需要把
 * 报告或数据库放到另一块盘。这里把「配置」与「实际解析」分开：
 *
 *   · 配置是五类目录的绝对路径（`null` = 用默认），存在**固定的 userData**
 *     下的 `data-locations.json` —— 不放进数据库，否则会变成
 *     「库自己记录自己搬到哪」的鸡生蛋问题。
 *   · 解析在每次启动时做一遍：逐类检查「存在、是目录、可写、不是网络盘」，
 *     不可用就回退到默认并返回原因，绝不因为一块盘没插就打不开软件。
 *
 * Chromium 的缓存、Cookie、单实例锁**不在这里**：它们必须留在本机，
 * 所以 `app.setPath('userData')` 全程不动。
 */
import { constants } from 'node:fs'
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import type { AppPaths } from '../paths'

export const DATA_CATEGORIES = ['db', 'reports', 'logs', 'hde', 'companion'] as const
export type DataCategory = (typeof DATA_CATEGORIES)[number]

/** 数据库是文件，配置里存它所在的**目录**；其余四类本身就是目录。 */
export const DB_FILE_NAME = 'securereel.sqlite'

export const dataLocationsSchema = z
  .object({
    version: z.literal(1),
    db: z.string().refine(isAbsolute, '必须是绝对路径').nullable(),
    reports: z.string().refine(isAbsolute, '必须是绝对路径').nullable(),
    logs: z.string().refine(isAbsolute, '必须是绝对路径').nullable(),
    hde: z.string().refine(isAbsolute, '必须是绝对路径').nullable(),
    companion: z.string().refine(isAbsolute, '必须是绝对路径').nullable()
  })
  .strict()

export type DataLocations = z.infer<typeof dataLocationsSchema>

export const EMPTY_LOCATIONS: DataLocations = {
  version: 1,
  db: null,
  reports: null,
  logs: null,
  hde: null,
  companion: null
}

export function locationsFile(userDataDir: string): string {
  return join(userDataDir, 'data-locations.json')
}

/**
 * 读配置。任何异常都退化为「全部默认」：
 * 配置坏了不该让软件起不来，用户还能进去改回来。
 */
export async function readLocations(userDataDir: string): Promise<DataLocations> {
  try {
    const raw = await readFile(locationsFile(userDataDir), 'utf8')
    const parsed = dataLocationsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : EMPTY_LOCATIONS
  } catch {
    return EMPTY_LOCATIONS
  }
}

/** 临时文件 + rename：写到一半断电也不会留下半份 JSON。 */
export async function writeLocationsAtomic(
  userDataDir: string,
  locations: DataLocations
): Promise<void> {
  const target = locationsFile(userDataDir)
  const temp = `${target}.tmp`
  await mkdir(dirname(target), { recursive: true })
  await writeFile(temp, `${JSON.stringify(locations, null, 2)}\n`, 'utf8')
  await rename(temp, target)
}

const NETWORK_FS_TYPES = new Set([
  'smbfs',
  'nfs',
  'afpfs',
  'cifs',
  'webdav',
  'ftp',
  'sshfs',
  '9p',
  'fuse.sshfs'
])

/** macOS/Linux 的 `stat -f %T` 返回的文件系统类型名。 */
export function isNetworkFsType(type: string): boolean {
  return NETWORK_FS_TYPES.has(type.trim().toLowerCase())
}

/** Windows 的 `\\server\share` 与 `//server/share` 一律视为网络路径。 */
export function isUncPath(path: string): boolean {
  return /^\\\\/.test(path) || /^\/\//.test(path)
}

export type LocationProbe = (
  category: DataCategory,
  path: string
) => Promise<{ ok: boolean; reason?: string }>

export interface LocationFallback {
  category: DataCategory
  configured: string
  used: string
  reason: string
}

export interface ResolvedLocations {
  paths: AppPaths
  fallbacks: LocationFallback[]
}

export function defaultDirFor(category: DataCategory, defaults: AppPaths): string {
  switch (category) {
    case 'db':
      return defaults.userDataDir
    case 'reports':
      return defaults.reportsDir
    case 'logs':
      return defaults.logsDir
    case 'hde':
      return defaults.hdeWorkDir
    case 'companion':
      return defaults.companionDir
  }
}

function pathsFromDirs(userDataDir: string, dirs: Record<DataCategory, string>): AppPaths {
  return {
    userDataDir,
    dbFile: join(dirs.db, DB_FILE_NAME),
    reportsDir: dirs.reports,
    logsDir: dirs.logs,
    hdeWorkDir: dirs.hde,
    companionDir: dirs.companion
  }
}

/**
 * 把配置解析成实际路径。
 *
 * `probe` 由调用方注入（主进程用真实文件系统，测试里用假实现），
 * 这样这段判定逻辑可以在 node 环境里单测。
 */
export async function resolveLocations(
  defaults: AppPaths,
  locations: DataLocations,
  probe: LocationProbe
): Promise<ResolvedLocations> {
  const dirs = {} as Record<DataCategory, string>
  const fallbacks: LocationFallback[] = []

  for (const category of DATA_CATEGORIES) {
    const fallbackDir = defaultDirFor(category, defaults)
    const configured = locations[category]
    if (configured === null) {
      dirs[category] = fallbackDir
      continue
    }
    const verdict = await probe(category, configured)
    if (verdict.ok) {
      dirs[category] = configured
      continue
    }
    dirs[category] = fallbackDir
    fallbacks.push({
      category,
      configured,
      used: fallbackDir,
      reason: verdict.reason ?? '不可用'
    })
  }

  return { paths: pathsFromDirs(defaults.userDataDir, dirs), fallbacks }
}

/**
 * 真实文件系统探测。
 *
 * 只检查「能不能用」，不创建目录 —— 创建发生在迁移与启动的 ensureDir 阶段，
 * 这样用户在设置页选错路径时不会到处留空目录。
 */
export function createFsProbe(options: {
  /** 返回该路径所在的文件系统类型；拿不到就返回 null */
  fsTypeOf: (path: string) => Promise<string | null>
}): LocationProbe {
  return async (_category, path) => {
    if (!isAbsolute(path)) return { ok: false, reason: '不是绝对路径' }
    if (isUncPath(path)) return { ok: false, reason: '不支持网络路径' }
    try {
      const info = await stat(path)
      if (!info.isDirectory()) return { ok: false, reason: '不是目录' }
    } catch {
      return { ok: false, reason: '目录不存在或无法访问' }
    }
    try {
      await access(path, constants.W_OK)
    } catch {
      return { ok: false, reason: '目录不可写' }
    }
    const fsType = await options.fsTypeOf(path)
    if (fsType !== null && isNetworkFsType(fsType)) {
      return { ok: false, reason: `不支持网络盘（${fsType}）` }
    }
    return { ok: true }
  }
}

/** 目标必须为空目录：迁移不会覆盖已有文件，选错目录要当场拦住。 */
export async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path)
    return entries.length === 0
  } catch {
    return false
  }
}

/** 源与目标不能互相包含，否则迁移会把自己复制进自己。 */
export function isSameOrNested(a: string, b: string): boolean {
  const left = resolve(a)
  const right = resolve(b)
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}
