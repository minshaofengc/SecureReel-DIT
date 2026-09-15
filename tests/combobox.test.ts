/**
 * 自研下拉的纯逻辑测试。
 *
 * 为什么只测 shared/combobox.ts：这里放的是最容易写错、错了又不报错的两件事 ——
 * 「哪些选项被筛出来」和「触发器里显示什么字」。键盘、焦点、定位那些属于
 * 渲染层，要测就得引 jsdom + testing-library，而这两样与本项目
 * 「依赖越少越稳、离线可用」的原则冲突（见 ui.tsx 开头）。所以把逻辑抽出来，
 * 换来的是零新依赖下能覆盖最危险的部分。
 */
import { describe, expect, it } from 'vitest'
import {
  clampIndex,
  filterOptions,
  flatten,
  labelOf,
  moveActive,
  resolveTriggerText,
  type ComboGroup,
  type ComboOption
} from '@shared/combobox'

const FLAT: ComboOption<string>[] = [
  { value: '', label: '未分组' },
  { value: 'p1', label: '母亲' },
  { value: 'p2', label: '父亲' }
]

const GROUPED: ComboGroup<string>[] = [
  { label: '母亲', options: [{ value: 'j1', label: 'A002 卡' }, { value: 'j2', label: 'A003 卡' }] },
  { label: '父亲', options: [{ value: 'j3', label: 'B001 卡' }] }
]

describe('flatten', () => {
  it('无分组时每项都不带 group', () => {
    const flat = flatten(FLAT, undefined)
    expect(flat).toHaveLength(3)
    expect(flat.every((option) => option.group === undefined)).toBe(true)
    expect(flat.every((option) => option.groupStart === undefined)).toBe(true)
  })

  it('有分组时每项都记住自己属于哪一组', () => {
    const flat = flatten(undefined, GROUPED)
    expect(flat.map((option) => option.group)).toEqual(['母亲', '母亲', '父亲'])
  })

  it('两种输入都给时是拼接：裸选项在前，分组在后', () => {
    // 报告页就是这么用的 ——「请选择任务」排在按母项目分好的各组之上
    const head: ComboOption<string>[] = [{ value: '', label: '请选择任务' }]
    const flat = flatten(head, GROUPED)
    expect(flat.map((option) => option.value)).toEqual(['', 'j1', 'j2', 'j3'])
    // 裸选项不属于任何组；groupStart 是筛完之后才算出来的，这里只该有 group
    expect(flat[0]?.group).toBeUndefined()
    expect(flat[0]?.groupStart).toBeUndefined()
    expect(flat[1]?.group).toBe('母亲')
  })

  it('两种输入都是 undefined 时返回空数组，不抛错', () => {
    expect(flatten(undefined, undefined)).toEqual([])
  })
})

describe('filterOptions', () => {
  it('空查询返回全部，且不改动分组归属', () => {
    const flat = flatten(undefined, GROUPED)
    expect(filterOptions(flat, '').map((option) => option.value)).toEqual(['j1', 'j2', 'j3'])
  })

  it('查询只留匹配项', () => {
    const flat = flatten(FLAT, undefined)
    expect(filterOptions(flat, '父').map((option) => option.value)).toEqual(['p2'])
  })

  it('大小写不敏感', () => {
    const options: ComboOption<string>[] = [{ value: 'md5', label: 'MD5' }]
    expect(filterOptions(flatten(options, undefined), 'md5')).toHaveLength(1)
  })

  it('动作项永远不被筛掉 —— 否则「新建母项目」会在打字时凭空消失', () => {
    const options: ComboOption<string>[] = [
      { value: 'p1', label: '母亲' },
      { value: '__new__', label: '+ 新建母项目…', tone: 'action' }
    ]
    const result = filterOptions(flatten(options, undefined), 'zzz')
    expect(result.map((option) => option.value)).toEqual(['__new__'])
  })

  it('分组标题标在筛完之后的第一项上，而不是原来那一项上', () => {
    const flat = flatten(undefined, GROUPED)
    // 「A002」被筛掉之后，标题必须落到「A003」上，否则界面上会出现一个没有内容的组
    const result = filterOptions(flat, 'A003')
    expect(result).toHaveLength(1)
    expect(result[0]?.groupStart).toBe('母亲')
  })

  it('整组被筛空时，这一组的标题不出现', () => {
    const flat = flatten(undefined, GROUPED)
    const result = filterOptions(flat, 'B001')
    expect(result).toHaveLength(1)
    expect(result[0]?.groupStart).toBe('父亲')
    expect(result.some((option) => option.groupStart === '母亲')).toBe(false)
  })

  it('筛完之后的每一项都只带自己的那一份 group 信息', () => {
    const flat = flatten(undefined, GROUPED)
    const result = filterOptions(flat, '')
    // group 只用于内部重新标起点，渲染靠的是 groupStart
    expect(result[0]?.groupStart).toBe('母亲')
    expect(result[1]?.groupStart).toBeUndefined()
    expect(result[2]?.groupStart).toBe('父亲')
  })

  it('前面挂着裸选项时，分组标题照样落在筛完后的第一项上', () => {
    const head: ComboOption<string>[] = [{ value: '', label: '请选择任务' }]
    const flat = flatten(head, GROUPED)
    const result = filterOptions(flat, 'A003')
    expect(result.map((option) => option.value)).toEqual(['j2'])
    expect(result[0]?.groupStart).toBe('母亲')
  })
})

describe('labelOf', () => {
  it('找得到就返回 label', () => {
    expect(labelOf(flatten(FLAT, undefined), 'p2')).toBe('父亲')
  })

  it('找不到返回 undefined —— 删掉当前母项目之后真会发生，调用方必须容忍', () => {
    expect(labelOf(flatten(FLAT, undefined), 'gone')).toBeUndefined()
  })
})

describe('clampIndex / moveActive', () => {
  it('下标越界就夹回来', () => {
    expect(clampIndex(9, 3)).toBe(2)
    expect(clampIndex(-4, 3)).toBe(0)
  })

  it('列表为空时返回 0，调用方靠 length 判断有没有可选项', () => {
    expect(clampIndex(5, 0)).toBe(0)
    expect(moveActive(0, 1, 0)).toBe(0)
  })

  it('方向键到顶到底停住，不循环', () => {
    expect(moveActive(0, -1, 3)).toBe(0)
    expect(moveActive(2, 1, 3)).toBe(2)
    expect(moveActive(1, 1, 3)).toBe(2)
  })
})

describe('resolveTriggerText', () => {
  it('仅选择模式：不打字时显示当前值的 label', () => {
    expect(resolveTriggerText(true, 'p1', '', false, '母亲')).toBe('母亲')
  })

  it('仅选择模式：打字期间显示打的字', () => {
    expect(resolveTriggerText(true, 'p1', '父', true, '母亲')).toBe('父')
  })

  it('仅选择模式：面板收起后立刻退回当前真值 —— 这就是"取消打字"的全部机制', () => {
    expect(resolveTriggerText(true, 'p1', '', false, '母亲')).toBe('母亲')
  })

  it('仅选择模式：面板开着但没打字，仍显示真值（不是空）', () => {
    expect(resolveTriggerText(true, 'p1', '', true, '母亲')).toBe('母亲')
  })

  it('仅选择模式：value 不在选项里时渲染空串，不出现 undefined', () => {
    expect(resolveTriggerText(true, 'gone', '', false, undefined)).toBe('')
  })

  it('自由输入模式：输入框里的字就是 value，恒等', () => {
    expect(resolveTriggerText(false, '航拍', '', false, undefined)).toBe('航拍')
    expect(resolveTriggerText(false, '航拍', '航拍', true, '导演')).toBe('航拍')
  })
})
