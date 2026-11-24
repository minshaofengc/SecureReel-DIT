/**
 * 使用统计的门面。
 *
 * 装配顺序刻意简单：`start()` 只挂一个心跳和一个 6 小时的发送定时器，
 * 除此之外不注册任何全局监听；锁屏/休眠由 `index.ts` 转达。
 *
 * 关闭开关时：停止累加、清空本地历史、一个包都不发。
 * 这是"同意"二字的最低要求，也是隐私说明里的原话。
 */
import type { BrowserWindow } from 'electron'
import type { AppSettings } from '@shared/types'
import type { UsageStatus } from '@shared/ipc'
import {
  isReportingEnabled,
  needsConsent,
  USAGE_POLICY_VERSION,
  type ConsentDecision
} from '@shared/usage'
import type { Store } from '../db/store'
import type { Logger } from '../logger'
import { ensureInstallId, resetInstallId } from './install-id'
import { readConsent, writeConsent } from './consent'
import { UsageTracker } from './tracker'
import { LAST_SENT_AT_KV, UsageReporter } from './reporter'

export const PRIVACY_URL = 'https://securereel.pages.dev/privacy.html'
const ALLOWED_PRIVACY_PREFIXES = ['https://securereel.pages.dev/']

const FIRST_REPORT_DELAY_MS = 30_000
const REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface UsageDeps {
  store: Store
  logger: Logger
  getSettings: () => AppSettings
  saveSettings: (next: AppSettings) => AppSettings
  getMainWindow: () => BrowserWindow | null
  isFocused: () => boolean
  getIdleSeconds: () => number
  platform?: string
  arch?: string
  appVersion: string
  /** 正式包才允许真的发请求；开发与冒烟默认关闭 */
  allowNetwork?: boolean
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

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private consent(): ReturnType<typeof readConsent> {
    return readConsent(this.deps.store)
  }

  private isEnabled(): boolean {
    return isReportingEnabled(this.consent(), this.deps.getSettings().usageStatsEnabled)
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.tracker.start()
    this.tracker.noteLaunch()

    if (this.isEnabled()) {
      this.firstReportTimer = setTimeout(() => {
        void this.reporter.reportOnce()
      }, FIRST_REPORT_DELAY_MS)
      this.reportTimer = setInterval(() => {
        void this.reporter.reportOnce()
      }, REPORT_INTERVAL_MS)
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

  status(): UsageStatus {
    const consent = this.consent()
    const rows = this.deps.store.listUsageRows(this.installId)
    return {
      enabled: this.isEnabled(),
      consent: consent?.decision ?? null,
      policyVersion: USAGE_POLICY_VERSION,
      needsConsent: needsConsent(consent),
      installId: this.installId,
      pendingDays: this.deps.store.countPendingUsage(this.installId),
      lastSentAt: this.deps.store.getKv(LAST_SENT_AT_KV),
      firstSeenDay: rows[0]?.day ?? null
    }
  }

  /**
   * 打开/关闭。
   *
   * 关闭 = 停止累加 + 清空本地历史 + 一个包都不发。
   * 重新打开会把同意记录补成当前政策版本 —— 用户主动打开开关，就是一次明确同意。
   */
  setEnabled(enabled: boolean): UsageStatus {
    if (enabled) {
      writeConsent(this.deps.store, 'granted', USAGE_POLICY_VERSION, new Date(this.now()).toISOString())
      this.deps.saveSettings({ ...this.deps.getSettings(), usageStatsEnabled: true })
      if (this.started && this.firstReportTimer === null) {
        this.firstReportTimer = setTimeout(() => {
          void this.reporter.reportOnce()
        }, FIRST_REPORT_DELAY_MS)
        this.reportTimer = setInterval(() => {
          void this.reporter.reportOnce()
        }, REPORT_INTERVAL_MS)
      }
      this.tracker.noteLaunch()
    } else {
      writeConsent(this.deps.store, 'declined', USAGE_POLICY_VERSION, new Date(this.now()).toISOString())
      this.deps.saveSettings({ ...this.deps.getSettings(), usageStatsEnabled: false })
      this.tracker.discardPending()
      this.deps.store.clearUsage()
      if (this.firstReportTimer !== null) {
        clearTimeout(this.firstReportTimer)
        this.firstReportTimer = null
      }
      if (this.reportTimer !== null) {
        clearInterval(this.reportTimer)
        this.reportTimer = null
      }
    }
    return this.status()
  }

  /** 首次弹层里的「同意 / 暂不开启」，语义与设置开关一致。 */
  decideConsent(decision: ConsentDecision): UsageStatus {
    return this.setEnabled(decision === 'granted')
  }

  resetInstallId(): UsageStatus {
    this.tracker.discardPending()
    this.installId = resetInstallId(this.deps.store)
    return this.status()
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
