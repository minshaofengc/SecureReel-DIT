/**
 * HDE 机型推断测试。
 *
 * 重点**不是**"能认出 ALEXA"，而是"**不误认**"：
 * 早先的实现用 `path.includes('min')`，于是 `admin`、`minolta`、`administrator`
 * 这类普通路径会被判成 ALEXA Mini，把普通素材盘拖进 CODEX VFS / HDE 流程。
 * 所以下面的反例与正例同等重要 —— 修改判定规则时，反例组是安全网。
 */
import { describe, expect, it } from 'vitest'
import { describeModel, inferModel } from '../src/main/adapters/hde'
import type { HdeCameraModel } from '../src/shared/types'

/** 没有任何 HDE 内容特征：判定结果只能来自路径本身。 */
const noSignals = { arxCount: 0, zeroByteMediaCount: 0, hintInName: false }

function modelOf(path: string): HdeCameraModel {
  return inferModel(path, noSignals)
}

describe('inferModel · 正例（该认出来的要认出来）', () => {
  it('识别 ALEXA Mini 的各种写法', () => {
    expect(modelOf('/Volumes/ALEXA_MINI/A001')).toBe('alexa-mini')
    expect(modelOf('/Volumes/A001_MINI')).toBe('alexa-mini')
    expect(modelOf('/Volumes/A001MINI')).toBe('alexa-mini')
    expect(modelOf('/Volumes/MINI2_CARD')).toBe('alexa-mini')
    expect(modelOf('/Volumes/A001-Mini')).toBe('alexa-mini')
  })

  it('识别 ALEXA Mini LF，且不会被 Mini 规则抢先', () => {
    expect(modelOf('/Volumes/ALEXA MINI LF')).toBe('alexa-mini-lf')
    expect(modelOf('/Volumes/A001_MINILF')).toBe('alexa-mini-lf')
    expect(modelOf('/Volumes/mini-lf-02')).toBe('alexa-mini-lf')
  })

  it('识别 ALEXA 35 / 35 Xtreme', () => {
    expect(modelOf('/Volumes/ALEXA 35')).toBe('alexa-35')
    expect(modelOf('/Volumes/ALEXA35_CARD')).toBe('alexa-35')
    expect(modelOf('/Volumes/ALEXA 35 Xtreme')).toBe('alexa-35-xtreme')
    expect(modelOf('/Volumes/ALEXA35XTREME')).toBe('alexa-35-xtreme')
  })

  it('识别 ALEXA 265，但只认带 alexa 前缀的写法', () => {
    expect(modelOf('/Volumes/ALEXA 265')).toBe('alexa-265')
    expect(modelOf('/Volumes/ALEXA265')).toBe('alexa-265')
  })
})

describe('inferModel · 反例（绝不允许误判成 ALEXA Mini）', () => {
  const falsePositives = [
    '/Volumes/admin/DCIM',
    '/Users/administrator/cards',
    '/Volumes/MINOLTA_CARD',
    '/Volumes/minimal-footage',
    '/Volumes/SONY_MINING',
    '/Volumes/Miniature_Set',
    '/Volumes/DOMINIC_A001',
    '/Volumes/A001_TERMINAL'
  ]

  it.each(falsePositives)('%s 不应被认成任何 ALEXA 机型', (path) => {
    expect(modelOf(path)).toBe('unknown')
  })

  it('含 265 的普通卷标不会被认成 ALEXA 265', () => {
    expect(modelOf('/Volumes/A00265_CARD')).toBe('unknown')
    expect(modelOf('/Volumes/2026-05-2650_clip')).toBe('unknown')
  })
})

describe('inferModel · 内容特征兜底', () => {
  it('路径无型号信息但盘上有 .arx 时，按 Mini 家族处理', () => {
    expect(inferModel('/Volumes/A001', { ...noSignals, arxCount: 3 })).toBe('alexa-mini')
  })

  it('路径里有 HDE 提示词但没有 .arx 时，交回用户（unknown）', () => {
    expect(inferModel('/Volumes/CODEX_CARD', { ...noSignals, hintInName: true })).toBe('unknown')
  })
})

describe('describeModel', () => {
  it('机型都有可展示的中文说明', () => {
    expect(describeModel('alexa-mini')).toBe('ALEXA Mini')
    expect(describeModel('alexa-mini-lf')).toBe('ALEXA Mini LF')
    expect(describeModel('alexa-35')).toBe('ALEXA 35')
    expect(describeModel('alexa-35-xtreme')).toBe('ALEXA 35 Xtreme')
    expect(describeModel('alexa-265')).toBe('ALEXA 265')
    expect(describeModel('unknown')).toBe('未识别机型')
  })
})
