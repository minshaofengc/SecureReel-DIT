/**
 * 诊断包导出测试。
 *
 * 用真实的 /usr/bin/zip 在临时目录上跑完整流程：
 *   日志收集 → 系统信息写入 → 打包 → 校验 zip 里确实有内容。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildAppPaths, type AppPaths } from '../src/main/paths'
import { Logger } from '../src/main/logger'
import { Store } from '../src/main/db/store'
import { createDiagnosticsZip } from '../src/main/diagnostics'
import type { FfprobeRunner } from '../src/main/media/probe'

let root = ''
let paths: AppPaths
let store: Store
let logger: Logger

const probeRunnerStub = {
  available: true,
  frameToolAvailable: true,
  unavailableReason: null
} as unknown as FfprobeRunner

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'securereel-diag-test-'))
  paths = buildAppPaths(join(root, 'userData'))
  await mkdir(paths.logsDir, { recursive: true })
  store = await Store.openInMemory()
  logger = new Logger({ dir: paths.logsDir })
})

afterEach(async () => {
  store.close()
  await rm(root, { recursive: true, force: true })
})

describe('诊断包导出', () => {
  it('把近几天的日志与系统信息打进 zip', async () => {
    // 造两天日志：今天 + 三天前（后者应被排除）
    logger.info('app', '今天是这条')
    await logger.flush()
    await writeFile(
      join(paths.logsDir, 'securereel-2020-01-01.jsonl'),
      '{"at":"2020-01-01T00:00:00Z","level":"info","scope":"x","message":"太老了"}\n',
      'utf8'
    )

    const destination = join(root, 'diag.zip')
    const result = await createDiagnosticsZip(destination, {
      paths,
      logger,
      store,
      probeRunner: probeRunnerStub,
      language: 'zh-CN'
    })

    expect(result).toBe(destination)
    const listed = execFileSync('/usr/bin/unzip', ['-l', destination]).toString()
    expect(listed).toContain('system-info.txt')
    expect(listed).toContain(`securereel-${new Date().toISOString().slice(0, 10)}.jsonl`)
    expect(listed).not.toContain('2020-01-01')
    // 系统信息不是空文件（有实际的字节长度行）
    expect(listed).toMatch(/\d+\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+system-info\.txt/)
  })

  it('日志目录为空时也能出包（只有系统信息）', async () => {
    await rm(paths.logsDir, { recursive: true, force: true })
    const destination = join(root, 'diag-empty.zip')
    const result = await createDiagnosticsZip(destination, {
      paths,
      logger,
      store,
      probeRunner: probeRunnerStub,
      language: 'zh-CN'
    })
    expect(result).toBe(destination)
    const listed = execFileSync('/usr/bin/unzip', ['-l', destination]).toString()
    expect(listed).toContain('system-info.txt')
  })
})
