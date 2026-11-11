import { describe, expect, it } from 'vitest'
import { StorageEvidenceSession, confirmedStoragePreflight, storageEvidenceView } from '../src/renderer/src/state/storage-evidence'
import type { TargetPreflightResult } from '../src/shared/storage-safety'

const snapshot = (patch: Partial<TargetPreflightResult> = {}): TargetPreflightResult => ({
  fingerprint: 'devices-and-paths-a', checkedAt: '2026-10-18T00:00:00Z',
  source: { path: '/source', label: 'source', filesystemId: 'src', physicalDeviceIds: ['disk0'], capacityPoolId: null, availableBytes: 1000, present: true },
  targets: [], groups: [], risks: [], blockingReasons: [], requiredBytes: 10, independentDeviceGroups: null,
  ...patch
})

describe('desktop storage evidence lifecycle', () => {
  it('rejects source A after source B has already been checked', () => {
    const session = new StorageEvidenceSession()
    const sourceA = session.begin('sourceA')
    const sourceB = session.begin('sourceB')
    expect(session.isCurrent(sourceB, 'sourceB')).toBe(true)
    expect(session.isCurrent(sourceA, 'sourceB')).toBe(false)
  })
  it('rejects a late target A/B reply when the current target selection is A/C', () => {
    const session = new StorageEvidenceSession()
    const targetsAB = session.begin('source:A,B')
    expect(session.isCurrent(targetsAB, 'source:A,C')).toBe(false)
  })
  it('navigation and failed recheck invalidate prior in-flight evidence', () => {
    const session = new StorageEvidenceSession()
    const check = session.begin('same-paths')
    session.invalidate()
    expect(session.isCurrent(check, 'same-paths')).toBe(false)
    const recheck = session.begin('same-paths')
    expect(session.isCurrent(recheck, 'same-paths')).toBe(true)
    expect(session.isCurrent(check, 'same-paths')).toBe(false)
  })
  it('requires explicit risk acknowledgement bound to this exact fingerprint', () => {
    const risky = snapshot({ risks: [{ code: 'shared-device', paths: ['/a', '/b'] }] })
    expect(confirmedStoragePreflight(risky, null)).toBe(false)
    expect(confirmedStoragePreflight(risky, 'older-device')).toBe(false)
    expect(confirmedStoragePreflight(risky, risky.fingerprint)).toBe(true)
    expect(confirmedStoragePreflight({ ...risky, fingerprint: 'replaced-device' }, risky.fingerprint)).toBe(false)
  })
  it('never allows an acknowledgement to override a blocking reason', () => {
    const blocked = snapshot({ blockingReasons: ['Missing target'] })
    expect(confirmedStoragePreflight(blocked, blocked.fingerprint)).toBe(false)
    expect(confirmedStoragePreflight(null, null)).toBe(false)
    expect(confirmedStoragePreflight(snapshot(), null)).toBe(true)
  })
  /*
   * 2.0.8 曾在窗口失焦时作废整份证据，用户切一次访达回来就得重做扫描与确认，
   * 表现为"都做完了还是点不动"。证据只应该跟着**输入**失效。
   * 换盘的安全兜底在主进程（createJob / start 重算 fingerprint），不靠这里。
   */
  it('keeps a completed check valid across a focus round-trip when the input did not change', () => {
    const session = new StorageEvidenceSession()
    const check = session.begin('source:A|targets:B')
    expect(session.isCurrent(check, 'source:A|targets:B')).toBe(true)
    expect(session.isCurrent(check, 'source:A|targets:C')).toBe(false)
  })
})


describe('desktop safety evidence presentation', () => {
  it('shows missing historical topology as unknown rather than independent backups', () => {
    expect(storageEvidenceView(undefined, true).status).toBe('historical-unknown')
    expect(storageEvidenceView(null, false).status).toBe('not-checked')
  })
  it('keeps unknown independence and shared-pool shortages attached to all affected paths', () => {
    const result = snapshot({
      groups: [{ id: 'pool', paths: ['/a', '/b'], requiredBytes: 1600, availableBytes: 1000, sufficient: false }],
      risks: [{ code: 'shared-filesystem', paths: ['/a', '/b'] }],
      blockingReasons: ['Insufficient aggregate space']
    })
    const presentation = storageEvidenceView(result)
    expect(presentation.status).toBe('independence-unknown')
    expect(presentation.insufficientPaths).toEqual(['/a', '/b'])
    expect(presentation.riskAcknowledgementAvailable).toBe(false)
  })
  it('offers explicit acknowledgement only for nonblocking same-device risk', () => {
    const result = snapshot({ independentDeviceGroups: 1, risks: [{ code: 'shared-device', paths: ['/a', '/b'] }] })
    expect(storageEvidenceView(result).status).toBe('identified')
    expect(storageEvidenceView(result).riskAcknowledgementAvailable).toBe(true)
    expect(confirmedStoragePreflight(result, null)).toBe(false)
    expect(confirmedStoragePreflight(result, result.fingerprint)).toBe(true)
  })
})

it('keeps the risk-confirmation controls available for paused tasks and completed proxy retries', () => {
  expect(storageEvidenceView(snapshot(), false, 'paused').reviewAvailable).toBe(true)
  expect(storageEvidenceView(snapshot(), false, 'completed').reviewAvailable).toBe(true)
  expect(storageEvidenceView(snapshot(), false, 'completed-with-errors').reviewAvailable).toBe(true)
  expect(storageEvidenceView(snapshot(), false, 'running').reviewAvailable).toBe(false)
  expect(storageEvidenceView(snapshot(), false, 'queued').reviewAvailable).toBe(false)
  expect(storageEvidenceView(snapshot(), false, 'cancelled').reviewAvailable).toBe(false)
})
