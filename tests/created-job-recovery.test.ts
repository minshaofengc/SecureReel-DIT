import { describe, expect, it, vi } from 'vitest'
import type { CopyJob, IpcResult } from '../src/shared/types'
import { startPersistedJob } from '../src/shared/created-job-recovery'

const job = (state: CopyJob['state']): CopyJob => ({
  id: 'qa_job_01', name: 'QA created job', mode: 'copy', state,
  sourcePath: '/qa/source', sourceRootName: 'source', sourceKind: 'generic',
  isCodExVfs: false, parentProjectId: null, targets: [], hashAlgorithm: 'xxhash64',
  manifestFormat: 'asc-mhl-2.0', verifyAfterWrite: true,
  proxyEnabled: false, proxyResolution: '1080p', proxyCodec: 'prores',
  proxyProfile: '422-proxy', proxyLutPath: null, totalFiles: 1, totalBytes: 1,
  filesDone: 0, filesFailed: 0, bytesDone: 0, createdAt: '2026-10-15',
  startedAt: null, finishedAt: null, degradationNotice: null
})
const ok = (state: CopyJob['state']): IpcResult<CopyJob> => ({ ok: true, data: job(state) })

describe('start recovery never re-creates or double-starts an ambiguous job', () => {
  it('first start fails while stored job remains draft; second attempt uses same ID', async () => {
    let state: CopyJob['state'] = 'draft'
    const get = vi.fn(async () => ok(state))
    const start = vi.fn(async (jobId: string) => {
      if (jobId !== 'qa_job_01') throw new Error('Wrong ID')
      if (start.mock.calls.length === 1) return { ok: false as const, error: 'QA start refused' }
      state = 'running'
      return ok(state)
    })
    await expect(startPersistedJob('qa_job_01', { get, start })).rejects.toThrow('QA start refused')
    expect((await startPersistedJob('qa_job_01', { get, start })).state).toBe('running')
    expect(start).toHaveBeenCalledTimes(2)
    expect(start.mock.calls.every((args) => args[0] === 'qa_job_01')).toBe(true)
  })
  it('successful start with lost response resolves state via get and does not try again', async () => {
    const get = vi.fn().mockResolvedValueOnce(ok('draft')).mockResolvedValue(ok('running'))
    const start = vi.fn(async () => { throw new Error('QA IPC response lost') })
    expect((await startPersistedJob('qa_job_01', { get, start })).state).toBe('running')
    expect(start).toHaveBeenCalledTimes(1)
    expect((await startPersistedJob('qa_job_01', { get, start })).state).toBe('running')
    expect(start).toHaveBeenCalledTimes(1)
  })
  it('read failure before starting cannot trigger a speculative start', async () => {
    const start = vi.fn(async () => ok('running'))
    await expect(startPersistedJob('qa_job_01', {
      get: async () => ({ ok: false, error: 'Read unavailable' }), start
    })).rejects.toThrow('Read unavailable')
    expect(start).not.toHaveBeenCalled()
  })
  it('unreadable state after start error blocks repeat and preserves ambiguity', async () => {
    const get = vi.fn().mockResolvedValueOnce(ok('draft'))
      .mockResolvedValue({ ok: false, error: 'QA connection down' })
    await expect(startPersistedJob('qa_job_01', {
      get, start: async () => { throw new Error('timeout') }
    })).rejects.toThrow('Cannot confirm')
  })
  it('cancelled jobs must not be restarted', async () => {
    const start = vi.fn(async () => ok('running'))
    await expect(startPersistedJob('qa_job_01', {
      get: async () => ok('cancelled'), start
    })).rejects.toThrow('cancelled')
    expect(start).not.toHaveBeenCalled()
  })
})
