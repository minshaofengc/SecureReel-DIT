/**
 * 文件状态的前进规则。
 *
 * 这条规则是"界面不会倒退"的最后一道兜底：中间态是延迟 200ms 合并发送的，
 * 完全可能晚于终态到达。与其在主进程的每一条结清路径上都记得撤销一次
 * （漏掉任何一条 —— 冲突、取消、异常分支 —— 界面就会倒退），
 * 不如在这里用一条无状态规则挡住：漏不掉。
 */
import { describe, expect, it } from 'vitest'
import { FILE_STATES, isFileStateSettled, shouldApplyFileStateChange } from '../src/shared/types'

describe('文件状态前进规则', () => {
  it('"落定"的名单与 FILE_STATES 保持同步', () => {
    const settled = FILE_STATES.filter((state) => isFileStateSettled(state))
    // 新增状态时这条会红：逼你想清楚它算不算终态
    expect([...settled].sort()).toEqual(['cancelled', 'failed', 'skipped', 'verified'])
  })

  it('迟到的中间态不会把已落定的行打回去', () => {
    expect(shouldApplyFileStateChange('verified', 'copying')).toBe(false)
    expect(shouldApplyFileStateChange('verified', 'verifying')).toBe(false)
    expect(shouldApplyFileStateChange('failed', 'copying')).toBe(false)
    expect(shouldApplyFileStateChange('cancelled', 'verifying')).toBe(false)
    expect(shouldApplyFileStateChange('skipped', 'copying')).toBe(false)
  })

  it('处理中的行接受正常推进', () => {
    expect(shouldApplyFileStateChange('pending', 'copying')).toBe(true)
    expect(shouldApplyFileStateChange('copying', 'verifying')).toBe(true)
    expect(shouldApplyFileStateChange('verifying', 'verified')).toBe(true)
  })

  it('落定态之间仍可互相改写（重试成功、复核推翻结论）', () => {
    expect(shouldApplyFileStateChange('failed', 'verified')).toBe(true)
    expect(shouldApplyFileStateChange('verified', 'failed')).toBe(true)
  })
})
