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

  reportsList: 'reports:list',
  reportsRegenerate: 'reports:regenerate',
  reportsReveal: 'reports:reveal',
  reportsOpen: 'reports:open',

  hdeStatus: 'hde:status',
  hdeDecide: 'hde:decide',

  logsTail: 'logs:tail',
  logsReveal: 'logs:reveal',

  event: 'main:event'
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
  /** 启动时若把不兼容的旧数据库挪走留档，这里放说明文字，供界面提示 */
  databaseNotice: string | null
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
  }
  onEvent(handler: (event: unknown) => void): () => void
}
