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
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from 'react'
import type { AppInfo } from '@shared/ipc'
import type {
  AppSettings,
  CopyJob,
  CopyJobFile,
  FileStateDelta,
  IpcResult,
  JobProgress,
  LogEntry,
  MainEvent,
  ParentProject,
  ProjectDraft,
  ReportRevision
} from '@shared/types'
import { DEFAULT_SETTINGS, cueForJobState, isJobLive, shouldApplyFileStateChange } from '@shared/types'
import { translate } from '../i18n'
import { playCue, unlockAudio } from '../sound'

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
  setProjectDraft: Dispatch<SetStateAction<ProjectDraft | null>>
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
  /**
   * 每个任务的 relPath → 行下标。
   *
   * 刻意不放进 React state：它只服务于查找，不参与渲染。存在的理由很实在 ——
   * 文件表可能有上千行，而中间态事件每 200ms 就来一批，
   * 逐条 `findIndex` 线性扫的话每秒就是几十万次比较，全花在没意义的查找上。
   */
  const fileIndex = useRef<Record<string, Map<string, number>>>({})
  /**
   * 上一次看到的每个任务的状态。
   *
   * 提示音只该在状态**发生变化**时响一次，而不是每次收到事件都响 ——
   * 而且要靠它区分"刚开始"和"刚结束"。
   */
  const lastJobState = useRef<Record<string, CopyJob['state']>>({})
  /**
   * 设置的最新值。
   *
   * 事件回调（applyEvent）需要读提示音开关与音量，但不能把 settings 放进
   * 它的依赖数组 —— 那样每改一次设置都会重新订阅一次主进程事件。
   */
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  /*
   * 音频上下文必须在**用户交互之后**才能启动（Chromium 的自动播放策略）。
   * 挂一次性监听：界面上第一次按下就把它解锁，之后任何时候都能响。
   */
  useEffect(() => {
    const unlock = (): void => unlockAudio()
    window.addEventListener('pointerdown', unlock, { once: true })
    return () => window.removeEventListener('pointerdown', unlock)
  }, [])

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
      const list = (await unwrap(window.securereel.jobs.files(jobId, limit, 0))).slice(0, MAX_FILE_ROWS)
      // 索引必须与列表同时重建，否则增量事件会改到错行上去
      fileIndex.current[jobId] = new Map(list.map((file, index) => [file.relPath, index]))
      setFiles((current) => ({ ...current, [jobId]: list }))
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
          /*
           * 提示音。
           *
           * 必须自己记住上一次的状态：`job:state` 只是"当前是什么"，
           * 不带"从什么变成的"。没有这一步就分不清"刚开始"和"刚结束"，
           * 也无法避免同一次变化被重复响。
           */
          const previousState = lastJobState.current[payload.jobId]
          lastJobState.current[payload.jobId] = payload.state
          if (previousState !== undefined) {
            const cue = cueForJobState(previousState, payload.state)
            if (cue !== null && settingsRef.current.soundEnabled) {
              playCue(cue, settingsRef.current.soundVolume)
            }
          }
          setJobs((current) =>
            current.map((job) => (job.id === payload.jobId ? { ...job, state: payload.state } : job))
          )
          /*
           * 进入非运行态后引擎就不再推中间态了，而库里可能还留着 copying /
           * verifying（取消、崩溃恢复、异常退出都会这样）。这里重拉一次，
           * 界面才与事实一致。
           *
           * 暂停**不**重拉：paused 仍属运行态，那些"拷贝中"是真实状态，
           * 重拉反而会把正在动的进度打回原样。
           */
          if (!isJobLive(payload.state)) void loadFiles(payload.jobId, 1500)
          break
        }
        case 'job:file': {
          const payload = event.payload as { jobId: string; file: CopyJobFile }
          setFiles((current) => {
            const list = current[payload.jobId]
            if (list === undefined) return current
            const index = fileIndex.current[payload.jobId]?.get(payload.file.relPath) ?? -1
            if (index < 0) {
              // 清单里还没这一行（正常流程不会发生，重拉之后才有）—— 追加并补索引
              fileIndex.current[payload.jobId]?.set(payload.file.relPath, list.length)
              return { ...current, [payload.jobId]: [...list, payload.file] }
            }
            const next = list.slice()
            next[index] = payload.file
            return { ...current, [payload.jobId]: next }
          })
          break
        }
        case 'job:files-delta': {
          const payload = event.payload as { jobId: string; deltas: FileStateDelta[] }
          setFiles((current) => {
            const list = current[payload.jobId]
            const index = fileIndex.current[payload.jobId]
            if (list === undefined || index === undefined) return current
            const next = list.slice()
            let changed = false
            for (const delta of payload.deltas) {
              const at = index.get(delta.relPath)
              if (at === undefined) continue
              const previous = next[at]
              if (previous === undefined) continue
              /*
               * 迟到的中间态必须挡掉：中间态是延迟 200ms 合并发送的，
               * 完全可能晚于终态到达。不挡的话，一个界面上已经写着「已校验」
               * 的行会被 200ms 前的「校验中」打回去 —— 比不显示中间态还糟。
               */
              if (!shouldApplyFileStateChange(previous.state, delta.state)) continue
              /*
               * 只在字段真的不同时才把新行放回数组。这一步是性能关键：
               * 行组件套了 React.memo，引用没变就跳过重渲染 ——
               * 上千行的表里，一次中间态事件通常只弄脏几行。
               */
              const merged: CopyJobFile = { ...previous }
              let touched = false
              if (delta.state !== previous.state) {
                merged.state = delta.state
                touched = true
              }
              if (delta.bytesCopied !== undefined && delta.bytesCopied !== previous.bytesCopied) {
                merged.bytesCopied = delta.bytesCopied
                touched = true
              }
              if (delta.error !== undefined && delta.error !== previous.error) {
                merged.error = delta.error
                touched = true
              }
              if (delta.sourceHash !== undefined && delta.sourceHash !== previous.sourceHash) {
                merged.sourceHash = delta.sourceHash
                touched = true
              }
              if (!touched) continue
              next[at] = merged
              changed = true
            }
            // 一行都没真变就返回原引用，让 React 整个跳过这次更新
            return changed ? { ...current, [payload.jobId]: next } : current
          })
          break
        }
        case 'job:files-resync': {
          const payload = event.payload as { jobId: string }
          void loadFiles(payload.jobId, 1500)
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
    [loadFiles, pushToast, refreshReports]
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
