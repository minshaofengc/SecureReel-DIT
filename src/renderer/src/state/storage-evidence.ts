import type { JobState } from '@shared/types'
import type { TargetPreflightResult } from '@shared/storage-safety'

interface EvidenceTicket { generation: number; key: string }

/** A late IPC answer cannot restore evidence after input, focus or page changes. */
export class StorageEvidenceSession {
  private generation = 0
  invalidate(): void { this.generation++ }
  begin(key: string): EvidenceTicket { return { generation: ++this.generation, key } }
  isCurrent(ticket: EvidenceTicket, currentKey: string): boolean {
    return ticket.generation === this.generation && ticket.key === currentKey
  }
}

export function confirmedStoragePreflight(result: TargetPreflightResult | null, acceptedFingerprint: string | null): boolean {
  return result !== null && result.blockingReasons.length === 0 &&
    (result.risks.length === 0 || acceptedFingerprint === result.fingerprint)
}


/** Facts used by desktop rendering; absence of topology is never independence. */
export function storageEvidenceView(result: TargetPreflightResult | null | undefined, historical = false, state?: JobState) {
  return {
    reviewAvailable: state !== 'running' && state !== 'queued' && state !== 'cancelled',
    status: !result ? historical ? 'historical-unknown' : 'not-checked'
      : result.independentDeviceGroups === null ? 'independence-unknown' : 'identified',
    riskAcknowledgementAvailable: !!result && result.risks.length > 0 && result.blockingReasons.length === 0,
    insufficientPaths: result?.groups.filter((group) => group.sufficient === false).flatMap((group) => group.paths) ?? []
  }
}
