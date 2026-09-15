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
 *   · 其余按可解码处理，失败再退回内嵌预览
 */
export const MATERIAL_FORMATS = [
  'prores',
  'prores-raw',
  'r3d',
  'braw',
  'arriraw',
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

/* ------------------------------------------------------------------ *
 * 任务
 * ------------------------------------------------------------------ */

export interface CopyJob {
  id: string
  name: string
  sourcePath: string
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
  /** 当前正在处理的文件（相对路径） */
  currentFile: string | null
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
  frameConcurrency: 4
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
