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
  /*
   * 失焦与回到前台**不再作废证据**。
   *
   * 原先 blur/focus 都直接 invalidate()：用户点开访达确认一下盘、系统弹一次
   * 权限框，回来勾选和检查结果就全没了，按钮变灰且看不出原因。
   *
   * 换盘的安全性不依赖这里：主进程在 createJob 与 start 时会重新探测并比对
   * fingerprint（含 filesystemId / physicalDeviceIds / present），设备真的变了
   * 一定过不去。这里只在输入（源、目标、模式、代理）变化时作废，那才是
   * 用户明确改变了任务要求。迟到的 IPC 回复仍由 generation 计数丢弃。
   */
  const check = useCallback(async (requiredBytes?: number | null) => {
    const request = JSON.parse(key) as StoragePreflightInput | null
    if (request === null) return null
    const ticket = session.current.begin(key)
    setSnapshot(null)
    setAccepted(null)
    setError(null)
    setChecking(true)
    try {
      /*
       * 界面已经扫过源就把总字节数带过去，主进程不必再整盘扫一遍。
       * 这一步只是「要占多少空间」的判定，不需要重新遍历文件树。
       */
      const answer = await window.securereel.jobs.preflight(
        requiredBytes === null || requiredBytes === undefined
          ? request
          : { ...request, requiredBytes }
      )
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
