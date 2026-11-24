/**
 * 账号与设置同步的门面。
 *
 * 职责边界：
 *   · 登录态与 token 只在本进程，渲染层拿不到 token；
 *   · 同步只碰 `SYNCABLE_SETTING_KEYS` 白名单里的键；
 *   · 任何失败都不弹窗、不打断拷贝 —— 同步是锦上添花，不是主流程。
 */
import type { AppSettings } from '@shared/types'
import {
  isValidEmail,
  mergeSettings,
  normalizeEmail,
  type AccountErrorCode,
  type AccountResult,
  type AccountStatus,
  type CloudSettings
} from '@shared/account'
import type { Store } from '../db/store'
import type { Logger } from '../logger'
import { AccountApi, readSettings, type RawResponse } from './api'
import { SessionStore, type StoredSession } from './session'

const LAST_SYNC_KV = 'account.lastSyncAt'
const SYNC_DEBOUNCE_MS = 2000

export interface AccountDeps {
  store: Store
  logger: Logger
  sessionFile: string
  allowNetwork: boolean
  installId: () => string
  getSettings: () => AppSettings
  /** 云端设置写回本机后，通知界面刷新 */
  onSettingsApplied: (settings: AppSettings) => void
  now?: () => number
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
}

export class AccountService {
  private session: StoredSession | null
  private readonly sessions: SessionStore
  private readonly api: AccountApi
  private lastCloud: CloudSettings = {}
  private lastSyncAt: string | null
  private syncError: string | null = null
  private syncing = false
  private debounce: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: AccountDeps) {
    this.sessions = new SessionStore(deps.sessionFile, deps.logger)
    this.session = this.sessions.load()
    this.api = new AccountApi({ allowNetwork: deps.allowNetwork, fetchImpl: deps.fetchImpl })
    this.lastSyncAt = deps.store.getKv(LAST_SYNC_KV)
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  status(): AccountStatus {
    return {
      loggedIn: this.session !== null,
      email: this.session?.email ?? null,
      lastSyncAt: this.lastSyncAt,
      syncError: this.syncError,
      syncing: this.syncing
    }
  }

  /** 启动时：把当前安装重新绑到账号，并拉一次设置。失败只记日志。 */
  start(): void {
    const session = this.session
    if (session === null) return
    void (async () => {
      try {
        await this.api.bind(session.token, this.deps.installId())
        await this.syncNow()
      } catch (error) {
        this.deps.logger.warn('account', `启动同步失败：${String(error)}`)
      }
    })()
  }

  stop(): void {
    if (this.debounce !== null) {
      clearTimeout(this.debounce)
      this.debounce = null
    }
  }

  private mapError(res: RawResponse): AccountErrorCode {
    if (res.networkError) return 'network'
    const code = res.body?.['error']
    if (res.status === 429) return 'rate_limited'
    if (res.status === 401) {
      if (code === 'invalid_code') return 'invalid_code'
      if (code === 'code_expired') return 'code_expired'
      return 'unauthorized'
    }
    if (res.status === 400) return code === 'invalid_email' ? 'invalid_email' : 'invalid_code'
    return 'server'
  }

  private clearSession(): void {
    this.session = null
    this.sessions.clear()
    this.lastCloud = {}
    this.syncError = null
  }

  async requestCode(rawEmail: string): Promise<AccountResult<boolean>> {
    const email = normalizeEmail(rawEmail)
    if (!isValidEmail(email)) return { ok: false, error: 'invalid_email' }

    const res = await this.api.requestCode(email)
    if (!res.ok) return { ok: false, error: this.mapError(res) }

    // 本地联调时服务端会回一个 devCode；生产不会出现这个字段。
    const dev = res.body?.['devCode']
    if (typeof dev === 'string') {
      this.deps.logger.info('account', `本地验证码：${dev}`)
    }
    return { ok: true, data: true }
  }

  async verify(rawEmail: string, rawCode: string): Promise<AccountResult<AccountStatus>> {
    const email = normalizeEmail(rawEmail)
    const code = rawCode.trim()
    if (!isValidEmail(email)) return { ok: false, error: 'invalid_email' }
    if (!/^\d{6}$/.test(code)) return { ok: false, error: 'invalid_code' }

    const res = await this.api.verify(email, code, this.deps.installId())
    if (!res.ok) return { ok: false, error: this.mapError(res) }

    const token = res.body?.['token']
    if (typeof token !== 'string' || token.length !== 64) return { ok: false, error: 'server' }

    this.session = { token, email }
    this.sessions.save(this.session)
    this.syncError = null
    await this.pullAndMerge()
    return { ok: true, data: this.status() }
  }

  async logout(): Promise<AccountResult<AccountStatus>> {
    const session = this.session
    if (session !== null) {
      // 失败也照样清本地：用户点了退出，不能因为网络不通就退不出去。
      await this.api.logout(session.token, this.deps.installId())
    }
    this.clearSession()
    return { ok: true, data: this.status() }
  }

  async deleteAccount(): Promise<AccountResult<AccountStatus>> {
    const session = this.session
    if (session === null) return { ok: false, error: 'unauthorized' }

    const res = await this.api.deleteAccount(session.token)
    if (!res.ok && res.status !== 401) return { ok: false, error: this.mapError(res) }

    this.clearSession()
    return { ok: true, data: this.status() }
  }

  async syncNow(): Promise<AccountResult<AccountStatus>> {
    if (this.session === null) return { ok: true, data: this.status() }
    if (this.syncing) return { ok: true, data: this.status() }

    /*
     * ⚠️ `status()` 必须在 `syncing` 复位之后再取。
     * 早先是在 try 里直接 `return this.status()`，那时 finally 还没跑，
     * 返回的 syncing 仍是 true —— 界面会把「同步中…」一直显示下去。
     */
    this.syncing = true
    let ok = false
    try {
      ok = await this.pullAndMerge()
    } finally {
      this.syncing = false
    }

    return ok
      ? { ok: true, data: this.status() }
      : { ok: false, error: (this.syncError as AccountErrorCode | null) ?? 'server' }
  }

  /** 设置页改完之后调用；2 秒内多次改动只推一次。 */
  onSettingsSaved(): void {
    if (this.session === null) return
    if (this.debounce !== null) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.pushChanges()
    }, SYNC_DEBOUNCE_MS)
  }

  private async pullAndMerge(): Promise<boolean> {
    const session = this.session
    if (session === null) return false

    const res = await this.api.getSettings(session.token)
    if (!res.ok) {
      this.syncError = this.mapError(res)
      if (res.status === 401) this.clearSession()
      return false
    }

    const cloud = readSettings(res.body)
    this.lastCloud = cloud

    const local = this.deps.getSettings()
    const localAt = this.deps.store.getSettingTimestamps()
    const { apply, push } = mergeSettings(local, localAt, cloud)

    if (Object.keys(apply).length > 0) {
      const stamps: Record<string, number> = {}
      for (const key of Object.keys(apply)) {
        const entry = cloud[key]
        if (entry !== undefined) stamps[key] = entry.updatedAt
      }
      const merged = this.deps.store.applySyncedSettings(apply, stamps)
      this.deps.onSettingsApplied(merged)
    }

    if (Object.keys(push).length > 0) {
      const put = await this.api.putSettings(session.token, push)
      if (!put.ok) {
        this.syncError = this.mapError(put)
        if (put.status === 401) this.clearSession()
        return false
      }
      for (const [key, value] of Object.entries(push)) this.lastCloud[key] = value
    }

    this.lastSyncAt = new Date(this.now()).toISOString()
    this.deps.store.setKv(LAST_SYNC_KV, this.lastSyncAt)
    this.syncError = null
    return true
  }

  private async pushChanges(): Promise<void> {
    const session = this.session
    if (session === null || this.syncing) return

    const local = this.deps.getSettings()
    const localAt = this.deps.store.getSettingTimestamps()
    const { push } = mergeSettings(local, localAt, this.lastCloud)
    if (Object.keys(push).length === 0) return

    const res = await this.api.putSettings(session.token, push)
    if (!res.ok) {
      this.syncError = this.mapError(res)
      if (res.status === 401) this.clearSession()
      return
    }
    for (const [key, value] of Object.entries(push)) this.lastCloud[key] = value
    this.lastSyncAt = new Date(this.now()).toISOString()
    this.deps.store.setKv(LAST_SYNC_KV, this.lastSyncAt)
    this.syncError = null
  }
}
