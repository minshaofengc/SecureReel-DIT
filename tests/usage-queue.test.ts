/**
 * 本地统计存储与同意记录。
 *
 * 这里钉的是"落库这一层"的语义：同一天累加、上限、脏标记、退避、重置。
 * 上报是否幂等由服务端的 MAX 合并保证，这里只保证**发出去的是绝对值**。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Store } from '@main/db/store'
import { ensureInstallId, resetInstallId, INSTALL_ID_KV } from '@main/usage/install-id'
import { readConsent, writeConsent, CONSENT_KV } from '@main/usage/consent'
import { UsageTracker } from '@main/usage/tracker'
import type { Logger } from '@main/logger'
import { isValidInstallId } from '@shared/usage'

let store: Store

beforeEach(async () => {
  store = await Store.openInMemory()
})

describe('安装 ID', () => {
  it('首次调用生成并落库，二次调用返回同一个', () => {
    const first = ensureInstallId(store)
    expect(isValidInstallId(first)).toBe(true)
    expect(ensureInstallId(store)).toBe(first)
    expect(store.getKv(INSTALL_ID_KV)).toBe(first)
  })

  it('库里是坏值时重新生成', () => {
    store.setKv(INSTALL_ID_KV, 'not-an-id')
    const id = ensureInstallId(store)
    expect(isValidInstallId(id)).toBe(true)
  })

  it('重置换新 ID 并清空历史', () => {
    const first = ensureInstallId(store)
    store.accrueUsage({
      installId: first,
      day: '2026-11-24',
      activeSeconds: 60,
      aliveSeconds: 60,
      launches: 1,
      nowIso: '2026-11-24T10:00:00.000Z'
    })
    expect(store.listUsageRows(first)).toHaveLength(1)

    const next = resetInstallId(store)
    expect(next).not.toBe(first)
    expect(isValidInstallId(next)).toBe(true)
    expect(store.listUsageRows(first)).toHaveLength(0)
    expect(store.listUsageRows(next)).toHaveLength(0)
  })
})

describe('按天累加', () => {
  const installId = 'inst_0123456789abcdef0123456789abcdef'

  it('同一天多次累加求和', () => {
    for (const active of [30, 30, 30]) {
      store.accrueUsage({
        installId,
        day: '2026-11-24',
        activeSeconds: active,
        aliveSeconds: active,
        launches: 0,
        nowIso: '2026-11-24T10:00:00.000Z'
      })
    }
    const rows = store.listUsageRows(installId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.activeSeconds).toBe(90)
    expect(rows[0]?.aliveSeconds).toBe(90)
  })

  it('存活秒数自动补齐到不小于活跃秒数', () => {
    store.accrueUsage({
      installId,
      day: '2026-11-24',
      activeSeconds: 60,
      aliveSeconds: 0,
      launches: 0,
      nowIso: '2026-11-24T10:00:00.000Z'
    })
    const row = store.listUsageRows(installId)[0]
    expect(row?.activeSeconds).toBe(60)
    expect(row?.aliveSeconds).toBe(60)
  })

  it('一天最多 86400 秒', () => {
    store.accrueUsage({
      installId,
      day: '2026-11-24',
      activeSeconds: 86_000,
      aliveSeconds: 86_000,
      launches: 0,
      nowIso: '2026-11-24T10:00:00.000Z'
    })
    store.accrueUsage({
      installId,
      day: '2026-11-24',
      activeSeconds: 86_000,
      aliveSeconds: 86_000,
      launches: 0,
      nowIso: '2026-11-24T11:00:00.000Z'
    })
    const row = store.listUsageRows(installId)[0]
    expect(row?.activeSeconds).toBe(86_400)
    expect(row?.aliveSeconds).toBe(86_400)
  })

  it('新写入的行默认是待发送', () => {
    store.accrueUsage({
      installId,
      day: '2026-11-24',
      activeSeconds: 10,
      aliveSeconds: 10,
      launches: 0,
      nowIso: '2026-11-24T10:00:00.000Z'
    })
    const row = store.listUsageRows(installId)[0]
    expect(row?.dirty).toBe(true)
    expect(row?.attempts).toBe(0)
    expect(row?.nextAttemptAt).toBe(0)
    expect(store.countPendingUsage(installId)).toBe(1)
  })
})

describe('发送状态', () => {
  const installId = 'inst_0123456789abcdef0123456789abcdef'

  beforeEach(() => {
    store.accrueUsage({
      installId,
      day: '2026-11-24',
      activeSeconds: 100,
      aliveSeconds: 200,
      launches: 1,
      nowIso: '2026-11-24T10:00:00.000Z'
    })
  })

  it('成功发送后不再待发；再次累加会重新变脏', () => {
    store.markUsageSent(installId, ['2026-11-24'])
    expect(store.countPendingUsage(installId)).toBe(0)
    expect(store.listUsageRows(installId)[0]?.dirty).toBe(false)

    store.accrueUsage({
      installId,
      day: '2026-11-24',
      activeSeconds: 30,
      aliveSeconds: 30,
      launches: 0,
      nowIso: '2026-11-24T10:05:00.000Z'
    })
    expect(store.countPendingUsage(installId)).toBe(1)
  })

  it('失败会记次数并推到下次重试时间', () => {
    store.markUsageFailed(installId, ['2026-11-24'], 1_800_000_000_000)
    const row = store.listUsageRows(installId)[0]
    expect(row?.attempts).toBe(1)
    expect(row?.nextAttemptAt).toBe(1_800_000_000_000)
    expect(row?.dirty).toBe(true)
  })
})

describe('重置与统计', () => {
  const installId = 'inst_0123456789abcdef0123456789abcdef'

  it('clearUsage 清空全部安装的行', () => {
    store.accrueUsage({
      installId,
      day: '2026-11-24',
      activeSeconds: 10,
      aliveSeconds: 10,
      launches: 0,
      nowIso: '2026-11-24T10:00:00.000Z'
    })
    store.clearUsage()
    expect(store.listUsageRows(installId)).toHaveLength(0)
  })

  it('usageTotals 汇总天数与累计秒数', () => {
    for (const day of ['2026-11-23', '2026-11-24']) {
      store.accrueUsage({
        installId,
        day,
        activeSeconds: 100,
        aliveSeconds: 100,
        launches: 0,
        nowIso: '2026-11-24T10:00:00.000Z'
      })
    }
    expect(store.usageTotals(installId)).toEqual({ days: 2, activeSeconds: 200 })
  })
})

describe('同意记录', () => {
  it('初始为空', () => {
    expect(readConsent(store)).toBeNull()
  })

  it('写入后能读回', () => {
    writeConsent(store, 'granted', 1, '2026-11-24T10:00:00.000Z')
    expect(readConsent(store)).toEqual({
      decision: 'granted',
      policyVersion: 1,
      decidedAt: '2026-11-24T10:00:00.000Z'
    })
    expect(store.getKv(CONSENT_KV)).not.toBeNull()
  })

  it('损坏的 JSON 当作没有记录，不让界面崩', () => {
    store.setKv(CONSENT_KV, '{oops')
    expect(readConsent(store)).toBeNull()
  })

  it('拒绝也照实记录（下次不再打扰）', () => {
    writeConsent(store, 'declined', 1)
    expect(readConsent(store)?.decision).toBe('declined')
  })
})

describe('心跳到落库的整条链路', () => {
  const installId = 'inst_0123456789abcdef0123456789abcdef'
  const logger = { warn: () => undefined, info: () => undefined } as unknown as Logger

  function makeTracker(now: () => number, enabled = true, focused = true): UsageTracker {
    return new UsageTracker({
      store,
      logger,
      enabled: () => enabled,
      installId: () => installId,
      isFocused: () => focused,
      getIdleSeconds: () => 0,
      now,
      timezoneOffsetMinutes: () => -480,
      heartbeatMs: 30_000,
      persistMs: 60_000
    })
  }

  it('两次 30 秒心跳后落库 60 秒，并记一次启动', () => {
    let clock = Date.parse('2026-11-24T02:00:00Z') // 北京 10:00
    const tracker = makeTracker(() => clock)
    tracker.noteLaunch()
    tracker.tick() // 建立基准，不累加
    clock += 30_000
    tracker.tick()
    clock += 30_000
    tracker.tick() // 满 60 秒，触发落库
    tracker.flush()

    const row = store.listUsageRows(installId)[0]
    expect(row?.day).toBe('2026-11-24')
    expect(row?.activeSeconds).toBe(60)
    expect(row?.aliveSeconds).toBe(60)
    expect(row?.launches).toBe(1)
  })

  it('窗口不在前台时只记存活，不记活跃', () => {
    let clock = Date.parse('2026-11-24T02:00:00Z')
    const tracker = makeTracker(() => clock, true, false)
    tracker.tick()
    clock += 30_000
    tracker.tick()
    tracker.flush()

    const row = store.listUsageRows(installId)[0]
    expect(row?.activeSeconds).toBe(0)
    expect(row?.aliveSeconds).toBe(30)
  })

  it('关掉开关后不再累加，但基准照常推进', () => {
    let clock = Date.parse('2026-11-24T02:00:00Z')
    let enabled = false
    const tracker = new UsageTracker({
      store,
      logger,
      enabled: () => enabled,
      installId: () => installId,
      isFocused: () => true,
      getIdleSeconds: () => 0,
      now: () => clock,
      timezoneOffsetMinutes: () => -480
    })
    tracker.noteLaunch()
    tracker.tick()
    clock += 30_000
    tracker.tick()
    tracker.flush()
    expect(store.listUsageRows(installId)).toHaveLength(0)

    enabled = true
    clock += 30_000
    tracker.tick()
    tracker.flush()
    const row = store.listUsageRows(installId)[0]
    expect(row?.activeSeconds).toBe(30)
    expect(row?.launches).toBe(0)
  })
})
