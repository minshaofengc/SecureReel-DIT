/**
 * 任务数据库的门面。
 *
 * 所有落库/取库都走这一个类，界面层看不到 SQL，也就不会出现
 * "某处忘了写事务"这类问题。
 */
import type {
  AppSettings,
  CopyJob,
  CopyJobFile,
  CopyTarget,
  FileState,
  FileTargetResult,
  JobState,
  LastJobDraft,
  MediaProbe,
  ParentProject,
  ProjectDetails,
  ProjectInfo,
  ReportRevision,
  ReportSummary,
  TargetProgress,
  VolumeKind
} from '@shared/types'
import { DEFAULT_SETTINGS, HASH_ALGORITHMS, JOB_MODES, JOB_STATES, MANIFEST_FORMATS, migrateThemeId, VOLUME_KINDS } from '@shared/types'
import {
  fillMissingDetails,
  hasCrew,
  hasLenses,
  hasSubstance,
  mergeTalentIntoParent,
  normalizeProjectDetails,
  normalizeProjectInfo
} from '@shared/project'
import {
  fromSqlBoolean,
  fromSqlNullableNumber,
  fromSqlNullableString,
  fromSqlNumber,
  openDatabase,
  toSqlValue,
  transaction,
  type SqlDatabase,
  type SqlValue
} from './driver'
import { quarantineDatabaseFile } from '@main/fs-utils'
import {
  JOB_COLUMN_MIGRATIONS,
  REQUIRED_JOB_COLUMNS,
  SCHEMA_POST_MIGRATION_SQL,
  SCHEMA_SQL,
  SCHEMA_VERSION
} from './schema'

type Row = Record<string, SqlValue>

function asString(value: SqlValue | undefined, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value)
}

function pick<T extends readonly string[]>(options: T, value: SqlValue | undefined, fallback: T[number]): T[number] {
  const raw = value === null || value === undefined ? '' : String(value)
  return (options as readonly string[]).includes(raw) ? (raw as T[number]) : fallback
}

export interface FileUpsertInput {
  relPath: string
  sizeBytes: number
}

export interface FilePatch {
  sourceHash?: string | null
  state?: FileState
  bytesCopied?: number
  error?: string | null
  probe?: MediaProbe | null
}

export interface PendingFile {
  id: number
  relPath: string
  sizeBytes: number
  bytesCopied: number
  state: FileState
}

/** 旧数据库被隔离留档的说明。 */
export interface QuarantineRecord {
  /** 不兼容的具体原因（缺哪些列） */
  reason: string
  /** 留档后的文件路径；挪不动时为 null */
  backupPath: string | null
}

/** `settings_kv` 里存「上次任务草稿」的键。 */
export const LAST_JOB_DRAFT_KEY = 'lastJobDraft'

export class Store {
  private quarantine: QuarantineRecord | null = null

  private constructor(private readonly db: SqlDatabase) {}

  static async open(path: string): Promise<Store> {
    const db = await openDatabase(path)
    const store = new Store(db)

    // 关键一步：先确认已有的表结构和当前代码兼容。
    // CREATE TABLE IF NOT EXISTS 对"表已存在但结构不同"是静默通过的，
    // 于是错误会推迟到第一次查询才爆出来，而且报的是跟真因无关的列名错误。
    const incompatible = store.detectIncompatibleSchema()

    if (incompatible !== null && path !== ':memory:') {
      try {
        db.close()
      } catch {
        /* 关不掉也要继续走隔离流程 */
      }
      const backupPath = await quarantineDatabaseFile(path)
      const fresh = await openDatabase(path)
      const freshStore = new Store(fresh)
      freshStore.migrate()
      freshStore.quarantine = { reason: incompatible, backupPath }
      freshStore.db
        .prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
        .run('quarantine', JSON.stringify(freshStore.quarantine))
      return freshStore
    }

    store.migrate()
    return store
  }

  /** 启动时是否有旧库被隔离；没有则为 null。 */
  get quarantined(): QuarantineRecord | null {
    return this.quarantine
  }

  /**
   * 检查 `jobs` 表是否与当前代码兼容。
   *
   * 返回 null 表示兼容（或表还不存在，属于全新库）；
   * 返回字符串表示不兼容，内容是缺了哪些列。
   */
  private detectIncompatibleSchema(): string | null {
    let columns: string[]
    try {
      const rows = this.db.prepare('PRAGMA table_info(jobs)').all()
      columns = rows.map((row) => String(row.name))
    } catch {
      return 'PRAGMA table_info 执行失败'
    }

    // 表还不存在 —— 全新数据库，正常路径
    if (columns.length === 0) return null

    const missing = REQUIRED_JOB_COLUMNS.filter((column) => !columns.includes(column))
    if (missing.length === 0) return null

    return `已有 jobs 表缺少列：${missing.join(', ')}（现有列：${columns.join(', ')}）`
  }


  /** 给单测用的内存库。 */
  static async openInMemory(): Promise<Store> {
    return Store.open(':memory:')
  }

  close(): void {
    this.db.close()
  }

  /**
   * 顺序不能换：
   *   1. 建表（`IF NOT EXISTS`，对老库只补齐缺的表）
   *   2. 给老库补上后加的列
   *   3. 建依赖新列的索引 —— 必须在 2 之后，
   *      否则在老库上会因为列还不存在而报错，并让 `exec()` 中断掉后面所有语句。
   */
  private migrate(): void {
    this.db.exec(SCHEMA_SQL)
    this.addMissingJobColumns()
    this.db.exec(SCHEMA_POST_MIGRATION_SQL)
    this.db
      .prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
      .run('version', String(SCHEMA_VERSION))
  }

  /**
   * 幂等的加列迁移。
   *
   * SQLite 没有 `ADD COLUMN IF NOT EXISTS`，重复执行会报 duplicate column，
   * 所以必须先查 `PRAGMA table_info` 再决定要不要执行。
   *
   * 放在 `migrate()` 里（而非 `open()` 的某个分支），是为了让
   * **正常路径与隔离重建路径都覆盖到** —— 隔离重建出来的新库结构是全新的，
   * 这里会自然跳过；而老库走的正是这条路径把缺失的列补上。
   */
  private addMissingJobColumns(): void {
    for (const migration of JOB_COLUMN_MIGRATIONS) {
      let columns: string[]
      try {
        columns = this.db
          .prepare(`PRAGMA table_info(${migration.table})`)
          .all()
          .map((row) => String(row.name))
      } catch {
        continue
      }
      // 表还不存在 —— SCHEMA_SQL 已经把它按最新结构建好了，无需补列
      if (columns.length === 0) continue
      if (columns.includes(migration.column)) continue
      this.db.exec(migration.ddl)
    }
  }

  /** 当前库记录的架构版本，便于诊断。 */
  schemaVersion(): string | null {
    try {
      const row = this.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('version')
      return row === undefined ? null : asString(row.value)
    } catch {
      return null
    }
  }

  /* ---------------- 设置 ---------------- */

  getSettings(): AppSettings {
    const row = this.db.prepare('SELECT value FROM settings_kv WHERE key = ?').get('app')
    if (row === undefined) return { ...DEFAULT_SETTINGS }
    try {
      const parsed = JSON.parse(asString(row.value)) as Partial<AppSettings>
      /*
       * themeId 必须显式归一化，不能只靠展开合并。
       *
       * 2026-10-04 起主题从四套收成一套（见 types.ts 的 THEMES），
       * 而这里读出来是**软合并、不校验**的 —— 老用户升上来时themeId 仍是
       * 'qinghe' 这类旧值，会一路漏到 <html data-theme="qinghe">。
       * tokens.css 现在按 data-mode 匹配、不看 data-theme，于是
       * 所有 --accent 之类全部取不到值，界面变成一片无样式的透明块，
       * 看起来像应用崩了 —— 而且不报任何错。
       */
      return { ...DEFAULT_SETTINGS, ...parsed, themeId: migrateThemeId(parsed.themeId) }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  saveSettings(settings: AppSettings): AppSettings {
    this.db
      .prepare('INSERT OR REPLACE INTO settings_kv (key, value) VALUES (?, ?)')
      .run('app', JSON.stringify(settings))
    return settings
  }

  /**
   * 读一条与环境无关的零散状态。
   *
   * `settings_kv` 是通用的键值表，`settings` 只是其中一条。这里给那些
   * **不属于 AppSettings** 的东西留口子 —— 比如"上次任务用过什么"，
   * 它既不是用户偏好，也不该跟着设置一起被重置。
   */
  getKv(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings_kv WHERE key = ?').get(key)
    return row === undefined ? null : asString(row.value)
  }

  setKv(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO settings_kv (key, value) VALUES (?, ?)').run(key, value)
  }

  /**
   * 上次任务草稿。
   *
   * 读不出来（没有 / JSON 坏了 / 形状不对）一律返回 null，让调用方按
   * "全新一次"处理 —— 预填只是便利，绝不能因为它自己坏了而挡住拷贝。
   */
  getLastJobDraft(): LastJobDraft | null {
    const raw = this.getKv(LAST_JOB_DRAFT_KEY)
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as Partial<LastJobDraft> | null
      if (parsed === null || typeof parsed !== 'object') return null
      if (typeof parsed.sourcePath !== 'string' || parsed.sourcePath === '') return null
      if (!Array.isArray(parsed.targetPaths)) return null
      return {
        sourcePath: parsed.sourcePath,
        targetPaths: parsed.targetPaths.filter((item): item is string => typeof item === 'string'),
        projectName: typeof parsed.projectName === 'string' ? parsed.projectName : ''
      }
    } catch {
      return null
    }
  }

  saveLastJobDraft(draft: LastJobDraft): void {
    this.setKv(LAST_JOB_DRAFT_KEY, JSON.stringify(draft))
  }

  /* ---------------- 任务 ---------------- */

  insertJob(job: CopyJob): void {
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO jobs (
             id, name, mode, source_path, source_root_name, source_kind, is_codex_vfs,
             hash_algorithm, manifest_format,
             verify_after_write, state, total_files, total_bytes, files_done, files_failed,
             bytes_done, created_at, started_at, finished_at, degradation_notice, parent_project_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          job.id,
          job.name,
          job.mode,
          job.sourcePath,
          job.sourceRootName,
          job.sourceKind,
          job.isCodExVfs ? 1 : 0,
          job.hashAlgorithm,
          job.manifestFormat,
          job.verifyAfterWrite ? 1 : 0,
          job.state,
          job.totalFiles,
          job.totalBytes,
          job.filesDone,
          job.filesFailed,
          job.bytesDone,
          job.createdAt,
          job.startedAt,
          job.finishedAt,
          job.degradationNotice,
          job.parentProjectId
        )

      for (const target of job.targets) {
        this.db
          .prepare(
            `INSERT INTO job_targets (job_id, id, path, label, enabled, free_bytes, writable, state)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
          )
          .run(
            job.id,
            target.id,
            target.path,
            target.label,
            target.enabled ? 1 : 0,
            target.freeBytes,
            target.writable ? 1 : 0
          )
      }
    })
  }

  getJob(jobId: string): CopyJob | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId)
    if (row === undefined) return null
    return this.mapJob(row, this.listTargets(jobId))
  }

  listJobs(): CopyJob[] {
    // 二级键用 rowid：同一毫秒内创建的任务时间戳完全相同，
    // 只按 created_at 排序会让顺序在两次查询之间抖动，界面上表现为任务"跳位置"。
    const rows = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC').all()
    return rows.map((row) => this.mapJob(row, this.listTargets(asString(row.id))))
  }

  /** 按母项目分组用：取某个母项目名下的全部任务。 */
  listJobsByParent(parentProjectId: string): CopyJob[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs WHERE parent_project_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(parentProjectId)
    return rows.map((row) => this.mapJob(row, this.listTargets(asString(row.id))))
  }

  countJobsByParent(parentProjectId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS total FROM jobs WHERE parent_project_id = ?')
      .get(parentProjectId)
    return fromSqlNumber(row?.total)
  }

  /** 上次异常退出时停在 running/paused 的任务，启动后需要提示用户恢复。 */
  listResumableJobs(): CopyJob[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE state IN ('running', 'paused', 'queued') ORDER BY created_at DESC")
      .all()
    return rows.map((row) => this.mapJob(row, this.listTargets(asString(row.id))))
  }

  updateJob(jobId: string, patch: Partial<CopyJob>): void {
    const columns: string[] = []
    const values: SqlValue[] = []

    const assign = (column: string, value: unknown): void => {
      columns.push(`${column} = ?`)
      values.push(toSqlValue(value))
    }

    if (patch.state !== undefined) assign('state', patch.state)
    if (patch.totalFiles !== undefined) assign('total_files', patch.totalFiles)
    if (patch.totalBytes !== undefined) assign('total_bytes', patch.totalBytes)
    if (patch.filesDone !== undefined) assign('files_done', patch.filesDone)
    if (patch.filesFailed !== undefined) assign('files_failed', patch.filesFailed)
    if (patch.bytesDone !== undefined) assign('bytes_done', patch.bytesDone)
    if (patch.startedAt !== undefined) assign('started_at', patch.startedAt)
    if (patch.finishedAt !== undefined) assign('finished_at', patch.finishedAt)
    if (patch.degradationNotice !== undefined) assign('degradation_notice', patch.degradationNotice)
    if (patch.hashAlgorithm !== undefined) assign('hash_algorithm', patch.hashAlgorithm)
    if (patch.manifestFormat !== undefined) assign('manifest_format', patch.manifestFormat)
    if (patch.sourceKind !== undefined) assign('source_kind', patch.sourceKind)
    if (patch.isCodExVfs !== undefined) assign('is_codex_vfs', patch.isCodExVfs)
    if (patch.parentProjectId !== undefined) assign('parent_project_id', patch.parentProjectId)

    if (columns.length === 0) return
    values.push(jobId)
    this.db.prepare(`UPDATE jobs SET ${columns.join(', ')} WHERE id = ?`).run(...values)
  }

  deleteJob(jobId: string): void {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId)
  }

  private mapJob(row: Row, targets: CopyTarget[]): CopyJob {
    return {
      id: asString(row.id),
      name: asString(row.name),
      mode: pick(JOB_MODES, row.mode, 'copy'),
      sourcePath: asString(row.source_path),
      sourceRootName: asString(row.source_root_name),
      sourceKind: pick(VOLUME_KINDS, row.source_kind, 'generic') as VolumeKind,
      isCodExVfs: fromSqlBoolean(row.is_codex_vfs),
      parentProjectId: fromSqlNullableString(row.parent_project_id),
      targets,
      hashAlgorithm: pick(HASH_ALGORITHMS, row.hash_algorithm, 'xxhash64'),
      manifestFormat: pick(MANIFEST_FORMATS, row.manifest_format, 'asc-mhl-2.0'),
      verifyAfterWrite: fromSqlBoolean(row.verify_after_write),
      state: pick(JOB_STATES, row.state, 'draft') as JobState,
      totalFiles: fromSqlNumber(row.total_files),
      totalBytes: fromSqlNumber(row.total_bytes),
      filesDone: fromSqlNumber(row.files_done),
      filesFailed: fromSqlNumber(row.files_failed),
      bytesDone: fromSqlNumber(row.bytes_done),
      createdAt: asString(row.created_at),
      startedAt: fromSqlNullableString(row.started_at),
      finishedAt: fromSqlNullableString(row.finished_at),
      degradationNotice: fromSqlNullableString(row.degradation_notice)
    }
  }

  /**
   * 任务级计数器的原子自增。
   *
   * 必须用 `SET x = x + ?` 而不是"先读后写绝对值" —— 后台校验是并发的，
   * 读改写会让多个文件的进度互相覆盖，最终数字偏小甚至回退。
   */
  incrementJobCounters(
    jobId: string,
    delta: { filesDone?: number; filesFailed?: number; bytesDone?: number }
  ): void {
    this.db
      .prepare(
        `UPDATE jobs SET
           files_done   = files_done   + ?,
           files_failed = files_failed + ?,
           bytes_done   = bytes_done   + ?
         WHERE id = ?`
      )
      .run(delta.filesDone ?? 0, delta.filesFailed ?? 0, delta.bytesDone ?? 0, jobId)
  }

  /** 目标级计数器的原子自增。 */
  incrementTargetCounters(
    jobId: string,
    targetId: string,
    delta: { filesDone?: number; filesFailed?: number; bytesCopied?: number }
  ): void {
    this.db
      .prepare(
        `UPDATE job_targets SET
           files_done   = files_done   + ?,
           files_failed = files_failed + ?,
           bytes_copied = bytes_copied + ?
         WHERE job_id = ? AND id = ?`
      )
      .run(delta.filesDone ?? 0, delta.filesFailed ?? 0, delta.bytesCopied ?? 0, jobId, targetId)
  }

  /** 修正扫描阶段记录的字节数（CODEX VFS 上 HDE 素材会报 0 字节）。 */
  updateFileSize(jobId: string, relPath: string, sizeBytes: number): void {
    this.db
      .prepare('UPDATE job_files SET size_bytes = ? WHERE job_id = ? AND rel_path = ?')
      .run(sizeBytes, jobId, relPath)
  }

  /* ---------------- 目标 ---------------- */

  listTargets(jobId: string): CopyTarget[] {
    const rows = this.db
      .prepare('SELECT * FROM job_targets WHERE job_id = ? ORDER BY rowid ASC')
      .all(jobId)
    return rows.map((row) => ({
      id: asString(row.id),
      path: asString(row.path),
      label: asString(row.label),
      enabled: fromSqlBoolean(row.enabled),
      freeBytes: fromSqlNullableNumber(row.free_bytes),
      writable: fromSqlBoolean(row.writable)
    }))
  }

  addTarget(jobId: string, target: CopyTarget): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO job_targets (job_id, id, path, label, enabled, free_bytes, writable, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
      )
      .run(
        jobId,
        target.id,
        target.path,
        target.label,
        target.enabled ? 1 : 0,
        target.freeBytes,
        target.writable ? 1 : 0
      )
  }

  updateTargetProgress(jobId: string, targetId: string, patch: Partial<TargetProgress>): void {
    const columns: string[] = []
    const values: SqlValue[] = []
    const assign = (column: string, value: unknown): void => {
      columns.push(`${column} = ?`)
      values.push(toSqlValue(value))
    }

    if (patch.state !== undefined) assign('state', patch.state)
    if (patch.filesDone !== undefined) assign('files_done', patch.filesDone)
    if (patch.filesFailed !== undefined) assign('files_failed', patch.filesFailed)
    if (patch.bytesCopied !== undefined) assign('bytes_copied', patch.bytesCopied)
    if (patch.error !== undefined) assign('error', patch.error)

    if (columns.length === 0) return
    values.push(jobId, targetId)
    this.db.prepare(`UPDATE job_targets SET ${columns.join(', ')} WHERE job_id = ? AND id = ?`).run(...values)
  }

  listTargetProgress(jobId: string): TargetProgress[] {
    const rows = this.db.prepare('SELECT * FROM job_targets WHERE job_id = ? ORDER BY rowid ASC').all(jobId)
    return rows.map((row) => ({
      targetId: asString(row.id),
      label: asString(row.label),
      state: (asString(row.state, 'pending') as TargetProgress['state']) ?? 'pending',
      filesDone: fromSqlNumber(row.files_done),
      filesFailed: fromSqlNumber(row.files_failed),
      bytesCopied: fromSqlNumber(row.bytes_copied),
      bytesPerSecond: 0,
      error: fromSqlNullableString(row.error)
    }))
  }

  /* ---------------- 文件 ---------------- */

  /**
   * 批量写入文件清单。
   *
   * 用 `ON CONFLICT DO NOTHING` 保留已经完成的记录 ——
   * 这样"重新扫描同一个任务"不会把已校验通过的文件打回 pending，
   * 断点续传才不会白干。
   */
  upsertFiles(jobId: string, files: FileUpsertInput[]): void {
    const statement = this.db.prepare(
      `INSERT INTO job_files (job_id, rel_path, size_bytes, state)
       VALUES (?, ?, ?, 'pending')
       ON CONFLICT (job_id, rel_path) DO NOTHING`
    )
    transaction(this.db, () => {
      for (const file of files) {
        statement.run(jobId, file.relPath, file.sizeBytes)
      }
    })
  }

  updateFile(jobId: string, relPath: string, patch: FilePatch): void {
    const columns: string[] = []
    const values: SqlValue[] = []
    const assign = (column: string, value: unknown): void => {
      columns.push(`${column} = ?`)
      values.push(toSqlValue(value))
    }

    if (patch.sourceHash !== undefined) assign('source_hash', patch.sourceHash)
    if (patch.state !== undefined) assign('state', patch.state)
    if (patch.bytesCopied !== undefined) assign('bytes_copied', patch.bytesCopied)
    if (patch.error !== undefined) assign('error', patch.error)
    if (patch.probe !== undefined) assign('probe_json', patch.probe === null ? null : JSON.stringify(patch.probe))

    if (columns.length === 0) return
    values.push(jobId, relPath)
    this.db.prepare(`UPDATE job_files SET ${columns.join(', ')} WHERE job_id = ? AND rel_path = ?`).run(...values)
  }

  getFileRow(jobId: string, relPath: string): Row | undefined {
    return this.db.prepare('SELECT * FROM job_files WHERE job_id = ? AND rel_path = ?').get(jobId, relPath)
  }

  /** 取单个文件的完整快照（含各目标结果），用于事件推送。 */
  getFile(jobId: string, relPath: string): CopyJobFile | null {
    const row = this.getFileRow(jobId, relPath)
    if (row === undefined) return null
    const id = fromSqlNumber(row.id)
    return this.mapFile(row, this.resultsForFiles([id]))
  }

  countFiles(jobId: string, state?: FileState): number {
    const row =
      state === undefined
        ? this.db.prepare('SELECT COUNT(*) AS c FROM job_files WHERE job_id = ?').get(jobId)
        : this.db.prepare('SELECT COUNT(*) AS c FROM job_files WHERE job_id = ? AND state = ?').get(jobId, state)
    return fromSqlNumber(row?.c)
  }

  /**
   * 取待处理的文件（断点续传的入口）。按 id 稳定排序。
   *
   * 只匹配 `pending`。原因有两个：
   *  1. `failed` 必须留在失败态等用户判断，否则会被反复重拷，既掩盖问题又浪费时间；
   *  2. 运行中处于 `verifying` 的文件不能再被查出来，否则同一个文件会被重复拷贝。
   * 上次异常退出残留的 `copying` / `verifying` 由 `resetInFlightFiles()` 在任务开始时归零。
   */
  listPendingFiles(jobId: string, limit: number): PendingFile[] {
    const rows = this.db
      .prepare(
        `SELECT id, rel_path, size_bytes, bytes_copied, state
           FROM job_files
          WHERE job_id = ? AND state = 'pending'
          ORDER BY id ASC
          LIMIT ?`
      )
      .all(jobId, limit)
    return rows.map((row) => ({
      id: fromSqlNumber(row.id),
      relPath: asString(row.rel_path),
      sizeBytes: fromSqlNumber(row.size_bytes),
      bytesCopied: fromSqlNumber(row.bytes_copied),
      state: asString(row.state, 'pending') as FileState
    }))
  }

  /** 分页读文件，供界面表格使用。 */
  listFiles(jobId: string, limit = 500, offset = 0): CopyJobFile[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM job_files WHERE job_id = ? ORDER BY id ASC LIMIT ? OFFSET ?`
      )
      .all(jobId, limit, offset)
    return rows.map((row) => this.mapFile(row, this.resultsForFiles([fromSqlNumber(row.id)])))
  }

  /**
   * 分批遍历全部文件，用于生成清单与报告。
   *
   * 不用 OFFSET（大表上会越翻越慢），改用 `id > :lastId` 游标。
   */
  async *iterateFiles(jobId: string, batchSize = 2000): AsyncGenerator<CopyJobFile> {
    let lastId = 0
    for (;;) {
      const rows = this.db
        .prepare(
          `SELECT * FROM job_files WHERE job_id = ? AND id > ? ORDER BY id ASC LIMIT ?`
        )
        .all(jobId, lastId, batchSize)
      if (rows.length === 0) return
      const ids = rows.map((row) => fromSqlNumber(row.id))
      const results = this.resultsForFiles(ids)
      for (const row of rows) {
        lastId = fromSqlNumber(row.id)
        yield this.mapFile(row, results)
      }
    }
  }

  /** 汇总各状态的文件数，一次查询搞定。 */
  fileStateCounts(jobId: string): Record<FileState, number> {
    const rows = this.db
      .prepare('SELECT state, COUNT(*) AS c FROM job_files WHERE job_id = ? GROUP BY state')
      .all(jobId)
    const counts: Record<FileState, number> = {
      pending: 0,
      copying: 0,
      verifying: 0,
      verified: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0
    }
    for (const row of rows) {
      const state = asString(row.state, 'pending') as FileState
      if (state in counts) counts[state] = fromSqlNumber(row.c)
    }
    return counts
  }

  /** 进程被强杀时，残留的 copying/verifying 行必须回到 pending，否则永远卡住。 */
  resetInFlightFiles(jobId: string): number {
    const result = this.db
      .prepare(
        `UPDATE job_files SET state = 'pending'
          WHERE job_id = ? AND state IN ('copying', 'verifying')`
      )
      .run(jobId)
    return result.changes
  }

  private mapFile(row: Row, results: Map<number, FileTargetResult[]>): CopyJobFile {
    const id = fromSqlNumber(row.id)
    const rawProbe = fromSqlNullableString(row.probe_json)
    let probe: MediaProbe | null = null
    if (rawProbe !== null) {
      try {
        probe = JSON.parse(rawProbe) as MediaProbe
      } catch {
        probe = null
      }
    }

    return {
      id,
      jobId: asString(row.job_id),
      relPath: asString(row.rel_path),
      sizeBytes: fromSqlNumber(row.size_bytes),
      sourceHash: fromSqlNullableString(row.source_hash),
      state: asString(row.state, 'pending') as FileState,
      bytesCopied: fromSqlNumber(row.bytes_copied),
      results: results.get(id) ?? [],
      probe,
      error: fromSqlNullableString(row.error)
    }
  }

  /* ---------------- 文件 × 目标 结果 ---------------- */

  saveFileResult(fileId: number, jobId: string, result: FileTargetResult): void {
    this.db
      .prepare(
        `INSERT INTO file_target_results (file_id, job_id, target_id, state, hash, hash_match, bytes_copied, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (file_id, target_id) DO UPDATE SET
           state = excluded.state,
           hash = excluded.hash,
           hash_match = excluded.hash_match,
           bytes_copied = excluded.bytes_copied,
           error = excluded.error`
      )
      .run(
        fileId,
        jobId,
        result.targetId,
        result.state,
        result.hash,
        result.hashMatch === null ? null : result.hashMatch ? 1 : 0,
        result.bytesCopied,
        result.error
      )
  }

  private resultsForFiles(fileIds: number[]): Map<number, FileTargetResult[]> {
    const map = new Map<number, FileTargetResult[]>()
    if (fileIds.length === 0) return map

    const placeholders = fileIds.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT * FROM file_target_results WHERE file_id IN (${placeholders}) ORDER BY target_id ASC`
      )
      .all(...fileIds)

    for (const row of rows) {
      const fileId = fromSqlNumber(row.file_id)
      const list = map.get(fileId) ?? []
      list.push({
        targetId: asString(row.target_id),
        state: asString(row.state, 'pending') as FileState,
        hash: fromSqlNullableString(row.hash),
        hashMatch: row.hash_match === null || row.hash_match === undefined ? null : fromSqlBoolean(row.hash_match),
        bytesCopied: fromSqlNumber(row.bytes_copied),
        error: fromSqlNullableString(row.error)
      })
      map.set(fileId, list)
    }
    return map
  }

  /* ---------------- 报告 ---------------- */

  /** 取下一个修订号。R001、R002…… 只增不减。 */
  nextRevision(jobId: string): string {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM reports WHERE job_id = ?")
      .get(jobId)
    const nextIndex = fromSqlNumber(row?.c) + 1
    return `R${String(nextIndex).padStart(3, '0')}`
  }

  insertReport(revision: ReportRevision): void {
    this.db
      .prepare(
        `INSERT INTO reports (job_id, revision, created_at, dir, files_json, summary_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        revision.jobId,
        revision.revision,
        revision.createdAt,
        revision.dir,
        JSON.stringify(revision.files),
        JSON.stringify(revision.summary)
      )
  }

  /** PDF 生成完之后回填文件路径。 */
  updateReportFiles(jobId: string, revision: string, files: ReportRevision['files']): void {
    this.db
      .prepare('UPDATE reports SET files_json = ? WHERE job_id = ? AND revision = ?')
      .run(JSON.stringify(files), jobId, revision)
  }

  listReports(jobId: string): ReportRevision[] {
    const rows = this.db
      .prepare('SELECT * FROM reports WHERE job_id = ? ORDER BY revision DESC')
      .all(jobId)
    return rows.map((row) => ({
      id: fromSqlNumber(row.id),
      jobId: asString(row.job_id),
      revision: asString(row.revision),
      createdAt: asString(row.created_at),
      dir: asString(row.dir),
      files: JSON.parse(asString(row.files_json, '{}')) as ReportRevision['files'],
      summary: JSON.parse(asString(row.summary_json, '{}')) as ReportSummary
    }))
  }

  /* ---------------- 项目信息 ---------------- */

  /**
   * 读一条项目信息。
   *
   * 返回值一定经过 `normalizeProjectInfo` 整形：库里存的是整包 JSON，
   * 老版本写下的记录缺少后加的字段（lenses / copyNotes / parentProjectName），
   * 直接交出去会让界面在 `.map()` 上崩掉，而报错行跟真正原因毫无关系。
   */
  getProjectInfo(jobId: string): ProjectInfo | null {
    const row = this.db.prepare('SELECT * FROM project_info WHERE job_id = ?').get(jobId)
    if (row === undefined) return null
    try {
      return normalizeProjectInfo(JSON.parse(asString(row.data_json)))
    } catch {
      return null
    }
  }

  saveProjectInfo(jobId: string, info: ProjectInfo): void {
    this.db
      .prepare(
        `INSERT INTO project_info (job_id, data_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (job_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
      )
      .run(jobId, JSON.stringify(info), info.updatedAt)
  }

  /**
   * 取"上一次填写过的项目信息"，供未选母项目时预填。
   *
   * 两个刻意的限制：
   *   · 只看**未分组**的任务（parent_project_id IS NULL）。否则会出现
   *     "我没选母项目，却自动带了某部戏的机型和人名"这种让人心里发毛的情况。
   *   · 跳过没有实质内容的记录（`hasSubstance`），否则最近一条恰好是空填的
   *     任务就会把好数据顶掉。
   *
   * 卡号会被清空 —— 它是每一张卡的属性，不能带到下一张卡上。
   */
  getLatestProjectTemplate(): ProjectInfo | null {
    const rows = this.db
      .prepare(
        `SELECT p.data_json AS data_json FROM project_info p
         JOIN jobs j ON j.id = p.job_id
         WHERE j.parent_project_id IS NULL
         ORDER BY j.created_at DESC, j.rowid DESC
         LIMIT 30`
      )
      .all()

    for (const row of rows) {
      let parsed: ProjectInfo
      try {
        parsed = normalizeProjectInfo(JSON.parse(asString(row.data_json)))
      } catch {
        continue
      }
      if (!hasSubstance(parsed)) continue
      // 卡号与本次备注都属于「这一张卡」，不能带到下一张卡上
      return { ...parsed, cardLabel: '', copyNotes: '' }
    }
    return null
  }

  /* ---------------- 母项目 ---------------- */

  createParentProject(project: ParentProject): void {
    this.db
      .prepare(
        `INSERT INTO parent_projects (id, name, data_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(project.id, project.name, JSON.stringify(project.details), project.createdAt, project.updatedAt)
  }

  getParentProject(parentProjectId: string): ParentProject | null {
    const row = this.db.prepare('SELECT * FROM parent_projects WHERE id = ?').get(parentProjectId)
    if (row === undefined) return null
    try {
      return {
        id: asString(row.id),
        name: asString(row.name),
        details: normalizeProjectDetails(JSON.parse(asString(row.data_json, '{}'))),
        createdAt: asString(row.created_at),
        updatedAt: fromSqlNullableString(row.updated_at)
      }
    } catch {
      return null
    }
  }

  /**
   * 列出母项目。
   *
   * 排序按「最近有拷贝活动」而不是创建时间：现场正在拍的那部戏永远排在最前面，
   * 拷贝页的下拉里第一个就是它，不用每次翻。没有任务的新项目退回按创建时间排。
   */
  listParentProjects(): ParentProject[] {
    const rows = this.db
      .prepare(
        `SELECT p.id AS id
         FROM parent_projects p
         LEFT JOIN jobs j ON j.parent_project_id = p.id
         GROUP BY p.id
         ORDER BY COALESCE(MAX(j.created_at), p.created_at) DESC, p.rowid DESC`
      )
      .all()
    return rows
      .map((row) => this.getParentProject(asString(row.id)))
      .filter((project): project is ParentProject => project !== null)
  }

  /**
   * 从母项目名下**历史拷贝任务**的快照里，把档案里空着的字段补上。
   *
   * 存在理由（真实踩到的）：旧版本不会把拷贝页填的职员与镜头写回母项目，
   * 那些内容只活在每个任务的 `project_info` 快照里。于是母项目档案是空的，
   * 切到它却什么也带不出来 —— 用户会以为"我之前填的东西丢了"。
   * 数据其实一直在库的另一张表里，这里负责把它还回去。
   *
   * 语义是**只补空、不覆盖**（见 `fillMissingDetails`）：用户自己写进档案的内容
   * 优先级永远高于历史记录的推断。
   *
   * 只读、不落库。写回档案是 `rememberParentTalent` 与该用户的编辑动作的事 ——
   * 一个读接口顺手改数据库，会让"我什么都没动，它自己变了"这种事发生。
   */
  recallParentDetails(parentProjectId: string): ProjectDetails | null {
    const project = this.getParentProject(parentProjectId)
    if (project === null) return null

    // 档案已经齐了就不必翻历史
    const complete =
      hasCrew(project.details.crew) && hasLenses(project.details.lenses) && project.details.camera !== ''
    if (complete) return project.details

    const rows = this.db
      .prepare(
        `SELECT p.data_json AS data_json FROM project_info p
         JOIN jobs j ON j.id = p.job_id
         WHERE j.parent_project_id = ?
         ORDER BY j.created_at DESC, j.rowid DESC
         LIMIT 50`
      )
      .all(parentProjectId)

    let merged = project.details
    for (const row of rows) {
      let snapshot: ProjectDetails
      try {
        snapshot = normalizeProjectInfo(JSON.parse(asString(row.data_json)))
      } catch {
        continue
      }
      // 逐条叠加：后一条只能填前一条留下的空，不会顶掉已经有的
      merged = fillMissingDetails(merged, snapshot)
      if (hasCrew(merged.crew) && hasLenses(merged.lenses) && merged.camera !== '') break
    }
    return merged
  }

  /**
   * 把这次拷贝填的职员与镜头记进母项目档案。
   *
   * 只动这两项，其余字段（机型、项目名、备注、拍摄日）原样保留 ——
   * 拷贝页的顺手改动不该把人家档案里别的字段一起改写。
   * 本次没填的项不写（见 `mergeTalentIntoParent`），避免把攒了很久的名单清空。
   *
   * 返回是否真的产生了变化，让调用方能决定要不要提示用户、要不要刷新列表。
   */
  rememberParentTalent(
    parentProjectId: string,
    filled: Pick<ProjectDetails, 'lenses' | 'crew'>
  ): { project: ParentProject; changed: boolean } | null {
    const current = this.getParentProject(parentProjectId)
    if (current === null) return null

    const { details, changed } = mergeTalentIntoParent(current.details, filled)
    if (!changed) return { project: current, changed: false }

    const updated = this.updateParentProject(parentProjectId, {
      details,
      updatedAt: new Date().toISOString()
    })
    return updated === null ? null : { project: updated, changed: true }
  }

  updateParentProject(
    parentProjectId: string,
    patch: { name?: string; details?: ParentProject['details']; updatedAt?: string | null }
  ): ParentProject | null {
    const current = this.getParentProject(parentProjectId)
    if (current === null) return null

    const name = patch.name ?? current.name
    const details = patch.details ?? current.details
    this.db
      .prepare('UPDATE parent_projects SET name = ?, data_json = ?, updated_at = ? WHERE id = ?')
      .run(name, JSON.stringify(details), patch.updatedAt ?? current.updatedAt, parentProjectId)

    return { ...current, name, details, updatedAt: patch.updatedAt ?? current.updatedAt }
  }

  /**
   * 删除母项目。
   *
   * **只解绑，不删除名下的拷贝任务** —— 素材已经拷到盘上了，
   * 删一个归类标签不该把拷贝记录一起抹掉。任务会回到"未分组"。
   */
  deleteParentProject(parentProjectId: string): void {
    transaction(this.db, () => {
      this.db
        .prepare('UPDATE jobs SET parent_project_id = NULL WHERE parent_project_id = ?')
        .run(parentProjectId)
      this.db.prepare('DELETE FROM parent_projects WHERE id = ?').run(parentProjectId)
    })
  }

  /* ---------------- ASC MHL 链 ---------------- */

  getManifestIds(jobId: string): { manifestId: string; previousManifestId: string | null } | null {
    const row = this.db.prepare('SELECT * FROM manifest_ids WHERE job_id = ?').get(jobId)
    if (row === undefined) return null
    return {
      manifestId: asString(row.manifest_id),
      previousManifestId: fromSqlNullableString(row.previous_manifest_id)
    }
  }

  setManifestIds(jobId: string, manifestId: string, previousManifestId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO manifest_ids (job_id, manifest_id, previous_manifest_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (job_id) DO UPDATE SET
           manifest_id = excluded.manifest_id,
           previous_manifest_id = excluded.previous_manifest_id,
           created_at = excluded.created_at`
      )
      .run(jobId, manifestId, previousManifestId, new Date().toISOString())
  }
}
