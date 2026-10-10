/**
 * SecureReel DIT —— 跨进程共享的领域模型。
 *
 * 这里只放纯粹的数据结构和常量，不依赖 Node 也不依赖 DOM，
 * 因此主进程、预加载脚本和渲染进程可以共用同一份定义。
 */

/* ------------------------------------------------------------------ *
 * 校验算法
 * ------------------------------------------------------------------ */

/**
 * 校验算法。
 *
 * 数组顺序 = 设置页下拉里的顺序，按"现场常用 → 兼容/归档"排：
 * 前面三个是速度路线（xxHash 三兄弟），中间三个是通用/兼容路线，最后是归档。
 *
 * 怎么给现场的人讲这七种：
 *   · xxHash64   —— 默认。速度快，值短（16 位），自家流程自洽，够用
 *   · xxHash3    —— 同一条路线的新版本，现代 CPU 上比 xxHash64 更快
 *   · xxHash128  —— 同一条路线，值 32 位，比 64 位的碰撞概率更低
 *   · MD5        —— 老流程的通用语言，很多转录/交付环节只认它
 *   · SHA-1      —— 老标准的归档口径。⚠️ 见下面 ASC MHL 的说明
 *   · SHA-256    —— 归档与质检最常被要求的口径。⚠️ 只能配 CSV / JSON 清单
 *   · ASC C4     —— SMPTE ST 2114 内容标识，ASC MHL 的原生口径
 */
export const HASH_ALGORITHMS = [
  'xxhash64',
  'xxh3',
  'xxh128',
  'md5',
  'sha1',
  'sha256',
  'asc-c4'
] as const
export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number]

export const HASH_ALGORITHM_LABELS: Record<HashAlgorithm, string> = {
  xxhash64: 'xxHash64',
  xxh3: 'xxHash3',
  xxh128: 'xxHash128',
  md5: 'MD5',
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  'asc-c4': 'ASC C4 (SMPTE ST 2114)'
}

/**
 * 各算法输出的**字符串长度**。
 *
 * 注意这里不是"十六进制字符数"：
 *   · 除 ASC C4 外，其余都输出小写十六进制
 *   · ASC C4 输出的是 90 字符的 C4 标识（`c4` + 88 位 Base58），
 *     这是 SMPTE ST 2114 规定的标准文本形态，用在清单的 `<c4>` 元素里
 *
 * ⚠️ 改这里之前先看 `hashLooksValid()`：长度对不上就等于校验值形态非法，
 * 而形态非法会被当成"读到坏数据"处理，不是"配置错了"。
 */
export const HASH_VALUE_LENGTH: Record<HashAlgorithm, number> = {
  xxhash64: 16,
  xxh3: 16,
  xxh128: 32,
  md5: 32,
  sha1: 40,
  sha256: 64,
  'asc-c4': 90
}

/* ------------------------------------------------------------------ *
 * 清单格式
 * ------------------------------------------------------------------ */

/**
 * 清单格式。
 *
 *   · asc-mhl-2.0 —— 默认。影视行业事实标准，校验值 + 目录结构 + 作业信息
 *   · mhl-v1      —— 传统 MHL，对接还在用旧格式的流程
 *   · csv         —— 一张表，Excel / Numbers 直接打开。现场交付、跨部门核对最快
 *   · json        —— 给脚本和自动化流程用，字段完整、有序、可直接解析
 */
export const MANIFEST_FORMATS = ['asc-mhl-2.0', 'mhl-v1', 'csv', 'json'] as const
export type ManifestFormat = (typeof MANIFEST_FORMATS)[number]

/**
 * ASC MHL 2.0 官方 XSD 里**允许出现**的哈希元素名。
 *
 * 这张表是从官方 `ASCMHL.xsd` 里抄下来的（`<sequence>` 内，元素名与顺序
 * 都不能改），测试会拿 XSD 校验生成物，所以它同时也是"能不能选"的判据。
 *
 * ⚠️ 表里**没有 sha256**，这是官方架构的事实、不是我们的取舍：
 * ASC MHL 2.0 只定义了 c4 / md5 / sha1 / xxh128 / xxh3 / xxh64 六种。
 * 硬把 sha256 写成 `<sha256>` 会生成一份 XSD 校验不过的清单 ——
 * 交给别人时对方工具直接读不进来，而且**不会报错**，只会少一半条目。
 * 所以选 SHA-256 时界面上会把 ASC MHL 禁掉并写明原因（见 supportsAlgorithm）。
 */
export const ASC_MHL_HASH_ELEMENTS: Partial<Record<HashAlgorithm, string>> = {
  'asc-c4': 'c4',
  md5: 'md5',
  sha1: 'sha1',
  xxh128: 'xxh128',
  xxh3: 'xxh3',
  xxhash64: 'xxh64'
}

/** MHL v1 用的元素名（旧格式，沿用各家实现里的写法）。 */
export const MHL_V1_HASH_ELEMENTS: Partial<Record<HashAlgorithm, string>> = {
  'asc-c4': 'c4',
  md5: 'md5',
  xxhash64: 'xxhash64'
}

/**
 * 某个「算法 × 清单格式」的组合能不能用。
 *
 * 存在的意义是让"不能用的组合"变成一条**可查询的规则**，而不是散落在
 * 界面里的 if。界面的下拉据此禁用 + 显示原因，主进程据此兜底拒绝。
 */
export function supportsAlgorithm(format: ManifestFormat, algorithm: HashAlgorithm): boolean {
  if (format === 'asc-mhl-2.0') return ASC_MHL_HASH_ELEMENTS[algorithm] !== undefined
  if (format === 'mhl-v1') return MHL_V1_HASH_ELEMENTS[algorithm] !== undefined
  // CSV / JSON 是我们自己定义的形态，七种算法都写得进去
  return true
}

/** 某个格式能用的全部算法（界面据此过滤下拉项）。 */
export function algorithmsForFormat(format: ManifestFormat): HashAlgorithm[] {
  return HASH_ALGORITHMS.filter((algorithm) => supportsAlgorithm(format, algorithm))
}

/* ------------------------------------------------------------------ *
 * 源盘
 * ------------------------------------------------------------------ */

export const VOLUME_KINDS = ['generic', 'hde-vfs', 'hde-mxf', 'arriraw'] as const
export type VolumeKind = (typeof VOLUME_KINDS)[number]

/**
 * SourceDrive —— 源盘信息。
 *
 * `isCodExVfs` 为 true 时，卷内的 `.arx` / HDE `.mxf` 由 CODEX Device Manager
 * 的虚拟文件系统提供，在 Finder 里显示为 0 字节属于预期行为。
 */
export interface SourceDrive {
  /** 绝对路径 */
  path: string
  /** 展示名（卷标或末级目录名） */
  label: string
  kind: VolumeKind
  isCodExVfs: boolean
  /** 卷总容量；未知为 null */
  totalBytes: number | null
  /** 剩余容量；未知为 null */
  freeBytes: number | null
  fileSystem: string | null
  readOnly: boolean
  /** 该卷上被识别为可拷贝素材的文件数（扫描后才填充） */
  mediaFileCount: number | null
}

/* ------------------------------------------------------------------ *
 * 任务 / 文件状态
 * ------------------------------------------------------------------ */

export const JOB_STATES = [
  'draft',
  'queued',
  'running',
  'paused',
  'completed',
  'completed-with-errors',
  'failed',
  'cancelled'
] as const
export type JobState = (typeof JOB_STATES)[number]

/**
 * "任务还占着运行态"的状态。
 *
 * 判断依据刻意不是界面上显示的 running，而是**任务是否可以被安全地做只读长操作**：
 * `queued` / `paused` 的任务在 JobManager 里同样持有 RunHandle，引擎随时会继续推进，
 * 所以它们和 `running` 一样不能再生成报告 —— 否则会与正在跑的引擎抢同一批文件行。
 */
export const LIVE_JOB_STATES = ['queued', 'running', 'paused'] as const

/** 任务是否处于运行态（含排队与暂停）。 */
export function isJobLive(state: JobState): boolean {
  return (LIVE_JOB_STATES as readonly string[]).includes(state)
}

/**
 * 任务模式。
 *
 * - `copy`   ：正常拷贝（读源 → 写目标 → 独立重读校验 → 原子改名）
 * - `verify` ：仅校验（两侧只算校验值并比对，**不写入也不删除任何字节**）。
 *   用于隔天复检、交接核对别人拷好的盘。
 */
export const JOB_MODES = ['copy', 'verify'] as const
export type JobMode = (typeof JOB_MODES)[number]

export const FILE_STATES = [
  'pending',
  'copying',
  'verifying',
  'verified',
  'failed',
  'skipped',
  'cancelled'
] as const
export type FileState = (typeof FILE_STATES)[number]

/** 文件状态是否已经"落定"——不会再往后走了。 */
export function isFileStateSettled(state: FileState): boolean {
  return state === 'verified' || state === 'failed' || state === 'skipped' || state === 'cancelled'
}

/**
 * 这条文件状态变更该不该应用到界面上。
 *
 * 存在的理由：中间态是**延迟合并**（200ms）发送的，所以它完全可能晚于终态到达 ——
 * 一个界面上已经写着「已校验」的行，会在 200ms 后收到一条迟到的「校验中」。
 * 直接应用的话用户会看到"校验完了又倒回去"，比根本不显示中间态还糟。
 *
 * 为什么用"界面侧拦截"而不是"主进程发送前撤销"：撤销需要在每一条可能的
 * 结清路径上（正常完成、失败、冲突、取消、崩溃异常）都记得撤销一次，
 * 漏掉任何一条界面就会倒退。而这条规则是无状态的，漏不掉。
 */
export function shouldApplyFileStateChange(previous: FileState, next: FileState): boolean {
  return !isFileStateSettled(previous) || isFileStateSettled(next)
}

/* ------------------------------------------------------------------ *
 * 提示音
 * ------------------------------------------------------------------ */

export type SoundCue = 'start' | 'done' | 'error'

/**
 * 任务状态变化该配哪种提示音；返回 null 表示不响。
 *
 * 两个刻意的选择：
 *   · **开始认 `queued`**：JobManager 启动时先置 queued 并发状态事件，
 *     引擎随后置 running 走的是进度通道，不是状态事件。
 *   · **取消不响**：那是用户自己按的，不需要再被提醒一次。
 *
 * 放在 shared 而不是声音模块里，有两个理由：它是纯逻辑；而且**必须能被
 * node 环境的单元测试直接引用** —— 声音本身没法断言，"什么时候该响"可以。
 * `sound.ts` 用到 DOM 的 AudioContext，测试引不动它。
 */
export function cueForJobState(previous: JobState, next: JobState): SoundCue | null {
  if (previous === next) return null
  if (next === 'queued') return 'start'
  if (next === 'completed') return 'done'
  if (next === 'completed-with-errors' || next === 'failed') return 'error'
  return null
}

/* ------------------------------------------------------------------ *
 * 拷贝目标
 * ------------------------------------------------------------------ */

export interface CopyTarget {
  id: string
  path: string
  label: string
  enabled: boolean
  /** 写入前探测到的剩余容量 */
  freeBytes: number | null
  /** 校验类型：普通目标全部重读校验 */
  writable: boolean
}

export interface TargetProgress {
  targetId: string
  label: string
  state: 'pending' | 'running' | 'completed' | 'failed' | 'disabled'
  filesDone: number
  filesFailed: number
  bytesCopied: number
  bytesPerSecond: number
  error: string | null
}

/* ------------------------------------------------------------------ *
 * 文件与结果
 * ------------------------------------------------------------------ */

/** 单个文件在单个目标上的拷贝结果。 */
export interface FileTargetResult {
  targetId: string
  state: FileState
  /** 目标侧重读得到的校验值 */
  hash: string | null
  /** 目标侧校验值是否与源侧一致 */
  hashMatch: boolean | null
  bytesCopied: number
  error: string | null
}

/** 多媒体探测结果；探测失败不影响哈希报告。 */
/**
 * 素材格式族。
 *
 * 分族的实际意义在于**能不能拿到帧**：
 *   · prores / prores-raw —— ffmpeg 原生可解码，首尾帧都能真解出来
 *   · r3d / braw —— 厂商私有编码，ffmpeg 没有解码器；
 *     首帧改从文件内嵌的预览图取（厂商自己嵌的，用于机内回放）
 *   · canon-raw —— 佳能 Cinema RAW Light（.CRM）。**只做了命名，不做探测**：
 *     ffmpeg 能读它的 MOV 容器但没有 CRAW 解码器，所以既没有帧也没有元数据；
 *     登记它只是为了让报告里不把 8K RAW 母版写成"普通文件"。
 *     详见 media/formats.ts 里 crm 那一条的注释。
 *   · 其余按可解码处理，失败再退回内嵌预览
 */
export const MATERIAL_FORMATS = [
  'prores',
  'prores-raw',
  'r3d',
  'braw',
  'arriraw',
  'canon-raw',
  'hde',
  'cinema-dng',
  'mxf',
  'audio',
  'generic'
] as const
export type MaterialFormat = (typeof MATERIAL_FORMATS)[number]

/** 首帧是从哪来的 —— 报告里要如实标注，不能让人以为都是解码出来的。 */
export const FRAME_SOURCES = ['decoded', 'embedded-preview', 'none'] as const
export type FrameSource = (typeof FRAME_SOURCES)[number]

export interface MediaProbe {
  available: boolean
  /** 不可用原因（面向用户的说明） */
  reason: string | null
  capturedAt: string | null
  durationSeconds: number | null
  timecode: string | null
  codec: string | null
  width: number | null
  height: number | null
  frameRate: string | null
  /** 提取出的首帧 / 尾帧缩略图文件名（位于报告的 frames/ 目录） */
  firstFrame: string | null
  lastFrame: string | null
  /**
   * 候选静帧文件名（位于报告的 frames/ 目录），每条 3–4 张。
   *
   * 与 firstFrame / lastFrame 的分工：那两张只是"这条素材长什么样"的锚点，
   * 这里是"片子里最值得挑出来的几张画面"。本地启发式挑选（清晰度打分），
   * 不涉及任何模型 —— 闭眼 / 表情这类语义判断本项目做不到，也不假装能做。
   */
  stillFrames: string[]
  /** 识别出的素材格式，例如 "ProRes 422 HQ"（面向用户的可读名称） */
  format: string | null
  /** 格式族 */
  formatFamily: MaterialFormat
  /** 首帧来源 */
  frameSource: FrameSource
  /** 该格式若要拿到完整技术参数，需要哪个厂商官方工具；null 表示不需要 */
  vendorTool: string | null
  /** 补充说明：为什么某些字段是空的、预览图分辨率与传感器分辨率的区别等 */
  note: string | null
  /**
   * 代理生成结果（仅在设置了 proxyEnabled 时才有值）。
   *
   * `ok=true` 表示目标盘上已存在对应的 ProRes 代理；不可解码的私有格式
   * （R3D / BRAW / ARRIRAW / CRM）会带 `ok=false` + 说明原因，
   * 而不是静默留白。
   */
  proxy: MediaProxyResult | null
}

/** 一条素材的代理生成结果。 */
export interface MediaProxyResult {
  /** 相对目标盘的代理文件路径；失败时为 null */
  relPath: string | null
  ok: boolean
  /** 失败 / 跳过原因（面向用户） */
  reason: string | null
  /** 实际用的规格，便于报告标注（仅 ProRes 有意义；h264/h265 时为 null） */
  profile: ProxyProfile | null
  /** 实际用的编码 */
  codec: ProxyCodec | null
  /** 实际用的分辨率档位 */
  resolution: ProxyResolution | null
  /** 实际编码出的画面尺寸（只降不升后的真实值）；未知时为 null */
  width: number | null
  height: number | null
  /** 实际套用的 LUT（未套为 null）——报告如实标注"这条代理套了哪个 LUT" */
  lutPath: string | null
}

export interface CopyJobFile {
  id: number
  jobId: string
  /** 相对源根目录的 POSIX 风格路径 */
  relPath: string
  sizeBytes: number
  /** 读源时计算出的校验值 */
  sourceHash: string | null
  state: FileState
  bytesCopied: number
  results: FileTargetResult[]
  probe: MediaProbe | null
  error: string | null
}

/**
 * 文件行的**轻量增量**，用于把 `copying` / `verifying` 这些中间态送到界面上。
 *
 * 为什么不能直接推整包 `CopyJobFile`：中间态的推送频率是"每文件每阶段一次"，
 * 一个上千文件的卡就是几千条。而拼一个 `CopyJobFile` 要额外查一次
 * `file_target_results`、解析 `probe_json` —— 这些**中间态根本用不到**。
 * 所以这里只带渲染层真正会画的那几个字段，其余字段在界面侧按
 * "给了哪些就覆盖哪些"合并，天然不会被冲掉。
 *
 * 与 `job:file`（文件结清时的完整行）的分工很明确：
 * 增量只负责"状态看起来在动"，最终事实仍以 `job:file` 为准。
 */
export interface FileStateDelta {
  relPath: string
  state: FileState
  bytesCopied?: number
  error?: string | null
  sourceHash?: string | null
}

/* ------------------------------------------------------------------ *
 * 任务
 * ------------------------------------------------------------------ */

export interface CopyJob {
  id: string
  name: string
  /** 任务模式：copy = 拷贝 + 校验；verify = 仅校验，不写目标盘 */
  mode: JobMode
  sourcePath: string
  /**
   * 用户选中的那个来源目录的名字（`basename(sourcePath)`）。
   *
   * 目标盘上的落盘结构 = `<目标盘根>/<sourceRootName>/<源内相对路径>`。
   *
   * 存在的理由：`walkFiles` 算出来的相对路径是相对**用户选中的那一层**的，
   * 那一层本身不会出现在任何 relPath 里。选卡根时看不出问题（DCIM 那一层
   * 本来就是内容的一部分），但选卡内的子文件夹时，目标盘上会平白少一层 ——
   * 现场看到的是"文件夹本身没拷过去，文件全摊在盘根"。
   *
   * 空串表示「不加这一层」。1.x 建的存量任务全是空串，行为与从前完全一致，
   * 不会因为升级而让老任务重跑时多出一级目录。
   */
  sourceRootName: string
  sourceKind: VolumeKind
  isCodExVfs: boolean
  /** 归属的母项目；null = 未分组 */
  parentProjectId: string | null
  targets: CopyTarget[]
  hashAlgorithm: HashAlgorithm
  manifestFormat: ManifestFormat
  verifyAfterWrite: boolean
  /**
   * 本次任务是否出代理。**每任务**决定（拷贝页可选），不是全局设置 ——
   * 同一台机器上，"这次要给剪辑交代理"和"这次只备份"是两件不同的事。
   */
  proxyEnabled: boolean
  /** 本次任务的代理分辨率（只降不升） */
  proxyResolution: ProxyResolution
  /** 本次任务的代理编码 */
  proxyCodec: ProxyCodec
  /** 本次任务的 ProRes 规格（仅 codec === 'prores' 时有意义） */
  proxyProfile: ProxyProfile
  /** 本次任务的代理 LUT（`.cube` 绝对路径）；null = 不套 */
  proxyLutPath: string | null
  state: JobState
  totalFiles: number
  totalBytes: number
  filesDone: number
  filesFailed: number
  bytesDone: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  /** 降级为普通 ARRIRAW 拷贝时的说明（HDE 工具缺失） */
  degradationNotice: string | null
}

/**
 * 一个**正在处理中**的文件。
 *
 * 存在的理由：整体速率与剩余时间只能回答"还剩多久"，回答不了
 * "现在到底在动没有"。上千个小文件的卡上，用户最想确认的就是这件事。
 * 单个超大素材（一整条 100GB+）也靠这里的字节数画一根细进度条。
 */
export interface ActiveFileProgress {
  relPath: string
  sizeBytes: number
  /** 已读（并已写入各目标）的字节数 */
  bytesRead: number
}

export interface JobProgress {
  jobId: string
  state: JobState
  /**
   * 当前处于哪个阶段。
   *
   * 拷贝跑完之后还有两段不短的工作：解析素材元数据、提取每条素材的首帧。
   * 不把阶段暴露出来，用户会看到进度条停在 100% 却什么都不动，
   * 以为程序卡死了。
   */
  phase: JobPhase
  totalFiles: number
  filesDone: number
  filesFailed: number
  totalBytes: number
  bytesDone: number
  /**
   * 总进度（0–100），**已包含目标盘重读校验的工作量**。
   *
   * 界面画进度条只用它，不要再拿 bytesDone/totalBytes 自己算 ——
   * 那样算出来的口径漏掉了校验阶段，收尾时进度条会停在接近 100% 不动，
   * 看起来像卡死。口径本身在 `shared/progress.ts`，主进程算一次。
   */
  overallPercent: number
  bytesPerSecond: number
  /**
   * 本次拷贝的**平均速度**（字节/秒），已剔除暂停时段。
   *
   * 与 `bytesPerSecond`（4 秒滑动窗口的瞬时速率）的分工：
   * 瞬时速率给波形图看趋势，平均速度给"剩余时间"用 —— 后者平稳得多，
   * 算出来的完成时刻不会来回跳。分析阶段为 0。
   */
  averageBytesPerSecond: number
  /** 当前正在处理的文件（相对路径）。并发时是其中任意一个，仅作兼容保留 */
  currentFile: string | null
  /** 当前真正在处理的文件；串行时长度为 0 或 1，并发时最多等于文件级并发数 */
  activeFiles: ActiveFileProgress[]
  targets: TargetProgress[]
  etaSeconds: number | null
  /**
   * 预计完成的**绝对时刻**（ISO 8601），由 `now + etaSeconds` 得出。
   *
   * 只在拷贝阶段给（分析/收尾阶段耗时与字节无关，外推没意义）。
   * 界面拿它显示"预计完成 北京时间 HH:MM"。null 表示还算不出来。
   */
  etaFinishAt: string | null
  /**
   * 写入速度采样序列（每秒一个点，最多 120 个），只给波形图用。
   *
   * 单个瞬时速率数字看不出"盘是稳定跑还是越跑越慢"，趋势只有序列能给。
   */
  speedHistory: number[]
  /** 素材分析进度（phase 为 analyzing 时有效） */
  analyzeDone: number
  analyzeTotal: number
}

export const JOB_PHASES = ['copying', 'analyzing', 'finalizing', 'done'] as const
export type JobPhase = (typeof JOB_PHASES)[number]

/* ------------------------------------------------------------------ *
 * 母项目与项目信息
 * ------------------------------------------------------------------ */

export const MAX_CREW_ROWS = 50
export const MAX_LENS_ROWS = 40
export const MAX_PROJECT_NOTES_LENGTH = 4000
export const MAX_COPY_NOTES_LENGTH = 4000
export const MAX_PARENT_NAME_LENGTH = 120

export interface CrewEntry {
  role: string
  name: string
}

/** 一颗镜头：型号 + 焦段/编号等补充信息（可留空） */
export interface LensEntry {
  model: string
  detail: string
}

/**
 * 项目级共享信息 —— 母项目与每一次拷贝共用同一套字段。
 *
 * 抽成共用基类是为了让两处共用同一个 zod schema、同一个 normalize、
 * 同一套表单组件：以后加字段只需要写一遍。
 */
export interface ProjectDetails {
  projectName: string
  shootDay: string
  camera: string
  lenses: LensEntry[]
  /** 项目备注（整部戏的） */
  notes: string
  crew: CrewEntry[]
}

/**
 * 母项目：一部戏一个，例如《母亲》。
 *
 * 它承载的是"整部戏不变"的信息（机型、镜头、主创、项目备注），
 * 拷贝时被快照进每个子任务，因此母项目后来怎么改都不会动到旧报告。
 */
export interface ParentProject {
  id: string
  name: string
  details: ProjectDetails
  createdAt: string
  updatedAt: string | null
}

/**
 * 一次拷贝任务的项目信息 = 项目级共享信息的**快照** + 本张卡的属性。
 *
 * 刻意存快照而不是引用母项目：报告是"当时的实况记录"。
 * 母项目后来改名、换镜头、甚至被删掉，旧报告必须还是当时那个样子 ——
 * 这与"旧报告修订永不覆盖"是同一条原则。
 */
export interface ProjectInfo extends ProjectDetails {
  /** 卡号 / 卷号 —— 属于这一张卡，不属于项目 */
  cardLabel: string
  /** 本次拷贝备注 —— DIT 现场写的，与项目备注分开两层 */
  copyNotes: string
  /** 母项目名字的快照，让报告自描述；null = 未分组 */
  parentProjectName: string | null
  updatedAt: string | null
}

/** 创建任务时提交的项目信息；服务端补齐 parentProjectName 与 updatedAt */
export type ProjectDraft = ProjectDetails & {
  cardLabel: string
  copyNotes: string
}

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */

export const REPORT_FORMATS = ['json', 'html', 'pdf', 'manifest'] as const
export type ReportFormat = (typeof REPORT_FORMATS)[number]

export interface ReportTargetSummary {
  targetId: string
  label: string
  path: string
  filesCopied: number
  filesFailed: number
  bytesCopied: number
}

export interface ReportSummary {
  jobId: string
  jobName: string
  revision: string
  createdAt: string
  /**
   * 生成报告时任务所处的状态。
   *
   * 必须写进报告：一份"被取消"或"失败"的任务，如果报告里只写"未通过 N 个"，
   * 拿到报告的人会误以为备份跑完了只是有坏文件 —— 这两件事后果完全不同。
   */
  jobState: JobState
  sourcePath: string
  sourceLabel: string
  hashAlgorithm: HashAlgorithm
  manifestFormat: ManifestFormat
  totalFiles: number
  totalBytes: number
  verifiedFiles: number
  failedFiles: number
  durationSeconds: number | null
  targets: ReportTargetSummary[]
  project: ProjectInfo
}

export interface ReportRevision {
  id: number
  jobId: string
  /** R001、R002 …… 单调递增，旧修订永不被覆盖 */
  revision: string
  createdAt: string
  /** 该修订的目录绝对路径 */
  dir: string
  /** 各格式的绝对文件路径 */
  files: Partial<Record<ReportFormat, string>>
  summary: ReportSummary
}

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

/**
 * 上一次拷贝任务用过的信息，用于下次打开拷贝页时预填。
 *
 * 与 `store.getLatestProjectTemplate()`（项目信息模板）分工不同：
 * 那个管的是"机型 / 镜头 / 人员"这类**跟着戏走**的内容，
 * 这里管的是"上次从哪个盘拷到哪个盘、用了什么选项"这类**跟着操作走**的内容 ——
 * 现场常常是同一张卡连拷到几块盘，每次都重新选一遍路径纯属浪费。
 *
 * 刻意只存路径与选项，不存任务名：任务名是每次都不一样的（换了卡就要改），
 * 自动填一个错的比空着更烦人。
 */
export interface LastJobDraft {
  sourcePath: string
  targetPaths: string[]
  /**
   * 上次填的项目名。
   *
   * 必须单独记：`getLatestProjectTemplate()` 只看**未分组**的任务，
   * 一个人如果习惯把任务挂到母项目下，项目名就永远拿不回来 ——
   * 那正是"下次拷贝记不住上次项目名"的根因。
   */
  projectName: string
}

/**
 * 配色皮肤 id 列表。
 *
 * 2026-10-11 起为**三套皮肤**（中性 / 石墨蓝 / 暖砂），**默认中性**。
 * 此前是五套（多一个暗房 darkroom 与靛青 indigo）—— 选项太多反而挑不出来，砍到三套。
 * 「中性」的色值直接写进了 `styles/tokens.css` 的**基础块**（`html[data-mode='…']`），
 * 所以 `mono` **没有自己的覆盖块**。
 *
 * 皮肤只换颜色，不换版式；版式由视图模式（见 ViewSwitch）负责。
 * 明暗两档（`themeMode`）与皮肤正交，两者都在设置页的「外观」卡里选。
 *
 * ⚠️ 加一套皮肤要同时动三处，漏一处**都不报错**但会出问题：
 *   1. 这里（类型与顺序）
 *   2. `styles/tokens.css` 里的明暗两块覆盖 —— 漏了是"点了没反应"
 *   3. `i18n/messages.ts` 的中英两份皮肤名 —— 漏了是界面上冒出键名
 */
export const THEMES = ['mono', 'steel', 'sand'] as const
export type ThemeId = (typeof THEMES)[number]

/**
 * 已经不再合法、但可能存在于老存档里的主题 id。
 *
 * 必须留一份：设置是从 `settings_kv` 里软合并读出来的（`getSettings` 不做校验），
 * 老用户升上来时 `themeId` 仍是 `'qinghe'`（或 2.0.5 那批的 `'darkroom'` / `'indigo'`）。
 * 若不归一化，它会一路漏到 `<html data-skin="…">`，而 tokens.css 已没有匹配这个
 * 值的块 —— 于是所有 `--accent` 之类全部取不到值，界面变成一片无样式的
 * 透明块，看起来像应用崩了，**而且不报任何错**。
 *
 * ⚠️ 这份名单只用于**测试枚举**（store / schemas 两条用例各有一轮）。
 * `migrateThemeId` 自己不读它 —— 它只查 `THEMES`，不在名单里的一律回落默认。
 */
export const LEGACY_THEME_IDS = [
  'qinghe',
  'wuguang',
  'cheese',
  'iris',
  'studio',
  'darkroom',
  'indigo'
] as const

/** 把任意历史值归一化成当前合法主题 id。未知值一律回落到默认。 */
export function migrateThemeId(value: unknown): ThemeId {
  if (typeof value === 'string' && (THEMES as readonly string[]).includes(value)) {
    return value as ThemeId
  }
  return DEFAULT_SETTINGS.themeId
}

export const THEME_MODES = ['system', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

export const LANGUAGES = ['zh-CN', 'en'] as const
export type Language = (typeof LANGUAGES)[number]

export interface AppSettings {
  language: Language
  themeId: ThemeId
  themeMode: ThemeMode
  hashAlgorithm: HashAlgorithm
  manifestFormat: ManifestFormat
  verifyAfterWrite: boolean
  /** 同时写入的目标数量上限（1–8） */
  maxParallelTargets: number
  /**
   * 「性能与行为」档位。只作**一键套用**的记录，不反向推断 ——
   * 用户手动改细项后这里仍是上次选的档位（界面可据此显示"已微调"）。
   */
  performanceMode: PerformanceMode
  /** 断点续传：残留的分片文件若大小未超预期则续写 */
  resumePartialFiles: boolean
  /** 任务完成后弹出目标盘 */
  ejectAfterCopy: boolean
  /** 用户指定的 ffmpeg 所在目录；null 表示自动查找 */
  ffmpegDir: string | null
  /** 用户指定的官方 arrirawhde 绝对路径；null 表示自动查找 */
  arrirawHdePath: string | null
  /** 用户在知晓后果后同意在缺少官方工具时降级为普通拷贝 */
  acceptHdeDowngrade: boolean
  /**
   * 为视频素材提取首帧（写进报告）。
   *
   * 默认开启：报告里能看到每条素材的画面，是判断"卡有没有读错"最直接的手段。
   * 私有格式（R3D / BRAW）走文件内嵌预览图，不解码，几乎不耗时。
   */
  extractFrames: boolean
  /**
   * 最多为多少条素材提取首帧并写进报告；0 表示不限制。
   *
   * 存在的理由：一张五千条素材的卡，PDF 里塞五千张图会变成几百 MB。
   * 默认不限制（按用户要求"每条视频都出首帧"），需要时在这里收口。
   */
  maxFrameExtractions: number
  /** 并行提取首帧的进程数（1–8） */
  frameConcurrency: number
  /**
   * 任务开始 / 结束 / 出错时给一声提示音。
   *
   * 现场拷卡时人经常不在机器跟前，靠"看一眼屏幕"发现任务结束不现实；
   * 出错更需要立刻被注意到。默认开启。
   */
  soundEnabled: boolean
  /** 提示音音量（0–1） */
  soundVolume: number
  /**
   * 任务结束后是否生成报告。
   *
   * 默认开启（与历史行为一致）。关掉后任务完成只剩数据库记录与日志，
   * 不再产出 HTML/PDF/清单 —— 适合"只想要拷贝本身"的轻量场景。
   * 注意：关闭的是**自动生成**；任务详情里仍可手动补一份（受"运行中不许生成"红线约束）。
   */
  generateReport: boolean
  /**
   * 报告输出目录。
   *
   * null（默认）= 保持历史行为：本机 `<userData>/reports/<jobId>/R00N/`，
   * 并另发一份到目标盘 `SecureReel/<任务名>_R001/`。
   * 指定绝对路径时，报告改写到该目录（仍按任务建子目录），不再发目标盘副本。
   */
  reportOutputDir: string | null
  /**
   * 全部目标弹出后是否关机。
   *
   * ⚠️ 破坏性操作，**默认关闭**。只在任务**成功完成**（非失败/取消）时触发，
   * 且留一段缓冲倒计时允许用户取消（"后悔药"）。适合无人值守过夜拷卡。
   */
  shutdownAfterCopy: boolean
  /**
   * 为每条视频素材生成代理（ProRes）。
   *
   * 默认关闭：代理要额外读一遍源、写一份成品，一小时素材可能十几分钟，
   * 且体积不小（ProRes 422 Proxy 约 45 Mbps）。需要给剪辑交代理时再开。
   */
  proxyEnabled: boolean
  /** 代理规格：422 Proxy / LT / 422 / HQ。默认 Proxy（体积最小、剪辑最顺）。 */
  proxyProfile: ProxyProfile
  /** 代理输出分辨率。默认 1080p。只降不升。 */
  proxyResolution: ProxyResolution
  /** 代理编码。默认 ProRes（两平台恒定可用）。 */
  proxyCodec: ProxyCodec
  /**
   * 默认套在代理上的 3D LUT（`.cube` 绝对路径）；null = 不套。
   *
   * 只是**默认值**，拷贝页可针对单次任务另选或清空。
   */
  proxyLutPath: string | null
  /** 并行生成代理的进程数（1–4） */
  proxyConcurrency: number
  /**
   * 每条视频出几张候选静帧（3–4）。
   *
   * 与"首帧提取"不同：静帧会在片子里均匀取多个时间点、挑清晰度最高的几张，
   * 供筛选精彩画面用。0 表示不出（只保留原有首尾帧）。
   */
  stillFrameCount: number
}

/** ProRes 代理规格。数值对应 ffmpeg `-profile:v`。 */
export const PROXY_PROFILES = ['422-proxy', '422-lt', '422', '422-hq'] as const
export type ProxyProfile = (typeof PROXY_PROFILES)[number]

/**
 * 代理输出分辨率。
 *
 * ⚠️ **只降不升**：源比目标矮就保持原分辨率（靠 `-vf scale` 里的 `min(ih,H)`）。
 * 往小放大没有意义 —— 它不会凭空多出细节，只会把文件撑大、让剪辑白等。
 */
export const PROXY_RESOLUTIONS = ['1080p', '1440p', '4k'] as const
export type ProxyResolution = (typeof PROXY_RESOLUTIONS)[number]

/** 各分辨率对应的**目标高度**（像素）。宽按源比例自动算，取偶。 */
export const PROXY_RESOLUTION_HEIGHT: Record<ProxyResolution, number> = {
  '1080p': 1080,
  '1440p': 1440,
  '4k': 2160
}

/**
 * 代理编码。
 *
 * - `prores`：FFmpeg 原生 `prores_ks`（LGPL），**两平台恒定可用**，剪辑最顺。
 * - `h264` / `h265`：走**本机硬件编码器**（macOS VideoToolbox / Win NVENC·QSV·AMF），
 *   h264 另有 `libopenh264`（BSD）软件兜底；h265 没有软件兜底（libx265 是 GPL，不用）。
 *
 * 为什么不给用户选具体硬件（NVENC/QSV/AMF）：由运行时探测**自动挑最优**，
 * 用户只关心"我要 H.264 还是 H.265"。
 */
export const PROXY_CODECS = ['prores', 'h264', 'h265'] as const
export type ProxyCodec = (typeof PROXY_CODECS)[number]

/**
 * 「性能与行为」的档位预设。
 *
 * 现场多数时候不该让用户逐项去调并行数/断点续传/拷完弹出这些细项 ——
 * 一个档位把一套合理的组合一次设好，想微调再展开「高级」。
 * 档位只做**一键套用**，不反向推断（手动改细项后不会自动跳档）。
 */
export const PERFORMANCE_MODES = ['quiet', 'standard', 'turbo'] as const
export type PerformanceMode = (typeof PERFORMANCE_MODES)[number]

/** 档位 → 各细项的取值。`AppSettings` 里对应的字段与之同名。 */
export const PERFORMANCE_MODE_PRESETS: Record<
  PerformanceMode,
  Pick<AppSettings, 'maxParallelTargets' | 'resumePartialFiles' | 'ejectAfterCopy' | 'shutdownAfterCopy'>
> = {
  /** 静默/省心：少占资源、拷完自动弹出。适合后台跑，不打断别的活。 */
  quiet: { maxParallelTargets: 2, resumePartialFiles: true, ejectAfterCopy: true, shutdownAfterCopy: false },
  /** 标准：均衡，默认值。 */
  standard: { maxParallelTargets: 4, resumePartialFiles: true, ejectAfterCopy: false, shutdownAfterCopy: false },
  /** 极速：所有目标盘并行拉满，适合急着交片。 */
  turbo: { maxParallelTargets: 8, resumePartialFiles: true, ejectAfterCopy: false, shutdownAfterCopy: false }
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'zh-CN',
  themeId: 'mono',
  themeMode: 'dark',
  hashAlgorithm: 'xxhash64',
  manifestFormat: 'asc-mhl-2.0',
  verifyAfterWrite: true,
  maxParallelTargets: 4,
  performanceMode: 'standard',
  resumePartialFiles: true,
  ejectAfterCopy: false,
  ffmpegDir: null,
  arrirawHdePath: null,
  acceptHdeDowngrade: false,
  extractFrames: true,
  maxFrameExtractions: 0,
  frameConcurrency: 4,
  soundEnabled: true,
  soundVolume: 0.6,
  generateReport: true,
  reportOutputDir: null,
  shutdownAfterCopy: false,
  proxyEnabled: false,
  proxyProfile: '422-proxy',
  proxyResolution: '1080p',
  proxyCodec: 'prores',
  proxyLutPath: null,
  proxyConcurrency: 1,
  stillFrameCount: 0
}

/* ------------------------------------------------------------------ *
 * HDE 适配层
 * ------------------------------------------------------------------ */

export interface HdeToolStatus {
  /** CODEX Device Manager 虚拟文件系统是否可用 */
  vfsAvailable: boolean
  /** 已挂载的 CODEX VFS 卷路径 */
  vfsVolumes: string[]
  /** 官方 arrirawhde 可执行文件路径；未找到为 null */
  transcoderPath: string | null
  /** 转码器版本（--version 输出），未探测到为 null */
  transcoderVersion: string | null
  /** 面向用户的说明 */
  message: string
  /** 需要用户确认才能降级 */
  requiresUserConfirmation: boolean
}

export type HdeCameraModel = 'alexa-mini' | 'alexa-mini-lf' | 'alexa-35' | 'alexa-35-xtreme' | 'alexa-265' | 'unknown'

export interface HdeCapabilityDecision {
  model: HdeCameraModel
  /** 走 CODEX VFS 读取（Mini / Mini LF） */
  useVfs: boolean
  /** 必须调用官方 arrirawhde（35 / 35 Xtreme / 265） */
  requiresTranscoder: boolean
  /** 允许继续执行（可能已降级） */
  canProceed: boolean
  /** 是否已降级为普通 ARRIRAW 拷贝 */
  degraded: boolean
  message: string
}

/* ------------------------------------------------------------------ *
 * 事件（主进程 → 渲染进程）
 * ------------------------------------------------------------------ */

export interface LogEntry {
  at: string
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
}

export type MainEvent =
  | { type: 'job:progress'; payload: JobProgress }
  | { type: 'job:state'; payload: { jobId: string; state: JobState } }
  | { type: 'job:file'; payload: { jobId: string; file: CopyJobFile } }
  /**
   * 一批中间态变更（已按 200ms 合并）。载荷刻意用增量而不是整行，
   * 见 `FileStateDelta` 的说明。
   */
  | { type: 'job:files-delta'; payload: { jobId: string; deltas: FileStateDelta[] } }
  /**
   * 要求界面**重新拉取**该任务的文件清单。
   *
   * 只在"主进程把一批中间态改回 pending"之后发：任务开始时的
   * `resetInFlightFiles` 会把上次中断留下的 `copying`/`verifying` 归零，
   * 若不通知，界面会一直显示上次崩溃时卡住的那几个"拷贝中"。
   */
  | { type: 'job:files-resync'; payload: { jobId: string } }
  | { type: 'job:log'; payload: { jobId: string; entry: LogEntry } }
  | { type: 'reports:changed'; payload: { jobId: string } }
  | { type: 'toast'; payload: { level: 'info' | 'warn' | 'error' | 'success'; message: string } }

/* ------------------------------------------------------------------ *
 * IPC 结果包装
 * ------------------------------------------------------------------ */

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

/* ------------------------------------------------------------------ *
 * 体积统计
 * ------------------------------------------------------------------ */

export interface DriveUsage {
  path: string
  label: string
  totalBytes: number
  freeBytes: number
  requiredBytes: number | null
  sufficient: boolean | null
}

/* ------------------------------------------------------------------ *
 * 扫描结果
 * ------------------------------------------------------------------ */

export interface ScanResult {
  root: string
  kind: VolumeKind
  isCodExVfs: boolean
  fileCount: number
  totalBytes: number
  /** 体积最大的若干文件，供 UI 预览 */
  preview: { relPath: string; sizeBytes: number }[]
  /** 卷上文件后缀直方图 */
  extensions: { ext: string; count: number; bytes: number }[]
  warnings: string[]
}
