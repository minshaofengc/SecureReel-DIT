/**
 * 1.x → 2.0 数据迁移。
 *
 * 这个模块直接动用户的数据库文件，所以测试的重点不是"能搬"，而是
 * **"搬错的时候不会毁掉东西"**：不覆盖、不删除、不阻断。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DB_FILE,
  LEGACY_USER_DATA_DIR,
  legacyUserDataDirOf,
  migrateLegacyUserData
} from '../src/main/core/data-migration'
import { pathExists } from '../src/main/fs-utils'

describe('1.x → 2.0 数据迁移', () => {
  let root = ''
  let current = ''
  let legacy = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'securereel-migrate-'))
    current = join(root, 'SecureReel DIT 2')
    legacy = join(root, LEGACY_USER_DATA_DIR)
    await mkdir(current, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('由当前目录推导出的旧目录与 app.setName 的约定一致', () => {
    expect(legacyUserDataDirOf('/tmp/x/SecureReel DIT 2')).toBe('/tmp/x/SecureReel DIT')
  })

  it('没有 1.x 数据时按全新安装处理，不建任何东西', async () => {
    const result = await migrateLegacyUserData(current, legacy)
    expect(result.status).toBe('skipped')
    expect(result.copied).toEqual([])
    expect(await pathExists(join(current, DB_FILE))).toBe(false)
  })

  it('把数据库三件套与报告档案一起搬过来', async () => {
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, DB_FILE), 'legacy-db')
    // WAL 模式下最近提交的事务可能还留在这里 —— 少了它就会丢最后一次任务的结果
    await writeFile(join(legacy, `${DB_FILE}-wal`), 'legacy-wal')
    await mkdir(join(legacy, 'reports', 'job_abc123', 'R001'), { recursive: true })
    await writeFile(join(legacy, 'reports', 'job_abc123', 'R001', 'report.html'), '<html>旧报告</html>')

    const result = await migrateLegacyUserData(current, legacy)

    expect(result.status).toBe('migrated')
    expect(await readFile(join(current, DB_FILE), 'utf8')).toBe('legacy-db')
    expect(await readFile(join(current, `${DB_FILE}-wal`), 'utf8')).toBe('legacy-wal')
    expect(await readFile(join(current, 'reports', 'job_abc123', 'R001', 'report.html'), 'utf8')).toBe(
      '<html>旧报告</html>'
    )
  })

  it('绝不删除旧数据：迁移完旧目录原样还在', async () => {
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, DB_FILE), 'legacy-db')

    await migrateLegacyUserData(current, legacy)

    expect(await pathExists(join(legacy, DB_FILE))).toBe(true)
    expect(await readFile(join(legacy, DB_FILE), 'utf8')).toBe('legacy-db')
  })

  it('幂等：第二次启动不会重复迁移，也不会覆盖已迁移的数据', async () => {
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, DB_FILE), 'legacy-db')

    const first = await migrateLegacyUserData(current, legacy)
    expect(first.status).toBe('migrated')

    // 2.0 自己跑过任务，库被改写了
    await writeFile(join(current, DB_FILE), 'newer-db')
    const second = await migrateLegacyUserData(current, legacy)

    expect(second.status).toBe('skipped')
    // 关键：不能被旧库顶掉
    expect(await readFile(join(current, DB_FILE), 'utf8')).toBe('newer-db')
  })

  it('目标已有同名报告时不覆盖，未冲突的部分照常补齐', async () => {
    await mkdir(join(legacy, 'reports', 'job_abc123'), { recursive: true })
    await writeFile(join(legacy, DB_FILE), 'legacy-db')
    await writeFile(join(legacy, 'reports', 'job_abc123', 'a.txt'), '来自旧目录')
    await writeFile(join(legacy, 'reports', 'job_abc123', 'b.txt'), '只在旧目录有')

    await mkdir(join(current, 'reports', 'job_abc123'), { recursive: true })
    await writeFile(join(current, 'reports', 'job_abc123', 'a.txt'), '来自新目录')

    const result = await migrateLegacyUserData(current, legacy)
    expect(result.status).toBe('migrated')

    expect(await readFile(join(current, 'reports', 'job_abc123', 'a.txt'), 'utf8')).toBe('来自新目录')
    expect(await readFile(join(current, 'reports', 'job_abc123', 'b.txt'), 'utf8')).toBe('只在旧目录有')
  })

  it('新旧目录相同时直接跳过，不做自我复制', async () => {
    const result = await migrateLegacyUserData(legacy, legacy)
    expect(result.status).toBe('skipped')
  })
})
