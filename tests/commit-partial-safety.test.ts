import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitPartial } from '../src/main/fs-utils'
let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'publish-material-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
it('并发发布同名素材时只有一个成功，不覆盖先到者', async () => {
  const a = join(root, 'a.partial'),
    b = join(root, 'b.partial'),
    final = join(root, 'material.mov')
  await writeFile(a, 'camera A')
  await writeFile(b, 'camera B')
  const results = await Promise.allSettled([commitPartial(a, final), commitPartial(b, final)])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(['camera A', 'camera B']).toContain(await readFile(final, 'utf8'))
})
it('已有正式文件保持逐字节不变', async () => {
  const partial = join(root, 'new.partial'),
    final = join(root, 'material.mov')
  await writeFile(partial, 'new material')
  await writeFile(final, 'existing material')
  await expect(commitPartial(partial, final)).rejects.toThrow()
  expect(await readFile(final, 'utf8')).toBe('existing material')
  expect(await readFile(partial, 'utf8')).toBe('new material')
})
