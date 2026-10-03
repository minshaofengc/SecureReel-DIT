/**
 * 中间态合并缓冲。
 *
 * 这块逻辑如果只靠端到端拷贝来测是测不稳的：小文件几十毫秒就全部跑完，
 * 中间态还没来得及送出就被终态盖过去了。抽成独立的类之后，
 * "窗口内折叠"这个行为可以被精确地钉住。
 */
import { describe, expect, it, vi } from 'vitest'
import type { FileStateDelta } from '../src/shared/types'
import { FileDeltaBuffer } from '../src/main/core/file-delta-buffer'

describe('中间态合并缓冲', () => {
  it('同一文件的多次变更折叠成一条，取最后一次的字段', () => {
    const flushed: FileStateDelta[][] = []
    const buffer = new FileDeltaBuffer(50, (deltas) => flushed.push(deltas))

    buffer.record('a.mp4', { state: 'copying' })
    buffer.record('a.mp4', { state: 'verifying', bytesCopied: 4096 })

    expect(buffer.size).toBe(1)
    buffer.flush()

    expect(flushed).toEqual([[{ relPath: 'a.mp4', state: 'verifying', bytesCopied: 4096 }]])
  })

  it('不同文件各占一条，一次 flush 全部送出', () => {
    const flushed: FileStateDelta[][] = []
    const buffer = new FileDeltaBuffer(50, (deltas) => flushed.push(deltas))

    buffer.record('a.mp4', { state: 'copying' })
    buffer.record('b.mp4', { state: 'copying' })
    buffer.record('c.mp4', { state: 'copying' })
    buffer.flush()

    expect(flushed).toHaveLength(1)
    expect(flushed[0]?.map((item) => item.relPath).sort()).toEqual(['a.mp4', 'b.mp4', 'c.mp4'])
  })

  it('到点自动送出，不需要调用方干预', async () => {
    const flushed: FileStateDelta[][] = []
    const buffer = new FileDeltaBuffer(10, (deltas) => flushed.push(deltas))

    buffer.record('a.mp4', { state: 'copying' })
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(flushed).toHaveLength(1)
    expect(buffer.size).toBe(0)
  })

  it('空缓冲不触发回调 —— 省掉无谓的 IPC', () => {
    const onFlush = vi.fn()
    const buffer = new FileDeltaBuffer(50, onFlush)

    buffer.flush()

    expect(onFlush).not.toHaveBeenCalled()
  })

  it('flush 之后不会重复送出同一批', () => {
    const flushed: FileStateDelta[][] = []
    const buffer = new FileDeltaBuffer(50, (deltas) => flushed.push(deltas))

    buffer.record('a.mp4', { state: 'copying' })
    buffer.flush()
    buffer.flush()

    expect(flushed).toHaveLength(1)
  })

  it('clear 丢弃未送出的变更，之后也不会偷偷送出去', async () => {
    const flushed: FileStateDelta[][] = []
    const buffer = new FileDeltaBuffer(10, (deltas) => flushed.push(deltas))

    buffer.record('a.mp4', { state: 'copying' })
    buffer.clear()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(flushed).toHaveLength(0)
    expect(buffer.size).toBe(0)
  })
})
