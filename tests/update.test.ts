/**
 * 更新检查的纯逻辑。
 *
 * 这里钉的是"什么时候该说、说几次"——更新提示最容易出的两个毛病是
 * **每次启动都弹同一个版本**和**版本号按字符串比大小**（2.0.10 < 2.0.9）。
 * 两者都只能靠单测拦住，手工试很难覆盖。
 */
import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  isNewerVersion,
  parseVersion,
  shouldAutoCheck,
  shouldNotifyVersion,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_NOTIFY_INTERVAL_MS,
  UPDATE_RETRY_AFTER_FAILURE_MS
} from '@shared/update'

describe('版本解析', () => {
  it('接受带 v 前缀、预发布后缀与两段式', () => {
    expect(parseVersion('2.0.10')).toEqual({ major: 2, minor: 0, patch: 10 })
    expect(parseVersion('v2.0.9')).toEqual({ major: 2, minor: 0, patch: 9 })
    expect(parseVersion('2.0.9-beta.1')).toEqual({ major: 2, minor: 0, patch: 9 })
    expect(parseVersion('2.1')).toEqual({ major: 2, minor: 1, patch: 0 })
  })

  it('认不出的输入返回 null，而不是 0.0.0', () => {
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('release-latest')).toBeNull()
    expect(parseVersion('   ')).toBeNull()
  })
})

describe('版本比较', () => {
  it('按数字段比较，不是按字符串', () => {
    // 字符串比较下 "2.0.10" < "2.0.9"，这正是最经典的翻车点
    expect(compareVersions('2.0.10', '2.0.9')).toBeGreaterThan(0)
    expect(isNewerVersion('2.0.10', '2.0.9')).toBe(true)
    expect(isNewerVersion('2.0.9', '2.0.10')).toBe(false)
  })

  it('相同版本不算更新', () => {
    expect(compareVersions('v2.0.10', '2.0.10')).toBe(0)
    expect(isNewerVersion('2.0.10', '2.0.10')).toBe(false)
  })

  it('解析失败时一律不提示更新', () => {
    expect(compareVersions('garbage', '2.0.10')).toBe(0)
    expect(isNewerVersion('garbage', '2.0.10')).toBe(false)
    expect(isNewerVersion('2.0.10', 'garbage')).toBe(false)
  })
})

describe('自动检查节流（7 天）', () => {
  const now = 1_800_000_000_000

  it('从未检查过 → 检查', () => {
    expect(shouldAutoCheck({ lastCheckAt: null, lastFailureAt: null, now })).toBe(true)
  })

  it('不满 7 天 → 不检查', () => {
    expect(
      shouldAutoCheck({
        lastCheckAt: now - UPDATE_CHECK_INTERVAL_MS + 1000,
        lastFailureAt: null,
        now
      })
    ).toBe(false)
  })

  it('满 7 天 → 检查', () => {
    expect(
      shouldAutoCheck({
        lastCheckAt: now - UPDATE_CHECK_INTERVAL_MS,
        lastFailureAt: null,
        now
      })
    ).toBe(true)
  })

  it('失败后一天内不重试，超过一天再试', () => {
    expect(
      shouldAutoCheck({
        lastCheckAt: null,
        lastFailureAt: now - UPDATE_RETRY_AFTER_FAILURE_MS + 1000,
        now
      })
    ).toBe(false)
    expect(
      shouldAutoCheck({
        lastCheckAt: null,
        lastFailureAt: now - UPDATE_RETRY_AFTER_FAILURE_MS,
        now
      })
    ).toBe(true)
  })

  it('失败冷却优先于成功窗口：刚失败过就不该马上再查', () => {
    expect(
      shouldAutoCheck({
        lastCheckAt: now - UPDATE_CHECK_INTERVAL_MS - 1,
        lastFailureAt: now - 1000,
        now
      })
    ).toBe(false)
  })
})

describe('提醒节流（同一版本 7 天一次）', () => {
  const now = 1_800_000_000_000
  const base = { currentVersion: '2.0.10', latestVersion: '2.0.11', now }

  it('有新版本、从没提醒过 → 提醒', () => {
    expect(
      shouldNotifyVersion({ ...base, lastNotifiedVersion: null, lastNotifiedAt: null })
    ).toBe(true)
  })

  it('同一版本 6 天前提醒过 → 不再提醒', () => {
    expect(
      shouldNotifyVersion({
        ...base,
        lastNotifiedVersion: '2.0.11',
        lastNotifiedAt: now - UPDATE_NOTIFY_INTERVAL_MS + 1000
      })
    ).toBe(false)
  })

  it('同一版本满 7 天 → 再提醒一次', () => {
    expect(
      shouldNotifyVersion({
        ...base,
        lastNotifiedVersion: '2.0.11',
        lastNotifiedAt: now - UPDATE_NOTIFY_INTERVAL_MS
      })
    ).toBe(true)
  })

  it('换了更新的版本 → 立刻提醒，不受上一个版本计时影响', () => {
    expect(
      shouldNotifyVersion({
        currentVersion: '2.0.10',
        latestVersion: '2.0.12',
        lastNotifiedVersion: '2.0.11',
        lastNotifiedAt: now - 1000,
        now
      })
    ).toBe(true)
  })

  it('没有新版本 → 永不提醒', () => {
    expect(
      shouldNotifyVersion({
        currentVersion: '2.0.10',
        latestVersion: '2.0.10',
        lastNotifiedVersion: null,
        lastNotifiedAt: null,
        now
      })
    ).toBe(false)
    expect(
      shouldNotifyVersion({
        currentVersion: '2.0.10',
        latestVersion: null,
        lastNotifiedVersion: null,
        lastNotifiedAt: null,
        now
      })
    ).toBe(false)
  })
})
