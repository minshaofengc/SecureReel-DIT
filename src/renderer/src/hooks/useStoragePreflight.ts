import { useCallback, useEffect, useRef, useState } from 'react'
import { StorageEvidenceSession, confirmedStoragePreflight } from '../state/storage-evidence'
import type { PreflightConfirmation, TargetPreflightResult } from '@shared/storage-safety'

export interface StoragePreflightInput {
  sourcePath: string
  targets: { path: string }[]
  mode: 'copy' | 'verify'
  proxyEnabled?: boolean
}

/** Evidence and acknowledgement belong to this exact input and focus session. */
export function useStoragePreflight(input: StoragePreflightInput | null) {
  const key = JSON.stringify(input)
  const currentKey = useRef(key)
  currentKey.current = key
  const session = useRef(new StorageEvidenceSession())
  const [snapshot, setSnapshot] = useState<{ key: string; result: TargetPreflightResult } | null>(null)
  const [accepted, setAccepted] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const invalidate = useCallback(() => {
    session.current.invalidate()
    setSnapshot(null)
    setAccepted(null)
    setChecking(false)
    setError(null)
  }, [])
  useEffect(() => {
    const evidence = session.current
    invalidate()
    return () => { evidence.invalidate() }
  }, [key, invalidate])
  useEffect(() => {
    // Invalidate on leaving as well as returning: an old in-flight reply cannot
    // re-enable a start while the window is away and a device is being swapped.
    window.addEventListener('blur', invalidate)
    window.addEventListener('focus', invalidate)
    return () => {
      window.removeEventListener('blur', invalidate)
      window.removeEventListener('focus', invalidate)
    }
  }, [invalidate])
  const check = useCallback(async () => {
    const request = JSON.parse(key) as StoragePreflightInput | null
    if (request === null) return null
    const ticket = session.current.begin(key)
    setSnapshot(null)
    setAccepted(null)
    setError(null)
    setChecking(true)
    try {
      const answer = await window.securereel.jobs.preflight(request)
      if (!session.current.isCurrent(ticket, currentKey.current)) return null
      if (!answer.ok) throw new Error(answer.error)
      setSnapshot({ key, result: answer.data })
      return answer.data
    } catch (cause) {
      if (session.current.isCurrent(ticket, currentKey.current)) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      return null
    } finally {
      if (session.current.isCurrent(ticket, currentKey.current)) setChecking(false)
    }
  }, [key])
  const result = snapshot?.key === key ? snapshot.result : null
  const acknowledged = result !== null && accepted === result.fingerprint
  const ready = confirmedStoragePreflight(result, accepted)
  const confirmation: PreflightConfirmation | undefined = ready && result !== null
    ? { fingerprint: result.fingerprint, acceptRisks: acknowledged }
    : undefined
  return {
    result, checking, error, ready, confirmation, acknowledged, check, invalidate,
    acknowledge: (value: boolean) => setAccepted(value ? result?.fingerprint ?? null : null)
  }
}
