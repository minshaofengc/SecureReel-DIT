import { mkdtemp, mkdir, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { preflightStorage } from '../src/main/core/storage-preflight'

describe('storage preflight real filesystem', () => {
  it('canonicalizes aliases and blocks a same-volume copy without writing any files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'securereel-storage-native-'))
    try {
      const source = join(root, 'card')
      const target = join(root, 'backup')
      const alias = join(root, 'alias')
      await mkdir(source)
      await mkdir(target)
      // Junctions avoid requiring Windows symlink privileges.
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const input = {
        sourcePath: source,
        targets: [target],
        requiredBytes: 1,
        mode: 'copy' as const
      }
      const direct = await preflightStorage(input)
      const aliased = await preflightStorage({ ...input, targets: [alias] })
      expect(aliased.fingerprint).toBe(direct.fingerprint)
      expect(direct.source.present).toBe(true)
      if (process.platform === 'darwin') {
        expect(direct.source.filesystemId).toMatch(/^mac:volume:/)
        expect(direct.source.physicalDeviceIds.length).toBeGreaterThan(0)
      }
      expect(direct.targets[0]?.present).toBe(true)
      expect(direct.blockingReasons.length).toBeGreaterThan(0)
      expect(await readdir(source)).toEqual([])
      expect(await readdir(target)).toEqual([])
      const readOnly = await preflightStorage({ ...input, mode: 'verify', proxyEnabled: true })
      expect(readOnly.risks).toEqual([])
      expect(readOnly.blockingReasons).toEqual([])
      expect(await readdir(source)).toEqual([])
      expect(await readdir(target)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
