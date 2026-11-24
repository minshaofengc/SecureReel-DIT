/** 同意记录：只存"同意/拒绝 + 政策版本 + 时间"，不存任何可识别信息。 */
import type { ConsentDecision, ConsentRecord } from '@shared/usage'
import type { Store } from '../db/store'

export const CONSENT_KV = 'usage.consent'

export function readConsent(store: Store): ConsentRecord | null {
  const raw = store.getKv(CONSENT_KV)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ConsentRecord> | null
    if (parsed === null || typeof parsed !== 'object') return null
    if (parsed.decision !== 'granted' && parsed.decision !== 'declined') return null
    if (typeof parsed.policyVersion !== 'number' || !Number.isFinite(parsed.policyVersion)) return null
    return {
      decision: parsed.decision,
      policyVersion: Math.floor(parsed.policyVersion),
      decidedAt: typeof parsed.decidedAt === 'string' ? parsed.decidedAt : ''
    }
  } catch {
    return null
  }
}

export function writeConsent(
  store: Store,
  decision: ConsentDecision,
  policyVersion: number,
  nowIso = new Date().toISOString()
): ConsentRecord {
  const record: ConsentRecord = { decision, policyVersion, decidedAt: nowIso }
  store.setKv(CONSENT_KV, JSON.stringify(record))
  return record
}
