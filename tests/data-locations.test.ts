/**
 * 可配置数据目录。
 *
 * 这段逻辑决定「应用打开时去哪里找数据库、报告、日志」。写错的代价很实在：
 * 盘没插就起不来，或者静默写进默认目录让用户以为数据在外置盘上。
 * 所以测试重点放在**回退**与**网络盘拦截**，而不是「能读能写」。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DATA_CATEGORIES,
  DB_FILE_NAME,
  EMPTY_LOCATIONS,
  createFsProbe,
  defaultDirFor,
  isEmptyDirectory,
  isNetworkFsType,
  isSameOrNested,
  isUncPath,
  locationsFile,
  readLocations,
  resolveLocations,
  writeLocationsAtomic,
  type DataCategory,
  type DataLocations
} from '../src/main/core/data-locations'
import { buildAppPaths } from '../src/main/paths'

describe('数据目录配置的读写', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'securereel-locations-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('没有配置文件时全部走默认', async () => {
    await expect(readLocations(root)).resolves.toEqual(EMPTY_LOCATIONS)
  })

  it('配置文件损坏时退化为默认，而不是抛错', async () => {
    await writeFile(locationsFile(root), '{ this is not json', 'utf8')
    await expect(readLocations(root)).resolves.toEqual(EMPTY_LOCATIONS)
  })

  it('拒绝相对路径的配置', async () => {
    await writeFile(
      locationsFile(root),
      JSON.stringify({ ...EMPTY_LOCATIONS, reports: 'relative/path' }),
      'utf8'
    )
    await expect(readLocations(root)).resolves.toEqual(EMPTY_LOCATIONS)
  })

  it('原子写入后能原样读回', async () => {
    const locations: DataLocations = {
      ...EMPTY_LOCATIONS,
      reports: join(root, 'reports'),
      logs: join(root, 'logs')
    }
    await writeLocationsAtomic(root, locations)
    await expect(readLocations(root)).resolves.toEqual(locations)
    const raw = await readFile(locationsFile(root), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
  })
})

describe('路径解析与回退', () => {
  const defaults = buildAppPaths('/Users/someone/Library/Application Support/SecureReel DIT 2')

  it('未配置时五类都用默认目录', async () => {
    const probe = vi.fn(async () => ({ ok: true }))
    const resolved = await resolveLocations(defaults, EMPTY_LOCATIONS, probe)
    expect(probe).not.toHaveBeenCalled()
    expect(resolved.fallbacks).toEqual([])
    for (const category of DATA_CATEGORIES) {
      expect(defaultDirFor(category, defaults)).toBeTruthy()
    }
    expect(resolved.paths.dbFile).toBe(join(defaults.userDataDir, DB_FILE_NAME))
    expect(resolved.paths.reportsDir).toBe(defaults.reportsDir)
    expect(resolved.paths.logsDir).toBe(defaults.logsDir)
    expect(resolved.paths.hdeWorkDir).toBe(defaults.hdeWorkDir)
    expect(resolved.paths.companionDir).toBe(defaults.companionDir)
  })

  it('配置可用时按配置走', async () => {
    const reports = join('/Volumes/Backup', 'reports')
    const resolved = await resolveLocations(
      defaults,
      { ...EMPTY_LOCATIONS, reports },
      async () => ({ ok: true })
    )
    expect(resolved.paths.reportsDir).toBe(reports)
    expect(resolved.fallbacks).toEqual([])
  })

  it('目录不可用时回退到默认并给出原因', async () => {
    const reports = join('/Volumes/Missing', 'reports')
    const resolved = await resolveLocations(
      defaults,
      { ...EMPTY_LOCATIONS, reports },
      async () => ({ ok: false, reason: '目录不存在或无法访问' })
    )
    expect(resolved.paths.reportsDir).toBe(defaults.reportsDir)
    expect(resolved.fallbacks).toEqual([
      {
        category: 'reports',
        configured: reports,
        used: defaults.reportsDir,
        reason: '目录不存在或无法访问'
      }
    ])
  })

  it('只回退坏掉的那一类，其余保持自定义', async () => {
    const reports = join('/Volumes/Backup', 'reports')
    const logs = join('/Volumes/Missing', 'logs')
    const resolved = await resolveLocations(
      defaults,
      { ...EMPTY_LOCATIONS, reports, logs },
      async (category: DataCategory) =>
        category === 'logs' ? { ok: false, reason: '目录不存在或无法访问' } : { ok: true }
    )
    expect(resolved.paths.reportsDir).toBe(reports)
    expect(resolved.paths.logsDir).toBe(defaults.logsDir)
    expect(resolved.fallbacks.map((item) => item.category)).toEqual(['logs'])
  })

  it('数据库目录单独配置时文件落在该目录下', async () => {
    const db = join('/Volumes/Fast', 'db')
    const resolved = await resolveLocations(
      defaults,
      { ...EMPTY_LOCATIONS, db },
      async () => ({ ok: true })
    )
    expect(resolved.paths.dbFile).toBe(join(db, DB_FILE_NAME))
  })
})

describe('网络盘与路径判定', () => {
  it('识别常见网络文件系统类型', () => {
    for (const type of ['smbfs', 'nfs', 'afpfs', 'cifs', 'SMBFS']) {
      expect(isNetworkFsType(type)).toBe(true)
    }
    for (const type of ['apfs', 'exfat', 'hfs', 'ntfs']) {
      expect(isNetworkFsType(type)).toBe(false)
    }
  })

  it('识别 Windows UNC 路径', () => {
    expect(isUncPath('\\\\server\\share\\data')).toBe(true)
    expect(isUncPath('//server/share/data')).toBe(true)
    expect(isUncPath('/Volumes/Backup')).toBe(false)
    expect(isUncPath('C:\\Users\\data')).toBe(false)
  })

  it('判断两个路径是否互相包含', () => {
    expect(isSameOrNested('/a/b', '/a/b')).toBe(true)
    expect(isSameOrNested('/a/b/c', '/a/b')).toBe(true)
    expect(isSameOrNested('/a/b', '/a/b/c')).toBe(true)
    expect(isSameOrNested('/a/b', '/a/c')).toBe(false)
  })
})

describe('真实文件系统探测', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'securereel-probe-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('空目录可用，不存在与文件都不可用', async () => {
    const empty = join(root, 'empty')
    await mkdir(empty)
    const file = join(root, 'file.txt')
    await writeFile(file, 'x', 'utf8')
    const probe = createFsProbe({ fsTypeOf: async () => 'apfs' })

    await expect(probe('reports', empty)).resolves.toEqual({ ok: true })
    await expect(probe('reports', join(root, 'missing'))).resolves.toMatchObject({ ok: false })
    await expect(probe('reports', file)).resolves.toMatchObject({
      ok: false,
      reason: '不是目录'
    })
  })

  it('网络盘即使可写也拒绝', async () => {
    const dir = join(root, 'net')
    await mkdir(dir)
    const probe = createFsProbe({ fsTypeOf: async () => 'smbfs' })
    await expect(probe('reports', dir)).resolves.toMatchObject({
      ok: false,
      reason: '不支持网络盘（smbfs）'
    })
  })

  it('空目录判定', async () => {
    const empty = join(root, 'empty')
    const used = join(root, 'used')
    await mkdir(empty)
    await mkdir(used)
    await writeFile(join(used, 'a.txt'), 'x', 'utf8')
    await expect(isEmptyDirectory(empty)).resolves.toBe(true)
    await expect(isEmptyDirectory(used)).resolves.toBe(false)
    await expect(isEmptyDirectory(join(root, 'missing'))).resolves.toBe(false)
  })
})
