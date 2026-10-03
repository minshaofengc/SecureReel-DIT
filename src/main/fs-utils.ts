/**
 * 文件系统底层工具。
 *
 * 这一层只做「安全的机械动作」：遍历、容量探测、原子改名、卷标推断。
 * 业务语义（校验、断点、报告）不在这里，全部在 core/ 下。
 *
 * 平台差异：所有与路径/卷有关的判断都问 `platform.ts` 要一个决定，
 * 并且每个接受 `platform` 的函数都把它做成**可选尾参、默认本机**——
 * 这样 Windows 分支在 macOS 上就能被 vitest 直接断言（见 tests/platform.test.ts）。
 */
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
import { basename, dirname, join, posix, relative, sep, win32 } from 'node:path'
import {
  executableExtensions,
  HOST,
  type HostPlatform,
  pathListSeparator,
  pathRootLength,
  samePathName,
  systemVolumeLabel
} from './platform'

/* ------------------------------------------------------------------ *
 * 路径规范化与安全
 * ------------------------------------------------------------------ */

/**
 * 按**目标**平台选 path 模块。
 *
 * 必须显式选，不能靠宿主机的 `join`/`baseName`：在 macOS 上测 Windows 分支时，
 * 宿主的 `join('D:\\Cards', 'a/b')` 会拼出 `/` 分隔的结果，测出来的东西
 * 跟真正在 Windows 上跑的不是一回事。
 */
function pathModuleOf(platform: HostPlatform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/**
 * 把路径统一成清单里要用的 POSIX 风格。
 *
 * 注意：**只替换平台分隔符**，不把反斜杠当分隔符转换。
 * 原因是 macOS 上 `\` 是合法的文件名字符（HFS+/APFS 允许），
 * 如果无差别地把 `\` 换成 `/`，清单里就会写出一个不存在的路径 ——
 * 那比格式不统一严重得多。
 *
 * Windows 上这个顾虑不存在（文件名里不允许出现 `\`），所以那边
 * `toPosix` 会把分隔符全部换掉，正是我们想要的。
 * 「相对路径」本身不带盘符，两个平台拼出来的结果一致。
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
 * **下限是「根」而不是 1**：根目录不能削成空串（那样就变成相对路径了），
 * 而且 Windows 的 `D:\` 是个更长的根 —— 旧的 `while (end > 1)` 会把它
 * 削成 `D:`，那是「D 盘当前目录」的意思，跟「D 盘根」完全不是一回事，
 * 拿它去 join 出来的路径全是错的。
 */
export function stripTrailingSeparators(path: string, platform: HostPlatform = HOST): string {
  const separator = platform === 'win32' ? '\\' : '/'
  const minLength = pathRootLength(path, platform)
  let end = path.length
  while (end > minLength && (path[end - 1] === '/' || path[end - 1] === separator)) end--
  return path.slice(0, end)
}

/**
 * 从来源路径里取出「该在目标盘上保留的那一层目录名」。
 *
 * 目标盘的落盘结构是 `<目标盘根>/<这一层>/<源内相对路径>`。
 * 取不到一个像样的名字时返回空串 = 「不额外建这一层」：
 * 宁可维持旧行为，也绝不能把 `/`、`.`、`..` 这种段拼进目标路径里 ——
 * 那会让文件落到盘外或语义不明的地方。
 *
 * 用 `basename()` 而不是「找最后一个 `/` 再切」：后者在 Windows 上
 * 对 `D:\Cards\A001` 一个 `/` 都找不到，会把**整条路径（含盘符）**
 * 当成目录名，落盘结构直接错乱。
 */
export function safeSourceRootName(path: string, platform: HostPlatform = HOST): string {
  const normalized = stripTrailingSeparators(path, platform)
  const name = pathModuleOf(platform).basename(normalized)
  if (name === '' || name === '.' || name === '..') return ''
  // 只剩分隔符（`/`、`\`、`C:\` 这种根本身）也算取不到像样的名字
  if (name.replace(/[\\/]/g, '') === '') return ''
  return name
}

/**
 * 文件在目标盘上的相对路径 = `<来源目录名>/<源内相对路径>`。
 *
 * **只有这一处实现**，因为它有两个调用方，而两者必须永远一致：
 *   · 拷贝引擎用它拼实际写入的路径（`CopyEngine.targetRelPath`）
 *   · 报告层用它拼清单里的路径（清单要能拿去核对目标盘上的真实文件）
 * 两边算得不一样，就会出现"清单里列的文件在盘上找不到"这种最难查的问题。
 *
 * `sourceRootName` 为空串（1.x 的存量任务）时原样返回。
 */
export function targetRelativePath(sourceRootName: string, relPath: string): string {
  return sourceRootName === '' ? relPath : posix.join(sourceRootName, relPath)
}

/**
 * Windows 保留设备名。
 *
 * 这些名字（含带扩展名的形式，如 `CON.txt`）在 Windows 上**永远不能**
 * 用作文件或目录名，创建会直接失败。危险在于它们看起来完全正常。
 */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 把任意文本（通常是任务名）转成可以安全做目录名的形式。
 *
 * 与清单文件名的"安全化"刻意不同：那个为了符合 ASC 规范只留 ASCII，
 * 这里的目录是给现场的人看的，**要保留中文**，只清掉会破坏路径结构的东西：
 *   · `/` 与 `\` —— 会把目录名拆成两级
 *   · `:` —— macOS 的访达会把它显示成 `/`，看上去像两层，极易误判
 *   · `< > " | ? *` —— Windows 上非法，会让 mkdir / 写报告直接失败
 *   · 控制字符与 NUL
 *   · 前导点 —— 会成为隐藏目录，在访达里"看不见"，最难排查
 *   · 尾随点与空格 —— 部分文件系统会静默吞掉
 * 返回空串表示没剩可用内容，调用方自行回退。
 *
 * ⚠️ 这张过滤表**两个平台统一使用**，没有做平台分支，这是有意的：
 * 目标盘（现场几乎都是 exFAT）会在 Mac 与 Windows 之间来回插，
 * 而「旧报告修订永不覆盖」这条产品红线依赖「同一个任务名永远算出
 * 同一个目录名」。若两个平台各过滤一套，同一块卡上就会长出
 * `采访"终版"_R001` 和 `采访_终版_R001` 两个平行目录。
 * 代价是 macOS 上一个含 `"` 的任务名，目录名会比 2.0.1 之前多一个下划线。
 */
export function safeFolderName(name: string): string {
  const cleaned = name
    .replace(/[/\\:<>"|?*]/g, '_')
    // eslint-disable-next-line no-control-regex -- 清掉控制字符正是这个正则存在的唯一用途
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim()
  if (cleaned === '') return ''
  // 保留设备名判定看的是第一个点之前的主干：`CON.txt` 同样是保留名
  const stem = cleaned.split('.')[0] ?? ''
  return WINDOWS_RESERVED_NAMES.test(stem) ? `_${cleaned}` : cleaned
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
export function resolveInside(root: string, relPath: string, platform: HostPlatform = HOST): string {
  const normalized = normalizeRelPath(relPath)
  const pathModule = pathModuleOf(platform)
  const base = stripTrailingSeparators(root, platform)
  const absolute = pathModule.join(base, normalized)
  const rootWithSep = base.endsWith(pathModule.sep) ? base : base + pathModule.sep
  // NTFS 大小写不敏感，比较必须忽略大小写，否则 `C:\Cards` 与 `c:\cards`
  // 之间会误报「路径逃逸」，把合法任务拦下来
  const inside =
    samePathName(absolute, base, platform) ||
    (platform === 'win32'
      ? absolute.toLowerCase().startsWith(rootWithSep.toLowerCase())
      : absolute.startsWith(rootWithSep))
  if (!inside) {
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
export async function isSameVolume(a: string, b: string, platform: HostPlatform = HOST): Promise<boolean> {
  if (platform === 'win32') {
    // 盘符不同 ⇒ 一定是不同卷，不必去 stat（对刚拔掉/刚插入的盘也更稳）。
    // 盘符相同的情况仍交给下面的 dev 比较，好让「同一盘符下的不同装载点」
    // 之类的边角情由设备号兜住。
    const pathModule = pathModuleOf(platform)
    const rootA = pathModule.parse(a).root
    const rootB = pathModule.parse(b).root
    if (rootA !== '' && rootB !== '' && !samePathName(rootA, rootB, platform)) return false
  }
  try {
    const [infoA, infoB] = await Promise.all([stat(a), stat(b)])
    return infoA.dev === infoB.dev
  } catch {
    return false
  }
}

/** 源目录是否位于目标目录内部 —— 这种布局会把文件拷到自己里面，必须拦下。 */
export async function isNestedPath(
  child: string,
  parent: string,
  platform: HostPlatform = HOST
): Promise<boolean> {
  const separator = pathModuleOf(platform).sep
  const normalizedChild = child.endsWith(separator) ? child : child + separator
  const normalizedParent = parent.endsWith(separator) ? parent : parent + separator
  const fold = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value)
  if (fold(normalizedChild).startsWith(fold(normalizedParent))) return true
  if (fold(normalizedParent).startsWith(fold(normalizedChild))) return true
  // 不同挂载点但实际是同一个目录时，用 inode 再确认一次。
  //
  // ⚠️ 必须挡住 ino === 0：exFAT / FAT32（**摄影机卡的主流格式**）的 st_ino
  // 恒为 0，守卫缺失时「0 === 0 且 dev 相同」会对**任意两个同卷路径**成立，
  // 把完全合法的目标盘判成「源目录套在目标里」—— 拷贝页会无缘无故拒绝开工。
  try {
    const [a, b] = await Promise.all([stat(child), stat(parent)])
    if (a.ino === 0 || b.ino === 0) return false
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
 * 清空挂载点缓存。
 *
 * 盘符会被系统复用：拔掉 E: 盘再插一块新盘，它还是 E:。
 * 所以每次重新枚举卷之前必须清一次，否则会拿上一块盘的挂载点去操作新盘。
 */
export function invalidateVolumeCache(): void {
  mountPointCache.clear()
}

/**
 * 向上回溯找出挂载点。
 *
 * macOS 的做法是不断向上取父目录，直到设备号发生变化，那么上一级就是挂载点。
 * 结果按路径缓存，避免在进度回调里反复 stat。
 *
 * Windows 上不需要这么绕：卷一定挂在盘符根（`D:\`），直接取 `parse().root` 即可。
 */
export async function findMountPoint(path: string, platform: HostPlatform = HOST): Promise<string> {
  // 缓存键带上平台：同一台机器上两个平台分支的结果是两回事，
  // 不能互相覆盖（注入平台跑测试时会撞上）
  const cacheKey = `${platform}\u0000${path}`
  const cached = mountPointCache.get(cacheKey)
  if (cached !== undefined) return cached

  if (platform === 'win32') {
    const root = pathModuleOf(platform).parse(path).root
    const resolved = root === '' ? path : root
    mountPointCache.set(cacheKey, resolved)
    return resolved
  }

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

  mountPointCache.set(cacheKey, mountPoint)
  return mountPoint
}

/**
 * 卷在界面上显示的名字。
 *
 * - macOS：`/Volumes/A001` → `A001`；根目录 → 「启动磁盘」（沿用旧文案）
 * - Windows：`E:\` → `E:`。真实的**卷标**（像 `A001` 这种）Node 拿不到，
 *   需要 PowerShell，由 `volumes.ts` 在枚举卷列表时补上并覆盖这里的结果。
 */
function describeVolumeLabel(mountPoint: string, platform: HostPlatform): string {
  if (platform === 'win32') {
    const root = pathModuleOf(platform).parse(mountPoint).root
    const bare = (root === '' ? mountPoint : root).replace(/[\\/]+$/, '')
    return bare === '' ? mountPoint : bare
  }
  if (mountPoint === '/') return systemVolumeLabel(platform)
  return basename(mountPoint)
}

export async function describeVolume(
  path: string,
  platform: HostPlatform = HOST
): Promise<VolumeDescription | null> {
  try {
    const [info, mountPoint] = await Promise.all([stat(path), findMountPoint(path, platform)])
    return {
      path,
      label: describeVolumeLabel(mountPoint, platform),
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
 * 可执行文件查找
 * ------------------------------------------------------------------ */

/**
 * 在 PATH 里查找可执行文件；不启动任何子进程，纯查目录。
 *
 * Windows 上有两处跟 POSIX 不一样，都必须处理：
 *   · PATH 的分隔符是 `;` 而不是 `:` —— 按 `:` 切会把整条 PATH 当成一个目录，
 *     结果是「永远找不到」；
 *   · 可执行文件靠扩展名（`PATHEXT`）识别，所以 `ffmpeg` 要去挨个试
 *     `ffmpeg.COM` / `ffmpeg.EXE` / …
 */
export async function whichInPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: HostPlatform = HOST
): Promise<string | null> {
  // Windows 上环境变量的键名大小写并不固定（`PATH` / `Path` 都见过），两个都认
  const rawPath = env.PATH ?? env['Path'] ?? ''
  const pathModule = pathModuleOf(platform)
  const separator = pathListSeparator(platform)
  // 调用方已经写了后缀（例如 `ffprobe.exe`）就不要再追加一次
  const candidates = name.includes('.') ? [name] : executableExtensions(platform, env).map((ext) => `${name}${ext}`)

  for (const dir of rawPath.split(separator)) {
    if (dir === '') continue
    for (const candidate of candidates) {
      const full = pathModule.join(dir, candidate)
      if (await isExecutableFile(full, platform)) return full
    }
  }
  return null
}

/**
 * 一个路径是否指向「可执行文件」。
 *
 * POSIX 看文件模式位（X_OK）；Windows 没有执行位，X_OK 在那里近似 F_OK、
 * 等于没检查 —— 只能按 `PATHEXT` 的扩展名约定判断。
 */
export async function isExecutableFile(path: string, platform: HostPlatform = HOST): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    if (platform === 'win32') {
      const lower = path.toLowerCase()
      return executableExtensions(platform).some((ext) => ext !== '' && lower.endsWith(ext))
    }
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
