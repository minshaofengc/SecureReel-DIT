import { describe, expect, it } from 'vitest'
import { runCommand } from '../src/main/exec'
import { PauseGate, Semaphore } from '../src/main/core/concurrency'

describe('command cancellation and bounded streaming', () => {
  it('never starts an already cancelled command', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("started")'], {
      signal: controller.signal
    })
    expect(result.stdout).toBe('')
    expect(result.code).toBeNull()
  })
  it('streams complete output lines while retaining bounded output', async () => {
    const lines: string[] = []
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write("progress=1\\nprogress=2\\ntail")'],
      {
        maxStdoutBytes: 4,
        onStdoutLine: (line) => lines.push(line)
      }
    )
    expect(lines).toEqual(['progress=1', 'progress=2', 'tail'])
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4)
  })
  it('settles when cancelled during execution', async () => {
    const controller = new AbortController()
    const result = runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      signal: controller.signal
    })
    controller.abort()
    expect((await result).code).toBeNull()
  })
})

describe('cancellable scheduling', () => {
  it('notifies pause subscribers once per transition and unsubscribes', () => {
    const gate = new PauseGate()
    let paused = 0
    const unsubscribe = gate.onPause(() => paused++)
    gate.pause()
    gate.pause()
    expect(paused).toBe(1)
    gate.resume()
    unsubscribe()
    gate.pause()
    expect(paused).toBe(1)
  })
  it('rejects a cancelled waiter without consuming the next permit', async () => {
    const semaphore = new Semaphore(1)
    await semaphore.acquire()
    const controller = new AbortController()
    const cancelled = semaphore.acquire(controller.signal)
    const rejected = expect(cancelled).rejects.toThrow('取消')
    controller.abort()
    await rejected
    semaphore.release()
    expect(await semaphore.run(async () => 'next')).toBe('next')
  })
  it('does not call queued work that has been cancelled', async () => {
    const semaphore = new Semaphore(1)
    const controller = new AbortController()
    controller.abort()
    let ran = false
    await expect(
      semaphore.run(async () => {
        ran = true
      }, controller.signal)
    ).rejects.toThrow('取消')
    expect(ran).toBe(false)
    expect(await semaphore.run(async () => 'free')).toBe('free')
  })
})

describe('UTF-8 output boundaries', () => {
  it('keeps byte caps even when the boundary falls inside a multibyte character', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write("中中");process.stderr.write("中中")'],
      {
        maxStdoutBytes: 4,
        maxStderrBytes: 4
      }
    )
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4)
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(4)
    expect(result.stdout).toBe('中')
  })
})
