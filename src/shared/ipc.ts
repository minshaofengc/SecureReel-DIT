/**
 * IPC 通道常量与请求/响应形状。
 *
 * 主进程与预加载脚本必须使用同一份常量，避免字符串拼写漂移。
 */
import type {
  AppSettings,
  CopyJob,
  CopyJobFile,
  CopyTarget,
  DriveUsage,
  HdeCapabilityDecision,
  HdeToolStatus,
  IpcResult,
  JobProgress,
  LastJobDraft,
  ParentProject,
  ProjectDetails,
  ProjectDraft,
  ProjectInfo,
  ReportRevision,
  ReportSummary,
  ScanResult,
  SourceDrive
} from './types'

export const IPC = {
  appInfo: 'app:info',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  volumesList: 'volumes:list',
  volumesInspect: 'volumes:inspect',
  volumesScan: 'volumes:scan',
  volumesUsage: 'volumes:usage',
  volumesEject: 'volumes:eject',
  pathPick: 'path:pick',

  jobCreate: 'job:create',
  jobList: 'job:list',
  jobGet: 'job:get',
  jobFiles: 'job:files',
  jobStart: 'job:start',
  jobPause: 'job:pause',
  jobResume: 'job:resume',
  jobCancel: 'job:cancel',
  jobDelete: 'job:delete',
  jobRecoverable: 'job:recoverable',
  jobLastDraft: 'job:last-draft',
  jobProgress: 'job:progress',
  jobAddTarget: 'job:add-target',
  jobSetParent: 'job:set-parent',

  projectGet: 'project:get',
  projectSave: 'project:save',
  projectTemplate: 'project:template',

  parentList: 'parent:list',
  parentGet: 'parent:get',
  parentCreate: 'parent:create',
  parentUpdate: 'parent:update',
  parentDelete: 'parent:delete',
  parentRecall: 'parent:recall',

  reportsList: 'reports:list',
  reportsRegenerate: 'reports:regenerate',
  reportsReveal: 'reports:reveal',
  reportsOpen: 'reports:open',

  hdeStatus: 'hde:status',
  hdeDecide: 'hde:decide',

  logsTail: 'logs:tail',
  logsReveal: 'logs:reveal',
  logsExportDiagnostics: 'logs:export-diagnostics',

  event: 'main:event',

  /**
   * 同步窗口标题栏叠加层的颜色（只有 Windows 用得上）。
   *
   * 为什么非要回传：`titleBarOverlay` 的颜色由**主进程**设置在原生窗口上，
   * 而主题在**渲染层**切换；配色真源是 `styles/tokens.css`。
   * 让主进程也存一份调色板，就意味着以后改主题要记得改两处 ——
   * 所以改成渲染层把 CSS 变量算出来的颜色送回来。
   */
  windowSetTitleBar: 'window:set-title-bar'
} as const

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  userDataDir: string
  logsDir: string
  reportsDir: string
  /**
   * 启动时若把不兼容的旧数据库挪走留档，这里给出**结构化**的事实供界面组织提示。
   *
   * 刻意不返回"已经拼好的一句话"：界面是中英双语的，主进程拼中文的话
   * 英文界面下就会冒出一整段中文。文案归界面，主进程只负责给事实。
   */
  databaseQuarantine: { backupPath: string | null } | null
}

export interface CreateJobRequest {
  name: string
  sourcePath: string
  targets: { path: string }[]
  /** 任务模式；缺省 = copy（拷贝 + 校验） */
  mode?: CopyJob['mode']
  hashAlgorithm?: AppSettings['hashAlgorithm']
  manifestFormat?: AppSettings['manifestFormat']
  verifyAfterWrite?: boolean
  /** 归属的母项目；null 或缺省 = 未分组 */
  parentProjectId?: string | null
  /** 本次拷贝的项目信息；缺省 = 全空 */
  project?: ProjectDraft
}

export interface CreateJobResponse {
  job: CopyJob
  scan: ScanResult
}

/** 预加载脚本暴露给渲染进程的 API 形状。 */
export interface SecureReelApi {
  app: {
    info(): Promise<IpcResult<AppInfo>>
  }
  settings: {
    get(): Promise<IpcResult<AppSettings>>
    update(patch: Partial<AppSettings>): Promise<IpcResult<AppSettings>>
  }
  volumes: {
    list(): Promise<IpcResult<SourceDrive[]>>
    inspect(path: string): Promise<IpcResult<SourceDrive>>
    scan(path: string): Promise<IpcResult<ScanResult>>
    usage(paths: string[]): Promise<IpcResult<DriveUsage[]>>
    eject(path: string): Promise<IpcResult<boolean>>
    pickPath(kind: 'directory' | 'file', title?: string): Promise<IpcResult<string | null>>
  }
  jobs: {
    create(req: CreateJobRequest): Promise<IpcResult<CreateJobResponse>>
    list(): Promise<IpcResult<CopyJob[]>>
    get(jobId: string): Promise<IpcResult<CopyJob>>
    files(jobId: string, limit?: number, offset?: number): Promise<IpcResult<CopyJobFile[]>>
    /** 读取任务当前已落库的进度（任务结束后进度事件不再推送，界面需要主动拉） */
    progress(jobId: string): Promise<IpcResult<JobProgress>>
    start(jobId: string): Promise<IpcResult<CopyJob>>
    pause(jobId: string): Promise<IpcResult<CopyJob>>
    resume(jobId: string): Promise<IpcResult<CopyJob>>
    cancel(jobId: string): Promise<IpcResult<CopyJob>>
    remove(jobId: string): Promise<IpcResult<boolean>>
    recoverable(): Promise<IpcResult<CopyJob[]>>
    /** 上次任务用过的来源 / 目标 / 选项，用于拷贝页预填；从未建过任务时为 null */
    lastDraft(): Promise<IpcResult<LastJobDraft | null>>
    addTarget(jobId: string, path: string): Promise<IpcResult<CopyTarget[]>>
    /** 改任务的母项目归属；传 null = 移出到未分组 */
    setParent(jobId: string, parentProjectId: string | null): Promise<IpcResult<CopyJob>>
  }
  project: {
    get(jobId: string): Promise<IpcResult<ProjectInfo>>
    save(jobId: string, info: ProjectInfo): Promise<IpcResult<ProjectInfo>>
    /**
     * 取"上一次填写过的项目信息"，用于未选母项目时的预填。
     * 只会返回未分组任务填下的内容 —— 否则会出现"没选母项目却自动带了某部戏信息"的错觉。
     */
    template(): Promise<IpcResult<ProjectInfo | null>>
  }
  parents: {
    list(): Promise<IpcResult<ParentProject[]>>
    get(parentProjectId: string): Promise<IpcResult<ParentProject | null>>
    create(name: string, details: ProjectDetails): Promise<IpcResult<ParentProject>>
    update(
      parentProjectId: string,
      patch: { name?: string; details?: ProjectDetails }
    ): Promise<IpcResult<ParentProject>>
    /** 只解绑名下的拷贝任务，不删除任务本身 */
    remove(parentProjectId: string): Promise<IpcResult<boolean>>
    /**
     * 取这个母项目"该带进拷贝页"的项目信息。
     *
     * 与 `get` 的差别：档案里空着的字段会从该母项目名下历史拷贝任务的快照里补上。
     * 旧版本只在任务里存快照、不写回母项目，直接 `get` 会看到一份空档案，
     * 用户会以为从前填的职员与镜头丢了。只读，不落库。
     */
    recall(parentProjectId: string): Promise<IpcResult<ProjectDetails>>
  }
  reports: {
    list(jobId: string): Promise<IpcResult<ReportRevision[]>>
    regenerate(jobId: string): Promise<IpcResult<ReportSummary>>
    reveal(path: string): Promise<IpcResult<boolean>>
    open(path: string): Promise<IpcResult<boolean>>
  }
  hde: {
    status(): Promise<IpcResult<HdeToolStatus>>
    decide(path: string): Promise<IpcResult<HdeCapabilityDecision>>
  }
  logs: {
    tail(lines?: number): Promise<IpcResult<string[]>>
    reveal(): Promise<IpcResult<boolean>>
    /**
     * 导出诊断包：当天日志 + 版本/系统信息打成一个 zip，位置由用户选择。
     * 返回 zip 的绝对路径；用户取消保存对话框时返回 null。
     */
    exportDiagnostics(): Promise<IpcResult<string | null>>
  }
  onEvent(handler: (event: unknown) => void): () => void

  window: {
    /**
     * 把标题栏叠加层的颜色同步给主进程（Windows 无边框标题栏用）。
     *
     * 颜色由渲染层用 `getComputedStyle` 从当前主题的 CSS 变量里读出来，
     * 传的是**计算结果**而不是主题名 —— 保证主题配色的唯一真源仍然是 tokens.css。
     * 非 Windows 平台上主进程会静默忽略，所以调用方不必先判断平台。
     */
    setTitleBarOverlay(colors: { color: string; symbolColor: string }): Promise<IpcResult<boolean>>
  }
}
