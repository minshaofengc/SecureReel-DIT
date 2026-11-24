/**
 * 匿名使用统计的纯逻辑。
 *
 * 这个文件刻意不 import electron、不碰磁盘、不发请求：
 * 日切分、时钟钳制、退避、批量选取这些最容易出错的地方全部在这里，
 * 用 vitest 直接测。真正读写的部分在 `src/main/usage/`。
 *
 * ## 为什么按"天"聚合、存绝对值
 *
 * 上报的是「这一天的累计秒数」，不是「这次增加了多少秒」。
 * 服务端用 MAX() 合并，于是重试、重复投递、离线补传全都天然幂等，
 * 不需要去重表、序号或事务补偿。
 *
 * ## 为什么心跳要钳上限
 *
 * 笔记本合盖、系统休眠、用户改系统时间，都会让 `now - lastTick` 变成一个
 * 荒谬的大数。不钳的话，一次休眠就能把「在线时长」刷到几十小时。
 */

/** 心跳间隔：30 秒。比它更细对"秒级时长"没有意义，只会多写库。 */
export const HEARTBEAT_MS = 30_000
/** 落库间隔：60 秒。内存里累加，两跳写一次。 */
export const PERSIST_MS = 60_000
/** 超过这个空闲秒数就算"人不在"，只记进程存活，不记前台活跃。 */
export const IDLE_THRESHOLD_SECONDS = 60
/** 单次 tick 最多认多少秒：三倍心跳，超出部分视为休眠/改表。 */
export const MAX_TICK_SECONDS = (HEARTBEAT_MS / 1000) * 3
/** 一批最多带多少天。 */
export const MAX_BATCH_DAYS = 30
/** 一天最多 86400 秒，服务端也按这个上限校验。 */
export const MAX_DAY_SECONDS = 86_400

/**
 * 关闭开关的取值判定。
 *
 * 只在环境变量 / 启动参数里用；界面上不出现，隐私说明里写明。
 */
export function isDisabledFlag(raw: string | undefined | null): boolean {
  if (raw === undefined || raw === null) return false
  const value = raw.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

export interface UsageDayRow {
  day: string
  activeSeconds: number
  aliveSeconds: number
  launches: number
  dirty: boolean
  attempts: number
  nextAttemptAt: number
}

export interface UsageDayPayload {
  day: string
  activeSeconds: number
  aliveSeconds: number
  launches: number
}

export interface UsagePayload {
  v: 1
  installId: string
  appVersion: string
  platform: string
  arch: string
  days: UsageDayPayload[]
}

export interface TickState {
  focused: boolean
  idleSeconds: number
  locked: boolean
}

const DAY_MS = 86_400_000
const INSTALL_ID_PATTERN = /^inst_[0-9a-f]{32}$/

/**
 * 本地日（YYYY-MM-DD）。
 *
 * `timezoneOffsetMinutes` 用 JS 的 `getTimezoneOffset()` 口径：
 * UTC+8 传 **-480**（不是 480）。
 */
export function dayKeyOf(ms: number, timezoneOffsetMinutes: number): string {
  return new Date(ms - timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

/** 下一个本地零点对应的 UTC 毫秒。 */
export function nextLocalMidnight(ms: number, timezoneOffsetMinutes: number): number {
  const local = ms - timezoneOffsetMinutes * 60_000
  const nextLocal = (Math.floor(local / DAY_MS) + 1) * DAY_MS
  return nextLocal + timezoneOffsetMinutes * 60_000
}

/**
 * 把一段时间按本地日切开。
 *
 * 跨零点的那一跳（例如 23:59:50 → 00:00:20）会被拆成两行，
 * 否则"某一天用了多久"会在跨天时整段算到前一天。
 * 循环上限 8 次：正常 tick 最多跨 2 天，留足余量防止时钟异常死循环。
 */
export function splitIntervalAcrossDays(
  fromMs: number,
  toMs: number,
  timezoneOffsetMinutes: number
): { day: string; seconds: number }[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return []
  const result: { day: string; seconds: number }[] = []
  let cursor = fromMs
  let guard = 0
  while (cursor < toMs && guard < 8) {
    const day = dayKeyOf(cursor, timezoneOffsetMinutes)
    const boundary = Math.min(toMs, nextLocalMidnight(cursor, timezoneOffsetMinutes))
    const seconds = Math.round((boundary - cursor) / 1000)
    if (seconds > 0) {
      const existing = result.find((item) => item.day === day)
      if (existing) existing.seconds += seconds
      else result.push({ day, seconds })
    }
    cursor = boundary
    guard += 1
  }
  return result
}

/** 这一次 tick 算"真的在用"还是"只是开着"。 */
export function classifyTick(state: TickState): 'active' | 'alive' {
  if (state.locked) return 'alive'
  if (!state.focused) return 'alive'
  return state.idleSeconds < IDLE_THRESHOLD_SECONDS ? 'active' : 'alive'
}

/** 把 `now - lastTick` 钳进 [0, MAX_TICK_SECONDS]。 */
export function clampTickSeconds(rawSeconds: number): number {
  if (!Number.isFinite(rawSeconds) || rawSeconds <= 0) return 0
  return Math.min(Math.round(rawSeconds), MAX_TICK_SECONDS)
}

/** 一天的上限是 86400；累加时也要钳，避免脏数据写进库。 */
export function clampDaySeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.min(Math.round(seconds), MAX_DAY_SECONDS)
}

export interface Accrual {
  activeSeconds: number
  aliveSeconds: number
  launches: number
}

/** 返回累加后的新行（不改原对象），便于单测直接断言。 */
export function accrue(row: UsageDayRow, delta: Accrual): UsageDayRow {
  const active = clampDaySeconds(row.activeSeconds + Math.max(0, delta.activeSeconds))
  const alive = clampDaySeconds(Math.max(row.aliveSeconds + Math.max(0, delta.aliveSeconds), active))
  return {
    ...row,
    activeSeconds: active,
    aliveSeconds: alive,
    launches: Math.max(0, row.launches + Math.max(0, delta.launches)),
    dirty: true,
    attempts: 0,
    nextAttemptAt: 0
  }
}

/**
 * 失败退避：1 分 → 5 分 → 30 分 → 2 小时 → 12 小时 → 24 小时（封顶）。
 *
 * 断网时不要每 6 小时才重试一次，也不要每分钟撞一次墙 —— 这条曲线
 * 让「机场断网两小时」在恢复后很快补上，「长期离线」也不会天天写日志。
 */
export function backoffMs(attempts: number): number {
  const table = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000, 86_400_000]
  if (!Number.isFinite(attempts) || attempts <= 0) return table[0] ?? 60_000
  const index = Math.min(Math.floor(attempts) - 1, table.length - 1)
  return table[index] ?? 86_400_000
}

/** 挑出这一轮该发的行：脏、到点、按日期升序。 */
export function selectBatch<T extends UsageDayRow>(rows: T[], nowMs: number, limit = MAX_BATCH_DAYS): T[] {
  return rows
    .filter((row) => row.dirty && row.nextAttemptAt <= nowMs)
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(0, limit)
}

export function isValidInstallId(value: unknown): value is string {
  return typeof value === 'string' && INSTALL_ID_PATTERN.test(value)
}

/** 发给服务端前再钳一遍：本地库被手改也发不出越界数据。 */
export function toPayloadDay(row: UsageDayRow): UsageDayPayload {
  const active = clampDaySeconds(row.activeSeconds)
  const alive = clampDaySeconds(Math.max(row.aliveSeconds, active))
  return {
    day: row.day,
    activeSeconds: active,
    aliveSeconds: alive,
    launches: Math.max(0, Math.min(Math.round(row.launches), 50))
  }
}

/** 生成安装 ID。用 crypto.randomUUID 去掉横线，32 位十六进制。 */
export function formatInstallId(randomHex32: string): string {
  return `inst_${randomHex32.toLowerCase()}`
}
