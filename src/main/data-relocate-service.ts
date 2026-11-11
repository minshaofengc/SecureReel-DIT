/**
 * 把某一类数据搬到新目录，并立即切换过去。
 *
 * 这里是最容易出事的一段：数据库正开着、日志正在写、报告库持有路径。
 * 所以顺序是固定的，且每一步失败都要能退回旧状态：
 *
 *   1. 有运行中任务 → 直接拒绝（不能一边拷卡一边换库）
 *   2. 校验目标目录（空、可写、非网络盘、不与源互相包含）
 *   3. 复制（不覆盖已有文件）—— **数据库三件套要一起搬**，只搬主文件会丢 WAL 里的事务
 *   4. 数据库先打开新的、成功后才关旧的（`Store.rebind` 内部保证）
 *   5. 日志 flush 后换目录
 *   6. 改 `paths` 的字段（不重新赋值），最后原子写配置
 *
 * 任何一步抛错，前面的步骤都已经保持旧状态可继续使用；配置没写，重启后仍是旧路径。
 */
import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { buildAppPaths, type AppPaths } from './paths'
import type { Logger } from './logger'
import type { Store } from './db/store'
import {
  DATA_CATEGORIES,
  DB_FILE_NAME,
  defaultDirFor,
  isEmptyDirectory,
  isNetworkFsType,
  isSameOrNested,
  isUncPath,
  readLocations,
  writeLocationsAtomic,
  type DataCategory,
  type DataLocations
} from './core/data-locations'

/** SQLite 的 WAL 与共享内存必须跟主文件一起搬。 */
const DB_SIDECARS = ['-wal', '-shm']

export interface RelocateDeps {
  paths: AppPaths
  store: Store
  logger: Logger
  userDataDir: string
  /** 有任务在跑/在排队时不允许切换 */
  hasActiveWork: () => boolean
  /** 取目标路径所在的文件系统类型；拿不到返回 null */
  fsTypeOf: (path: string) => Promise<string | null>
}

export interface RelocateOutcome {
  copied: number
  skipped: number
}

function currentDirOf(paths: AppPaths, category: DataCategory): string {
  switch (category) {
    case 'db':
      return dirname(paths.dbFile)
    case 'reports':
      return paths.reportsDir
    case 'logs':
      return paths.logsDir
    case 'hde':
      return paths.hdeWorkDir
    case 'companion':
      return paths.companionDir
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 把 `from` 的内容复制进 `to`，**已存在的文件跳过、绝不覆盖**。
 *
 * 不覆盖是有意的：旧数据是用户唯一的退路。冲突时宁可少搬，也不静默盖掉。
 */
async function copyContents(from: string, to: string): Promise<RelocateOutcome> {
  await mkdir(to, { recursive: true })
  let copied = 0
  let skipped = 0
  for (const entry of await readdir(from)) {
    const source = join(from, entry)
    const target = join(to, entry)
    if (await exists(target)) {
      skipped++
      continue
    }
    await cp(source, target, { recursive: true, force: false, errorOnExist: false })
    copied++
  }
  return { copied, skipped }
}

async function copyDatabase(fromDir: string, toDir: string): Promise<RelocateOutcome> {
  await mkdir(toDir, { recursive: true })
  let copied = 0
  let skipped = 0
  for (const name of [DB_FILE_NAME, ...DB_SIDECARS.map((suffix) => `${DB_FILE_NAME}${suffix}`)]) {
    const source = join(fromDir, name)
    if (!(await exists(source))) continue
    const target = join(toDir, name)
    if (await exists(target)) {
      skipped++
      continue
    }
    await cp(source, target, { force: false, errorOnExist: false })
    copied++
  }
  return { copied, skipped }
}

export async function relocateCategory(
  deps: RelocateDeps,
  category: DataCategory,
  target: string
): Promise<RelocateOutcome> {
  if (deps.hasActiveWork()) {
    throw new Error('有任务正在运行或排队，请等任务结束后再更改数据目录。')
  }

  const from = currentDirOf(deps.paths, category)
  if (isSameOrNested(from, target)) {
    throw new Error('新目录不能与当前目录相同或互相包含。')
  }
  if (isUncPath(target)) throw new Error('不支持网络路径。')
  if (!(await exists(target))) throw new Error('目标目录不存在。')
  if (!(await isEmptyDirectory(target))) {
    throw new Error('目标目录不是空的。请选一个空目录，避免与已有文件混在一起。')
  }
  const fsType = await deps.fsTypeOf(target)
  if (fsType !== null && isNetworkFsType(fsType)) {
    throw new Error(`不支持网络盘（${fsType}）。`)
  }

  const outcome =
    category === 'db' ? await copyDatabase(from, target) : await copyContents(from, target)

  if (category === 'db') {
    // 先开新库、成功后才关旧库；打不开会抛错，旧库仍然可用
    await deps.store.rebind(join(target, DB_FILE_NAME))
    deps.paths.dbFile = join(target, DB_FILE_NAME)
  } else if (category === 'logs') {
    await deps.logger.rebind(target)
    deps.paths.logsDir = target
  } else if (category === 'reports') {
    deps.paths.reportsDir = target
  } else if (category === 'hde') {
    deps.paths.hdeWorkDir = target
  } else {
    deps.paths.companionDir = target
  }

  const current = await readLocations(deps.userDataDir)
  const next: DataLocations = { ...current, [category]: target }
  await writeLocationsAtomic(deps.userDataDir, next)

  deps.logger.info(
    'app',
    `数据目录已切换：${category} → ${target}（复制 ${outcome.copied} 项，跳过 ${outcome.skipped} 项）`
  )
  return outcome
}

/** 恢复默认：只改配置，不搬文件 —— 已迁移的数据仍留在原目录。 */
export async function resetCategory(
  deps: RelocateDeps,
  category: DataCategory
): Promise<void> {
  if (deps.hasActiveWork()) {
    throw new Error('有任务正在运行或排队，请等任务结束后再更改数据目录。')
  }
  const defaults = buildAppPaths(deps.userDataDir)
  const dir = defaultDirFor(category, defaults)

  if (category === 'db') {
    await deps.store.rebind(join(dir, DB_FILE_NAME))
    deps.paths.dbFile = join(dir, DB_FILE_NAME)
  } else if (category === 'logs') {
    await deps.logger.rebind(dir)
    deps.paths.logsDir = dir
  } else if (category === 'reports') {
    deps.paths.reportsDir = dir
  } else if (category === 'hde') {
    deps.paths.hdeWorkDir = dir
  } else {
    deps.paths.companionDir = dir
  }

  const current = await readLocations(deps.userDataDir)
  await writeLocationsAtomic(deps.userDataDir, { ...current, [category]: null })
  deps.logger.info('app', `数据目录已恢复默认：${category} → ${dir}`)
}

export { DATA_CATEGORIES }
