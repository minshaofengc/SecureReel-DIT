/**
 * 提示音的触发时机。
 *
 * 声音本身没法断言，但"什么时候该响、什么时候不该响"可以断言 ——
 * 而那恰恰是最容易做错的地方：每次收到事件都响、或者用户自己取消也要响一声。
 *
 * 注意这里引的是 `@shared/types` 里的纯函数，不是 `renderer/src/sound.ts`：
 * 后者用到 DOM 的 AudioContext，引进来会把 DOM 类型拖进主进程的编译范围。
 */
import { describe, expect, it } from 'vitest'
import { cueForJobState } from '../src/shared/types'

describe('提示音的触发时机', () => {
  it('任务排进队列 → 开始音', () => {
    expect(cueForJobState('draft', 'queued')).toBe('start')
    // 重跑一个已经结束的任务同样算"开始"
    expect(cueForJobState('completed', 'queued')).toBe('start')
  })

  it('正常跑完 → 完成音', () => {
    expect(cueForJobState('running', 'completed')).toBe('done')
  })

  it('有文件没通过、或任务整体失败 → 出错音', () => {
    expect(cueForJobState('running', 'completed-with-errors')).toBe('error')
    expect(cueForJobState('running', 'failed')).toBe('error')
  })

  it('用户主动取消不响 —— 那是他自己按的，不需要再被提醒一次', () => {
    expect(cueForJobState('running', 'cancelled')).toBeNull()
    expect(cueForJobState('queued', 'cancelled')).toBeNull()
  })

  it('暂停与继续不响', () => {
    expect(cueForJobState('running', 'paused')).toBeNull()
    expect(cueForJobState('paused', 'running')).toBeNull()
  })

  it('状态没变就不响 —— 同一次变化不能被响两遍', () => {
    expect(cueForJobState('completed', 'completed')).toBeNull()
    expect(cueForJobState('queued', 'queued')).toBeNull()
    expect(cueForJobState('running', 'running')).toBeNull()
  })
})
