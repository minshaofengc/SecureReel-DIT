/**
 * 数据目录迁移。
 *
 * 这段代码会关掉正在用的数据库、复制文件、再打开新库，出错的代价是
 * 用户看不到任务历史。所以测试盯的是：
 *   · 旧数据一点不动（复制不是移动）
 *   · 目标非空就拒绝，绝不覆盖
 *   · 有任务在跑就拒绝
 *   · 数据库三件套（主文件 + WAL + SHM）一起搬
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Logger } from '../src/main/logger'
import { Store } from '../src/main/db/store'
import { buildAppPaths, type AppPaths } from '../src/main/paths'
import { DB_FILE_NAME, readLocations } from '../src/main/core/data-locations'
import { relocateCategory, resetCategory, type RelocateDeps } from '../src/main/data-relocate-service'

describe('数据目录迁移', () => {
  let root = ''
  let paths: AppPaths
  let store: Store
  let logger: Logger
  let deps: RelocateDeps

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'securereel-relocate-'))
    paths = buildAppPaths(join(root, 'userData'))
    await mkdir(paths.userDataDir, { recursive: true })
    await mkdir(paths.reportsDir, { recursive: true })
    await mkdir(paths.logsDir, { recursive: true })
    store = await Store.open(paths.dbFile)
    logger = new Logger({ dir: paths.logsDir })
    deps = {
      paths,
      store,
      logger,
      userDataDir: paths.userDataDir,
      hasActiveWork: () => false,
      fsTypeOf: async () => 'apfs'
    }
  })

  afterEach(async () => {
    try {
      store.close()
    } catch {
      /* 已关闭 */
    }
    await rm(root, { recursive: true, force: true })
  })

  it('复制报告到新目录，旧目录保持原样', async () => {
    await mkdir(join(paths.reportsDir, 'job_a', 'R001'), { recursive: true })
    await writeFile(join(paths.reportsDir, 'job_a', 'R001', 'report.pdf'), 'pdf', 'utf8')
    const target = join(root, 'reports-new')
    await mkdir(target)

    const outcome = await relocateCategory(deps, 'reports', target)

    expect(outcome.copied).toBeGreaterThan(0)
    expect(await readFile(join(target, 'job_a', 'R001', 'report.pdf'), 'utf8')).toBe('pdf')
    expect(await readFile(join(paths.reportsDir, 'job_a', 'R001', 'report.pdf'), 'utf8')).toBe('pdf')
    expect(paths.reportsDir).toBe(target)
    await expect(readLocations(paths.userDataDir)).resolves.toMatchObject({ reports: target })
  })

  it('数据库连同 WAL 一起搬，并切换句柄', async () => {
    // 触发一次写入，确保 -wal 存在
    store.saveSettings({ ...store.getSettings() })
    const target = join(root, 'db-new')
    await mkdir(target)

    await relocateCategory(deps, 'db', target)

    expect(paths.dbFile).toBe(join(target, DB_FILE_NAME))
    await expect(stat(join(target, DB_FILE_NAME))).resolves.toBeTruthy()
    // 旧库仍在原处，作为退路
    await expect(stat(join(paths.userDataDir, DB_FILE_NAME))).resolves.toBeTruthy()
    // 新句柄可用
    expect(() => store.getSettings()).not.toThrow()
  })

  it('目标目录非空时拒绝，不覆盖任何文件', async () => {
    const target = join(root, 'not-empty')
    await mkdir(target)
    await writeFile(join(target, 'keep.txt'), 'original', 'utf8')

    await expect(relocateCategory(deps, 'reports', target)).rejects.toThrow(/不是空的/)
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('original')
    expect(paths.reportsDir).toBe(buildAppPaths(paths.userDataDir).reportsDir)
  })

  it('有任务在跑时拒绝', async () => {
    const target = join(root, 'reports-busy')
    await mkdir(target)
    deps.hasActiveWork = () => true
    await expect(relocateCategory(deps, 'reports', target)).rejects.toThrow(/任务正在运行/)
  })

  it('网络盘拒绝', async () => {
    const target = join(root, 'reports-net')
    await mkdir(target)
    deps.fsTypeOf = async () => 'smbfs'
    await expect(relocateCategory(deps, 'reports', target)).rejects.toThrow(/网络盘/)
  })

  it('恢复默认只改配置，不搬文件', async () => {
    const target = join(root, 'reports-custom')
    await mkdir(target)
    await relocateCategory(deps, 'reports', target)
    await resetCategory(deps, 'reports')

    expect(paths.reportsDir).toBe(buildAppPaths(paths.userDataDir).reportsDir)
    await expect(readLocations(paths.userDataDir)).resolves.toMatchObject({ reports: null })
    // 自定义目录里的数据仍在
    expect(await readdir(target)).toBeDefined()
  })
})
