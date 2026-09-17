/**
 * 全局状态。
 *
 * 界面里的所有数据都从主进程那一边来，这里只做缓存 + 事件订阅。
 * 任何"本地先改、稍后同步"的做法都会在拷贝长跑任务里造成界面与实际不符，
 * 所以这里的原则是：**主进程是唯一事实来源**。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { AppInfo } from '@shared/ipc'
import type {
  AppSettings,
  CopyJob,
  CopyJobFile,
  IpcResult,
  JobProgress,
  LogEntry,
  MainEvent,
  ParentProject,
  ProjectDraft,
  ReportRevision
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { translate } from '../i18n'

export interface Toast {
  id: number
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
}

interface AppStateValue {
  ready: boolean
  settings: AppSettings
  appInfo: AppInfo | null
  jobs: CopyJob[]
  progress: Record<string, JobProgress>
  files: Record<string, CopyJobFile[]>
  logs: Record<string, LogEntry[]>
  reports: Record<string, ReportRevision[]>
  toasts: Toast[]
  recovered: CopyJob[]
  parents: ParentProject[]
  /**
   * 拷贝页上正在填的项目信息草稿（仅内存，不落库）。
   *
   * 拷贝页在单页应用里切走再切回会整个卸载。纯本地 state 会把
   * 填了一半的机型、镜头、人员全部丢掉 —— 现场丢这个很难受。
   */
  projectDraft: ProjectDraft | null
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  refreshParents: () => Promise<void>
  setProjectDraft: (draft: ProjectDraft | null) => void
  refreshJobs: () => Promise<void>
  refreshReports: (jobId: string) => Promise<void>
  loadFiles: (jobId: string, limit?: number) => Promise<void>
  /**
   * 取某个任务当前已落库的进度。
   *
   * 进度事件只在任务运行时推送；任务结束、或者重启应用之后再看已完成的任务，
   * 内存里没有任何进度数据，各目标统计就会显示成 0 和「进行中」——
   * 和「已完成」的任务状态自相矛盾。这里补一次读取。
   */
  seedProgress: (jobId: string) => Promise<void>
  pushToast: (level: Toast['level'], message: string) => void
  dismissToast: (id: number) => void
  dismissRecovered: () => void
}

const AppStateContext = createContext<AppStateValue | null>(null)

/** 打开 IPC 结果：失败时把原因交给调用方，绝不静默吞掉。 */
export async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw new Error(result.error)
  return result.data
}

const MAX_LOG_LINES = 400
const MAX_FILE_ROWS = 3000

export function AppStateProvider({ children }: { children: ReactNode }): ReactNode {
  const [ready, setReady] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [jobs, setJobs] = useState<CopyJob[]>([])
  const [progress, setProgress] = useState<Record<string, JobProgress>>({})
  const [files, setFiles] = useState<Record<string, CopyJobFile[]>>({})
  const [logs, setLogs] = useState<Record<string, LogEntry[]>>({})
  const [reports, setReports] = useState<Record<string, ReportRevision[]>>({})
  const [toasts, setToasts] = useState<Toast[]>([])
  const [recovered, setRecovered] = useState<CopyJob[]>([])
  const [parents, setParents] = useState<ParentProject[]>([])
  const [projectDraft, setProjectDraft] = useState<ProjectDraft | null>(null)
  const toastSeq = useRef(1)

  const pushToast = useCallback((level: Toast['level'], message: string) => {
    const id = toastSeq.current++
    setToasts((current) => [...current.slice(-4), { id, level, message }])
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id))
    }, level === 'error' ? 10_000 : 4_500)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const refreshJobs = useCallback(async () => {
    try {
      setJobs(await unwrap(window.securereel.jobs.list()))
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : String(error))
    }
  }, [pushToast])

  const refreshReports = useCallback(
    async (jobId: string) => {
      try {
        const list = await unwrap(window.securereel.reports.list(jobId))
        setReports((current) => ({ ...current, [jobId]: list }))
      } catch {
        /* 报告列表读不到就先空着，不影响任务本身 */
      }
    },
    []
  )

  const loadFiles = useCallback(async (jobId: string, limit = 1000) => {
    try {
      const list = await unwrap(window.securereel.jobs.files(jobId, limit, 0))
      setFiles((current) => ({ ...current, [jobId]: list.slice(0, MAX_FILE_ROWS) }))
    } catch {
      /* 同上 */
    }
  }, [])

  const seedProgress = useCallback(async (jobId: string) => {
    try {
      const value = await unwrap(window.securereel.jobs.progress(jobId))
      setProgress((current) => (current[jobId] === undefined ? { ...current, [jobId]: value } : current))
    } catch {
      /* 读不到就按没有进度处理，不影响其它功能 */
    }
  }, [])

  const refreshParents = useCallback(async () => {
    try {
      setParents(await unwrap(window.securereel.parents.list()))
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : String(error))
    }
  }, [pushToast])

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        const saved = await unwrap(window.securereel.settings.update(patch))
        setSettings(saved)
      } catch (error) {
        pushToast('error', error instanceof Error ? error.message : String(error))
      }
    },
    [pushToast]
  )

  const applyEvent = useCallback(
    (raw: unknown) => {
      const event = raw as MainEvent
      switch (event.type) {
        case 'job:progress': {
          const payload = event.payload as JobProgress
          setProgress((current) => ({ ...current, [payload.jobId]: payload }))
          setJobs((current) =>
            current.map((job) =>
              job.id === payload.jobId
                ? {
                    ...job,
                    state: payload.state,
                    filesDone: payload.filesDone,
                    filesFailed: payload.filesFailed,
                    bytesDone: payload.bytesDone
                  }
                : job
            )
          )
          break
        }
        case 'job:state': {
          const payload = event.payload as { jobId: string; state: CopyJob['state'] }
          setJobs((current) =>
            current.map((job) => (job.id === payload.jobId ? { ...job, state: payload.state } : job))
          )
          break
        }
        case 'job:file': {
          const payload = event.payload as { jobId: string; file: CopyJobFile }
          setFiles((current) => {
            const list = current[payload.jobId]
            if (list === undefined) return current
            const index = list.findIndex((file) => file.relPath === payload.file.relPath)
            const next = index >= 0 ? list.map((f, i) => (i === index ? payload.file : f)) : [...list, payload.file]
            return { ...current, [payload.jobId]: next }
          })
          break
        }
        case 'job:log': {
          const payload = event.payload as { jobId: string; entry: LogEntry }
          setLogs((current) => {
            const list = current[payload.jobId] ?? []
            return { ...current, [payload.jobId]: [...list, payload.entry].slice(-MAX_LOG_LINES) }
          })
          break
        }
        case 'reports:changed': {
          const payload = event.payload as { jobId: string }
          void refreshReports(payload.jobId)
          break
        }
        case 'toast': {
          const payload = event.payload as { level: Toast['level']; message: string }
          pushToast(payload.level, payload.message)
          break
        }
        default:
          break
      }
    },
    [pushToast, refreshReports]
  )

  // 初始化
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [info, currentSettings, jobList, recoverable, parentList] = await Promise.all([
          unwrap(window.securereel.app.info()),
          unwrap(window.securereel.settings.get()),
          unwrap(window.securereel.jobs.list()),
          unwrap(window.securereel.jobs.recoverable()),
          unwrap(window.securereel.parents.list())
        ])
        if (cancelled) return
        setAppInfo(info)
        setSettings(currentSettings)
        setJobs(jobList)
        setRecovered(recoverable)
        setParents(parentList)
        if (info.databaseQuarantine !== null) {
          /*
           * 旧数据库被备份留档这件事必须让用户知道，否则会以为数据丢了。
           *
           * 文案**在渲染层组织**，主进程只给事实（备份路径 / 有没有备份成功）：
           * 主进程拼一段中文的话，英文界面下就会冒出一整段中文；
           * 而且曾经主进程与这里各拼半句，界面上"检测到旧版本数据库"说了两遍。
           *
           * 这里用 translate() 而不是 t()：这个 effect 跑在组件树拿到语言设置之前，
           * 语言刚从主进程读回来，就在 currentSettings 里。
           */
          const { backupPath } = info.databaseQuarantine
          pushToast(
            'warn',
            translate(
              currentSettings.language,
              backupPath === null ? 'app.databaseQuarantineNoBackup' : 'app.databaseQuarantine',
              backupPath === null ? undefined : { backup: backupPath }
            )
          )
        }
        if (jobList.length > 0) {
          const latest = jobList[0]
          if (latest !== undefined) void refreshReports(latest.id)
        }
      } catch (error) {
        if (!cancelled) {
          // 这一步失败时语言设置多半也没读回来，退回默认语言
          pushToast(
            'error',
            translate(DEFAULT_SETTINGS.language, 'app.initFailed', {
              reason: error instanceof Error ? error.message : String(error)
            })
          )
        }
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pushToast, refreshReports])

  // 事件订阅
  useEffect(() => {
    const off = window.securereel.onEvent(applyEvent)
    return () => off()
  }, [applyEvent])

  const value = useMemo<AppStateValue>(
    () => ({
      ready,
      settings,
      appInfo,
      jobs,
      progress,
      files,
      logs,
      reports,
      toasts,
      recovered,
      parents,
      projectDraft,
      updateSettings,
      refreshParents,
      setProjectDraft,
      refreshJobs,
      refreshReports,
      loadFiles,
      seedProgress,
      pushToast,
      dismissToast,
      dismissRecovered: () => setRecovered([])
    }),
    [
      ready,
      settings,
      appInfo,
      jobs,
      progress,
      files,
      logs,
      reports,
      toasts,
      recovered,
      parents,
      projectDraft,
      updateSettings,
      refreshParents,
      refreshJobs,
      refreshReports,
      loadFiles,
      seedProgress,
      pushToast,
      dismissToast
    ]
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext)
  if (value === null) throw new Error('useAppState 必须在 AppStateProvider 内部使用')
  return value
}
