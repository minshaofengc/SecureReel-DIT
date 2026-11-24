/**
 * 登录凭证的本地存储。
 *
 * 优先用 Electron 的 `safeStorage` 加密后落盘（macOS 走钥匙串，Windows 走 DPAPI）。
 * 系统加密不可用时退回**明文 base64 + 0600 权限**：
 * 无头/未签名环境下钥匙串常常不可用，此时若只放内存，用户每次启动都要重新登录，
 * 账号功能等于废掉。文件权限 600 意味着只有本用户可读，与多数桌面应用一致。
 * token 可以随时在服务端撤销，泄露风险可控。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import type { Logger } from '../logger'

export interface StoredSession {
  token: string
  email: string
}

interface FileShape {
  v: 1
  token: string
  email: string
  /** true = safeStorage 加密；false = 明文 base64（系统加密不可用时的退路） */
  encrypted: boolean
}

export class SessionStore {
  private memory: StoredSession | null = null

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger
  ) {}

  load(): StoredSession | null {
    if (this.memory !== null) return this.memory
    if (!existsSync(this.filePath)) return null
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<FileShape>
      if (typeof parsed.token !== 'string' || typeof parsed.email !== 'string') return null

      const token =
        parsed.encrypted === false
          ? Buffer.from(parsed.token, 'base64').toString('utf8')
          : safeStorage.decryptString(Buffer.from(parsed.token, 'base64'))

      if (token.length !== 64) return null
      this.memory = { token, email: parsed.email }
      return this.memory
    } catch (error) {
      this.logger.warn('account', `读取登录状态失败：${String(error)}`)
      return null
    }
  }

  save(session: StoredSession): void {
    this.memory = session
    try {
      const encrypted = safeStorage.isEncryptionAvailable()
      const token = encrypted
        ? safeStorage.encryptString(session.token).toString('base64')
        : Buffer.from(session.token, 'utf8').toString('base64')
      const payload: FileShape = { v: 1, token, email: session.email, encrypted }
      writeFileSync(this.filePath, JSON.stringify(payload), { mode: 0o600 })
      if (!encrypted) {
        this.logger.warn('account', '系统加密不可用，登录状态以 0600 权限明文保存。')
      }
    } catch (error) {
      this.logger.warn('account', `保存登录状态失败：${String(error)}`)
    }
  }

  clear(): void {
    this.memory = null
    try {
      if (existsSync(this.filePath)) unlinkSync(this.filePath)
    } catch (error) {
      this.logger.warn('account', `清除登录状态失败：${String(error)}`)
    }
  }
}
