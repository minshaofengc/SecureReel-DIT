/**
 * 自研下拉的纯逻辑。
 *
 * 为什么单独放一个文件、而不是写在组件里：
 *   1. 这些函数不碰 DOM 也不碰 React，可以单独测。而 vitest 跑在 node 环境、
 *      既不处理 JSX 也不收 `.tsx` —— 逻辑留在组件文件里就永远测不到。
 *   2. 「哪些选项被筛出来」「当前高亮第几项」这两件事最容易写错，
 *      而且错了只会表现为"看着有点怪"，不会报错。单独一个文件能让测试直接对着它写。
 */

/** 一个选项。`value` 是真正落库的值，`label` 是给人看的字。 */
export interface ComboOption<T extends string> {
  value: T
  label: string
  /**
   * 动作项（如「+ 新建母项目…」）：它不是值，点了会触发一个动作而不是选择。
   * 渲染成带分隔线、用辅色的一行，与真实可选值区分开。
   */
  tone?: 'action'
  disabled?: boolean
}

/** 一组选项。目前只有报告页的任务下拉用得到（原生写法是 `<optgroup>`）。 */
export interface ComboGroup<T extends string> {
  label: string
  options: readonly ComboOption<T>[]
}

/**
 * 拍平之后的一项。
 *
 * 拍平的意义：有分组和没分组走**同一条**代码路径 —— 键盘索引、筛选、
 * 高亮全都只在一个一维数组上跑，不需要为分组写第二套逻辑。
 * `group` 记录归属，`groupStart` 是渲染期算出来的「这一项上面要画分组标题」。
 */
export interface FlatOption<T extends string> {
  value: T
  label: string
  tone?: 'action'
  disabled?: boolean
  /** 所属分组标题；无分组时是 undefined */
  group?: string
  /** 非空 = 这里要起一个新分组，值就是标题文案 */
  groupStart?: string
}

/**
 * 把 options / groups 拍平成一维。
 *
 * 两者是**拼接**关系，不是二选一：报告页的下拉就是这样 ——
 * 最前面一项「请选择任务」不属于任何母项目，它后面才跟着按母项目分好的组。
 * 拼接顺序永远是 options 在前、groups 在后，和原生 <select> 里
 * 「裸 option 写在 <optgroup> 前面」是同一个视觉结果。
 *
 * 拍平的意义见 FlatOption 的注释。
 */
export function flatten<T extends string>(
  options: readonly ComboOption<T>[] | undefined,
  groups: readonly ComboGroup<T>[] | undefined
): FlatOption<T>[] {
  const head = (options ?? []).map<FlatOption<T>>((option) => ({
    value: option.value,
    label: option.label,
    ...(option.tone === undefined ? {} : { tone: option.tone }),
    ...(option.disabled === undefined ? {} : { disabled: option.disabled })
  }))

  if (groups === undefined) return head

  return [
    ...head,
    ...groups.flatMap((group) =>
      group.options.map<FlatOption<T>>((option) => ({
        value: option.value,
        label: option.label,
        ...(option.tone === undefined ? {} : { tone: option.tone }),
        ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
        group: group.label
      }))
    )
  ]
}

/**
 * 按输入的文字筛选。
 *
 * 两条规则值得写下来：
 *   · **不筛掉动作项**。「+ 新建母项目…」不含用户打的字，但如果因为筛选就把它
 *     藏起来，用户会发现"想新建母项目时它不见了"，而且想不通为什么。
 *   · **分组标题跟着一起筛**：某一组一项都不剩，它的标题也不出现。
 *     这是靠"重新标起点"实现的 —— 而不是靠记住原来哪几项是组头。
 */
export function filterOptions<T extends string>(flat: readonly FlatOption<T>[], query: string): FlatOption<T>[] {
  const needle = query.trim().toLowerCase()
  const matched =
    needle === ''
      ? flat
      : flat.filter((option) => option.tone === 'action' || option.label.toLowerCase().includes(needle))

  const started = new Set<string>()
  return matched.map<FlatOption<T>>((option) => {
    const group = option.group
    const carried = {
      value: option.value,
      label: option.label,
      ...(option.tone === undefined ? {} : { tone: option.tone }),
      ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
      ...(group === undefined ? {} : { group })
    }
    if (group === undefined || started.has(group)) return carried
    started.add(group)
    return { ...carried, groupStart: group }
  })
}

/**
 * 找 value 对应的显示文字。找不到返回 undefined。
 *
 * 找不到是**正常情况**，不是错误：删掉当前选中的母项目之后，value 会短暂地
 * 指向一个已经不存在的选项。调用方必须容忍 undefined（渲染成空串），
 * 绝不能让 undefined 漏到界面上。
 */
export function labelOf<T extends string>(flat: readonly FlatOption<T>[], value: T): string | undefined {
  return flat.find((option) => option.value === value)?.label
}

/** 把下标夹进 [0, length-1]。length 为 0 时返回 0（调用方靠 length 判断有没有可选项）。 */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(index, length - 1))
}

/**
 * 方向键移动高亮。
 *
 * **到头就停住，不循环** —— 任务下拉可能有几十项，循环会让人彻底失去位置感，
 * 按着按着就不知道自己在列表的哪一端了。首尾用 Home / End 直达。
 */
export function moveActive(current: number, delta: number, length: number): number {
  if (length <= 0) return 0
  return clampIndex(current + delta, length)
}

/**
 * 算出触发器（输入框）里该显示什么字。
 *
 * 这是「自由输入」和「只能选」两种模式**唯一**真正的分叉点，所以单独拎出来测。
 *
 * 只选模式：打字期间显示输入的字，其余时候显示当前值的 label。
 *   于是「取消打字」= 把 query 清空，显示文字自然退回真值 ——
 *   不需要（也绝不能）反过来去改 value。这正是母项目那个哨兵值
 *   （「+ 新建母项目…」点了之后 value 不变）能正确工作的原因。
 *
 * 自由输入模式：输入框里的字**就是** value，恒等。
 *   所以已经敲进去的内容永远不会被"回滚"，它从一开始就已经落库了。
 */
export function resolveTriggerText(
  selectOnly: boolean,
  value: string,
  query: string,
  open: boolean,
  selectedLabel: string | undefined
): string {
  if (!selectOnly) return value
  return open && query !== '' ? query : (selectedLabel ?? '')
}
