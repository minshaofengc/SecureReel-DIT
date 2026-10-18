import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/main/db/store'
import type { CopyJob } from '../src/shared/types'
import type { TargetPreflightResult } from '../src/shared/storage-safety'
const stores: Store[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
})
const evidence: TargetPreflightResult = {
  fingerprint: 'bound-to-original-devices',
  checkedAt: '2026-10-18T00:00:00.000Z',
  source: {
    path: '/card',
    label: 'Card',
    filesystemId: 'source',
    physicalDeviceIds: ['disk1'],
    capacityPoolId: 'source',
    availableBytes: 100,
    present: true
  },
  targets: [],
  groups: [],
  risks: [{ code: 'shared-device', paths: ['/A', '/B'] }],
  blockingReasons: [],
  requiredBytes: 60,
  independentDeviceGroups: 1
}
function job(): CopyJob {
  return {
    id: 'job_safety01',
    name: 'Safe',
    mode: 'copy',
    sourcePath: '/card',
    sourceRootName: 'card',
    sourceKind: 'generic',
    isCodExVfs: false,
    parentProjectId: null,
    targets: [],
    hashAlgorithm: 'xxhash64',
    manifestFormat: 'json',
    verifyAfterWrite: true,
    proxyEnabled: false,
    proxyResolution: '1080p',
    proxyCodec: 'prores',
    proxyProfile: '422-proxy',
    proxyLutPath: null,
    state: 'draft',
    totalFiles: 1,
    totalBytes: 60,
    filesDone: 0,
    filesFailed: 0,
    bytesDone: 0,
    createdAt: '2026-10-18T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    degradationNotice: null
  }
}
it('retains accepted device evidence independently of current volume probes and clears it on deletion', async () => {
  const store = await Store.openInMemory()
  stores.push(store)
  store.insertJob(job())
  expect(store.getJob('job_safety01')?.backupSafety).toBeUndefined()
  store.saveJobSafety('job_safety01', evidence, {
    fingerprint: evidence.fingerprint,
    acceptRisks: true
  })
  expect(store.getJob('job_safety01')?.backupSafety).toEqual(evidence)
  expect(store.getJobSafetyConfirmation('job_safety01')).toEqual({
    fingerprint: evidence.fingerprint,
    acceptRisks: true
  })
  store.deleteJob('job_safety01')
  store.insertJob(job())
  expect(store.getJob('job_safety01')?.backupSafety).toBeUndefined()
})
it('new independent evidence cannot inherit confirmation for an earlier device identity', async () => {
  const store = await Store.openInMemory()
  stores.push(store)
  store.insertJob(job())
  store.saveJobSafety('job_safety01', evidence, {
    fingerprint: evidence.fingerprint,
    acceptRisks: true
  })
  store.saveJobSafety('job_safety01', { ...evidence, fingerprint: 'different-device' })
  expect(store.getJobSafetyConfirmation('job_safety01')).toBeUndefined()
  expect(store.getJob('job_safety01')?.backupSafety?.fingerprint).toBe('different-device')
})
