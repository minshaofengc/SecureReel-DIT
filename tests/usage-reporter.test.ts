/**
 * 上报器：载荷形状、成功标记、失败退避、开关与开发模式闸门。
 *
 * 不碰真实网络 —— `fetchImpl` 是注入的。服务端那一侧已用 curl 验证过
 * （204 / 400 / 幂等合并），这里只保证客户端发出去的形状与服务端一致。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Store } from '@main/db/store'
import { UsageReporter, type ReporterDeps } from '@main/usage/reporter'
import type { Logger } from '@main/logger'
import { LAST_SENT_AT_KV } from '@main/usage/reporter'

const installId = 'inst_0123456789abcdef0123456789abcdef'
const logger = { warn: () => undefined, info: () => undefined } as unknown as Logger

let store: Store

beforeEach(async () => {
  store = await Store.openInMemory()
  store.accrueUsage({
    installId,
    day: '2026-11-24',
    activeSeconds: 90,
    aliveSeconds: 120,
    launches: 2,
    nowIso: '2026-11-24T10:00:00.000Z'
  })
})

function makeReporter(overrides: Partial<ReporterDeps> = {}): UsageReporter {
  return new UsageReporter({
    store,
    logger,
    enabled: () => true,
    installId: () => installId,
    platform: 'darwin',
    arch: 'arm64',
    appVersion: '2.0.11',
    allowNetwork: true,
    now: () => Date.parse('2026-11-24T12:00:00Z'),
    ...overrides
  })
}

describe('上报载荷', () => {
  it('字段与服务端校验一致，且只发待发行的绝对值', async () => {
    let captured: { url: string; init?: RequestInit } | null = null
    const reporter = makeReporter({
      fetchImpl: async (url, init) => {
        captured = { url, init }
        return new Response(null, { status: 204 })
      }
    })

    const result = await reporter.reportOnce()
    expect(result).toEqual({ sent: 1, ok: true })
    expect(captured).not.toBeNull()

    const body = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>
    expect(body).toEqual({
      v: 1,
      installId,
      appVersion: '2.0.11',
      platform: 'darwin',
      arch: 'arm64',
      days: [{ day: '2026-11-24', activeSeconds: 90, aliveSeconds: 120, launches: 2 }]
    })
    expect(String(captured?.url)).toContain('/api/v1/usage')
    expect(captured?.init?.method).toBe('POST')
  })

  it('成功后清掉待发标记并记录时间', async () => {
    const reporter = makeReporter({
      fetchImpl: async () => new Response(null, { status: 204 })
    })
    await reporter.reportOnce()
    expect(store.countPendingUsage(installId)).toBe(0)
    expect(store.getKv(LAST_SENT_AT_KV)).not.toBeNull()
  })
})

describe('失败与闸门', () => {
  it('非 2xx 不抛错，只记次数与下次重试时间', async () => {
    const now = Date.parse('2026-11-24T12:00:00Z')
    const reporter = makeReporter({
      now: () => now,
      fetchImpl: async () => new Response('nope', { status: 500 })
    })
    const result = await reporter.reportOnce()
    expect(result).toEqual({ sent: 0, ok: false })
    const row = store.listUsageRows(installId)[0]
    expect(row?.attempts).toBe(1)
    expect(row?.nextAttemptAt).toBe(now + 60_000)
    expect(row?.dirty).toBe(true)
  })

  it('网络异常同样静默', async () => {
    const reporter = makeReporter({
      fetchImpl: async () => {
        throw new Error('offline')
      }
    })
    await expect(reporter.reportOnce()).resolves.toEqual({ sent: 0, ok: false })
  })

  it('关掉开关后一个请求都不发', async () => {
    let called = 0
    const reporter = makeReporter({
      enabled: () => false,
      fetchImpl: async () => {
        called += 1
        return new Response(null, { status: 204 })
      }
    })
    await reporter.reportOnce()
    expect(called).toBe(0)
    expect(store.countPendingUsage(installId)).toBe(1)
  })

  it('开发模式（allowNetwork=false）不发请求，也不清标记', async () => {
    let called = 0
    const reporter = makeReporter({
      allowNetwork: false,
      fetchImpl: async () => {
        called += 1
        return new Response(null, { status: 204 })
      }
    })
    const result = await reporter.reportOnce()
    expect(result).toEqual({ sent: 0, ok: true })
    expect(called).toBe(0)
    expect(store.countPendingUsage(installId)).toBe(1)
  })
})
