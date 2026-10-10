/**
 * 数据库表结构。
 *
 * 设计要点：
 *  - 每个文件在每个目标上的结果单独成行（file_target_results），
 *    这样"单盘故障不影响其他健康目标"才有落地的地方。
 *  - job_files 上 (job_id, rel_path) 唯一，断点续传靠它做 upsert。
 *  - 报告修订用 UNIQUE(job_id, revision) 锁死，做到物理上不可能覆盖旧修订。
 */

export const SCHEMA_VERSION = 3

/**
 * 兼容性判据：`jobs` 表必须同时具备这些列。
 *
 * 用列名而不是版本号来判定，是因为真正致命的情况恰恰是
 * "版本号对不上但表已经存在"——`CREATE TABLE IF NOT EXISTS` 在这种情况下
 * 会静默接受一张结构不同的旧表，然后在第一次查询时炸掉，
 * 报出的还是 `no such column: state` 这种跟真正原因毫无关系的错误。
 */
export const REQUIRED_JOB_COLUMNS = [
  'id',
  'name',
  'source_path',
  'hash_algorithm',
  'manifest_format',
  'state',
  'total_files',
  'total_bytes',
  'files_done',
  'files_failed',
  'bytes_done',
  'created_at'
] as const

/**
 * 增量加列迁移。
 *
 * ⚠️ 这条路径必须走显式 ALTER，**绝不能**把新列塞进 `REQUIRED_JOB_COLUMNS`。
 * 那个常量的语义是"缺了就必须隔离"：老用户的库天然缺新列，一旦列进去，
 * 启动时会被判定为结构不兼容 → 整个数据库改名留档 → 界面上所有任务凭空消失。
 * 数据其实还在磁盘上，但用户看到的是"我的东西没了"。
 *
 * 而只把新列写进 `SCHEMA_SQL` 也不行：`CREATE TABLE IF NOT EXISTS`
 * 对已存在的表是静默跳过的，列根本加不上，错误会推迟到第一次插入才爆。
 *
 * 所以：只有这里列出的 ALTER 才是安全的加列途径。只加列，绝不删列或改列。
 */
export const JOB_COLUMN_MIGRATIONS = [
  {
    table: 'jobs',
    column: 'parent_project_id',
    ddl: 'ALTER TABLE jobs ADD COLUMN parent_project_id TEXT'
  },
  {
    // 任务模式（copy = 拷贝+校验；verify = 仅校验）。
    // 老库存量任务全部按 copy 处理 —— 它们本来就是拷贝任务。
    table: 'jobs',
    column: 'mode',
    ddl: "ALTER TABLE jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'copy'"
  },
  {
    // 来源目录名（见 CopyJob.sourceRootName 的说明）。
    // 默认空串 = 目标盘上不加这一层，正好等于 1.x 的行为 ——
    // 老任务重跑时落盘结构不会变，不会凭空多出一级目录或撞名。
    table: 'jobs',
    column: 'source_root_name',
    ddl: "ALTER TABLE jobs ADD COLUMN source_root_name TEXT NOT NULL DEFAULT ''"
  },
  {
    // 每任务代理开关。老任务默认 0（不出代理）——
    // 与 2.0.6 之前"代理开关在全局设置里、且默认关闭"的观感一致。
    table: 'jobs',
    column: 'proxy_enabled',
    ddl: 'ALTER TABLE jobs ADD COLUMN proxy_enabled INTEGER NOT NULL DEFAULT 0'
  },
  {
    // 每任务代理分辨率。默认 1080p（与当前全局默认一致）。
    table: 'jobs',
    column: 'proxy_resolution',
    ddl: "ALTER TABLE jobs ADD COLUMN proxy_resolution TEXT NOT NULL DEFAULT '1080p'"
  },
  {
    // 每任务代理编码。默认 prores（两平台恒定可用）。
    table: 'jobs',
    column: 'proxy_codec',
    ddl: "ALTER TABLE jobs ADD COLUMN proxy_codec TEXT NOT NULL DEFAULT 'prores'"
  },
  {
    // 每任务 ProRes 规格。默认 422-proxy（与全局默认一致）。
    table: 'jobs',
    column: 'proxy_profile',
    ddl: "ALTER TABLE jobs ADD COLUMN proxy_profile TEXT NOT NULL DEFAULT '422-proxy'"
  },
  {
    // 每任务代理 LUT（.cube 绝对路径）。可空 —— 绝大多数任务不套 LUT。
    table: 'jobs',
    column: 'proxy_lut_path',
    ddl: 'ALTER TABLE jobs ADD COLUMN proxy_lut_path TEXT'
  }
] as const

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  mode               TEXT NOT NULL DEFAULT 'copy',
  source_path        TEXT NOT NULL,
  source_root_name   TEXT NOT NULL DEFAULT '',
  source_kind        TEXT NOT NULL DEFAULT 'generic',
  is_codex_vfs       INTEGER NOT NULL DEFAULT 0,
  hash_algorithm     TEXT NOT NULL,
  manifest_format    TEXT NOT NULL,
  verify_after_write INTEGER NOT NULL DEFAULT 1,
  proxy_enabled      INTEGER NOT NULL DEFAULT 0,
  proxy_resolution   TEXT NOT NULL DEFAULT '1080p',
  proxy_codec        TEXT NOT NULL DEFAULT 'prores',
  proxy_profile      TEXT NOT NULL DEFAULT '422-proxy',
  proxy_lut_path     TEXT,
  state              TEXT NOT NULL,
  total_files        INTEGER NOT NULL DEFAULT 0,
  total_bytes        INTEGER NOT NULL DEFAULT 0,
  files_done         INTEGER NOT NULL DEFAULT 0,
  files_failed       INTEGER NOT NULL DEFAULT 0,
  bytes_done         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT,
  degradation_notice TEXT,
  parent_project_id  TEXT
);

CREATE TABLE IF NOT EXISTS job_targets (
  job_id       TEXT NOT NULL,
  id           TEXT NOT NULL,
  path         TEXT NOT NULL,
  label        TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  free_bytes   INTEGER,
  writable     INTEGER NOT NULL DEFAULT 1,
  state        TEXT NOT NULL DEFAULT 'pending',
  files_done   INTEGER NOT NULL DEFAULT 0,
  files_failed INTEGER NOT NULL DEFAULT 0,
  bytes_copied INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  PRIMARY KEY (job_id, id),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS job_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL,
  rel_path    TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  source_hash TEXT,
  state       TEXT NOT NULL DEFAULT 'pending',
  bytes_copied INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  probe_json  TEXT,
  UNIQUE (job_id, rel_path),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_files_job_state ON job_files (job_id, state);

CREATE TABLE IF NOT EXISTS file_target_results (
  file_id      INTEGER NOT NULL,
  job_id       TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  state        TEXT NOT NULL,
  hash         TEXT,
  hash_match   INTEGER,
  bytes_copied INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  PRIMARY KEY (file_id, target_id),
  FOREIGN KEY (file_id) REFERENCES job_files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT NOT NULL,
  revision     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  dir          TEXT NOT NULL,
  files_json   TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  UNIQUE (job_id, revision),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_info (
  job_id     TEXT PRIMARY KEY,
  data_json  TEXT NOT NULL,
  updated_at TEXT,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS manifest_ids (
  job_id              TEXT PRIMARY KEY,
  manifest_id         TEXT NOT NULL,
  previous_manifest_id TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

/*
 * 母项目：一部戏一个，例如《母亲》。
 *
 * 只承载"整部戏不变"的信息，拷贝时会被快照进每个子任务。
 * 新表一律 CREATE TABLE IF NOT EXISTS —— 对老库天然安全，不会触发隔离。
 */
CREATE TABLE IF NOT EXISTS parent_projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  data_json  TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT
);

`

/**
 * 依赖增量加列的语句（索引、视图…）。
 *
 * ⚠️ 必须与 `SCHEMA_SQL` 分开、在加列之后执行。
 * 索引写进 `SCHEMA_SQL` 会踩到一个很难查的坑：老库上 `CREATE TABLE IF NOT EXISTS`
 * 是静默跳过的，列还不存在，于是 `CREATE INDEX ... ON jobs(parent_project_id)`
 * 直接报 `no such column` —— `exec()` 会在这一句中断，**后面所有迁移都不会执行**，
 * 表现出来就是"升级之后新功能一用就报 no such column"。
 */
export const SCHEMA_POST_MIGRATION_SQL = `
CREATE INDEX IF NOT EXISTS idx_jobs_parent_project ON jobs(parent_project_id);
`

