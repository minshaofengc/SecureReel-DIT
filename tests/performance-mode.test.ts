/**
 * 「性能模式」档位 → 细项映射的契约。
 *
 * 档位是"一键套用"，所以它最容易坏在**映射本身写错**：
 * 比如极速档忘了把并行数拉高，或静默档把"拷完弹出"关掉了 ——
 * 这种错不会报错，只会让用户觉得"这个档位没用"。
 */
import { describe, expect, it } from 'vitest'
import { PERFORMANCE_MODES, PERFORMANCE_MODE_PRESETS } from '../src/shared/types'

describe('性能档位预设', () => {
  it('每个档位都有预设', () => {
    for (const mode of PERFORMANCE_MODES) {
      expect(PERFORMANCE_MODE_PRESETS[mode]).toBeDefined()
    }
  })

  it('每个档位的并行数都在合法区间（schema 是 1–8）', () => {
    for (const mode of PERFORMANCE_MODES) {
      const value = PERFORMANCE_MODE_PRESETS[mode].maxParallelTargets
      expect(value).toBeGreaterThanOrEqual(1)
      expect(value).toBeLessThanOrEqual(8)
    }
  })

  it('档位越高并行数越大（静默 ≤ 标准 ≤ 极速）', () => {
    expect(PERFORMANCE_MODE_PRESETS.quiet.maxParallelTargets).toBeLessThan(
      PERFORMANCE_MODE_PRESETS.standard.maxParallelTargets
    )
    expect(PERFORMANCE_MODE_PRESETS.standard.maxParallelTargets).toBeLessThan(
      PERFORMANCE_MODE_PRESETS.turbo.maxParallelTargets
    )
  })

  it('极速档把并行拉到最高（8）', () => {
    expect(PERFORMANCE_MODE_PRESETS.turbo.maxParallelTargets).toBe(8)
  })

  it('静默档拷完弹出目标盘（省得人去拔）', () => {
    expect(PERFORMANCE_MODE_PRESETS.quiet.ejectAfterCopy).toBe(true)
  })

  it('没有任何档位默认开启关机（破坏性操作，必须手动开）', () => {
    for (const mode of PERFORMANCE_MODES) {
      expect(PERFORMANCE_MODE_PRESETS[mode].shutdownAfterCopy).toBe(false)
    }
  })

  it('断点续传在所有档位都开着（没有理由关）', () => {
    for (const mode of PERFORMANCE_MODES) {
      expect(PERFORMANCE_MODE_PRESETS[mode].resumePartialFiles).toBe(true)
    }
  })
})
