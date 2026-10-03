/**
 * SecureReel DIT —— 跨进程共享的领域模型。
 *
 * 这里只放纯粹的数据结构和常量，不依赖 Node 也不依赖 DOM，
 * 因此主进程、预加载脚本和渲染进程可以共用同一份定义。
 */

/* ------------------------------------------------------------------ *
 * 校验算法
 * ------------------------------------------------------------------ */

export const HASH_ALGORITHMS = ['xxhash64', 'md5', 'asc-c4'] as const
export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number]

export const HASH_ALGORITHM_LABELS: Record<HashAlgorithm, string> = {
  xxhash64: 'xxHash64',
  md5: 'MD5',
  'asc-c4': 'ASC C4 (SMPTE ST 2114)'
}

/**
 * 各算法输出的**字符串长度**。
 *
 * 注意这里不是"十六进制字符数"：
 *   · xxhash64 / md5 输出小写十六进制
 *   · ASC C4 输出的是 90 字符的 C4 标识（`c4` + 88 位 Base58），
 *     这是 SMPTE ST 2114 规定的标准文本形态，用在清单的 `<c4>` 元素里
 */
export const HASH_VALUE_LENGTH: Record<HashAlgorithm, number> = {
  xxhash64: 16,
  md5: 32,
  'asc-c4': 90
}

/* ------------------------------------------------------------------ *
 * 清单格式
 * ------------------------------------------------------------------ */

export const MANIFEST_FORMATS = ['asc-mhl-2.0', 'mhl-v1'] as const
export type ManifestFormat = (typeof MANIFEST_FORMATS)[number]

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
  bytesPerSecond: number
  /** 当前正在处理的文件（相对路径）。并发时是其中任意一个，仅作兼容保留 */
  currentFile: string | null
  /** 当前真正在处理的文件；串行时长度为 0 或 1，并发时最多等于文件级并发数 */
  activeFiles: ActiveFileProgress[]
  targets: TargetProgress[]
  etaSeconds: number | null
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

export const THEMES = ['qinghe', 'wuguang', 'cheese'] as const
export type ThemeId = (typeof THEMES)[number]

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
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'zh-CN',
  themeId: 'qinghe',
  themeMode: 'system',
  hashAlgorithm: 'xxhash64',
  manifestFormat: 'asc-mhl-2.0',
  verifyAfterWrite: true,
  maxParallelTargets: 4,
  resumePartialFiles: true,
  ejectAfterCopy: false,
  ffmpegDir: null,
  arrirawHdePath: null,
  acceptHdeDowngrade: false,
  extractFrames: true,
  maxFrameExtractions: 0,
  frameConcurrency: 4,
  soundEnabled: true,
  soundVolume: 0.6
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
