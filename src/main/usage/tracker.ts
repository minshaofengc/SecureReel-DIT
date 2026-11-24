/**
 * 心跳：判断"人在不在用"，把秒数累加到内存，定期落库。
 *
 * 三条纪律：
 *   1. 只读状态、不监听 blur/focus 做即时写库 —— 现场切窗口很频繁，
 *      事件风暴会跟拷贝抢 IO。
 *   2. 关掉开关后不累加；但 `lastTickAt` 照常推进，重新打开时不会补算关闭期间。
 *   3. 任何异常都不能往外抛 —— 统计坏了不能影响拷贝。
 */
import {
  clampTickSeconds,
  classifyTick,
  HEARTBEAT_MS,
  PERSIST_MS,
  splitIntervalAcrossDays
} from '@shared/usage'
import type { Logger } from '../logger'
import type { Store } from '../db/store'

export interface TrackerDeps {
  store: Store
  logger: Logger
  /** 只有"同意 + 设置开着"才为真。 */
  enabled: () => boolean
  installId: () => string
  isFocused: () => boolean
  getIdleSeconds: () => number
  now?: () => number
  /** JS `getTimezoneOffset()` 口径：UTC+8 是 -480。 */
  timezoneOffsetMinutes?: () => number
  heartbeatMs?: number
  persistMs?: number
}

interface PendingDay {
  active: number
  alive: number
  launches: number
}

export class UsageTracker {
  private lastTickAt: number | null = null
  private locked = false
  private pending = new Map<string, PendingDay>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastPersistAt = 0

  constructor(private readonly deps: TrackerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private tz(): number {
    return this.deps.timezoneOffsetMinutes
      ? this.deps.timezoneOffsetMinutes()
      : new Date().getTimezoneOffset()
  }

  private heartbeatMs(): number {
    return this.deps.heartbeatMs ?? HEARTBEAT_MS
  }

  start(): void {
    if (this.timer !== null) return
    this.lastTickAt = this.now()
    this.lastPersistAt = this.now()
    this.timer = setInterval(() => this.tick(), this.heartbeatMs())
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 锁屏 / 解锁：先把锁屏前那一小段记上，再切换状态。 */
  setLocked(value: boolean): void {
    if (value === this.locked) return
    this.tick()
    this.locked = value
  }

  /** 休眠唤醒后调用：不要把睡眠时长算成在线。 */
  resetClock(): void {
    this.lastTickAt = this.now()
  }

  /** 启动一次算一次；关闭统计时不记。 */
  noteLaunch(): void {
    if (!this.deps.enabled()) return
    const day = this.dayOf(this.now())
    const entry = this.pending.get(day) ?? { active: 0, alive: 0, launches: 0 }
    entry.launches += 1
    this.pending.set(day, entry)
  }

  private dayOf(ms: number): string {
    // 与 shared/usage 的 dayKeyOf 同一口径，这里只需要当天，省一次数组分配。
    return new Date(ms - this.tz() * 60_000).toISOString().slice(0, 10)
  }

  tick(): void {
    try {
      const now = this.now()
      const previous = this.lastTickAt
      this.lastTickAt = now
      if (previous === null) return

      const seconds = clampTickSeconds((now - previous) / 1000)
      if (seconds === 0) return
      if (!this.deps.enabled()) return

      const kind = classifyTick({
        focused: this.deps.isFocused(),
        idleSeconds: this.deps.getIdleSeconds(),
        locked: this.locked
      })

      const parts = splitIntervalAcrossDays(now - seconds * 1000, now, this.tz())
      for (const part of parts) {
        const entry = this.pending.get(part.day) ?? { active: 0, alive: 0, launches: 0 }
        entry.alive += part.seconds
        if (kind === 'active') entry.active += part.seconds
        this.pending.set(part.day, entry)
      }

      const persistMs = this.deps.persistMs ?? PERSIST_MS
      if (now - this.lastPersistAt >= persistMs) {
        this.lastPersistAt = now
        this.flush()
      }
    } catch (error) {
      // 统计永远不能把主流程带崩。
      this.deps.logger.warn('usage', `心跳计算失败（不影响拷贝）：${String(error)}`)
    }
  }

  /** 把内存里的增量写进库。失败只记日志。 */
  flush(): void {
    if (this.pending.size === 0) return
    const installId = this.deps.installId()
    const nowIso = new Date(this.now()).toISOString()
    const entries = [...this.pending.entries()]
    this.pending.clear()
    for (const [day, value] of entries) {
      if (value.active === 0 && value.alive === 0 && value.launches === 0) continue
      try {
        this.deps.store.accrueUsage({
          installId,
          day,
          activeSeconds: value.active,
          aliveSeconds: value.alive,
          launches: value.launches,
          nowIso
        })
      } catch (error) {
        this.deps.logger.warn('usage', `写入本地统计失败（不影响拷贝）：${String(error)}`)
      }
    }
  }

  /** 重置安装 ID 时调用：丢掉还没落库的那一段。 */
  discardPending(): void {
    this.pending.clear()
  }
}
