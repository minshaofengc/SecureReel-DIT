
import { describe, expect, it } from 'vitest'
import type { TargetProgress } from '../src/shared/types'
import { destinationOutcome, classifyJobIssue } from '../src/shared/target-verification'

const make = (patch: Partial<TargetProgress> = {}): TargetProgress => ({
  targetId: 'A',
  label: 'Backup A',
  state: 'completed',
  filesDone: 3,
  filesFailed: 0,
  bytesCopied: 3,
  bytesPerSecond: 0,
  error: null,
  ...patch
})

describe('destination outcome is not an engine phase indicator', () => {
  it('shows a target as verified only with all file results confirmed', () => {
    expect(destinationOutcome(3, make())).toBe('verified')
    expect(destinationOutcome(3, make({ filesDone: 2 }))).toBe('unavailable')
    expect(destinationOutcome(0, make({ filesDone: 0 }))).toBe('unavailable')
  })
  it('shows failures even when the target terminal state says completed', () => {
    expect(destinationOutcome(3, make({ filesFailed: 1 }))).toBe('failed')
    expect(destinationOutcome(3, make({ error: 'I/O failure' }))).toBe('failed')
    expect(destinationOutcome(3, make({ state: 'failed' }))).toBe('failed')
  })
  it('does not promote target A success into target B success', () => {
    expect(destinationOutcome(3, make({ targetId: 'A' }))).toBe('verified')
    expect(destinationOutcome(3, make({ targetId: 'B', filesDone: 1, filesFailed: 2 }))).toBe('failed')
  })
  it('keeps pending, running, disabled, and missing evidence distinct', () => {
    expect(destinationOutcome(3, make({ state: 'pending' }))).toBe('pending')
    expect(destinationOutcome(3, make({ state: 'running' }))).toBe('running')
    expect(destinationOutcome(3, make({ state: 'disabled' }))).toBe('disabled')
    expect(destinationOutcome(3, undefined)).toBe('unavailable')
  })
})


describe('job failures retain their actual cause, not a synthetic file error', () => {
  it('routes media failures to file result inspection', () => {
    expect(classifyJobIssue('completed-with-errors', 2, 0)).toBe('media')
    expect(classifyJobIssue('failed', 1, 5)).toBe('media')
  })
  it('routes proxy-only failures to proxy controls', () => {
    expect(classifyJobIssue('completed-with-errors', 0, 2)).toBe('proxy')
  })
  it('avoids claiming an unclassified failure is a media hash failure', () => {
    expect(classifyJobIssue('completed-with-errors', 0, null)).toBe('other')
    expect(classifyJobIssue('failed', 0, 0)).toBe('other')
  })
  it('does not create a failure with no failing state', () => {
    expect(classifyJobIssue('completed', 0, 0)).toBe(null)
    expect(classifyJobIssue('running', 0, null)).toBe(null)
  })
})
