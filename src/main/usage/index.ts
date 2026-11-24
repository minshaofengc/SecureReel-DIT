/**
 * 使用统计的门面。
 *
 * 默认开启，界面上没有任何开关：`start()` 只挂一个心跳和一个 6 小时的发送定时器，
 * 除此之外不注册任何全局监听；锁屏/休眠由 `index.ts` 转达。
 *
 * 关闭方式只有三种，全部不在界面里：
 *   · 环境变量 `SECUREREEL_DISABLE_USAGE=1`
 *   · 启动参数 `--disable-usage-stats`
 *   · 设置键 `usageStatsEnabled = false`
 * 任一成立即停止累加、不发包。
 */
import type { AppSettings } from '@shared/types'
import type { Store } from '../db/store'
import type { Logger } from '../logger'
import { ensureInstallId } from './install-id'
import { UsageTracker } from './tracker'
import { UsageReporter } from './reporter'

export const PRIVACY_URL = 'https://securereel.pages.dev/privacy'
const ALLOWED_PRIVACY_PREFIXES = ['https://securereel.pages.dev/']

const FIRST_REPORT_DELAY_MS = 30_000
const REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface UsageDeps {
  store: Store
  logger: Logger
  getSettings: () => AppSettings
  isFocused: () => boolean
  getIdleSeconds: () => number
  platform?: string
  arch?: string
  appVersion: string
  /** 正式包才允许真的发请求；开发与冒烟默认关闭 */
  allowNetwork?: boolean
  /** 环境变量或启动参数要求关闭 */
  disabledByOverride?: () => boolean
  now?: () => number
  openExternal?: (url: string) => Promise<void>
}

export class UsageService {
  private readonly tracker: UsageTracker
  private readonly reporter: UsageReporter
  private installId: string
  private firstReportTimer: ReturnType<typeof setTimeout> | null = null
  private reportTimer: ReturnType<typeof setInterval> | null = null
  private started = false

  constructor(private readonly deps: UsageDeps) {
    this.installId = ensureInstallId(deps.store)
    this.tracker = new UsageTracker({
      store: deps.store,
      logger: deps.logger,
      enabled: () => this.isEnabled(),
      installId: () => this.installId,
      isFocused: deps.isFocused,
      getIdleSeconds: deps.getIdleSeconds,
      now: deps.now
    })
    this.reporter = new UsageReporter({
      store: deps.store,
      logger: deps.logger,
      enabled: () => this.isEnabled(),
      installId: () => this.installId,
      platform: deps.platform ?? process.platform,
      arch: deps.arch ?? process.arch,
      appVersion: deps.appVersion,
      allowNetwork: deps.allowNetwork ?? true,
      now: deps.now
    })
  }

  private isEnabled(): boolean {
    if (this.deps.disabledByOverride?.() === true) return false
    return this.deps.getSettings().usageStatsEnabled
  }

  /** 账号登录后要绑定这个 ID。 */
  getInstallId(): string {
    return this.installId
  }

  /**
   * 发一轮上报。
   *
   * ⚠️ 必须先 `flush()`：心跳每 60 秒才落库，而首次上报在 30 秒 ——
   * 不先落库就会发一份空数据，安装要等下一次（6 小时后）才出现在后台。
   */
  private report(): void {
    this.tracker.flush()
    void this.reporter.reportOnce()
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.tracker.start()
    this.tracker.noteLaunch()

    if (this.isEnabled()) {
      this.firstReportTimer = setTimeout(() => this.report(), FIRST_REPORT_DELAY_MS)
      this.reportTimer = setInterval(() => this.report(), REPORT_INTERVAL_MS)
    }
  }

  /** 退出前调用：只落库，不发包（退出时不该等网络）。 */
  stop(): void {
    this.tracker.stop()
    this.tracker.flush()
    if (this.firstReportTimer !== null) {
      clearTimeout(this.firstReportTimer)
      this.firstReportTimer = null
    }
    if (this.reportTimer !== null) {
      clearInterval(this.reportTimer)
      this.reportTimer = null
    }
    this.started = false
  }

  setLocked(value: boolean): void {
    this.tracker.setLocked(value)
  }

  resetClock(): void {
    this.tracker.resetClock()
  }

  /** 给端到端验证用：推进一次心跳，不依赖真实定时器。 */
  tickNow(): void {
    this.tracker.tick()
  }

  /**
   * 打开隐私说明。
   *
   * **不接受渲染层传 URL** —— 地址写死在这里并过白名单，
   * 即使渲染进程被注入也没法让主进程打开任意地址。
   */
  async openPrivacyPolicy(): Promise<boolean> {
    const url = PRIVACY_URL
    if (!ALLOWED_PRIVACY_PREFIXES.some((prefix) => url.startsWith(prefix))) return false
    try {
      const open = this.deps.openExternal
      if (open !== undefined) await open(url)
      return true
    } catch (error) {
      this.deps.logger.warn('usage', `打开隐私说明失败：${String(error)}`)
      return false
    }
  }
}
