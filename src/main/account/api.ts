/**
 * 账号与同步的 HTTP 客户端。
 *
 * 与使用统计一样走 `net.fetch`（读系统代理），并受 `allowNetwork` 闸门约束：
 * 开发与冒烟默认不发真实请求，避免在线上账号库里留下测试账号。
 */
import type { CloudSettings } from '@shared/account'

export const DEFAULT_API_BASE = 'https://securereel.pages.dev/api/v1'
export const API_BASE = (process.env['SECUREREEL_API_BASE'] ?? '').trim() || DEFAULT_API_BASE

const TIMEOUT_MS = 10_000

async function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  const { net } = await import('electron')
  return net.fetch(input, init)
}

export interface RawResponse {
  ok: boolean
  status: number
  body: Record<string, unknown> | null
  /** 网络层失败（DNS、超时、代理）时为真 */
  networkError: boolean
}

export class AccountApi {
  constructor(
    private readonly deps: {
      allowNetwork: boolean
      baseUrl?: string
      fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
    }
  ) {}

  private async request(
    method: string,
    path: string,
    body?: unknown,
    token?: string
  ): Promise<RawResponse> {
    if (!this.deps.allowNetwork) {
      return { ok: false, status: 0, body: null, networkError: true }
    }
    const fetchImpl = this.deps.fetchImpl ?? defaultFetch
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token !== undefined) headers['Authorization'] = `Bearer ${token}`

    try {
      const response = await fetchImpl((this.deps.baseUrl ?? API_BASE) + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      let parsed: Record<string, unknown> | null = null
      const text = await response.text()
      if (text !== '') {
        try {
          parsed = JSON.parse(text) as Record<string, unknown>
        } catch {
          parsed = null
        }
      }
      return { ok: response.ok, status: response.status, body: parsed, networkError: false }
    } catch {
      return { ok: false, status: 0, body: null, networkError: true }
    }
  }

  requestCode(email: string): Promise<RawResponse> {
    return this.request('POST', '/auth/request-code', { email })
  }

  verify(email: string, code: string, installId: string): Promise<RawResponse> {
    return this.request('POST', '/auth/verify', { email, code, installId })
  }

  logout(token: string, installId: string): Promise<RawResponse> {
    return this.request('POST', '/auth/logout', { installId }, token)
  }

  deleteAccount(token: string): Promise<RawResponse> {
    return this.request('DELETE', '/account', undefined, token)
  }

  bind(token: string, installId: string): Promise<RawResponse> {
    return this.request('POST', '/installations/bind', { installId }, token)
  }

  getSettings(token: string): Promise<RawResponse> {
    return this.request('GET', '/settings', undefined, token)
  }

  putSettings(
    token: string,
    changes: Record<string, { value: unknown; updatedAt: number }>
  ): Promise<RawResponse> {
    return this.request('PUT', '/settings', { changes }, token)
  }
}

export function readSettings(body: Record<string, unknown> | null): CloudSettings {
  const raw = body?.['settings']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return raw as CloudSettings
}
