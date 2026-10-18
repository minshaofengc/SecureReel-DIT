import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { usageForTargets } from '../src/main/core/source-scan'
import { obviousSourceTargetOverlap, targetPreflightState, targetPreflightStatusList } from '../src/shared/target-preflight'
import type { DriveUsage } from '../src/shared/types'

const known = (path: string, remaining: number, required: number): DriveUsage => ({
  path, label: 'Test volume', totalBytes: 1000, freeBytes: remaining,
  requiredBytes: required, sufficient: remaining >= required, measured: true
})
const base = {
  sourceScanned: true,
  checking: false,
  lookupFailed: false,
  verifyOnly: false
}

describe('target preflight: never promote unmeasured devices to ready', () => {
  it('differentiates not scanned, checking, failed, unknown and ready', () => {
    const usage = [known('/A', 600, 200)]
    expect(targetPreflightState({ ...base, path: '/A', usage, sourceScanned: false })).toBe('not_checked')
    expect(targetPreflightState({ ...base, path: '/A', usage, checking: true })).toBe('checking')
    expect(targetPreflightState({ ...base, path: '/A', usage, lookupFailed: true })).toBe('failed')
    expect(targetPreflightState({ ...base, path: '/B', usage })).toBe('unknown')
    expect(targetPreflightState({ ...base, path: '/B', usage: [{ ...known('/B', 0, 200), measured: false, missing: true }] })).toBe('missing')
    expect(targetPreflightState({ ...base, path: '/A', usage })).toBe('ready')
  })
  it('keeps A ready when B has a capacity problem', () => {
    const usage = [known('/A', 900, 300), known('/B', 200, 300)]
    expect(targetPreflightStatusList(['/A', '/B'], { ...base, usage }))
      .toEqual(['ready', 'insufficient'])
  })
  it('never treats an omitted B response as success', () => {
    expect(targetPreflightStatusList(['/A', '/B'], {
      ...base, usage: [known('/A', 500, 100)]
    })).toEqual(['ready', 'unknown'])
  })
  it('verify-only accepts a measured volume without calling that file verification', () => {
    expect(targetPreflightState({
      ...base, path: '/A', usage: [known('/A', 0, 100)], verifyOnly: true
    })).toBe('ready')
    expect(targetPreflightState({
      ...base, path: '/B', usage: [], verifyOnly: true
    })).toBe('unknown')
  })
  it('checks every selected destination by its exact path, never by index', () => {
    const records = [known('/A', 500, 100), known('/B', 0, 100)]
    expect(targetPreflightStatusList(['/A', '/C'], { ...base, usage: records }))
      .toEqual(['ready', 'unknown'])
  })
  it('does not interpret an unmeasured zero as a measured insufficient capacity', () => {
    const noEvidence = { ...known('/A', 0, 100), measured: false, sufficient: null }
    expect(targetPreflightState({ ...base, path: '/A', usage: [noEvidence] })).toBe('unknown')
  })
})

describe('statfs preflight adapter measures or marks unknown, never invents 0 free space', () => {
  let basePath: string
  beforeAll(async () => {
    basePath = await mkdtemp(join(tmpdir(), 'dit03-measured-'))
    await mkdir(join(basePath, 'present'))
  })
  afterAll(async () => {
    await rm(basePath, { recursive: true, force: true })
  })
  it('marks an actual directory as measured and missing directory as unmeasured', async () => {
    const usage = await usageForTargets(
      [{ path: join(basePath, 'present') }, { path: join(basePath, 'missing') }],
      100
    )
    expect(usage).toHaveLength(2)
    expect(usage[0]?.measured).toBe(true)
    expect(usage[0]?.sufficient).toBe(true)
    expect(usage[1]?.measured).toBe(false)
    expect(usage[1]?.missing).toBe(true)
    expect(usage[1]?.sufficient).toBe(false) // preserve engine capacity guard; measured=false prevents UI from claiming a known value
    expect(usage[1]?.freeBytes).toBe(0) // transport fallback; NEVER display as a measured 0 B
  })
})


describe('UI preflight prevents obviously overlapping source and target before IPC submit', () => {
  it('blocks identical paths, nested source/target and Windows case variations', () => {
    expect(obviousSourceTargetOverlap('/source/P01', '/source/P01', false)).toBe(true)
    expect(obviousSourceTargetOverlap('/source/P01', '/source', false)).toBe(true)
    expect(obviousSourceTargetOverlap('/source', '/source/P01/backup', false)).toBe(true)
    expect(obviousSourceTargetOverlap('E:\\CARD\\P01', 'e:\\card\\p01\\BACKUP', true)).toBe(true)
  })
  it('does not claim two unrelated paths have overlapping directories', () => {
    expect(obviousSourceTargetOverlap('/card/01', '/card/011', false)).toBe(false)
    expect(obviousSourceTargetOverlap('/CARD/01', '/card/01', false)).toBe(false)
    expect(obviousSourceTargetOverlap('/SOURCE', '/OTHER', false)).toBe(false)
  })
})
