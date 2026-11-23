/**
 * 自动检查新版本。
 *
 * ## 为什么有两个数据源
 *
 * 主源是**官网的 `downloads.json`**（Cloudflare Pages），备源是 GitHub Releases API。
 * 国内网络下 api.github.com 经常连不上，而官网是自有域名、体积只有几 KB；
 * 反过来官网偶尔会因部署缓存返回旧版本，此时 GitHub 的 tag 更权威。
 * 两个都拿不到就如实返回错误，**绝不猜一个版本号**。
 *
 * ## 为什么走 `net.fetch` 而不是 Node 的 fetch
 *
 * `net.fetch` 走 Chromium 的网络栈，会读系统代理设置。现场用户的机器
 * 十有八九挂着代理才能访问 GitHub，用 Node 的原生 fetch 会绕过代理直接失败。
 *
 * ## 网络边界
 *
 * 这是本项目**唯一**主动发起的网络请求，且：
 *   · 只在用户开着「自动检查更新」时发生（可在设置里关掉）
 *   · 不带任何机器标识、任务信息、素材路径
 *   · 请求失败只写日志，绝不弹错误框打断拷贝
 */
import { net } from 'electron'
import { APP_VERSION } from '@shared/version'
import {
  isNewerVersion,
  shouldAutoCheck,
  shouldNotifyVersion,
  type UpdateCheckResult
} from '@shared/update'
import type { Store } from './db/store'
import type { Logger } from './logger'

/** `settings_kv` 里的键。集中在这里，避免读写两处拼错。 */
export const UPDATE_KV = {
  lastCheckAt: 'update.lastCheckAt',
  lastFailureAt: 'update.lastFailureAt',
  lastResult: 'update.lastResult',
  lastNotifiedVersion: 'update.lastNotifiedVersion',
  lastNotifiedAt: 'update.lastNotifiedAt'
} as const

const SITE_MANIFEST_URL = 'https://securereel.pages.dev/downloads.json'
const GITHUB_RELEASE_API = 'https://api.github.com/repos/minshaofengc/SecureReel-DIT/releases/latest'
const GITHUB_RELEASE_TAG_BASE = 'https://github.com/minshaofengc/SecureReel-DIT/releases/tag/v'
const REQUEST_TIMEOUT_MS = 8000

/** 允许打开的地址前缀。更新链接只可能来自这两处，别的一律拒绝。 */
const ALLOWED_RELEASE_PREFIXES = [
  'https://github.com/minshaofengc/SecureReel-DIT/',
  'https://securereel.pages.dev/'
]

interface RemoteRelease {
  version: string
  releaseUrl: string
  publishedAt: string | null
  source: 'site' | 'github'
}

function numberOrNull(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown | null> {
  try {
    const response = await net.fetch(url, {
      headers: headers ?? {},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!response.ok) return null
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

/** 官网清单：`{ version, releaseDate, packages: [...] }`。 */
async function readSiteManifest(): Promise<RemoteRelease | null> {
  const payload = await fetchJson(`${SITE_MANIFEST_URL}?t=${Date.now()}`)
  if (payload === null || typeof payload !== 'object') return null
  const record = payload as { version?: unknown; releaseDate?: unknown }
  if (typeof record.version !== 'string' || record.version.trim() === '') return null
  const version = record.version.trim()
  return {
    version,
    releaseUrl: `${GITHUB_RELEASE_TAG_BASE}${version}`,
    publishedAt: typeof record.releaseDate === 'string' ? record.releaseDate : null,
    source: 'site'
  }
}

/** GitHub API：`{ tag_name, html_url, published_at }`。 */
async function readGitHubRelease(): Promise<RemoteRelease | null> {
  const payload = await fetchJson(GITHUB_RELEASE_API, {
    Accept: 'application/vnd.github+json',
    'User-Agent': `SecureReel-DIT/${APP_VERSION}`
  })
  if (payload === null || typeof payload !== 'object') return null
  const record = payload as {
    tag_name?: unknown
    html_url?: unknown
    published_at?: unknown
  }
  if (typeof record.tag_name !== 'string') return null
  const version = record.tag_name.trim().replace(/^[vV]/, '')
  if (version === '') return null
  const url =
    typeof record.html_url === 'string' && record.html_url.startsWith('https://github.com/')
      ? record.html_url
      : `${GITHUB_RELEASE_TAG_BASE}${version}`
  return {
    version,
    releaseUrl: url,
    publishedAt: typeof record.published_at === 'string' ? record.published_at : null,
    source: 'github'
  }
}

function readCachedResult(store: Store): UpdateCheckResult | null {
  const raw = store.getKv(UPDATE_KV.lastResult)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<UpdateCheckResult> | null
    if (parsed === null || typeof parsed !== 'object') return null
    if (typeof parsed.checkedAt !== 'string') return null
    if (parsed.latestVersion !== null && typeof parsed.latestVersion !== 'string') return null
    return {
      currentVersion: typeof parsed.currentVersion === 'string' ? parsed.currentVersion : APP_VERSION,
      latestVersion: typeof parsed.latestVersion === 'string' ? parsed.latestVersion : null,
      hasUpdate: parsed.hasUpdate === true,
      releaseUrl: typeof parsed.releaseUrl === 'string' ? parsed.releaseUrl : null,
      publishedAt: typeof parsed.publishedAt === 'string' ? parsed.publishedAt : null,
      checkedAt: parsed.checkedAt,
      source: parsed.source === 'site' || parsed.source === 'github' ? parsed.source : null,
      error: typeof parsed.error === 'string' ? parsed.error : null,
      shouldNotify: false
    }
  } catch {
    return null
  }
}

/**
 * 计算"该不该提醒"，并在判定为"该提醒"时**立即记下提醒时间**。
 *
 * 为什么要在这里落盘而不是等界面确认：界面可能被立刻关掉、或者用户
 * 根本没看那一屏；如果等界面回调再记录，就会出现"每次启动都弹同一个版本"。
 * 宁可提前记（最坏是少提醒一次），也不要反复打扰。
 */
function decideNotify(store: Store, latestVersion: string | null, now: number): boolean {
  const notify = shouldNotifyVersion({
    latestVersion,
    currentVersion: APP_VERSION,
    lastNotifiedVersion: store.getKv(UPDATE_KV.lastNotifiedVersion),
    lastNotifiedAt: numberOrNull(store.getKv(UPDATE_KV.lastNotifiedAt)),
    now
  })
  if (notify && latestVersion !== null) {
    store.setKv(UPDATE_KV.lastNotifiedVersion, latestVersion)
    store.setKv(UPDATE_KV.lastNotifiedAt, String(now))
  }
  return notify
}

/**
 * 检查更新。
 *
 * `force=true` 是设置页的「立即检查」，不受 7 天节流限制；
 * `force=false` 是启动时的自动检查，会先看节流窗口。
 */
export async function checkForUpdates(options: {
  store: Store
  logger: Logger
  force: boolean
  now?: number
}): Promise<UpdateCheckResult> {
  const { store, logger, force } = options
  const now = options.now ?? Date.now()

  if (!force) {
    const lastCheckAt = numberOrNull(store.getKv(UPDATE_KV.lastCheckAt))
    const lastFailureAt = numberOrNull(store.getKv(UPDATE_KV.lastFailureAt))
    if (!shouldAutoCheck({ lastCheckAt, lastFailureAt, now })) {
      const cached = readCachedResult(store)
      if (cached !== null) {
        return { ...cached, source: 'cache', shouldNotify: decideNotify(store, cached.latestVersion, now) }
      }
      // 窗口内但没有缓存（例如上次成功写入后库被清理）—— 直接按"不检查"返回
      return {
        currentVersion: APP_VERSION,
        latestVersion: null,
        hasUpdate: false,
        releaseUrl: null,
        publishedAt: null,
        checkedAt: new Date(now).toISOString(),
        source: 'cache',
        error: null,
        shouldNotify: false
      }
    }
  }

  let remote = await readSiteManifest()
  if (remote === null) {
    logger.info('update', '官网清单不可用，改试 GitHub Releases API。')
    remote = await readGitHubRelease()
  }

  if (remote === null) {
    store.setKv(UPDATE_KV.lastFailureAt, String(now))
    logger.warn('update', '检查更新失败：官网清单与 GitHub API 均不可用（不影响拷贝）。')
    return {
      currentVersion: APP_VERSION,
      latestVersion: null,
      hasUpdate: false,
      releaseUrl: null,
      publishedAt: null,
      checkedAt: new Date(now).toISOString(),
      source: null,
      error: 'network',
      shouldNotify: false
    }
  }

  const hasUpdate = isNewerVersion(remote.version, APP_VERSION)
  const result: UpdateCheckResult = {
    currentVersion: APP_VERSION,
    latestVersion: remote.version,
    hasUpdate,
    releaseUrl: remote.releaseUrl,
    publishedAt: remote.publishedAt,
    checkedAt: new Date(now).toISOString(),
    source: remote.source,
    error: null,
    shouldNotify: false
  }

  store.setKv(UPDATE_KV.lastCheckAt, String(now))
  store.setKv(UPDATE_KV.lastFailureAt, '')
  store.setKv(UPDATE_KV.lastResult, JSON.stringify(result))

  logger.info(
    'update',
    hasUpdate
      ? `发现新版本 ${remote.version}（当前 ${APP_VERSION}），来源：${remote.source}。`
      : `已是最新版本（${APP_VERSION}），来源：${remote.source}。`
  )

  return { ...result, shouldNotify: decideNotify(store, remote.version, now) }
}

/**
 * 打开发布页。
 *
 * **不接受渲染层传 URL** —— 地址只从上次检查的缓存里取，并且要过一遍
 * 域名白名单。这样即使渲染进程被注入，也没有办法让主进程去打开任意地址。
 */
export async function openReleasePage(options: {
  store: Store
  logger: Logger
  openExternal: (url: string) => Promise<void>
}): Promise<boolean> {
  const cached = readCachedResult(options.store)
  const url = cached?.releaseUrl ?? null
  if (url === null) return false
  if (!ALLOWED_RELEASE_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    options.logger.warn('update', `拒绝打开不在白名单内的更新地址：${url}`)
    return false
  }
  try {
    await options.openExternal(url)
    return true
  } catch (error) {
    options.logger.warn('update', `打开更新页面失败：${String(error)}`)
    return false
  }
}
