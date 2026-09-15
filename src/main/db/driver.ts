/**
 * SQLite 驱动薄封装。
 *
 * 用 Node 22 内置的 `node:sqlite`（同步 API），好处是：
 *  - 不需要编译原生模块，装上就能跑
 *  - vitest（纯 Node）和 Electron 主进程里跑的是同一套驱动，行为一致
 *
 * 这一层的唯一价值是把驱动差异关在一个文件里：将来若要换成
 * better-sqlite3 或 SQLCipher，只需要改这里。
 */

/** SQLite 能接受的参数类型。注意：真值必须自己转成 1/0。 */
export type SqlValue = string | number | bigint | null | Uint8Array

export interface SqlRunResult {
  changes: number
  lastInsertRowid: number
}

export interface SqlStatement {
  run(...params: SqlValue[]): SqlRunResult
  get(...params: SqlValue[]): Record<string, SqlValue> | undefined
  all(...params: SqlValue[]): Record<string, SqlValue>[]
}

export interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}

/** JS 值 → SQL 值。`undefined` 一律当 NULL，布尔转 1/0。 */
export function toSqlValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value
  }
  if (value instanceof Uint8Array) return value
  if (value instanceof Date) return value.toISOString()
  throw new Error(`无法写入 SQLite 的值类型：${typeof value}`)
}

export function fromSqlBoolean(value: SqlValue | undefined): boolean {
  return Number(value ?? 0) === 1
}

export function fromSqlNumber(value: SqlValue | undefined): number {
  if (value === null || value === undefined) return 0
  return Number(value)
}

export function fromSqlNullableNumber(value: SqlValue | undefined): number | null {
  if (value === null || value === undefined) return null
  return Number(value)
}

export function fromSqlNullableString(value: SqlValue | undefined): string | null {
  if (value === null || value === undefined) return null
  return String(value)
}

/* ------------------------------------------------------------------ *
 * node:sqlite 适配
 * ------------------------------------------------------------------ */

interface NodeSqliteStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
}

interface NodeSqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): NodeSqliteStatement
  close(): void
}

class AdaptedStatement implements SqlStatement {
  constructor(private readonly inner: NodeSqliteStatement) {}

  run(...params: SqlValue[]): SqlRunResult {
    const result = this.inner.run(...params)
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid)
    }
  }

  get(...params: SqlValue[]): Record<string, SqlValue> | undefined {
    const row = this.inner.get(...params)
    return row === undefined ? undefined : (row as Record<string, SqlValue>)
  }

  all(...params: SqlValue[]): Record<string, SqlValue>[] {
    return this.inner.all(...params) as Record<string, SqlValue>[]
  }
}

class AdaptedDatabase implements SqlDatabase {
  constructor(private readonly inner: NodeSqliteDatabase) {}

  exec(sql: string): void {
    this.inner.exec(sql)
  }

  prepare(sql: string): SqlStatement {
    return new AdaptedStatement(this.inner.prepare(sql))
  }

  close(): void {
    this.inner.close()
  }
}

/**
 * 打开数据库。
 *
 * `path` 为 ':memory:' 时使用内存库（单元测试用）。
 */
export async function openDatabase(path: string): Promise<SqlDatabase> {
  let module: { DatabaseSync: new (path: string) => NodeSqliteDatabase }
  try {
    module = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => NodeSqliteDatabase
    }
  } catch (error) {
    throw new Error(
      `当前运行环境缺少 node:sqlite 模块，无法建立任务数据库。` +
        `请确认 Node.js 版本不低于 22.12。原始错误：${String(error)}`
    )
  }

  const raw = new module.DatabaseSync(path)
  const db = new AdaptedDatabase(raw)

  // WAL 让「拷贝过程中写检查点」不会卡住读取；外键约束保证删任务时不留孤儿行。
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')

  return db
}

/** 事务包装：抛错自动回滚。 */
export function transaction<T>(db: SqlDatabase, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw error
  }
}
