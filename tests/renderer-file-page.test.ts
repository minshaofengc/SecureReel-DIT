import { describe, expect, it } from 'vitest'
import type { CopyJobFile } from '../src/shared/types'
import { updateVisibleFilePage } from '../src/renderer/src/state/file-page'

const file = (relPath: string, state: CopyJobFile['state']): CopyJobFile => ({
  id: 1,
  jobId: 'job',
  relPath,
  state,
  sizeBytes: 10,
  bytesCopied: 0,
  sourceHash: null,
  results: [],
  probe: null,
  error: null
})

describe('monitor file page streamed updates', () => {
  it('does not append another page or filtered-out material', () => {
    const rows = [file('visible.mov', 'copying')]
    expect(updateVisibleFilePage(rows, file('outside.mov', 'verified'))).toBe(rows)
    expect(rows).toHaveLength(1)
  })
  it('keeps a verified row when an intermediate event arrives late', () => {
    const rows = [file('visible.mov', 'verified')]
    expect(updateVisibleFilePage(rows, file('visible.mov', 'copying'))).toBe(rows)
  })
  it('updates proxy/probe results on an already verified file without touching other rows', () => {
    const rows = [file('visible.mov', 'verified'), file('other.mov', 'verified')]
    const incoming = { ...rows[0]!, sourceHash: 'updated' }
    const next = updateVisibleFilePage(rows, incoming)
    expect(next[0]).toBe(incoming)
    expect(next[1]).toBe(rows[1])
    expect(rows[0]?.sourceHash).toBeNull()
  })
})
