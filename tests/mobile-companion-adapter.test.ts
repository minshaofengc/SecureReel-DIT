import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:https'
import { Store } from '../src/main/db/store'
import { Logger } from '../src/main/logger'
import { buildAppPaths } from '../src/main/paths'
import { ReportStore } from '../src/main/reports/report-store'
import { JobManager } from '../src/main/core/job-manager'
import { emptyProjectDraft } from '../src/shared/project'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { MobileCompanion } from '../src/main/mobile-companion/server'
import { desktopAdapter } from '../src/main/mobile-companion/adapter'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
it('real HTTPS creates once through Store/JobManager, verifies read-only and serves an immutable report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sr-real-companion-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'CARD')
  const target = join(dir, 'BACKUP')
  await mkdir(source)
  await mkdir(join(target, 'CARD'), { recursive: true })
  await writeFile(join(source, 'clip.bin'), 'verified bytes')
  await writeFile(join(target, 'CARD', 'clip.bin'), 'verified bytes')
  const paths = buildAppPaths(join(dir, 'data'))
  const store = await Store.openInMemory()
  cleanups.push(async () => store.close())
  const logger = new Logger({ dir: '' })
  const reportStore = new ReportStore(paths, logger)
  const manager = new JobManager({
    store,
    logger,
    paths,
    reportStore,
    probeRunner: {
      setFrameOutputDir: () => undefined,
      setStillFrameOutputDir: () => undefined,
      setStillFrameCount: () => undefined
    } as never,
    hde: {} as never,
    getSettings: () => ({ ...DEFAULT_SETTINGS, generateReport: false, extractFrames: false }),
    emit: () => undefined
  })
  const service = await MobileCompanion.open({
    directory: join(dir, 'authority'),
    adapter: desktopAdapter(manager, store, paths.reportsDir)
  })
  cleanups.push(() => service.stop())
  await service.approveRoot(source, 'source')
  await service.approveRoot(target, 'target')
  await service.start('127.0.0.1', 0)
  const setup = service.createPairing('127.0.0.1')
  expect(setup).toHaveProperty('desktopName')
  expect(service.status()).toHaveProperty('desktopName')
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
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              value: JSON.parse(Buffer.concat(chunks).toString())
            })
          )
        }
      )
      req.on('error', reject)
      if (body !== undefined) req.write(JSON.stringify(body))
      req.end()
    })
  const pair = await call('/pair', { pairingCode: setup.pairingCode, deviceName: 'Phone' })
  const token = pair.value.data.token
  const roots = (await call('/roots', undefined, token)).value.data
  const parentResult = await call(
    '/projects',
    {
      requestId: 'parent-create-0001',
      name: 'Production',
      details: { camera: 'ARRI', notes: 'Original', crew: [{ role: 'DIT', name: 'Crew member' }] }
    },
    token
  )
  expect(parentResult.status).toBe(200)
  const duplicateRequest = {
    requestId: 'parent-copy-0001',
    name: 'Production',
    details: parentResult.value.data.details
  }
  const copied = await call('/projects', duplicateRequest, token)
  expect(copied.value.data.id).not.toBe(parentResult.value.data.id)
  expect((await call('/projects', duplicateRequest, token)).value.data.id).toBe(
    copied.value.data.id
  )
  expect(store.listParentProjects()).toHaveLength(2)
  const parentId = parentResult.value.data.id
  const snapshotParent = (await call('/snapshot', undefined, token)).value.data.projects.find(
    (p: { id: string }) => p.id === parentId
  )
  expect(snapshotParent.details.crew).toEqual([{ role: 'DIT', name: 'Crew member' }])
  expect(
    (
      await call(
        '/projects',
        { requestId: 'parent-update-0001', id: parentId, details: { notes: 'Updated' } },
        token
      )
    ).value.data.details.crew
  ).toEqual([{ role: 'DIT', name: 'Crew member' }])
  expect(
    (await call('/projects', undefined, token)).value.data.find(
      (p: { id: string }) => p.id === parentId
    ).details.camera
  ).toBe('ARRI')
  const input = {
    requestId: 'creation-0001',
    sourceRootId: roots[0].id,
    targetRootIds: [roots[1].id],
    mode: 'verify',
    hashAlgorithm: 'sha256',
    manifestFormat: 'json',
    projectName: 'Card verify',
    name: 'Camera A001',
    parentProjectId: parentId,
    project: {
      ...emptyProjectDraft(),
      projectName: 'Production',
      camera: 'ARRI',
      cardLabel: 'A001',
      crew: [{ role: 'DIT', name: 'Crew member' }]
    }
  }
  const result = await call('/jobs', input, token)
  expect(result.status).toBe(200)
  expect(result.value.data.name).toBe('Camera A001')
  expect(result.value.data.origin).toBe('desktop')
  expect(result.value.data.parentProjectName).toBe('Production')
  expect(result.value.data.project.crew).toEqual([{ role: 'DIT', name: 'Crew member' }])
  const jobId = result.value.data.id
  expect((await call('/jobs', input, token)).value.data.id).toBe(jobId)
  expect(store.listJobs()).toHaveLength(1)
  expect((await call(`/jobs/${jobId}`, undefined, token)).value.data.project.cardLabel).toBe('A001')
  expect((await call('/snapshot', undefined, token)).value.data.desktopName).toBe(setup.desktopName)
  expect(
    (
      await call(
        '/jobs',
        { ...input, requestId: 'missing-parent-0001', parentProjectId: 'prj_missing123' },
        token
      )
    ).status
  ).toBe(409) // A failure after durable reservation conservatively requires reconciliation.
  expect(store.listJobs()).toHaveLength(1)
  await call(
    '/projects',
    { requestId: 'rename-parent-0001', id: parentId, name: 'Renamed', details: { crew: [] } },
    token
  )
  expect((await call(`/jobs/${jobId}`, undefined, token)).value.data.parentProjectName).toBe(
    'Production'
  )
  const projectSaved = await call(
    `/jobs/${jobId}/project`,
    { requestId: 'metadata-0001', project: { camera: 'Canon', notes: 'Card notes' } },
    token
  )
  expect(projectSaved.status).toBe(200)
  expect((await call(`/jobs/${jobId}/project`, undefined, token)).value.data.camera).toBe('Canon')
  expect(
    (
      await call(
        `/jobs/${jobId}/project`,
        { requestId: 'metadata-bad1', project: { sourcePath: '/etc' } },
        token
      )
    ).status
  ).toBe(400)

  expect((await call(`/reports/${jobId}`, undefined, token)).status).toBe(409)
  expect((await call(`/jobs/${jobId}/start`, { requestId: 'start-0001' }, token)).status).toBe(200)
  await manager.wait(jobId)
  expect(store.getJob(jobId)?.state).toBe('completed')
  expect(store.getJob(jobId)?.filesDone).toBe(1)
  expect(await readFile(join(source, 'clip.bin'), 'utf8')).toBe('verified bytes')
  expect(await readFile(join(target, 'CARD', 'clip.bin'), 'utf8')).toBe('verified bytes')
  await manager.generateReports(jobId)
  const revisions = (await call(`/reports/${jobId}`, undefined, token)).value.data
  expect(revisions).toHaveLength(1)
  expect(revisions[0].formats).toContain('json')
  const immutable = await call(`/reports/${jobId}/${revisions[0].revision}/json`, undefined, token)
  expect(immutable.status).toBe(200)
  await manager.generateReports(jobId)
  expect(
    (await call(`/reports/${jobId}/${revisions[0].revision}/json`, undefined, token)).value
  ).toEqual(immutable.value)
  const reopened = await MobileCompanion.open({
    directory: join(dir, 'authority'),
    adapter: desktopAdapter(manager, store, paths.reportsDir)
  })
  expect(reopened.status().fingerprint).toBe(setup.fingerprint)
})
