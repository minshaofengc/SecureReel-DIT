/**
 * 版本比较与「7 天提醒一次」的节流判定。
 *
 * 这里刻意只放**纯函数**：不碰网络、不碰磁盘、不 import electron。
 * 更新检查的难点不在发请求，而在"什么时候该说、说几次"——
 * 那部分必须能被单测直接钉住，否则只能靠改系统时间手工试。
 */

/** 自动检查的间隔：7 天。 */
export const UPDATE_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

/** 同一个新版本的提醒间隔：7 天。 */
export const UPDATE_NOTIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 自动检查失败后的冷却时间。
 *
 * 与「检查成功」分开：成功才记 7 天，失败只记 1 天 ——
 * 用户可能只是那一次没联网（现场经常如此），不该因此整周不再检查；
 * 但也不能每次启动都卡一次超时，所以给一天冷却。
 */
export const UPDATE_RETRY_AFTER_FAILURE_MS = 24 * 60 * 60 * 1000

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
}

/**
 * 解析版本号。
 *
 * 接受 `2.0.10` / `v2.0.10` / `2.0.10-beta.1` / `2.0`。
 * 只取前三段数字：预发布后缀不参与比较 ——
 * 本项目的发布 tag 一律是 `vX.Y.Z`，没有 beta 通道。
 */
export function parseVersion(raw: string): ParsedVersion | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().replace(/^[vV]/, '')
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(trimmed)
  if (match === null) return null
  const major = Number(match[1])
  const minor = Number(match[2] ?? '0')
  const patch = Number(match[3] ?? '0')
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null
  return { major, minor, patch }
}

/**
 * 比较两个版本号。
 *
 * 返回值：`a > b` 为正，`a < b` 为负，相等为 0。
 * **任何一边解析不出来都返回 0** —— 拿不到可靠版本时宁可"不提示更新"，
 * 也不能因为解析失败就把一条坏数据当成新版本推给用户。
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return 0
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  return left.patch - right.patch
}

/** `candidate` 是否比 `current` 新。解析失败一律 false。 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const left = parseVersion(candidate)
  const right = parseVersion(current)
  if (left === null || right === null) return false
  return compareVersions(candidate, current) > 0
}

/** 距上次自动检查是否已经够 7 天（失败过则按 1 天冷却）。 */
export function shouldAutoCheck(input: {
  lastCheckAt: number | null
  lastFailureAt: number | null
  now: number
}): boolean {
  const { lastCheckAt, lastFailureAt, now } = input
  if (lastFailureAt !== null && now - lastFailureAt < UPDATE_RETRY_AFTER_FAILURE_MS) {
    return false
  }
  if (lastCheckAt === null) return true
  return now - lastCheckAt >= UPDATE_CHECK_INTERVAL_MS
}

/**
 * 这个新版本现在该不该提醒。
 *
 * 规则：
 *   · 没有新版本 → 不提醒
 *   · 从没提醒过这个版本 → 提醒
 *   · 提醒过同一个版本、且不满 7 天 → 不提醒
 *   · 提醒过同一个版本、已满 7 天 → 再提醒一次
 *   · 换了更新的版本 → 立刻提醒（不受上一个版本的计时影响）
 */
export function shouldNotifyVersion(input: {
  latestVersion: string | null
  currentVersion: string
  lastNotifiedVersion: string | null
  lastNotifiedAt: number | null
  now: number
}): boolean {
  const { latestVersion, currentVersion, lastNotifiedVersion, lastNotifiedAt, now } = input
  if (latestVersion === null) return false
  if (!isNewerVersion(latestVersion, currentVersion)) return false
  if (lastNotifiedVersion === null || lastNotifiedVersion !== latestVersion) return true
  if (lastNotifiedAt === null) return true
  return now - lastNotifiedAt >= UPDATE_NOTIFY_INTERVAL_MS
}

/**
 * 一次更新检查的结果。
 *
 * 刻意把「事实」与「该不该弹」分开：`hasUpdate` 是客观结论，
 * `shouldNotify` 是节流后的展示决定。界面只认后者，
 * 设置页里手动检查时则可以直接看前者。
 */
export interface UpdateCheckResult {
  currentVersion: string
  /** 远端最新版本；检查失败或数据不可信时为 null */
  latestVersion: string | null
  hasUpdate: boolean
  /** 发布页（GitHub Release）地址 */
  releaseUrl: string | null
  /** 发布时间（ISO 字符串，远端没给就是 null） */
  publishedAt: string | null
  /** 本次结果是什么时候拿到的（ISO） */
  checkedAt: string
  /** 数据来源：官网清单 / GitHub API / 本地缓存 */
  source: 'site' | 'github' | 'cache' | null
  /** 检查失败的原因（面向用户）；成功为 null */
  error: string | null
  /** 是否应当提示用户（已过 7 天节流） */
  shouldNotify: boolean
}
