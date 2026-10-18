import type { CopyJob, IpcResult } from '@shared/types'

/**
 * A successful create is already durable. A lost or rejected start response
 * is NOT proof that the main process did not start the job.
 *
 * Never submit a new create here. Read the authoritative persisted job before
 * starting; on ambiguous errors read it again. If the state cannot be read,
 * stop and let the operator inspect/retry after connectivity is restored.
 */
export async function startPersistedJob(
  jobId: string,
  api: {
    get: (id: string) => Promise<IpcResult<CopyJob>>
    start: (id: string) => Promise<IpcResult<CopyJob>>
  }
): Promise<CopyJob> {
  async function read(): Promise<CopyJob> {
    const answer = await api.get(jobId)
    if (!answer.ok) throw new Error(answer.error)
    if (answer.data.id !== jobId) throw new Error('Job identity mismatch; refusing start')
    return answer.data
  }

  const existing = await read()
  if (existing.state !== 'draft') {
    if (existing.state === 'cancelled') throw new Error('This job was cancelled. Check the monitor.')
    return existing // Already queued/running/finished. Never start twice.
  }

  try {
    const answer = await api.start(jobId)
    if (!answer.ok) throw new Error(answer.error)
    return answer.data
  } catch (startError) {
    // If start was applied but its IPC response was lost, this read resolves
    // the ambiguity without issuing a second start or duplicating creation.
    let after: CopyJob
    try {
      after = await read()
    } catch {
      throw new Error('Cannot confirm whether this job started. Check the monitor before retrying.')
    }
    if (after.state !== 'draft' && after.state !== 'cancelled') return after
    if (after.state === 'cancelled') throw new Error('This job was cancelled. Check the monitor.')
    throw startError
  }
}
