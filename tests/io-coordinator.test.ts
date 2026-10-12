import { describe, expect, it } from 'vitest'
import { IoCoordinator, volumeKey } from '../src/main/core/io-coordinator'

describe('volume I/O leases', () => {
  it('resolves existing and prospective sibling paths to the actual device', async () => {
    const expected = await volumeKey(process.cwd())
    expect(expected).toMatch(/^(physical:|dev:)/)
    expect(await volumeKey(process.cwd())).toBe(expected)
    expect(await volumeKey(`${process.cwd()}/not-created/yet`)).toBe(expected)
  })
  it('prioritizes waiting copy work over proxy work', async () => {
    const scheduler = new IoCoordinator()
    const release = await scheduler.acquire(['disk'], 'proxy')
    const order: string[] = []
    const proxy = scheduler.run(['disk'], 'proxy', async () => {
      order.push('proxy')
    })
    const copy = scheduler.run(['disk'], 'copy', async () => {
      order.push('copy')
    })
    release()
    await Promise.all([proxy, copy])
    expect(order).toEqual(['copy', 'proxy'])
  })
  it('acquires multiple volumes atomically without blocking unrelated disks', async () => {
    const scheduler = new IoCoordinator()
    const release = await scheduler.acquire(['a'], 'copy')
    const controller = new AbortController()
    const waiting = scheduler.acquire(['b', 'a', 'a'], 'verify', controller.signal)
    const rejected = expect(waiting).rejects.toThrow('取消')
    expect(await scheduler.run(['b'], 'copy', async () => 'free')).toBe('free')
    controller.abort()
    await rejected
    release()
    expect(await scheduler.run(['a', 'b'], 'copy', async () => 'both')).toBe('both')
  })
  it('does not leak leases on cancellation or operation failure', async () => {
    const scheduler = new IoCoordinator()
    const controller = new AbortController()
    controller.abort()
    await expect(scheduler.acquire(['a'], 'copy', controller.signal)).rejects.toThrow('取消')
    await expect(
      scheduler.run(['a'], 'copy', async () => {
        throw new Error('disk')
      })
    ).rejects.toThrow('disk')
    expect(await scheduler.run(['a'], 'verify', async () => 'ok')).toBe('ok')
  })
})

describe('cooperative preemption', () => {
  it('notifies an active proxy before granting copy and retains its lease until cleanup', async () => {
    const scheduler = new IoCoordinator()
    let preempted = false
    const releaseProxy = await scheduler.acquire(['disk'], 'proxy', undefined, () => {
      preempted = true
    })
    let copyStarted = false
    const copy = scheduler.run(['disk'], 'copy', async () => {
      copyStarted = true
    })
    expect(preempted).toBe(true)
    await Promise.resolve()
    expect(copyStarted).toBe(false)
    const nextProxy = scheduler.run(['disk'], 'proxy', async () => {
      expect(copyStarted).toBe(true)
    })
    releaseProxy()
    await Promise.all([copy, nextProxy])
  })
})

it('does not let lower priority work occupy a volume reserved by a waiting copy', async () => {
  const scheduler = new IoCoordinator()
  const releaseA = await scheduler.acquire(['a'], 'verify')
  const order: string[] = []
  const copy = scheduler.run(['a', 'b'], 'copy', async () => {
    order.push('copy')
  })
  const proxy = scheduler.run(['b'], 'proxy', async () => {
    order.push('proxy')
  })
  await Promise.resolve()
  expect(order).toEqual([])
  releaseA()
  await Promise.all([copy, proxy])
  expect(order).toEqual(['copy', 'proxy'])
})

it('multi-disk resources overlap their individual physical devices', async () => {
  const scheduler = new IoCoordinator()
  const release = await scheduler.acquire(['disk:a|disk:b'], 'proxy')
  let called = false
  const copy = scheduler.run(['disk:b'], 'copy', async () => {
    called = true
  })
  await Promise.resolve()
  expect(called).toBe(false)
  release()
  await copy
  expect(called).toBe(true)
})

it('expensive lower-priority work waits until copy activity has settled', async () => {
  const scheduler = new IoCoordinator()
  const release = await scheduler.acquire(['disk'], 'copy')
  const controller = new AbortController()
  let finished = false
  const idle = scheduler.waitForIdle(['disk'], 'proxy', 20, controller.signal).then(() => {
    finished = true
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(finished).toBe(false)
  release()
  await idle
  expect(finished).toBe(true)
})
it('waiting for an idle disk can be cancelled immediately', async () => {
  const scheduler = new IoCoordinator()
  const release = await scheduler.acquire(['disk'], 'copy')
  const controller = new AbortController()
  const idle = scheduler.waitForIdle(['disk'], 'proxy', 250, controller.signal)
  const rejected = expect(idle).rejects.toThrow('取消')
  controller.abort()
  await rejected
  release()
})
