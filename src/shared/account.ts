/**
 * 账号与设置同步的共享定义。
 *
 * 这里刻意只放**纯逻辑与类型**：邮箱归一化、同步白名单、逐键合并。
 * 主进程负责网络与磁盘，渲染层只负责显示 —— 两边都从这里取口径。
 */
import type { AppSettings } from './types'

/** 顶栏与账号面板需要的状态。 */
export interface AccountStatus {
  loggedIn: boolean
  /** 本机保存的邮箱；未登录为 null。服务端只存哈希，不存明文 */
  email: string | null
  /** 上次成功同步时间（ISO）；从未为 null */
  lastSyncAt: string | null
  /** 上次同步失败原因；没有为 null */
  syncError: string | null
  syncing: boolean
}

export type AccountErrorCode =
  | 'invalid_email'
  | 'rate_limited'
  | 'invalid_code'
  | 'code_expired'
  | 'unauthorized'
  | 'network'
  | 'server'

export interface AccountResult<T> {
  ok: boolean
  data?: T
  error?: AccountErrorCode
}

/**
 * 参与云同步的设置键。
 *
 * 判断标准只有一条：**换一台机器是否仍然成立**。
 * 所有绝对路径（ffmpeg、LUT、报告目录、HDE 路径）都是本机的，同步过去只会报错；
 * `usageStatsEnabled` 是隐藏开关，也不该被云同步传播。
 */
export const SYNCABLE_SETTING_KEYS = [
  'language',
  'themeId',
  'themeMode',
  'reportTheme',
  'hashAlgorithm',
  'manifestFormat',
  'autoCheckUpdates',
  'maxParallelTargets',
  'performanceMode',
  'resumePartialFiles',
  'ejectAfterCopy',
  'acceptHdeDowngrade',
  'extractFrames',
  'maxFrameExtractions',
  'frameConcurrency',
  'frameRestoreMode',
  'frameRestoreFallback',
  'soundEnabled',
  'soundVolume',
  'generateReport',
  'shutdownAfterCopy',
  'proxyEnabled',
  'proxyProfile',
  'proxyResolution',
  'proxyCodec',
  'proxyConcurrency',
  'stillFrameCount'
] as const satisfies readonly (keyof AppSettings)[]

export type SyncableSettingKey = (typeof SYNCABLE_SETTING_KEYS)[number]

const SYNCABLE = new Set<string>(SYNCABLE_SETTING_KEYS)

export function isSyncableKey(key: string): key is SyncableSettingKey {
  return SYNCABLE.has(key)
}

/** 邮箱归一化：去空白、转小写。哈希与比较都用这个结果。 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * 邮箱格式校验。
 *
 * 只拦明显不是邮箱的输入，不追求 RFC 完整性 —— 真正的验证靠收到验证码。
 */
export function isValidEmail(raw: string): boolean {
  const email = normalizeEmail(raw)
  if (email.length < 5 || email.length > 254) return false
  if (/\s/.test(email)) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
}

export interface CloudSettingEntry {
  value: unknown
  updatedAt: number
}

export type CloudSettings = Record<string, CloudSettingEntry>

export interface MergeResult {
  /** 云端更新、需要写到本机的键 */
  apply: Partial<AppSettings>
  /** 本机更新、需要推到云端的键 */
  push: Record<string, CloudSettingEntry>
}

/**
 * 逐键合并：谁的时间戳新听谁的。
 *
 * 按**字段**而不是整份比较，是为了避免"A 机改主题、B 机改语言"互相整份覆盖。
 * 时间戳相等时不动 —— 多半是同一次同步的两端。
 */
export function mergeSettings(
  local: AppSettings,
  localAt: Record<string, number>,
  cloud: CloudSettings
): MergeResult {
  const apply: Record<string, unknown> = {}
  const push: Record<string, CloudSettingEntry> = {}

  for (const key of SYNCABLE_SETTING_KEYS) {
    const cloudEntry = cloud[key]
    const localTime = localAt[key] ?? 0

    if (cloudEntry === undefined) {
      if (localTime > 0) push[key] = { value: local[key], updatedAt: localTime }
      continue
    }
    if (cloudEntry.updatedAt > localTime) {
      apply[key] = cloudEntry.value
      continue
    }
    if (localTime > cloudEntry.updatedAt) {
      push[key] = { value: local[key], updatedAt: localTime }
    }
  }

  return { apply: apply as Partial<AppSettings>, push }
}
