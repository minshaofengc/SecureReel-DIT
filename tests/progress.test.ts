/**
 * 总进度口径的测试。
 *
 * 这一组用例守的是**用户能看见的那个数字**，所以标准比"能算出来"高：
 *
 *   1. 必须单调不减 —— 进度条往后退比数字不准更让人恼火，也更像软件坏了
 *   2. 必须包含校验阶段 —— 否则收尾时会停在接近 100% 一动不动
 *   3. 结束时必须是 100% —— 差 1% 会让人等着不走
 *
 * 第 1 条是重点：最早的一版口径（只统计源字节、分母随调度增长）在
 * 多文件场景下会出现 66% → 40% 这种**倒退**。下面有一条模拟用例专门盯着它。
 */
import { describe, expect, it } from 'vitest'
import { computeOverallPercent, planTotalBytes } from '../src/shared/progress'

describe('计划总工作量', () => {
  it('= 总字节 × (1 + 要校验的遍数)', () => {
    expect(planTotalBytes(1000, 0)).toBe(1000)
    expect(planTotalBytes(1000, 1)).toBe(2000)
    expect(planTotalBytes(1000, 3)).toBe(4000)
  })

  it('空任务与负数遍数都不会算出负分母', () => {
    expect(planTotalBytes(0, 2)).toBe(0)
    expect(planTotalBytes(-5, 2)).toBe(0)
    expect(planTotalBytes(100, -1)).toBe(100)
  })
})

describe('总进度', () => {
  const base = {
    totalBytes: 1000,
    verifyPasses: 1,
    filesSettled: 0,
    totalFiles: 2
  }

  it('刚开始是 0', () => {
    expect(computeOverallPercent({ ...base, copiedBytes: 0, verifyBytesDone: 0 })).toBe(0)
  })

  it('拷贝读完但一遍校验都还没做时是 50%，不是 100%', () => {
    // 分母 = 1000 × (1 + 1) = 2000；拷贝只贡献了其中一半。
    // 老口径这里会显示 100% —— 那正是"卡在 100% 不动"的来源。
    expect(computeOverallPercent({ ...base, copiedBytes: 1000, verifyBytesDone: 0 })).toBe(50)
  })

  it('校验做完才到 100%', () => {
    expect(computeOverallPercent({ ...base, copiedBytes: 1000, verifyBytesDone: 1000 })).toBe(100)
  })

  it('不校验时（verifyPasses = 0）读完整份就是 100%', () => {
    expect(
      computeOverallPercent({
        ...base,
        verifyPasses: 0,
        copiedBytes: 1000,
        verifyBytesDone: 0
      })
    ).toBe(100)
  })

  it('全部文件判定完就直接 100%，不去纠结还剩几个字节', () => {
    // 现实里总有"某些校验本来不会发生"的情况（目标被停用、盘中途掉线）。
    // 与其卡在 97% 让人干等，不如据实收尾。
    expect(
      computeOverallPercent({
        ...base,
        copiedBytes: 900,
        verifyBytesDone: 900,
        filesSettled: 2
      })
    ).toBe(100)
  })

  it('拷贝量超过总量时不会超过 100%', () => {
    expect(computeOverallPercent({ ...base, copiedBytes: 9999, verifyBytesDone: 0 })).toBe(50)
  })

  it('空任务（没有字节）返回 0，不会变成 NaN', () => {
    const value = computeOverallPercent({
      totalBytes: 0,
      copiedBytes: 0,
      verifyBytesDone: 0,
      verifyPasses: 1,
      filesSettled: 0,
      totalFiles: 0
    })
    expect(value).toBe(0)
    // NaN 会让进度条宽度算成字符串 "NaN%" 被 CSS 丢掉，界面上是"条不见了"
    expect(Number.isFinite(value)).toBe(true)
  })

  it('全是 0 字节文件时用文件数兜一个进度', () => {
    expect(
      computeOverallPercent({
        totalBytes: 0,
        copiedBytes: 0,
        verifyBytesDone: 0,
        verifyPasses: 1,
        filesSettled: 1,
        totalFiles: 4
      })
    ).toBe(25)
  })

  it('非法输入不会漏出 NaN', () => {
    const value = computeOverallPercent({
      totalBytes: Number.NaN,
      copiedBytes: Number.NaN,
      verifyBytesDone: Number.NaN,
      verifyPasses: 1,
      filesSettled: 0,
      totalFiles: 3
    })
    expect(Number.isFinite(value)).toBe(true)
  })
})

describe('多文件场景：进度绝不能倒退', () => {
  /*
   * 模拟"两个 50 字节的文件、一个目标、要校验"：
   *   A 拷完 → A 校验 → B 拷完 → B 校验 → 收尾
   *
   * 分母固定在 100 × (1 + 1) = 200。
   * 这一串正是老口径出问题的场景：分母随文件被安排校验而增长，
   * 于是在"B 开始拷"那一刻进度从 66% 掉回 40%。
   */
  it('两个文件的整个生命周期里单调不减，且收尾为 100%', () => {
    const TOTAL = 100
    const PASSES = 1
    const steps: { label: string; copiedBytes: number; verifyBytesDone: number; filesSettled: number }[] = [
      { label: '起步', copiedBytes: 0, verifyBytesDone: 0, filesSettled: 0 },
      { label: 'A 拷到一半', copiedBytes: 25, verifyBytesDone: 0, filesSettled: 0 },
      { label: 'A 拷完（等校验）', copiedBytes: 50, verifyBytesDone: 0, filesSettled: 0 },
      { label: 'A 校验完成', copiedBytes: 50, verifyBytesDone: 50, filesSettled: 1 },
      { label: 'B 拷到一半', copiedBytes: 75, verifyBytesDone: 50, filesSettled: 1 },
      { label: 'B 拷完（等校验）', copiedBytes: 100, verifyBytesDone: 50, filesSettled: 1 },
      { label: 'B 校验完成', copiedBytes: 100, verifyBytesDone: 100, filesSettled: 2 }
    ]

    const values = steps.map((step) =>
      computeOverallPercent({
        totalBytes: TOTAL,
        copiedBytes: step.copiedBytes,
        verifyBytesDone: step.verifyBytesDone,
        verifyPasses: PASSES,
        filesSettled: step.filesSettled,
        totalFiles: 2
      })
    )

    for (let i = 1; i < values.length; i++) {
      const previous = values[i - 1] as number
      const current = values[i] as number
      // 断言里带上标签，失败时一眼能看出是哪一步倒退了
      expect(
        current,
        `${steps[i]?.label ?? ''} 出现倒退：${previous}% → ${current}%`
      ).toBeGreaterThanOrEqual(previous)
    }

    expect(values[0]).toBe(0)
    expect(values.at(-1)).toBe(100)
  })

  it('三个目标时校验占三分之二的工作量', () => {
    // 每个源字节要被读 1 遍 + 被 3 个目标各重读 1 遍 = 4 份工作量
    expect(
      computeOverallPercent({
        totalBytes: 100,
        copiedBytes: 100,
        verifyBytesDone: 0,
        verifyPasses: 3,
        filesSettled: 0,
        totalFiles: 1
      })
    ).toBe(25)
  })
})
