import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { preflightStorage, checkPreflightConfirmation } from '../src/main/core/storage-preflight'

const state = vi.hoisted(() => ({
  platform: 'darwin',
  disks: new Map<string, Record<string, unknown>>(),
  missing: new Set<string>(),
  free: new Map<string, number | null>(),
  calls: [] as { executable: string; args: readonly string[]; env?: NodeJS.ProcessEnv }[]
}))
vi.mock('../src/main/platform', async (original) => ({
  ...(await original<object>()),
  get HOST() {
    return state.platform
  }
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    realpath: vi.fn(async (path: string) => {
      if (!path.startsWith('/fixture/') && !/^[A-Za-z]:/.test(path) && !path.startsWith('\\\\'))
        return actual.realpath(path)
      if (state.missing.has(path)) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      return path
    }),
    stat: vi.fn(async (path: string) => {
      if (!path.startsWith('/fixture/') && !/^[A-Za-z]:/.test(path) && !path.startsWith('\\\\'))
        return actual.stat(path)
      if (state.missing.has(path)) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      return { dev: state.disks.get(path)?.dev ?? 10, isDirectory: (): boolean => true }
    }),
    statfs: vi.fn(async (path: string) => {
      if (!path.startsWith('/fixture/') && !/^[A-Za-z]:/.test(path) && !path.startsWith('\\\\'))
        return actual.statfs(path)
      const free = state.free.has(path) ? state.free.get(path) : 100
      if (free === null) throw new Error('unsupported')
      return { bavail: free, bsize: 1 }
    })
  }
})
function xml(value: unknown): string {
  if (Array.isArray(value)) return `<array>${value.map(xml).join('')}</array>`
  if (value && typeof value === 'object')
    return `<dict>${Object.entries(value)
      .map(([key, item]) => `<key>${key}</key>${xml(item)}`)
      .join('')}</dict>`
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>'
  if (typeof value === 'number') return `<integer>${value}</integer>`
  return `<string>${String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</string>`
}
vi.mock('../src/main/exec', () => ({
  resolveExecutable: vi.fn(async (path: string) => path),
  runCommand: vi.fn(
    async (executable: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      state.calls.push({ executable, args, env: options?.env })
      const path = state.platform === 'win32' ? options.env?.SECUREREEL_STORAGE_PATH : args.at(-1)
      const info = state.disks.get(path ?? '')
      return {
        code: info ? 0 : 1,
        stdout:
          typeof info?.rawPlist === 'string'
            ? info.rawPlist
            : info
              ? state.platform === 'win32'
                ? JSON.stringify(info)
                : `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${xml(info)}</plist>`
              : '',
        stderr: '',
        timedOut: false,
        spawnError: null
      }
    }
  )
}))
const source = '/fixture/card'
const a = '/fixture/backup-a'
const b = '/fixture/backup-b'
function disk(
  path: string,
  volume: string,
  parent: string,
  extra: Record<string, unknown> = {}
): void {
  state.disks.set(path, {
    dev: volume === 'CARD' ? 1 : volume === 'A' ? 2 : volume === 'B' ? 3 : 4,
    VolumeUUID: volume,
    VolumeName: volume,
    ParentWholeDisk: parent,
    DeviceIdentifier: `${parent}s1`,
    VirtualOrPhysical: 'Physical',
    ...extra
  })
}
const copy = (targets = [a, b], requiredBytes = 60, extra = {}) =>
  preflightStorage({ sourcePath: source, targets, requiredBytes, mode: 'copy', ...extra })
beforeEach(() => {
  state.platform = 'darwin'
  state.disks.clear()
  state.missing.clear()
  state.free.clear()
  state.calls.length = 0
  disk(source, 'CARD', 'disk1', { dev: 1 })
  disk(a, 'A', 'disk2', { dev: 2 })
  disk(b, 'B', 'disk3', { dev: 3 })
})
describe('storage preflight capacity and topology', () => {
  it('aggregates 60+60 on a 100-byte filesystem and requires explicit same-filesystem warning', async () => {
    disk(b, 'A', 'disk2', { dev: 2 })
    state.free.set(b, 90)
    const result = await copy()
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({
      paths: [a, b],
      requiredBytes: 120,
      availableBytes: 90,
      sufficient: false
    })
    expect(result.risks.map((r) => r.code)).toContain('shared-filesystem')
    expect(result.risks.map((r) => r.code)).toContain('insufficient-space')
    expect(result.independentDeviceGroups).toBe(1)
    expect(() => checkPreflightConfirmation(result)).toThrow()
    expect(() =>
      checkPreflightConfirmation(result, { fingerprint: result.fingerprint, acceptRisks: true })
    ).not.toThrow()
  })
  it('groups different APFS volumes sharing one container without treating virtual disk as physical', async () => {
    disk(a, 'A', 'disk7', {
      APFSContainerReference: 'disk7',
      APFSPhysicalStores: [{ APFSPhysicalStore: 'disk2s2' }]
    })
    disk(b, 'B', 'disk7', {
      APFSContainerReference: 'disk7',
      APFSPhysicalStores: [{ APFSPhysicalStore: 'disk2s2' }]
    })
    const result = await copy()
    expect(result.groups[0]).toMatchObject({ paths: [a, b], requiredBytes: 120, sufficient: false })
    expect(result.targets[0]?.physicalDeviceIds).toEqual(['mac:physical:disk2'])
    expect(result.independentDeviceGroups).toBe(1)
  })
  it('keeps different partitions capacity separate but warns of a common physical disk', async () => {
    disk(b, 'B', 'disk2', { dev: 3 })
    const result = await copy()
    expect(result.groups).toHaveLength(2)
    expect(result.groups.every((g) => g.sufficient)).toBe(true)
    expect(result.blockingReasons).toEqual([])
    expect(result.risks.map((r) => r.code)).toContain('shared-device')
    expect(result.independentDeviceGroups).toBe(1)
    expect(() => checkPreflightConfirmation(result)).toThrow()
    expect(() =>
      checkPreflightConfirmation(result, { fingerprint: result.fingerprint, acceptRisks: true })
    ).not.toThrow()
  })
  it('counts independent physical disks and permits a clean copy', async () => {
    const result = await copy()
    expect(result.independentDeviceGroups).toBe(2)
    expect(result.risks).toEqual([])
    expect(result.blockingReasons).toEqual([])
    expect(() => checkPreflightConfirmation(result)).not.toThrow()
  })
  it('does not count a virtual parent as an independent disk when APFS stores are absent', async () => {
    disk(a, 'A', 'disk7', { APFSContainerReference: 'disk7', FilesystemType: 'apfs' })
    const result = await copy()
    expect(result.targets[0]?.physicalDeviceIds).toEqual([])
    expect(result.independentDeviceGroups).toBeNull()
    expect(result.risks.map((r) => r.code)).toContain('independence-unknown')
  })
  it('blocks unknown capacity but lets acknowledged unknown topology proceed with known capacity', async () => {
    state.disks.delete(a)
    let result = await copy([a])
    expect(result.independentDeviceGroups).toBeNull()
    expect(result.blockingReasons).toEqual([])
    expect(() =>
      checkPreflightConfirmation(result, { fingerprint: result.fingerprint, acceptRisks: true })
    ).not.toThrow()
    state.free.set(a, null)
    result = await copy([a])
    expect(result.groups[0]?.sufficient).toBeNull()
    expect(result.blockingReasons.length).toBeGreaterThan(0)
  })
  it('blocks a target on the source filesystem and warns about another partition on the source disk', async () => {
    disk(a, 'CARD', 'disk1', { dev: 1 })
    expect((await copy([a])).blockingReasons.length).toBeGreaterThan(0)
    disk(a, 'OTHER', 'disk1', { dev: 4 })
    const result = await copy([a])
    expect(result.blockingReasons).toEqual([])
    expect(result.risks.map((r) => r.code)).toContain('source-device')
    expect(result.independentDeviceGroups).toBe(0)
  })
  it('blocks a lost target instead of silently probing its parent filesystem', async () => {
    state.missing.add(a)
    const result = await copy([a])
    expect(result.targets[0]?.present).toBe(false)
    expect(result.blockingReasons.length).toBeGreaterThan(0)
  })
  it('still blocks source same-filesystem when only one native volume probe succeeds', async () => {
    disk(a, 'A', 'disk2', { dev: 1 })
    state.disks.delete(source)
    disk(source, 'CARD', 'disk1', { dev: 1, rawPlist: 'unavailable' })
    const result = await copy([a])
    expect(result.blockingReasons.length).toBeGreaterThan(0)
  })
  it('resolves APFS physical stores from fresh container info when volume info omits them', async () => {
    disk(a, 'A', 'disk7', { APFSContainerReference: 'disk7', FilesystemType: 'apfs' })
    state.disks.set('disk7', {
      DiskUUID: 'CONTAINER',
      APFSPhysicalStores: [{ APFSPhysicalStore: 'disk2s2' }],
      VirtualOrPhysical: 'Virtual'
    })
    const result = await copy([a])
    expect(result.targets[0]?.physicalDeviceIds).toEqual(['mac:physical:disk2'])
    expect(result.targets[0]?.capacityPoolId).toContain('CONTAINER')
    expect(result.independentDeviceGroups).toBe(1)
  })
  it('refuses virtual disk-image parents even when a parent identifier is present', async () => {
    disk(a, 'IMAGE', 'disk9', { VirtualOrPhysical: 'Virtual' })
    const result = await copy([a])
    expect(result.targets[0]?.physicalDeviceIds).toEqual([])
    expect(result.independentDeviceGroups).toBeNull()
  })
  it('uses a real parent probe for non-APFS volumes without physical classification', async () => {
    disk(a, 'A', 'disk2', { VirtualOrPhysical: '' })
    state.disks.set('disk2', {
      WholeDisk: true,
      VirtualOrPhysical: 'Physical',
      DeviceIdentifier: 'disk2'
    })
    expect((await copy([a])).targets[0]?.physicalDeviceIds).toEqual(['mac:physical:disk2'])
  })
  it('downgrades unsafe XML entities to unknown topology without evaluating them', async () => {
    state.disks.set(a, {
      dev: 2,
      rawPlist:
        '<!DOCTYPE plist [<!ENTITY stolen SYSTEM "file:///etc/passwd">]><plist version="1.0"><dict><key>VolumeName</key><string>&stolen;</string></dict></plist>'
    })
    const result = await copy([a])
    expect(result.targets[0]?.label).toBe('backup-a')
    expect(result.independentDeviceGroups).toBeNull()
    expect(result.risks.map((r) => r.code)).toContain('independence-unknown')
  })
  it('binds proxy choice and source replacement to a fresh confirmation', async () => {
    const first = await copy([a])
    expect((await copy([a], 60, { proxyEnabled: true })).fingerprint).not.toBe(first.fingerprint)
    disk(source, 'NEWCARD', 'disk1', { dev: 1 })
    expect((await copy([a])).fingerprint).not.toBe(first.fingerprint)
  })
  it('groups transitive physical overlaps conservatively', async () => {
    const c = '/fixture/backup-c'
    disk(a, 'A', 'disk7', {
      APFSPhysicalStores: [{ APFSPhysicalStore: 'disk2s2' }, { APFSPhysicalStore: 'disk3s2' }]
    })
    disk(b, 'B', 'disk8', {
      APFSPhysicalStores: [{ APFSPhysicalStore: 'disk3s2' }, { APFSPhysicalStore: 'disk4s2' }]
    })
    disk(c, 'C', 'disk4')
    expect((await copy([a, b, c])).independentDeviceGroups).toBe(1)
  })
  it('verify mode does not require space or warn about backup independence', async () => {
    state.free.set(a, null)
    disk(a, 'CARD', 'disk1', { dev: 1 })
    const result = await preflightStorage({
      sourcePath: source,
      targets: [a],
      requiredBytes: 6000,
      mode: 'verify',
      proxyEnabled: true
    })
    expect(result.risks).toEqual([])
    expect(result.blockingReasons).toEqual([])
    expect(result.groups[0]?.requiredBytes).toBe(0)
    expect(() => checkPreflightConfirmation(result)).not.toThrow()
  })
  it('binds confirmation to ordered canonical paths and identities, not free space or timestamps', async () => {
    disk(b, 'B', 'disk2', { dev: 3 })
    const first = await copy()
    const confirmation = { fingerprint: first.fingerprint, acceptRisks: true }
    state.free.set(a, 99)
    const second = await copy()
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(() => checkPreflightConfirmation(second, confirmation)).not.toThrow()
    disk(a, 'NEW', 'disk4', { dev: 4 })
    const changed = await copy()
    expect(changed.fingerprint).not.toBe(first.fingerprint)
    expect(() => checkPreflightConfirmation(changed, confirmation)).toThrow()
    expect((await copy([b, a])).fingerprint).not.toBe(changed.fingerprint)
    expect((await copy([a, b], 61)).fingerprint).not.toBe(changed.fingerprint)
  })
  it('invalidates prior risk acceptance when capacity crosses into insufficient', async () => {
    disk(b, 'B', 'disk2', { dev: 3 })
    const first = await copy()
    state.free.set(a, 59)
    const second = await copy()
    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect(() =>
      checkPreflightConfirmation(second, { fingerprint: first.fingerprint, acceptRisks: true })
    ).toThrow()
  })
  it('validates paths, byte counts and modes before native commands', async () => {
    await expect(copy([a], -1)).rejects.toThrow()
    await expect(copy([a], Number.NaN)).rejects.toThrow()
    await expect(copy(['relative/path'])).rejects.toThrow()
    await expect(copy(['/fixture/\0bad'])).rejects.toThrow()
    expect(state.calls).toEqual([])
  })
  it('passes hostile path text as a single native argument, never shell code', async () => {
    const hostile = '/fixture/$(touch nope);`whoami`'
    disk(hostile, 'SPECIAL & <media>', 'disk4')
    const result = await copy([hostile])
    expect(result.targets[0]?.label).toBe('SPECIAL & <media>')
    expect(state.calls.some((call) => call.args.at(-1) === hostile && call.args.length === 3)).toBe(
      true
    )
  })
  it('uses Windows volume/physical/pool IDs and passes path only through the environment', async () => {
    state.platform = 'win32'
    state.disks.set('C:\\card', {
      filesystemId: 'volume-card',
      physicalDeviceIds: ['serial-source'],
      capacityPoolId: null,
      label: 'CARD'
    })
    state.disks.set('E:\\a', {
      filesystemId: 'volume-a',
      physicalDeviceIds: ['serial-a'],
      capacityPoolId: 'pool-a',
      label: 'A'
    })
    state.disks.set('F:\\b', {
      filesystemId: 'volume-b',
      physicalDeviceIds: ['serial-a'],
      capacityPoolId: 'pool-a',
      label: 'B'
    })
    const result = await preflightStorage({
      sourcePath: 'C:\\card',
      targets: ['E:\\a', 'F:\\b'],
      requiredBytes: 60,
      mode: 'copy'
    })
    expect(result.groups).toHaveLength(1)
    expect(result.independentDeviceGroups).toBe(1)
    expect(state.calls.every((call) => !call.args.join(' ').includes('E:\\a'))).toBe(true)
    expect(state.calls.some((call) => call.env?.SECUREREEL_STORAGE_PATH === 'E:\\a')).toBe(true)
  })
  it('leaves UNC storage independence unknown instead of inventing disks from share names', async () => {
    state.platform = 'win32'
    const result = await preflightStorage({
      sourcePath: 'C:\\card',
      targets: ['\\\\server\\share\\target'],
      requiredBytes: 60,
      mode: 'copy'
    })
    expect(result.independentDeviceGroups).toBeNull()
    expect(result.targets[0]?.physicalDeviceIds).toEqual([])
  })
  it('does not create or modify files when checking real temporary directories', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'securereel-preflight-'))
    try {
      const card = join(temp, 'card'),
        target = join(temp, 'target')
      await mkdir(card)
      await mkdir(target)
      const result = await preflightStorage({
        sourcePath: card,
        targets: [target],
        requiredBytes: 1,
        mode: 'verify'
      })
      expect(result.source.present).toBe(true)
      expect(result.targets[0]?.present).toBe(true)
      expect(await readdir(card)).toEqual([])
      expect(await readdir(target)).toEqual([])
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })
})
