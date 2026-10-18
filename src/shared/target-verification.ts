
import type { TargetProgress } from '@shared/types'

export type DestinationOutcome =
  | 'verified'
  | 'failed'
  | 'unavailable'
  | 'pending'
  | 'running'
  | 'disabled'

/**
 * The engine's target.state='completed' means that work stopped, NOT that
 * every file passed a destination reread. Never color that alone as success.
 * This is display-only; source truth remains JobManager/Store.
 */
export function destinationOutcome(
  totalFiles: number,
  progress: TargetProgress | undefined
): DestinationOutcome {
  if (progress === undefined) return 'unavailable'
  if (progress.state === 'failed' || progress.filesFailed > 0 || progress.error !== null)
    return 'failed'
  if (progress.state === 'completed') {
    return totalFiles > 0 && progress.filesDone === totalFiles
      ? 'verified'
      : 'unavailable'
  }
  return progress.state
}

/** The job terminal state can be partial because a proxy failed even if
 *  every source file was copied and verified. Never mislabel this as media corruption. */
export type JobIssueKind = 'media' | 'proxy' | 'other'
export function classifyJobIssue(
  state: string | null,
  filesFailed: number,
  proxyFailed: number | null
): JobIssueKind | null {
  if (filesFailed > 0) return 'media'
  if (proxyFailed !== null && proxyFailed > 0) return 'proxy'
  if (state === 'failed' || state === 'completed-with-errors') return 'other'
  return null
}
