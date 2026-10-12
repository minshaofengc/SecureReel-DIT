import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishProxyPartial } from '../src/main/media/proxy-pipeline'
import { proxyPublicationCommand } from '../src/main/platform'

const race = vi.hoisted(() => ({ beforeMove: null as null | (() => Promise<void>) }))
vi.mock('../src/main/exec', async (original) => {
  const real = await original<typeof import('../src/main/exec')>()
  return {
    ...real,
    runCommand: async (...args: Parameters<typeof real.runCommand>) => {
      if (race.beforeMove) {
        const beforeMove = race.beforeMove
        race.beforeMove = null
        await beforeMove()
      }
      return real.runCommand(...args)
    }
  }
})
let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'proxy-publication-'))
  race.beforeMove = null
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('正式代理安全发布（实际文件系统）', () => {
  it('用系统移动工具发布经过验证的临时文件', async () => {
    const partial = join(root, '含 空格 $(literal).partial')
    const finalPath = join(root, '正式代理.mov')
    await writeFile(partial, 'verified-proxy')
    await publishProxyPartial(partial, finalPath, new AbortController().signal)
    expect(await readFile(finalPath, 'utf8')).toBe('verified-proxy')
    await expect(readFile(partial)).rejects.toThrow()
  })
  it('已有同名文件时拒绝发布并保留两个文件', async () => {
    const partial = join(root, 'new.partial')
    const finalPath = join(root, 'existing.mov')
    await writeFile(partial, 'new')
    await writeFile(finalPath, 'previous')
    await expect(
      publishProxyPartial(partial, finalPath, new AbortController().signal)
    ).rejects.toThrow('未覆盖')
    expect(await readFile(finalPath, 'utf8')).toBe('previous')
    expect(await readFile(partial, 'utf8')).toBe('new')
  })
  it('存在性检查后的命名竞争也不会覆盖目标文件', async () => {
    const partial = join(root, 'new.partial')
    const finalPath = join(root, 'competing.mov')
    await writeFile(partial, 'new')
    race.beforeMove = () => writeFile(finalPath, 'competitor')
    await expect(
      publishProxyPartial(partial, finalPath, new AbortController().signal)
    ).rejects.toThrow()
    expect(await readFile(finalPath, 'utf8')).toBe('competitor')
    expect(await readFile(partial, 'utf8')).toBe('new')
  })
  it('检查后的目录竞争不得被误报为正式文件发布成功', async () => {
    const partial = join(root, 'new.partial')
    const finalPath = join(root, 'competing.mov')
    await writeFile(partial, 'new')
    race.beforeMove = () => mkdir(finalPath)
    await expect(
      publishProxyPartial(partial, finalPath, new AbortController().signal)
    ).rejects.toThrow()
  })
  it('预取消不会移动文件', async () => {
    const partial = join(root, 'new.partial')
    const finalPath = join(root, 'final.mov')
    const controller = new AbortController()
    controller.abort()
    await writeFile(partial, 'new')
    await expect(publishProxyPartial(partial, finalPath, controller.signal)).rejects.toThrow('取消')
    expect(await readFile(partial, 'utf8')).toBe('new')
    await expect(readFile(finalPath)).rejects.toThrow()
  })
})

it('Windows 使用禁止覆盖的 File.Move，路径通过环境变量传入而非拼接命令', () => {
  const partial = "D:\\含空格\\$literal'; new.partial"
  const finalPath = 'E:\\交付\\final.mov'
  const command = proxyPublicationCommand(partial, finalPath, 'win32')
  expect(command.executable).toMatch(/powershell\.exe$/)
  expect(command.args).toContain(
    '[System.IO.File]::Move($env:SECUREREEL_PROXY_PARTIAL, $env:SECUREREEL_PROXY_FINAL)'
  )
  expect(command.args.join(' ')).not.toContain(partial)
  expect(command.env).toEqual({
    SECUREREEL_PROXY_PARTIAL: partial,
    SECUREREEL_PROXY_FINAL: finalPath
  })
})
