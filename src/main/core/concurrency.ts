/**
 * 并发原语：暂停闸门与信号量。
 *
 * 刻意只用最朴素的实现 —— 这些对象位于拷贝热路径上，
 * 引入第三方库反而更难推断行为。
 */

/**
 * 暂停闸门。
 *
 * 拷贝循环在每个分片边界调用 `waitIfPaused()`：暂停时它挂起，
 * 继续时立刻放行。因为检查点是在文件粒度落库的，暂停不会丢进度。
 */
export class PauseGate {
  private paused = false
  private waiters: (() => void)[] = []

  get isPaused(): boolean {
    return this.paused
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    const waiters = this.waiters
    this.waiters = []
    for (const release of waiters) release()
  }

  /** 暂停中则挂起；`signal` 中止时抛出，避免暂停状态下无法取消任务。 */
  async waitIfPaused(signal?: AbortSignal): Promise<void> {
    if (!this.paused) return
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.waiters = this.waiters.filter((waiter) => waiter !== onResume)
        signal?.removeEventListener('abort', onAbort)
      }
      const onResume = (): void => {
        cleanup()
        resolve()
      }
      const onAbort = (): void => {
        cleanup()
        reject(new Error('任务已取消'))
      }
      this.waiters.push(onResume)
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
}

/** 简单的并发上限信号量。 */
export class Semaphore {
  private available: number
  private readonly queue: (() => void)[] = []

  constructor(limit: number) {
    this.available = Math.max(1, limit)
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
  }

  release(): void {
    const next = this.queue.shift()
    if (next !== undefined) {
      next()
      return
    }
    this.available++
  }

  /** 在信号量保护下执行一段逻辑。 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

/**
 * 速率计。
 *
 * 用滑动窗口而不是"总字节 ÷ 总耗时"，否则中途暂停后速率会一直偏低，
 * 现场看着会以为盘要坏了。
 */
export class RateMeter {
  private readonly samples: { at: number; bytes: number }[] = []

  constructor(private readonly windowMs = 4000) {}

  add(bytes: number, at: number = Date.now()): void {
    this.samples.push({ at, bytes })
    this.trim(at)
  }

  /** 每秒字节数。 */
  rate(at: number = Date.now()): number {
    this.trim(at)
    if (this.samples.length === 0) return 0
    const first = this.samples[0] as { at: number; bytes: number }
    const span = Math.max(1, at - first.at)
    const total = this.samples.reduce((sum, sample) => sum + sample.bytes, 0)
    return (total / span) * 1000
  }

  reset(): void {
    this.samples.length = 0
  }

  private trim(at: number): void {
    const cutoff = at - this.windowMs
    while (this.samples.length > 0 && (this.samples[0] as { at: number }).at < cutoff) {
      this.samples.shift()
    }
  }
}
