/**
 * 文件系统底层工具。
 *
 * 这一层只做「安全的机械动作」：遍历、容量探测、原子改名、卷标推断、弹出。
 * 业务语义（校验、断点、报告）不在这里，全部在 core/ 下。
 */
import { spawn } from 'node:child_process'
import { constants, type Dirent } from 'node:fs'
import {
  access,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  unlink
} from 'node:fs/promises'
import { basename, dirname, join, posix, relative, sep } from 'node:path'

/* ------------------------------------------------------------------ *
 * 路径规范化与安全
 * ------------------------------------------------------------------ */

/**
 * 把路径统一成清单里要用的 POSIX 风格。
 *
 * 注意：**只替换平台分隔符**，不把反斜杠当分隔符转换。
 * 原因是 macOS 上 `\` 是合法的文件名字符（HFS+/APFS 允许），
 * 如果无差别地把 `\` 换成 `/`，清单里就会写出一个不存在的路径 ——
 * 那比格式不统一严重得多。本应用只面向 macOS，分隔符本来就是 `/`。
 */
export function toPosix(path: string): string {
  if (sep === '/') return path
  return path.split(sep).join(posix.sep)
}

/**
 * 去掉路径末尾多余的分隔符。
 *
 * 为什么必须做：`/Volumes/CARD/` 与 `/Volumes/CARD` 指的是同一个目录，
 * 但**字符串长度差 1**。所有"用 root 的长度去切相对路径"的写法
 * （曾经的 `absPath.slice(root.length + 1)`）在带尾斜杠时会多切一个字符，
 * 把每条相对路径的首字母吃掉 —— 扫描阶段看不出问题，一开跑
 * 每个文件都拼不出真实路径、全部报"读取源文件失败"。
 *
 * 入口是界面上的路径输入框，用户从访达「拷贝路径」或终端粘贴时
 * 极容易带上尾斜杠，所以这里必须兜住，而不是指望用户不犯错。
 *
 * 根目录 `/` 是特例：不能削成空串（那样就变成相对路径了）。
 */
export function stripTrailingSeparators(path: string): string {
  let end = path.length
  while (end > 1 && (path[end - 1] === '/' || path[end - 1] === sep)) end--
  return path.slice(0, end)
}

/**
 * 校验并规范化相对路径。
 *
 * 任何试图逃出根目录（`..`）或包含 NUL 的路径一律拒绝 ——
 * 这是防止把文件写到目标盘之外的关键闸门。
 */
export function normalizeRelPath(relPath: string): string {
  if (relPath.includes('\0')) {
    throw new Error('相对路径包含非法字符')
  }
  const posixPath = toPosix(relPath).replace(/^\.\//, '')
  const segments = posixPath.split(posix.sep).filter((segment) => segment !== '' && segment !== '.')

  for (const segment of segments) {
    if (segment === '..') {
      throw new Error(`相对路径试图跳出根目录：${relPath}`)
    }
  }

  const normalized = segments.join(posix.sep)
  if (normalized === '') {
    throw new Error('相对路径为空')
  }
  return normalized
}

/** 把规范化后的相对路径还原成绝对路径，并再次确认没有逃逸。 */
export function resolveInside(root: string, relPath: string): string {
  const normalized = normalizeRelPath(relPath)
  const base = stripTrailingSeparators(root)
  const absolute = join(base, normalized)
  const rootWithSep = base.endsWith(sep) ? base : base + sep
  if (absolute !== base && !absolute.startsWith(rootWithSep)) {
    throw new Error(`路径逃逸检测：${absolute} 不在 ${root} 之内`)
  }
  return absolute
}

/* ------------------------------------------------------------------ *
 * 目录遍历
 * ------------------------------------------------------------------ */

export interface WalkedFile {
  relPath: string
  absPath: string
  sizeBytes: number
}

export interface WalkResult {
  files: WalkedFile[]
  totalBytes: number
  /** 遍历时收集到的问题（无权限、坏链接等），不中断整体拷贝 */
  warnings: string[]
}

export interface WalkOptions {
  /** 是否跳过 macOS / Windows 的系统垃圾文件 */
  skipSystemFiles?: boolean
  /** 上限保护，超过则停止并告警，避免误选整个启动盘 */
  maxFiles?: number
  signal?: AbortSignal
}

/** macOS 上应当忽略的文件名（先按大小写不敏感匹配）。 */
const SYSTEM_FILE_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized'])
const SYSTEM_DIR_NAMES = new Set(['.spotlight-v100', '.trashes', '.fseventsd', '.documentrevisions-v100', '.temporaryitems'])

function isSkippable(name: string, isDirectory: boolean): boolean {
  const lower = name.toLowerCase()
  if (isDirectory) return SYSTEM_DIR_NAMES.has(lower)
  return SYSTEM_FILE_NAMES.has(lower)
}

/**
 * 递归遍历一个目录，返回全部普通文件。
 *
 * - 不跟随符号链接（避免环）
 * - 逐个目录读取，遇到无权限的目录只记录 warning
 * - `partial` 后缀的本软件中转文件不会被当成素材
 */
export async function walkFiles(root: string, options: WalkOptions = {}): Promise<WalkResult> {
  const { skipSystemFiles = true, maxFiles = 200_000, signal } = options
  // 先削掉尾斜杠：否则下面算 relPath 时会把每条路径的首字母切掉（见 stripTrailingSeparators）
  const base = stripTrailingSeparators(root)
  const files: WalkedFile[] = []
  const warnings: string[] = []
  let totalBytes = 0
  const queue: string[] = [base]
  let truncated = false

  while (queue.length > 0) {
    if (signal?.aborted) throw new Error('遍历被取消')
    const current = queue.shift() as string

    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      warnings.push(`${current}：无法读取目录（${describeError(error)}）`)
      continue
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true
        break
      }

      const absPath = join(current, entry.name)
      // 用 relative() 而不是"按 root 的长度切字符串"：后者对尾斜杠、
      // 重复分隔符这类输入太脆弱，一个字符之差就会静默毁掉全部相对路径。
      const relPath = toPosix(relative(base, absPath))

      if (entry.isSymbolicLink()) {
        // 不跟随链接：DIT 现场常见软链指回源盘，跟进去会造成重复拷贝
        continue
      }

      if (entry.isDirectory()) {
        if (skipSystemFiles && isSkippable(entry.name, true)) continue
        queue.push(absPath)
        continue
      }

      if (!entry.isFile()) continue
      if (skipSystemFiles && isSkippable(entry.name, false)) continue
      if (entry.name.includes(PARTIAL_MARKER)) continue

      let size = 0
      try {
        const info = await stat(absPath)
        size = info.size
      } catch (error) {
        warnings.push(`${relPath}：无法读取文件信息（${describeError(error)}）`)
        continue
      }

      files.push({ relPath, absPath, sizeBytes: size })
      totalBytes += size
    }

    if (truncated) break
  }

  if (truncated) {
    warnings.push(`文件数量超过 ${maxFiles} 上限，已提前停止遍历。请确认选择的是素材盘而不是整个系统盘。`)
  }

  return { files, totalBytes, warnings }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code ? `${error.message} (${code})` : error.message
  }
  return String(error)
}

/* ------------------------------------------------------------------ *
 * 中转文件与原子改名
 * ------------------------------------------------------------------ */

/** 写入中的分片文件标记。放在文件名中间，避免被误认为正常素材。 */
export const PARTIAL_MARKER = '.securereel-partial'

/**
 * 生成写入用临时文件名。
 *
 * 与最终文件同目录，保证 `rename()` 落在同一个卷上 —— 跨卷 rename 会退化成
 * 复制+删除，那就失去原子性了。前缀带 `.` 让 Finder 默认隐藏它。
 */
export function partialPathFor(finalPath: string): string {
  return join(dirname(finalPath), `.${basename(finalPath)}${PARTIAL_MARKER}`)
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function removePathQuietly(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/**
 * 把一份不兼容的数据库文件挪到旁边留档。
 *
 * 为什么不是直接删：里面可能有用户上一次的完整任务与报告索引。
 * 遇到"结构与当前版本不兼容"时，正确做法是保留证据、另起一份新库，
 * 而不是把用户的数据当垃圾清掉。
 *
 * WAL 模式下还有 `-wal` 与 `-shm` 两个伴生文件，必须一起搬走，
 * 否则新库会读到旧的预写日志内容。
 */
export async function quarantineDatabaseFile(path: string): Promise<string | null> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${path}.legacy-${stamp}`
  try {
    if (!(await pathExists(path))) return null
    await rename(path, target)
    for (const suffix of ['-wal', '-shm']) {
      if (await pathExists(`${path}${suffix}`)) {
        await rename(`${path}${suffix}`, `${target}${suffix}`)
      }
    }
    return target
  } catch {
    return null
  }
}

/** 预分配目标文件长度（稀疏写），让小文件也能吃到顺序写的好处。 */
export async function allocateFile(path: string, size: number): Promise<void> {
  const handle = await open(path, 'w')
  try {
    if (size > 0) await handle.truncate(size)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * 原子提交：把写完并校验通过的分片改名到最终位置。
 *
 * 只有这一步成功之后，目标盘上才会出现一个"看起来完整"的素材文件。
 * 中途断电 / 拔盘时留下的都是 `.securereel-partial`，一眼可辨。
 */
export async function commitPartial(partial: string, finalPath: string): Promise<void> {
  await rename(partial, finalPath)
}

/** 写入完成后把目录元数据刷到磁盘，拔盘前这一步很重要。 */
export async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // 某些文件系统（网络盘、exFAT）不支持目录 fsync，忽略即可
  }
}

/* ------------------------------------------------------------------ *
 * 容量探测
 * ------------------------------------------------------------------ */

export interface VolumeUsage {
  totalBytes: number
  freeBytes: number
  availableBytes: number
}

export async function volumeUsage(path: string): Promise<VolumeUsage | null> {
  try {
    const info = await statfs(path)
    const blockSize = Number(info.bsize)
    return {
      totalBytes: blockSize * Number(info.blocks),
      freeBytes: blockSize * Number(info.bfree),
      // bavail 是给非特权用户的可用空间，判断"放得下吗"要用它
      availableBytes: blockSize * Number(info.bavail)
    }
  } catch {
    return null
  }
}

/** 两个路径是否在同一个卷上（用设备号判断）。 */
export async function isSameVolume(a: string, b: string): Promise<boolean> {
  try {
    const [infoA, infoB] = await Promise.all([stat(a), stat(b)])
    return infoA.dev === infoB.dev
  } catch {
    return false
  }
}

/** 源目录是否位于目标目录内部 —— 这种布局会把文件拷到自己里面，必须拦下。 */
export async function isNestedPath(child: string, parent: string): Promise<boolean> {
  const normalizedChild = child.endsWith(sep) ? child : child + sep
  const normalizedParent = parent.endsWith(sep) ? parent : parent + sep
  if (normalizedChild.startsWith(normalizedParent)) return true
  if (normalizedParent.startsWith(normalizedChild)) return true
  // 不同挂载点但实际是同一个目录时，用 inode 再确认一次
  try {
    const [a, b] = await Promise.all([stat(child), stat(parent)])
    return a.ino === b.ino && a.dev === b.dev
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 卷标推断
 * ------------------------------------------------------------------ */

export interface VolumeDescription {
  path: string
  label: string
  mountPoint: string
  device: number
  readOnly: boolean
}

const mountPointCache = new Map<string, string>()

/**
 * 向上回溯找出挂载点。
 *
 * 做法是不断向上取父目录，直到设备号发生变化，那么上一级就是挂载点。
 * 结果按路径缓存，避免在进度回调里反复 stat。
 */
export async function findMountPoint(path: string): Promise<string> {
  const cached = mountPointCache.get(path)
  if (cached !== undefined) return cached

  const start = await stat(path)
  let current = path
  let mountPoint = path

  for (let depth = 0; depth < 32; depth++) {
    const parent = dirname(current)
    if (parent === current) {
      mountPoint = current
      break
    }
    try {
      const info = await stat(parent)
      if (info.dev !== start.dev) {
        mountPoint = current
        break
      }
      current = parent
      mountPoint = parent
    } catch {
      mountPoint = current
      break
    }
  }

  mountPointCache.set(path, mountPoint)
  return mountPoint
}

export async function describeVolume(path: string): Promise<VolumeDescription | null> {
  try {
    const [info, mountPoint] = await Promise.all([stat(path), findMountPoint(path)])
    const inVolumes = mountPoint.startsWith('/Volumes/')
    const label = inVolumes ? basename(mountPoint) : mountPoint === '/' ? '启动磁盘' : basename(mountPoint)
    return {
      path,
      label,
      mountPoint,
      device: info.dev,
      readOnly: await isReadOnly(mountPoint)
    }
  } catch {
    return null
  }
}

async function isReadOnly(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK)
    return false
  } catch {
    return true
  }
}

/* ------------------------------------------------------------------ *
 * 弹出卷（macOS）
 * ------------------------------------------------------------------ */

/**
 * 弹出目标盘。
 *
 * 只用参数数组 + `shell: false` —— 路径里出现空格、引号、`$(...)` 都不会被解释。
 * 这是本项目对所有外部命令调用的统一姿势。
 */
export function ejectVolume(mountPoint: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') {
      resolve({ ok: false, message: '当前系统不支持自动弹出，请手动推出磁盘。' })
      return
    }
    const child = spawn('/usr/sbin/diskutil', ['eject', mountPoint], { shell: false })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      resolve({ ok: false, message: `无法调用 diskutil：${describeError(error)}` })
    })
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, message: '已弹出' })
      else resolve({ ok: false, message: stderr.trim() || `diskutil 退出码 ${code}` })
    })
  })
}

/* ------------------------------------------------------------------ *
 * 可执行文件查找
 * ------------------------------------------------------------------ */

/** 在 PATH 里查找可执行文件；不启动任何子进程，纯查目录。 */
export async function whichInPath(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const rawPath = env.PATH ?? ''
  for (const dir of rawPath.split(':')) {
    if (dir === '') continue
    const candidate = join(dir, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
