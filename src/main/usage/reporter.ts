/**
 * 上报：把本地待发的按天数据批量 POST 给官网的 Functions 接口。
 *
 * 沿用 `updates.ts` 的两条经验：
 *   · 用 `net.fetch` 而不是 Node fetch —— 现场机器大多挂代理，Node fetch 会绕过系统代理；
 *   · 失败只写日志、静默退避，绝不弹窗打断拷贝。
 *
 * 与更新检查不同的是：这里**可以**关掉，而且关掉后一个包都不发。
 */
import { backoffMs, selectBatch, toPayloadDay, type UsagePayload } from '@shared/usage'
import type { Logger } from '../logger'
import type { Store } from '../db/store'

/**
 * 默认走 Chromium 网络栈（`net.fetch`），会读系统代理。
 *
 * 这里用动态 import 而不是顶层 import：单测在纯 Node 里跑，
 * 顶层 import electron 会直接失败；注入 `fetchImpl` 时也完全不需要它。
 */
async function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  const { net } = await import('electron')
  return net.fetch(input, init)
}

export const DEFAULT_USAGE_ENDPOINT = 'https://securereel.pages.dev/api/v1/usage'
/** 联调与端到端测试用：指向本地或一个必然失败的地址。 */
export const USAGE_ENDPOINT =
  (process.env.SECUREREEL_USAGE_ENDPOINT ?? '').trim() || DEFAULT_USAGE_ENDPOINT

const REQUEST_TIMEOUT_MS = 8000
const FAILURES_KV = 'usage.consecutiveFailures'
export const LAST_SENT_AT_KV = 'usage.lastSentAt'

export interface ReporterDeps {
  store: Store
  logger: Logger
  enabled: () => boolean
  installId: () => string
  platform: string
  arch: string
  appVersion: string
  /**
   * 是否允许真的发请求。
   *
   * 打包后的正式应用为 true；`npm run dev`、冒烟验证、端到端流水线都是 false ——
   * 否则每跑一次测试就会在后台里多出一个假安装。要联调时用
   * `SECUREREEL_USAGE_ENDPOINT` 显式指定地址。
   */
  allowNetwork: boolean
  endpoint?: string
  now?: () => number
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
}

export interface ReportResult {
  sent: number
  ok: boolean
}

export class UsageReporter {
  private inflight = false

  constructor(private readonly deps: ReporterDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  async reportOnce(): Promise<ReportResult> {
    if (this.inflight) return { sent: 0, ok: false }
    if (!this.deps.enabled()) return { sent: 0, ok: false }
    if (!this.deps.allowNetwork) return { sent: 0, ok: true }

    this.inflight = true
    try {
      const installId = this.deps.installId()
      const rows = this.deps.store.listUsageRows(installId)
      const batch = selectBatch(rows, this.now())
      if (batch.length === 0) return { sent: 0, ok: true }

      const payload: UsagePayload = {
        v: 1,
        installId,
        appVersion: this.deps.appVersion,
        platform: this.deps.platform,
        arch: this.deps.arch,
        days: batch.map(toPayloadDay)
      }

      const fetchImpl = this.deps.fetchImpl ?? defaultFetch

      let ok = false
      try {
        const response = await fetchImpl(this.deps.endpoint ?? USAGE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
        ok = response.ok
      } catch {
        ok = false
      }

      const days = batch.map((row) => row.day)
      if (ok) {
        this.deps.store.markUsageSent(installId, days)
        this.deps.store.setKv(LAST_SENT_AT_KV, new Date(this.now()).toISOString())
        const previous = Number(this.deps.store.getKv(FAILURES_KV) ?? '0')
        if (Number.isFinite(previous) && previous > 0) {
          this.deps.logger.info('usage', `使用统计上报已恢复（此前连续失败 ${previous} 次）。`)
        }
        this.deps.store.setKv(FAILURES_KV, '0')
        return { sent: days.length, ok: true }
      }

      const previous = Number(this.deps.store.getKv(FAILURES_KV) ?? '0')
      const failures = Number.isFinite(previous) ? previous + 1 : 1
      const attempts = Math.max(...batch.map((row) => row.attempts)) + 1
      this.deps.store.markUsageFailed(installId, days, this.now() + backoffMs(attempts))
      this.deps.store.setKv(FAILURES_KV, String(failures))
      // 只在第一次失败时提醒一次，长期断网不刷日志。
      if (failures === 1) {
        this.deps.logger.warn('usage', '使用统计上报失败，已静默排队，下次自动补传（不影响拷贝）。')
      }
      return { sent: 0, ok: false }
    } catch (error) {
      this.deps.logger.warn('usage', `使用统计上报异常（不影响拷贝）：${String(error)}`)
      return { sent: 0, ok: false }
    } finally {
      this.inflight = false
    }
  }
}
