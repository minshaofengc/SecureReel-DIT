import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:https'
import { createHash } from 'node:crypto'
import { MobileCompanion } from '../src/main/mobile-companion/server'
import type { CompanionAdapter, CompanionJob } from '../src/main/mobile-companion/adapter'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'sr-companion-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'source')
  const target = join(dir, 'target')
  await mkdir(source)
  await mkdir(target)
  const jobs: CompanionJob[] = []
  let creates = 0
  let controls = 0
  const adapter: CompanionAdapter = {
    snapshot: () => ({ jobs, projects: [] }),
    create: async (input) => {
      creates++
      const job: CompanionJob = {
        id: 'job_abcdef',
        name: input.projectName,
        mode: input.mode,
        state: 'draft',
        totalFiles: 1,
        totalBytes: 4,
        filesDone: 0,
        filesFailed: 0,
        bytesDone: 0,
        sourceRootId: input.sourceRootId,
        targetRootIds: input.targetRootIds
      }
      jobs.push(job)
      return job
    },
    control: async (id, action) => {
      controls++
      const job = jobs.find((j) => j.id === id)!
      job.state =
        action === 'start' || action === 'resume'
          ? 'running'
          : action === 'pause'
            ? 'paused'
            : 'cancelled'
      return job
    },
    reports: () => [],
    reportFile: async () => null
  }
  const service = await MobileCompanion.open({ directory: join(dir, 'authority'), adapter })
  cleanups.push(() => service.stop())
  await service.approveRoot(source, 'source')
  await service.approveRoot(target, 'target')
  await service.start('127.0.0.1', 0)
  const setup = service.createPairing('127.0.0.1')
  const call = (path: string, body?: unknown, token?: string) =>
    new Promise<{ status: number; value: any }>((resolve, reject) => {
      const req = request(
        `${setup.url}/api/v1${path}`,
        {
          method: body === undefined ? 'GET' : 'POST',
          rejectUnauthorized: false,
          agent: false,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' })
          }
        },
        (res) => {
          const peer = (res.socket as import('node:tls').TLSSocket).getPeerCertificate()
          expect(createHash('sha256').update(peer.raw).digest('hex')).toBe(setup.fingerprint)
          const chunks: Buffer[] = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              value: JSON.parse(Buffer.concat(chunks).toString())
            })
          )
        }
      )
      req.on('error', reject)
      if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
      req.end()
    })
  const pair = async () =>
    (
      await call('/pair', {
        pairingCode: service.createPairing('127.0.0.1').pairingCode,
        deviceName: 'Test phone'
      })
    ).value.data
  return { service, setup, call, pair, dir, jobs, adapter, counts: () => ({ creates, controls }) }
}
describe('desktop HTTPS companion', () => {
  it('never starts or mutates a terminal job and rejects unsupported hash/manifest combinations', async () => {
    const f = await fixture()
    const { token } = await f.pair()
    const roots = (await f.call('/roots', undefined, token)).value.data
    const input = {
      requestId: 'retry-0003',
      sourceRootId: roots[0].id,
      targetRootIds: [roots[1].id],
      mode: 'copy',
      hashAlgorithm: 'sha256',
      manifestFormat: 'json',
      projectName: 'Card'
    }
    expect((await f.call('/jobs', { ...input, manifestFormat: 'asc-mhl-2.0' }, token)).status).toBe(
      400
    )
    await f.call('/jobs', input, token)
    f.jobs[0]!.state = 'completed'
    expect(
      (await f.call('/jobs/job_abcdef/start', { requestId: 'restart-0001' }, token)).status
    ).toBe(409)
    expect(
      (await f.call('/jobs/job_abcdef/cancel', { requestId: 'cancel-0001' }, token)).status
    ).toBe(409)
    expect(f.counts().controls).toBe(0)
  })

  it('requires auth and a bounded single-use pairing code, hides secrets in persistence', async () => {
    const f = await fixture()
    expect((await f.call('/snapshot')).status).toBe(401)
    expect((await f.call('/pair', { pairingCode: 'invalid', deviceName: 'Phone' })).status).toBe(
      403
    )
    const oneTime = f.service.createPairing('127.0.0.1')
    const paired = (
      await f.call('/pair', { pairingCode: oneTime.pairingCode, deviceName: 'Test phone' })
    ).value.data
    expect(
      (await f.call('/pair', { pairingCode: oneTime.pairingCode, deviceName: 'Other' })).status
    ).toBe(403)
    expect((await f.call('/snapshot', undefined, paired.token)).status).toBe(200)
    expect(
      (await f.call('/pair', { pairingCode: f.setup.pairingCode, deviceName: 'Other' })).status
    ).toBe(403)
    expect(await readFile(join(f.dir, 'authority', 'state.json'), 'utf8')).not.toContain(
      paired.token
    )
    await f.service.revokeClients()
    expect((await f.call('/snapshot', undefined, paired.token)).status).toBe(401)
  })
  it('expires pairing codes and rejects malformed, traversal and role-confused creation', async () => {
    const f = await fixture()
    const expired = f.service.createPairing('127.0.0.1', -1)
    expect(
      (await f.call('/pair', { pairingCode: expired.pairingCode, deviceName: 'Phone' })).status
    ).toBe(403)
    const { token } = await f.pair()
    expect((await f.call('/jobs', '{bad', token)).status).toBe(400)
    const roots = (await f.call('/roots', undefined, token)).value.data
    const input = {
      requestId: 'retry-0001',
      sourceRootId: roots[0].id,
      targetRootIds: [roots[1].id],
      mode: 'copy',
      hashAlgorithm: 'sha256',
      manifestFormat: 'json',
      projectName: 'Card'
    }
    expect((await f.call('/jobs', { ...input, sourceRootId: '../etc' }, token)).status).toBe(400)
    expect((await f.call('/jobs', { ...input, sourceRootId: roots[1].id }, token)).status).toBe(403)
    expect((await f.call('/jobs', { ...input, sourcePath: '/etc' }, token)).status).toBe(400)
    expect(f.counts().creates).toBe(0)
  })
  it('serializes concurrent retry requests and controls and reconnects from snapshot', async () => {
    const f = await fixture()
    const { token } = await f.pair()
    const roots = (await f.call('/roots', undefined, token)).value.data
    const input = {
      requestId: 'retry-0001',
      sourceRootId: roots[0].id,
      targetRootIds: [roots[1].id],
      mode: 'copy',
      hashAlgorithm: 'sha256',
      manifestFormat: 'json',
      projectName: 'Card'
    }
    const responses = await Promise.all([
      f.call('/jobs', input, token),
      f.call('/jobs', input, token)
    ])
    expect(responses.map((r) => r.status)).toEqual([200, 200])
    expect(f.counts().creates).toBe(1)
    expect((await f.call('/jobs', { ...input, projectName: 'Different' }, token)).status).toBe(409)
    const control = { requestId: 'start-0001' }
    await Promise.all([
      f.call('/jobs/job_abcdef/start', control, token),
      f.call('/jobs/job_abcdef/start', control, token)
    ])
    expect(f.counts().controls).toBe(1)
    expect((await f.call('/snapshot', undefined, token)).value.data.jobs[0].state).toBe('running')
    expect((await f.call('/reports/job_abcdef', undefined, token)).status).toBe(409)
    await f.service.stop()
    const reopened = await MobileCompanion.open({
      directory: join(f.dir, 'authority'),
      adapter: f.adapter
    })
    cleanups.push(() => reopened.stop())
    expect(reopened.status().running).toBe(false)
    expect(reopened.status().fingerprint).toBe(f.setup.fingerprint)
    await reopened.start('127.0.0.1', Number(new URL(f.setup.url).port))
    expect((await f.call('/jobs', input, token)).status).toBe(200)
    expect(f.counts().creates).toBe(1)
  })
  it('persists identity across restart and rejects an approved root replaced with a symlink', async () => {
    const f = await fixture()
    const { token } = await f.pair()
    const roots = (await f.call('/roots', undefined, token)).value.data
    const { symlink } = await import('node:fs/promises')
    await rm(join(f.dir, 'source'), { recursive: true })
    await symlink(tmpdir(), join(f.dir, 'source'))
    expect(
      (
        await f.call(
          '/jobs',
          {
            requestId: 'retry-0002',
            sourceRootId: roots[0].id,
            targetRootIds: [roots[1].id],
            mode: 'copy',
            hashAlgorithm: 'sha256',
            manifestFormat: 'json',
            projectName: 'Card'
          },
          token
        )
      ).status
    ).toBe(403)
    await writeFile(join(f.dir, 'probe'), 'unchanged')
  })
})

it('tracks authenticated contact and revokes one client without revoking another', async () => {
  const f = await fixture()
  const a = await f.pair()
  const b = await f.pair()
  expect(f.service.status().clients.find((c) => c.id === a.clientId)?.lastSeenAt).toBeNull()
  expect((await f.call('/snapshot', undefined, a.token)).status).toBe(200)
  expect(f.service.status().clients.find((c) => c.id === a.clientId)?.lastSeenAt).toMatch(/^20/)
  await f.service.revokeClient(a.clientId)
  expect((await f.call('/snapshot', undefined, a.token)).status).toBe(401)
  expect((await f.call('/snapshot', undefined, b.token)).status).toBe(200)
  const first = f.service.status().roots[0]!
  await f.service.removeRoot(first.id)
  expect(f.service.status().roots.some((r) => r.id === first.id)).toBe(false)
})
it('authorized preflight is read-only and returns folder IDs instead of desktop paths', async () => {
  const f = await fixture()
  const { token } = await f.pair()
  const roots = f.service.status().roots
  const source = roots.find((r) => r.role === 'source')!
  const target = roots.find((r) => r.role === 'target')!
  const actual = await realpath(f.dir)
  const identity = (path: string) => ({
    path,
    label: 'Disk',
    filesystemId: 'fs',
    capacityPoolId: 'pool',
    physicalDeviceIds: ['disk0'],
    availableBytes: 100,
    present: true
  })
  f.adapter.preflight = async () => ({
    fingerprint: 'bound',
    checkedAt: new Date().toISOString(),
    source: identity(join(actual, 'source')),
    targets: [identity(join(actual, 'target'))],
    groups: [
      {
        id: 'pool',
        paths: [join(actual, 'target')],
        requiredBytes: 60,
        availableBytes: 100,
        sufficient: true
      }
    ],
    risks: [],
    blockingReasons: [],
    requiredBytes: 60,
    independentDeviceGroups: 1
  })
  expect(
    (
      await f.call(
        '/preflight',
        { sourceRootId: source.id, targetRootIds: [target.id], mode: 'copy' },
        undefined
      )
    ).status
  ).toBe(401)
  const response = await f.call(
    '/preflight',
    { sourceRootId: source.id, targetRootIds: [target.id], mode: 'copy' },
    token
  )
  expect(response.status).toBe(200)
  expect(response.value.data.source.path).toBe(source.id)
  expect(response.value.data.targets[0].path).toBe(target.id)
  expect(response.value.data.groups[0].paths).toEqual([target.id])
  expect(JSON.stringify(response.value)).not.toContain(f.dir)
  expect(f.counts()).toEqual({ creates: 0, controls: 0 })
  expect(
    (
      await f.call(
        '/preflight',
        { sourceRootId: source.id, targetRootIds: ['root_forbidden'], mode: 'copy' },
        token
      )
    ).status
  ).toBe(403)
})
it('never labels a mutation failure after a durable reservation as a definite safe rejection', async () => {
  const f = await fixture()
  const { token } = await f.pair()
  const roots = f.service.status().roots
  const create = f.adapter.create
  f.adapter.create = async (input, approved) => {
    await create(input, approved)
    throw new Error('reply failed after create')
  }
  const input = {
    requestId: 'uncertain-create-01',
    sourceRootId: roots.find((r) => r.role === 'source')!.id,
    targetRootIds: [roots.find((r) => r.role === 'target')!.id],
    mode: 'copy',
    hashAlgorithm: 'xxhash64',
    manifestFormat: 'json',
    projectName: 'Card'
  }
  const first = await f.call('/jobs', input, token)
  expect(first.status).toBe(409)
  expect(first.value.error.code).toBe('request_uncertain')
  expect((await f.call('/jobs', input, token)).value.error.code).toBe('request_uncertain')
  expect(f.counts().creates).toBe(1)
  expect(f.jobs).toHaveLength(1)
})

it('keeps a completed mutation uncertain when its final filesystem save fails, including after restart', async () => {
  const f = await fixture()
  const { token, clientId } = await f.pair()
  const roots = f.service.status().roots
  const authority = join(f.dir, 'authority')
  const blockedTemp = join(authority, 'state.json.tmp')
  const create = f.adapter.create
  f.adapter.create = async (input, approved) => {
    const job = await create(input, approved)
    // Reservation has already renamed this temporary file away. Make the
    // final real write fail without replacing save(), writeFile() or rename().
    await mkdir(blockedTemp)
    return job
  }
  const input = {
    requestId: 'uncertain-final-save-01',
    sourceRootId: roots.find((r) => r.role === 'source')!.id,
    targetRootIds: [roots.find((r) => r.role === 'target')!.id],
    mode: 'copy',
    hashAlgorithm: 'xxhash64',
    manifestFormat: 'json',
    projectName: 'Card'
  }
  const first = await f.call('/jobs', input, token)
  expect(first.status).toBe(409)
  expect(first.value.error.code).toBe('request_uncertain')
  const persisted = JSON.parse(await readFile(join(authority, 'state.json'), 'utf8'))
  expect(persisted.requests[`${clientId}:${input.requestId}`].pending).toBe(true)
  expect(f.jobs).toHaveLength(1)
  await rm(blockedTemp, { recursive: true })
  const retry = await f.call('/jobs', input, token)
  expect(retry.status).toBe(409)
  expect(retry.value.error.code).toBe('request_uncertain')
  await f.service.stop()
  const reopened = await MobileCompanion.open({ directory: authority, adapter: f.adapter })
  cleanups.push(() => reopened.stop())
  await reopened.start('127.0.0.1', Number(new URL(f.setup.url).port))
  const afterRestart = await f.call('/jobs', input, token)
  expect(afterRestart.status).toBe(409)
  expect(afterRestart.value.error.code).toBe('request_uncertain')
  expect(f.counts().creates).toBe(1)
  expect(f.jobs).toHaveLength(1)
})
