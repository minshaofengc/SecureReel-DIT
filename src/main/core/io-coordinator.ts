import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { physicalVolumeProbe, physicalDisksFromPlist } from '@main/platform'
import { runCommand } from '@main/exec'

const physicalCache = new Map<number, { at: number; key: string }>()

export type IoPriority = 'copy' | 'verify' | 'probe' | 'proxy'
const PRIORITY: Record<IoPriority, number> = { copy: 0, verify: 1, probe: 2, proxy: 3 }

/** Resolve prospective output paths without creating anything on their volume. */
export async function volumeKey(path: string): Promise<string> {
  let current = resolve(path)
  while (true) {
    try {
      const device = (await stat(current)).dev
      const cached = physicalCache.get(device)
      if (cached && performance.now() - cached.at < 30000) return cached.key
      const probe = physicalVolumeProbe(current)
      let key = `dev:${device}`
      if (probe) {
        const result = await runCommand(probe.executable, probe.args, {
          timeoutMs: 3000,
          ...(probe.env ? { env: { ...process.env, ...probe.env } } : {})
        })
        if (result.code === 0 && !result.timedOut && result.spawnError === null) {
          if (probe.kind === 'windows') {
            const disk = result.stdout.trim()
            if (/^\d+$/.test(disk)) key = `physical:win:${disk}`
          } else {
            const disk = result.stdout.match(/(?:^|\n)(\/dev\/disk\d+(?:s\d+)*)\s/)?.[1]
            if (disk) {
              const info = await runCommand('/usr/sbin/diskutil', ['info', '-plist', disk], {
                timeoutMs: 3000
              })
              if (info.code === 0 && !info.timedOut) {
                const disks = physicalDisksFromPlist(info.stdout)
                if (disks.length) key = disks.map((d) => `physical:mac:${d}`).join('|')
              }
            }
          }
        }
      }
      physicalCache.set(device, { at: performance.now(), key })
      return key
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

interface Request {
  keys: string[]
  priority: IoPriority
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort: () => void
  onPreempt?: () => void
  preempted: boolean
}

/**
 * Process-wide, atomic multi-volume leases. Acquiring all keys together avoids
 * source/target lock inversions; unrelated volumes can continue independently.
 * Leases are non-preemptive: use chunk-sized copy leases, and abort/requeue an
 * encoder when its job pauses. Waiting copy work always wins the next slot.
 */
export class IoCoordinator {
  private readonly active = new Map<string, number>()
  private readonly queue: Request[] = []
  private readonly holders = new Set<Request>()
  private readonly activity = new Map<string, Map<IoPriority, number>>()
  private readonly limit: number

  constructor(limitPerVolume = 1) {
    this.limit = Math.max(1, Math.floor(limitPerVolume) || 1)
  }

  acquire(
    keys: readonly string[],
    priority: IoPriority,
    signal?: AbortSignal,
    onPreempt?: () => void
  ): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('任务已取消'))
    return new Promise((resolveLease, reject) => {
      const request: Request = {
        keys: [...new Set(keys.flatMap((key) => key.split('|')))].sort(),
        priority,
        signal,
        onPreempt,
        preempted: false,
        resolve: resolveLease,
        reject,
        onAbort: () => {
          const index = this.queue.indexOf(request)
          if (index === -1) return
          this.queue.splice(index, 1)
          signal?.removeEventListener('abort', request.onAbort)
          reject(new Error('任务已取消'))
          this.drain()
        }
      }
      this.queue.push(request)
      this.recordActivity(request)
      signal?.addEventListener('abort', request.onAbort, { once: true })
      for (const holder of [...this.holders]) {
        if (
          !holder.preempted &&
          holder.onPreempt &&
          PRIORITY[priority] < PRIORITY[holder.priority] &&
          request.keys.some((key) => holder.keys.includes(key))
        ) {
          holder.preempted = true
          holder.onPreempt()
        }
      }
      this.drain()
    })
  }

  async run<T>(
    keys: readonly string[],
    priority: IoPriority,
    fn: () => Promise<T>,
    signal?: AbortSignal,
    onPreempt?: () => void
  ): Promise<T> {
    const release = await this.acquire(keys, priority, signal, onPreempt)
    try {
      if (signal?.aborted) throw new Error('任务已取消')
      return await fn()
    } finally {
      release()
    }
  }

  private recordActivity(request: Request): void {
    for (const key of request.keys) {
      const entries = this.activity.get(key) ?? new Map<IoPriority, number>()
      entries.set(request.priority, performance.now())
      this.activity.set(key, entries)
    }
  }

  /** Avoid restarting expensive encoders between every copy chunk. */
  async waitForIdle(
    keys: readonly string[],
    priority: IoPriority,
    quietMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    const normalized = new Set(keys.flatMap((key) => key.split('|')))
    for (;;) {
      if (signal?.aborted) throw new Error('任务已取消')
      const busy = [...this.holders, ...this.queue].some(
        (request) =>
          PRIORITY[request.priority] < PRIORITY[priority] &&
          request.keys.some((key) => normalized.has(key))
      )
      let last = 0
      for (const key of normalized)
        for (const [other, at] of this.activity.get(key) ?? []) {
          if (PRIORITY[other] < PRIORITY[priority]) last = Math.max(last, at)
        }
      if (!busy && performance.now() - last >= quietMs) return
      await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          signal?.removeEventListener('abort', abort)
          resolve()
        }
        const timer = setTimeout(finish, Math.max(1, Math.min(50, quietMs)))
        const abort = (): void => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          reject(new Error('任务已取消'))
        }
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    }
  }

  private drain(): void {
    // Stable sorting preserves FIFO among requests of equal priority.
    this.queue.sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority])
    for (let index = 0; index < this.queue.length;) {
      const request = this.queue[index] as Request
      const reserved = this.queue
        .slice(0, index)
        .some(
          (waiting) =>
            PRIORITY[waiting.priority] < PRIORITY[request.priority] &&
            waiting.keys.some((key) => request.keys.includes(key))
        )
      if (reserved || request.keys.some((key) => (this.active.get(key) ?? 0) >= this.limit)) {
        index++
        continue
      }
      this.queue.splice(index, 1)
      request.signal?.removeEventListener('abort', request.onAbort)
      this.holders.add(request)
      for (const key of request.keys) this.active.set(key, (this.active.get(key) ?? 0) + 1)
      let released = false
      request.resolve(() => {
        if (released) return
        released = true
        this.recordActivity(request)
        this.holders.delete(request)
        for (const key of request.keys) {
          const remaining = (this.active.get(key) ?? 1) - 1
          if (remaining === 0) this.active.delete(key)
          else this.active.set(key, remaining)
        }
        this.drain()
      })
    }
  }
}

/** Shared across jobs; never create one coordinator per job. */
export const ioCoordinator = new IoCoordinator()
