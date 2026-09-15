import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LogEntry } from '@shared/types'

type Level = LogEntry['level']

const LEVEL_ORDER: Record<Level, number> = { info: 0, warn: 1, error: 2 }

/**
 * 结构化日志。
 *
 * 每行一条 JSON，落盘到 `<logsDir>/securereel-YYYY-MM-DD.jsonl`。
 * 写入串行化（promise 链）以避免并发 append 交织，同时不阻塞拷贝循环。
 * 生产代码里禁止 `console.log`，一律走这里。
 */
export class Logger {
  private queue: Promise<void> = Promise.resolve()
  private readonly dir: string
  private readonly minLevel: Level
  private readonly mirrorToConsole: boolean
  private lastError: string | null = null

  constructor(options: { dir: string; minLevel?: Level; mirrorToConsole?: boolean } = { dir: '' }) {
    this.dir = options.dir
    this.minLevel = options.minLevel ?? 'info'
    this.mirrorToConsole = options.mirrorToConsole ?? false
  }

  get directory(): string {
    return this.dir
  }

  /** 最近一次落盘失败的原因；用于在界面上提示"日志写不进去"。 */
  get lastWriteError(): string | null {
    return this.lastError
  }

  info(scope: string, message: string, meta?: Record<string, unknown>): void {
    this.write('info', scope, message, meta)
  }

  warn(scope: string, message: string, meta?: Record<string, unknown>): void {
    this.write('warn', scope, message, meta)
  }

  error(scope: string, message: string, meta?: Record<string, unknown>): void {
    this.write('error', scope, message, meta)
  }

  /** 生成一条日志条目（不落盘），用于通过 IPC 推送给界面。 */
  entry(level: Level, scope: string, message: string): LogEntry {
    return { at: new Date().toISOString(), level, scope, message }
  }

  private write(level: Level, scope: string, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return

    const entry: Record<string, unknown> = {
      at: new Date().toISOString(),
      level,
      scope,
      message
    }
    if (meta !== undefined) entry.meta = meta

    if (this.mirrorToConsole) {
      // eslint-disable-next-line no-console
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
      sink(`[${scope}] ${message}`)
    }

    if (this.dir === '') return

    const line = `${JSON.stringify(entry)}\n`
    const file = this.fileFor(new Date())
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        await appendFile(file, line, 'utf8')
      })
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error)
      })
  }

  /** 等待队列里的日志全部落盘。退出前调用。 */
  async flush(): Promise<void> {
    await this.queue
  }

  /**
   * 启动时清理过期日志：删掉保留期之前的按天日志文件。
   *
   * 日志按天累积且平时量不大，但没有清理策略的话几年后就是一堆没人看的
   * 文件 —— 在启动时顺手处理掉，用户无感。删除失败不影响启动。
   */
  async pruneOldLogs(retentionDays = 30): Promise<number> {
    if (this.dir === '') return 0
    let removed = 0
    try {
      const entries = await readdir(this.dir)
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
      for (const name of entries) {
        const match = /^securereel-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
        if (match === null) continue
        const stamp = Date.parse(`${match[1]}T00:00:00Z`)
        if (!Number.isFinite(stamp) || stamp >= cutoff) continue
        try {
          await rm(join(this.dir, name), { force: true })
          removed++
        } catch {
          /* 单个文件删不掉就算了，别让启动失败 */
        }
      }
    } catch {
      /* 日志目录读不到（例如不存在）不构成问题 */
    }
    return removed
  }

  private fileFor(date: Date): string {
    const stamp = date.toISOString().slice(0, 10)
    return join(this.dir, `securereel-${stamp}.jsonl`)
  }

  /** 读取最近 n 行日志文本（给"查看日志"用）。 */
  async tail(lines: number): Promise<string[]> {
    const file = this.fileFor(new Date())
    try {
      const content = await readFile(file, 'utf8')
      const all = content.split('\n').filter((line) => line.length > 0)
      const slice = all.slice(Math.max(0, all.length - lines))
      return slice.map((raw) => {
        try {
          const parsed = JSON.parse(raw) as LogEntry
          return `${parsed.at}  [${parsed.level.toUpperCase()}]  ${parsed.scope}  ${parsed.message}`
        } catch {
          return raw
        }
      })
    } catch {
      return []
    }
  }
}
