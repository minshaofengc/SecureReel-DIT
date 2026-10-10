/**
 * 数据库兼容性与隔离测试。
 *
 * 背景：这个用例不是凭空写的 —— 它来自一次真实的启动崩溃。
 * 机器上留着一份**更早版本**的数据库，它的 `jobs` 表是
 * `(id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)` 这种单列结构。
 * `CREATE TABLE IF NOT EXISTS` 遇到"表已存在但结构完全不同"时是**静默通过**的，
 * 于是建表看起来成功了，应用继续往下跑，直到第一次查询才炸：
 * `no such column: state` —— 报的跟真正的原因毫无关系。
 *
 * 现在的行为：检测到结构不兼容 → 把旧库改名留档 → 新建一份可用的库 → 提示用户。
 * 既不崩，也不静默销毁用户数据。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, type QuarantineRecord } from '../src/main/db/store'
import { openDatabase } from '../src/main/db/driver'
import { REQUIRED_JOB_COLUMNS, SCHEMA_VERSION } from '../src/main/db/schema'
import { DEFAULT_SETTINGS } from '../src/shared/types'

let root = ''
let dbPath = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'securereel-migrate-'))
  dbPath = join(root, 'securereel.sqlite')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 造一份"旧版本"的数据库：jobs 表结构与当前代码完全不同。 */
async function createLegacyDatabase(): Promise<void> {
  const db = await openDatabase(dbPath)
  db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
  db.prepare('INSERT INTO jobs (id, data, updated_at) VALUES (?, ?, ?)').run(
    'legacy_job_1',
    JSON.stringify({ name: '旧版本的任务' }),
    '2026-08-08T00:00:00.000Z'
  )
  db.close()
}

describe('全新数据库', () => {
  it('能正常建立并写入设置', async () => {
    const store = await Store.open(dbPath)
    expect(store.quarantined).toBeNull()
    expect(store.schemaVersion()).toBe(String(SCHEMA_VERSION))
    store.saveSettings({ ...DEFAULT_SETTINGS, themeId: 'steel' })
    expect(store.getSettings().themeId).toBe('steel')
    store.close()
  })
})

describe('不兼容的旧数据库', () => {
  it('启动不会崩，而是把旧库留档并新建一份可用的库', async () => {
    await createLegacyDatabase()

    const store = await Store.open(dbPath)

    // 没有崩，并且给出可追溯的说明
    expect(store.quarantined).not.toBeNull()
    expect(store.quarantined?.reason).toContain('jobs')

    // 新库是可用的
    expect(store.schemaVersion()).toBe(String(SCHEMA_VERSION))
    expect(store.listJobs()).toEqual([])
    store.saveSettings({ ...DEFAULT_SETTINGS, language: 'en' })
    expect(store.getSettings().language).toBe('en')

    store.close()
  })

  it('旧库文件被改名保留，没有被删除', async () => {
    await createLegacyDatabase()
    const store = await Store.open(dbPath)
    store.close()

    const files = await readdir(root)
    const legacy = files.filter((name) => name.includes('.legacy-'))
    expect(legacy.length).toBeGreaterThan(0)
    expect(existsSync(join(root, legacy[0] as string))).toBe(true)
  })

  it('留档的旧库内容仍然可以打开读取（数据没丢）', async () => {
    await createLegacyDatabase()
    const store = await Store.open(dbPath)
    const quarantined = store.quarantined as QuarantineRecord
    store.close()

    const legacyPath = quarantined.backupPath as string
    const legacy = await openDatabase(legacyPath)
    const row = legacy.prepare('SELECT id, data FROM jobs WHERE id = ?').get('legacy_job_1')
    expect(row).toBeDefined()
    expect(String(row?.data)).toContain('旧版本的任务')
    legacy.close()
  })

  it('隔离结论会写进 schema_meta，便于事后诊断', async () => {
    await createLegacyDatabase()
    const store = await Store.open(dbPath)
    store.close()

    const db = await openDatabase(dbPath)
    const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('quarantine')
    expect(row).toBeDefined()
    expect(String(row?.value)).toContain('.legacy-')
    db.close()
  })
})

/**
 * 造一份"上一版"的库：`jobs` 表结构与当前代码**完全一致，只缺 parent_project_id**。
 *
 * 这正是老用户升级时的真实状态 —— 也是本次改动唯一有真实数据丢失风险的路径：
 * 若把这个新列塞进 `REQUIRED_JOB_COLUMNS`，`detectIncompatibleSchema()` 就会
 * 判定为不兼容 → 整个库改名留档 → 界面上所有任务瞬间消失。
 */
async function createPreviousVersionDatabase(): Promise<void> {
  const db = await openDatabase(dbPath)
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE jobs (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      source_path        TEXT NOT NULL,
      source_kind        TEXT NOT NULL DEFAULT 'generic',
      is_codex_vfs       INTEGER NOT NULL DEFAULT 0,
      hash_algorithm     TEXT NOT NULL,
      manifest_format    TEXT NOT NULL,
      verify_after_write INTEGER NOT NULL DEFAULT 1,
      state              TEXT NOT NULL,
      total_files        INTEGER NOT NULL DEFAULT 0,
      total_bytes        INTEGER NOT NULL DEFAULT 0,
      files_done         INTEGER NOT NULL DEFAULT 0,
      files_failed       INTEGER NOT NULL DEFAULT 0,
      bytes_done         INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT NOT NULL,
      started_at         TEXT,
      finished_at        TEXT,
      degradation_notice TEXT
    );
    CREATE TABLE project_info (
      job_id     TEXT PRIMARY KEY,
      data_json  TEXT NOT NULL,
      updated_at TEXT
    );
  `)
  db.prepare(
    `INSERT INTO jobs (id, name, source_path, hash_algorithm, manifest_format, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'job_v2_0000001',
    '上一版留下的任务',
    '/Volumes/A002R2EC',
    'xxhash64',
    'asc-mhl-2.0',
    'completed',
    '2026-09-01T00:00:00.000Z'
  )
  // 老格式的项目信息：没有 lenses / copyNotes / parentProjectName
  db.prepare('INSERT INTO project_info (job_id, data_json, updated_at) VALUES (?, ?, ?)').run(
    'job_v2_0000001',
    JSON.stringify({
      projectName: '老项目',
      shootDay: '2026-09-01',
      camera: 'ALEXA Mini',
      cardLabel: 'A001',
      notes: '老版本的备注',
      crew: [{ role: 'DIT', name: '王五' }],
      updatedAt: null
    }),
    null
  )
  db.close()
}

describe('上一版数据库（缺新增列）', () => {
  it('parent_project_id 绝不能出现在 REQUIRED_JOB_COLUMNS 里', () => {
    // 这个常量的语义是"缺了就必须隔离"。老用户的库天然缺新列，
    // 一旦被列进去，启动时就会把他们的数据库整个改名留档 —— 界面上一片空白。
    expect(REQUIRED_JOB_COLUMNS as readonly string[]).not.toContain('parent_project_id')
  })

  it('升级时不隔离，而是补上缺的列，老任务原样保留', async () => {
    await createPreviousVersionDatabase()

    const store = await Store.open(dbPath)

    expect(store.quarantined).toBeNull()

    const jobs = store.listJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.id).toBe('job_v2_0000001')
    expect(jobs[0]?.name).toBe('上一版留下的任务')
    // 新列对老记录是 null，读出来应当是 null 而不是崩
    expect(jobs[0]?.parentProjectId).toBeNull()

    // 列确实被补上了：能写入带归属的新任务
    store.updateJob('job_v2_0000001', { parentProjectId: null })
    expect(store.listParentProjects()).toEqual([])

    store.close()

    const db = await openDatabase(dbPath)
    const columns = db
      .prepare('PRAGMA table_info(jobs)')
      .all()
      .map((row) => String(row.name))
    expect(columns).toContain('parent_project_id')
    // 新表也建出来了
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get('parent_projects')
    ).toBeDefined()
    db.close()

    // 目录里不该出现任何 legacy 备份 —— 一旦出现就说明升级路径走错了
    const files = await readdir(root)
    expect(files.filter((name) => name.includes('.legacy-'))).toHaveLength(0)
  })

  it('老格式的项目信息读出来不崩，缺的字段补成默认值', async () => {
    await createPreviousVersionDatabase()
    const store = await Store.open(dbPath)

    const info = store.getProjectInfo('job_v2_0000001')
    expect(info).not.toBeNull()
    expect(info?.projectName).toBe('老项目')
    expect(info?.camera).toBe('ALEXA Mini')
    expect(info?.lenses).toEqual([])
    expect(info?.copyNotes).toBe('')
    expect(info?.parentProjectName).toBeNull()
    expect(info?.crew).toEqual([{ role: 'DIT', name: '王五' }])

    store.close()
  })

  it('反复打开不会重复执行加列（幂等）', async () => {
    await createPreviousVersionDatabase()

    const first = await Store.open(dbPath)
    first.close()
    const second = await Store.open(dbPath)
    expect(second.quarantined).toBeNull()
    expect(second.listJobs()).toHaveLength(1)
    second.close()
  })
})

describe('结构正确的既有数据库', () => {
  it('第二次打开不会重复隔离，也不会清掉已有数据', async () => {
    const first = await Store.open(dbPath)
    first.saveSettings({ ...DEFAULT_SETTINGS, themeMode: 'dark' })
    first.close()

    const second = await Store.open(dbPath)
    expect(second.quarantined).toBeNull()
    expect(second.getSettings().themeMode).toBe('dark')
    second.close()

    // 目录里不应该出现任何 legacy 备份
    const files = await readdir(root)
    expect(files.filter((name) => name.includes('.legacy-'))).toHaveLength(0)
  })
})

describe('损坏的数据库文件', () => {
  it('文件内容不是数据库时给出明确错误而不是静默重建', async () => {
    await writeFile(dbPath, 'this is definitely not a sqlite database file')

    await expect(Store.open(dbPath)).rejects.toThrow()
  })
})
