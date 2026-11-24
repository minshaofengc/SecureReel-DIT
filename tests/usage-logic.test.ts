/**
 * 使用统计的纯逻辑。
 *
 * 这里钉的是三件最容易出错、手工又很难覆盖的事：
 *   1. 跨零点那一跳要把时间拆到两天（否则跨天时段整段算错）；
 *   2. 休眠 / 改系统时间不能让"在线时长"凭空变长；
 *   3. 重试与重复投递不能把数字放大（服务端 MAX 合并的前提是发绝对值）。
 */
import { describe, expect, it } from 'vitest'
import {
  accrue,
  backoffMs,
  clampDaySeconds,
  clampTickSeconds,
  classifyTick,
  dayKeyOf,
  formatInstallId,
  isReportingEnabled,
  isValidInstallId,
  MAX_DAY_SECONDS,
  MAX_TICK_SECONDS,
  needsConsent,
  nextLocalMidnight,
  selectBatch,
  splitIntervalAcrossDays,
  toPayloadDay,
  type UsageDayRow
} from '@shared/usage'

/** UTC+8 的 JS 偏移值是 -480。 */
const UTC8 = -480

describe('本地日与跨零点切分', () => {
  it('按本地时区算日期，不按 UTC', () => {
    // 2026-11-24T15:59:59Z = 北京时间 23:59:59
    expect(dayKeyOf(Date.parse('2026-11-24T15:59:59Z'), UTC8)).toBe('2026-11-24')
    // 2026-11-24T16:00:00Z = 北京时间次日 00:00:00
    expect(dayKeyOf(Date.parse('2026-11-24T16:00:00Z'), UTC8)).toBe('2026-11-25')
    // UTC 本身（偏移 0）
    expect(dayKeyOf(Date.parse('2026-11-24T23:59:59Z'), 0)).toBe('2026-11-24')
  })

  it('下一个本地零点换算回 UTC 毫秒', () => {
    const at = Date.parse('2026-11-24T15:00:00Z') // 北京 23:00
    expect(nextLocalMidnight(at, UTC8)).toBe(Date.parse('2026-11-24T16:00:00Z'))
  })

  it('跨零点的一跳拆成两行：10 秒 + 20 秒', () => {
    const from = Date.parse('2026-11-24T15:59:50Z') // 北京 23:59:50
    const to = Date.parse('2026-11-24T16:00:20Z') // 北京次日 00:00:20
    expect(splitIntervalAcrossDays(from, to, UTC8)).toEqual([
      { day: '2026-11-24', seconds: 10 },
      { day: '2026-11-25', seconds: 20 }
    ])
  })

  it('同一天内不拆', () => {
    const from = Date.parse('2026-11-24T02:00:00Z')
    const to = Date.parse('2026-11-24T02:00:30Z')
    expect(splitIntervalAcrossDays(from, to, UTC8)).toEqual([{ day: '2026-11-24', seconds: 30 }])
  })

  it('时间倒流或相等返回空数组，不抛异常', () => {
    const at = Date.parse('2026-11-24T02:00:00Z')
    expect(splitIntervalAcrossDays(at, at, UTC8)).toEqual([])
    expect(splitIntervalAcrossDays(at, at - 1000, UTC8)).toEqual([])
    expect(splitIntervalAcrossDays(Number.NaN, at, UTC8)).toEqual([])
  })

  it('跨多天时每天各记一段', () => {
    const from = Date.parse('2026-11-22T15:00:00Z') // 北京 11-22 23:00
    const to = Date.parse('2026-11-24T17:00:00Z') // 北京 11-25 01:00
    const rows = splitIntervalAcrossDays(from, to, UTC8)
    expect(rows.map((row) => row.day)).toEqual([
      '2026-11-22',
      '2026-11-23',
      '2026-11-24',
      '2026-11-25'
    ])
    expect(rows[0]?.seconds).toBe(3600)
    expect(rows[1]?.seconds).toBe(86_400)
    expect(rows[2]?.seconds).toBe(86_400)
    expect(rows[3]?.seconds).toBe(3600)
  })
})

describe('活跃判定', () => {
  it('窗口在前台且系统无操作 → 算活跃', () => {
    expect(classifyTick({ focused: true, idleSeconds: 10, locked: false })).toBe('active')
    expect(classifyTick({ focused: true, idleSeconds: 59, locked: false })).toBe('active')
  })

  it('空闲到 60 秒就不再算活跃', () => {
    expect(classifyTick({ focused: true, idleSeconds: 60, locked: false })).toBe('alive')
    expect(classifyTick({ focused: true, idleSeconds: 600, locked: false })).toBe('alive')
  })

  it('窗口不在前台只算进程存活', () => {
    expect(classifyTick({ focused: false, idleSeconds: 0, locked: false })).toBe('alive')
  })

  it('锁屏时即使窗口"聚焦"也只算存活', () => {
    expect(classifyTick({ focused: true, idleSeconds: 0, locked: true })).toBe('alive')
  })
})

describe('时钟钳制', () => {
  it('负数与非法值归零', () => {
    expect(clampTickSeconds(-30)).toBe(0)
    expect(clampTickSeconds(Number.NaN)).toBe(0)
    expect(clampTickSeconds(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('正常一跳原样通过', () => {
    expect(clampTickSeconds(30)).toBe(30)
  })

  it('休眠或改系统时间不能超过三倍心跳', () => {
    expect(MAX_TICK_SECONDS).toBe(90)
    expect(clampTickSeconds(1000)).toBe(90)
    expect(clampTickSeconds(86_400)).toBe(90)
  })

  it('一天最多 86400 秒', () => {
    expect(clampDaySeconds(1000)).toBe(1000)
    expect(clampDaySeconds(90_000)).toBe(MAX_DAY_SECONDS)
  })
})

describe('累加', () => {
  const base: UsageDayRow = {
    day: '2026-11-24',
    activeSeconds: 100,
    aliveSeconds: 200,
    launches: 1,
    dirty: false,
    attempts: 3,
    nextAttemptAt: 999
  }

  it('累加后重新标记为待发送，并清掉退避状态', () => {
    const next = accrue(base, { activeSeconds: 30, aliveSeconds: 30, launches: 0 })
    expect(next.activeSeconds).toBe(130)
    expect(next.aliveSeconds).toBe(230)
    expect(next.dirty).toBe(true)
    expect(next.attempts).toBe(0)
    expect(next.nextAttemptAt).toBe(0)
  })

  it('不改原对象', () => {
    accrue(base, { activeSeconds: 30, aliveSeconds: 30, launches: 0 })
    expect(base.activeSeconds).toBe(100)
  })

  it('存活秒数永远不小于活跃秒数', () => {
    const next = accrue(
      { ...base, activeSeconds: 0, aliveSeconds: 0 },
      { activeSeconds: 30, aliveSeconds: 0, launches: 0 }
    )
    expect(next.activeSeconds).toBe(30)
    expect(next.aliveSeconds).toBe(30)
  })

  it('负数增量按 0 处理', () => {
    const next = accrue(base, { activeSeconds: -50, aliveSeconds: -50, launches: -1 })
    expect(next.activeSeconds).toBe(100)
    expect(next.aliveSeconds).toBe(200)
    expect(next.launches).toBe(1)
  })
})

describe('失败退避', () => {
  it('按 1 分 → 5 分 → 30 分 → 2 时 → 12 时 → 24 时递增并封顶', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n))).toEqual([
      60_000, 300_000, 1_800_000, 7_200_000, 43_200_000, 86_400_000
    ])
    expect(backoffMs(99)).toBe(86_400_000)
  })

  it('0 次与非法值都按第一次退避', () => {
    expect(backoffMs(0)).toBe(60_000)
    expect(backoffMs(Number.NaN)).toBe(60_000)
  })
})

describe('批量选取', () => {
  const rows: UsageDayRow[] = [
    { day: '2026-11-24', activeSeconds: 1, aliveSeconds: 1, launches: 0, dirty: true, attempts: 0, nextAttemptAt: 0 },
    { day: '2026-11-22', activeSeconds: 1, aliveSeconds: 1, launches: 0, dirty: true, attempts: 0, nextAttemptAt: 0 },
    { day: '2026-11-23', activeSeconds: 1, aliveSeconds: 1, launches: 0, dirty: false, attempts: 0, nextAttemptAt: 0 },
    { day: '2026-11-21', activeSeconds: 1, aliveSeconds: 1, launches: 0, dirty: true, attempts: 2, nextAttemptAt: 9_000 }
  ]

  it('只取脏的、到点的，按日期升序', () => {
    expect(selectBatch(rows, 1_000).map((row) => row.day)).toEqual(['2026-11-22', '2026-11-24'])
  })

  it('未到退避时间的跳过', () => {
    expect(selectBatch(rows, 10_000).map((row) => row.day)).toEqual(['2026-11-21', '2026-11-22', '2026-11-24'])
  })

  it('遵守批量上限', () => {
    expect(selectBatch(rows, 1_000, 1)).toHaveLength(1)
  })
})

describe('安装 ID', () => {
  it('只接受 inst_ + 32 位小写十六进制', () => {
    expect(isValidInstallId('inst_0123456789abcdef0123456789abcdef')).toBe(true)
    expect(isValidInstallId('inst_0123456789ABCDEF0123456789ABCDEF')).toBe(false)
    expect(isValidInstallId('inst_123')).toBe(false)
    expect(isValidInstallId('0123456789abcdef0123456789abcdef')).toBe(false)
    expect(isValidInstallId(null)).toBe(false)
  })

  it('格式化后能通过校验', () => {
    const id = formatInstallId('0123456789ABCDEF0123456789ABCDEF')
    expect(id).toBe('inst_0123456789abcdef0123456789abcdef')
    expect(isValidInstallId(id)).toBe(true)
  })
})

describe('同意状态', () => {
  it('从未征求过 → 需要征求', () => {
    expect(needsConsent(null)).toBe(true)
  })

  it('当前版本已同意 / 已拒绝 → 都不再打扰', () => {
    expect(needsConsent({ decision: 'granted', policyVersion: 1, decidedAt: '' })).toBe(false)
    expect(needsConsent({ decision: 'declined', policyVersion: 1, decidedAt: '' })).toBe(false)
  })

  it('政策版本升级 → 重新征求', () => {
    expect(needsConsent({ decision: 'granted', policyVersion: 0, decidedAt: '' }, 1)).toBe(true)
  })

  it('只有「同意 + 设置开着」才上报', () => {
    const granted = { decision: 'granted' as const, policyVersion: 1, decidedAt: '' }
    const declined = { decision: 'declined' as const, policyVersion: 1, decidedAt: '' }
    expect(isReportingEnabled(granted, true)).toBe(true)
    expect(isReportingEnabled(granted, false)).toBe(false)
    expect(isReportingEnabled(declined, true)).toBe(false)
    expect(isReportingEnabled(null, true)).toBe(false)
    expect(isReportingEnabled({ ...granted, policyVersion: 0 }, true)).toBe(false)
  })
})

describe('发送前钳制', () => {
  it('越界数据被压回合法范围', () => {
    const payload = toPayloadDay({
      day: '2026-11-24',
      activeSeconds: 90_000,
      aliveSeconds: 10,
      launches: 999,
      dirty: true,
      attempts: 0,
      nextAttemptAt: 0
    })
    expect(payload.activeSeconds).toBe(86_400)
    expect(payload.aliveSeconds).toBe(86_400)
    expect(payload.launches).toBe(50)
  })
})
