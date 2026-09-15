import { join } from 'node:path'

/**
 * 应用本地目录结构。
 *
 * 刻意做成分层可测的形式：`buildAppPaths()` 只接收一个基础目录，
 * 不直接依赖 Electron，因此可以在单元测试里指向临时目录。
 */
export interface AppPaths {
  /** Electron 的 macOS userData 目录 */
  userDataDir: string
  /** 结构化日志 */
  logsDir: string
  /** 不可变报告档案（按任务 / 修订分层） */
  reportsDir: string
  /** HDE 相关中转文件 */
  hdeWorkDir: string
  /** SQLite 任务数据库 */
  dbFile: string
  /** 用户设置 */
  settingsFile: string
}

export function buildAppPaths(userDataDir: string): AppPaths {
  return {
    userDataDir,
    logsDir: join(userDataDir, 'logs'),
    reportsDir: join(userDataDir, 'reports'),
    hdeWorkDir: join(userDataDir, 'hde'),
    dbFile: join(userDataDir, 'securereel.sqlite'),
    settingsFile: join(userDataDir, 'settings.json')
  }
}
