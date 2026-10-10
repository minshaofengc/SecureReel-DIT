/**
 * 预加载脚本 —— 渲染进程与主进程之间唯一的通道。
 *
 * 渲染进程跑在沙箱里、没有 Node 集成，只能通过这里暴露的方法访问系统。
 * 暴露面刻意收得很窄：每个方法都对应一个明确的主进程处理器，
 * 不存在"传入任意通道名"这种万能入口。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { CreateJobRequest, SecureReelApi } from '@shared/ipc'

const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, payload) as Promise<T>

const api: SecureReelApi = {
  app: {
    info: () => invoke(IPC.appInfo)
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    update: (patch) => invoke(IPC.settingsUpdate, patch)
  },
  volumes: {
    list: () => invoke(IPC.volumesList),
    inspect: (path) => invoke(IPC.volumesInspect, { path }),
    scan: (path) => invoke(IPC.volumesScan, { path }),
    usage: (paths) => invoke(IPC.volumesUsage, { paths, requiredBytes: null }),
    eject: (path) => invoke(IPC.volumesEject, { path }),
    pickPath: (kind, title) => invoke(IPC.pathPick, { kind, title })
  },
  jobs: {
    create: (request: CreateJobRequest) => invoke(IPC.jobCreate, request),
    list: () => invoke(IPC.jobList),
    get: (jobId) => invoke(IPC.jobGet, { jobId }),
    files: (jobId, limit, offset) => invoke(IPC.jobFiles, { jobId, limit, offset }),
    progress: (jobId) => invoke(IPC.jobProgress, { jobId }),
    start: (jobId) => invoke(IPC.jobStart, { jobId }),
    pause: (jobId) => invoke(IPC.jobPause, { jobId }),
    resume: (jobId) => invoke(IPC.jobResume, { jobId }),
    cancel: (jobId) => invoke(IPC.jobCancel, { jobId }),
    remove: (jobId) => invoke(IPC.jobDelete, { jobId }),
    recoverable: () => invoke(IPC.jobRecoverable),
    lastDraft: () => invoke(IPC.jobLastDraft),
    addTarget: (jobId, path) => invoke(IPC.jobAddTarget, { jobId, path }),
    setParent: (jobId, parentProjectId) => invoke(IPC.jobSetParent, { jobId, parentProjectId })
  },
  project: {
    get: (jobId) => invoke(IPC.projectGet, { jobId }),
    save: (jobId, info) => invoke(IPC.projectSave, { jobId, info }),
    template: () => invoke(IPC.projectTemplate)
  },
  parents: {
    list: () => invoke(IPC.parentList),
    get: (parentProjectId) => invoke(IPC.parentGet, { parentProjectId }),
    create: (name, details) => invoke(IPC.parentCreate, { name, details }),
    update: (parentProjectId, patch) => invoke(IPC.parentUpdate, { parentProjectId, ...patch }),
    remove: (parentProjectId) => invoke(IPC.parentDelete, { parentProjectId }),
    recall: (parentProjectId) => invoke(IPC.parentRecall, { parentProjectId })
  },
  reports: {
    list: (jobId) => invoke(IPC.reportsList, { jobId }),
    regenerate: (jobId) => invoke(IPC.reportsRegenerate, { jobId }),
    reveal: (path) => invoke(IPC.reportsReveal, { path }),
    open: (path) => invoke(IPC.reportsOpen, { path })
  },
  hde: {
    status: () => invoke(IPC.hdeStatus),
    decide: (path) => invoke(IPC.hdeDecide, { path })
  },
  kv: {
    get: (key) => invoke(IPC.kvGet, { key }),
    set: (key, value) => invoke(IPC.kvSet, { key, value })
  },
  logs: {
    tail: (lines) => invoke(IPC.logsTail, { lines }),
    reveal: () => invoke(IPC.logsReveal),
    exportDiagnostics: () => invoke(IPC.logsExportDiagnostics)
  },
  onEvent: (handler) => {
    const listener = (_event: unknown, payload: unknown): void => handler(payload)
    ipcRenderer.on(IPC.event, listener)
    return () => {
      ipcRenderer.removeListener(IPC.event, listener)
    }
  },
  window: {
    setTitleBarOverlay: (colors) => invoke(IPC.windowSetTitleBar, colors)
  }
}

contextBridge.exposeInMainWorld('securereel', api)
