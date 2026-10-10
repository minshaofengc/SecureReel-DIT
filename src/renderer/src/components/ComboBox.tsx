/**
 * 自研下拉。
 *
 * 为什么不直接用原生控件：
 *   · `<select>` 展开后的面板由操作系统绘制，**不在 DOM 里**，CSS 一行都碰不到；
 *   · `<datalist>` 的候选列表同理，连列表的样子都改不了。
 * 这两样恰好就在「项目信息」这一区最显眼的位置，所以只能自己写 ——
 * 否则换主题时下拉永远是系统那一套灰，跟不上界面。
 *
 * 刻意不引第三方组件库，理由见 ui.tsx 开头：离线可用、依赖越少越稳。
 *
 * 两个导出：
 *   · `SelectBox` —— 只能从列表里选。value 必定是选项之一，onChange 能收窄成字面量联合。
 *   · `ComboBox`  —— 可以自由输入。输入框里的字**就是** value。
 * 两者共享内部 hook，因为真正不同的只有「显示文本怎么算」这一条规则
 * （在 shared/combobox.ts 的 resolveTriggerText 里），而键盘 / 焦点 /
 * 外部点击 / 定位这些最容易写错的地方必须只写一次。
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import {
  clampIndex,
  filterOptions,
  flatten,
  labelOf,
  moveActive,
  resolveTriggerText,
  type ComboGroup,
  type ComboOption,
  type FlatOption
} from '@shared/combobox'
import { useI18n } from '../i18n'

export type { ComboGroup, ComboOption }

/**
 * 「下方剩余空间少于这个值就考虑向上弹」的经验阈值（px）。
 *
 * ⚠️ 它**不是** `.combo-panel` 的 max-height。面板实际能长多高由 CSS 决定
 * （`app.css` 里 `.combo-panel { max-height: 300px }`）—— CSS 是唯一真相，
 * JS 不去镜像它。这里只回答"够不够放"这一个判断，取 180 是个偏保守的经验值：
 * 比它矮就宁可向上弹，免得只露出一两行还得滚动。
 *
 * （曾经这个常量叫 PANEL_MAX_HEIGHT 并写死 264，声称要与 CSS 的 max-height 对齐；
 * 但两者早已失同步，而且它在 `Math.min(PANEL_MAX_HEIGHT, 180)` 里恒被 180 截断，
 * 那个 min 是死代码。改名成语义正确的阈值，把这层会腐烂的隐式耦合去掉。）
 */
const PANEL_FLIP_THRESHOLD = 180

interface BaseProps<T extends string> {
  /** 受控值。`''` 是合法值（表示"未分组"），组件内部一律不用真值判断 */
  value: T
  /** 透传到根节点 —— 母项目页的 marginTop、报告页的 width: 280 都靠它 */
  style?: CSSProperties
  className?: string
  placeholder?: string
  disabled?: boolean
  /** 输入框的无障碍名。**必填**：这个控件没有可见的 `<label for>`，靠它兜底 */
  ariaLabel: string
  /** 面板的无障碍名，缺省与 ariaLabel 相同 */
  listLabel?: string
}

/** 自由输入：输入框里的字就是 value，每敲一个字都回调 */
export interface ComboBoxProps extends BaseProps<string> {
  options: readonly ComboOption<string>[]
  onChange: (next: string) => void
}

/**
 * 选项来源。**至少给一个**：只给 options、只给 groups，或者两个都给。
 *
 * 两个都给时 options 排在所有分组前面 —— 报告页靠这个把
 * 「请选择任务」放在按母项目分好的各组之上。
 */
type OptionSource<T extends string> =
  | { options: readonly ComboOption<T>[]; groups?: readonly ComboGroup<T>[] }
  | { options?: readonly ComboOption<T>[]; groups: readonly ComboGroup<T>[] }

/** 仅选择：打字只用来筛选，绝不改 value */
export type SelectBoxProps<T extends string> = BaseProps<T> &
  OptionSource<T> & {
    onChange: (next: T) => void
  }

interface PanelRect {
  top: number
  left: number
  width: number
  flip: boolean
}

interface ComboConfig<T extends string> {
  /** true = 只能选；false = 可自由输入 */
  selectOnly: boolean
  value: T
  options?: readonly ComboOption<T>[]
  groups?: readonly ComboGroup<T>[]
  disabled: boolean
  /** 从列表里选中某项 */
  onCommit: (next: T) => void
  /** 自由输入模式下每次按键（仅选择模式不传） */
  onType?: (next: string) => void
}

function useComboBox<T extends string>({
  selectOnly,
  value,
  options,
  groups,
  disabled,
  onCommit,
  onType
}: ComboConfig<T>): {
  value: T
  open: boolean
  text: string
  filtered: FlatOption<T>[]
  active: number
  panelStyle: CSSProperties | null
  listId: string
  rootRef: MutableRefObject<HTMLDivElement | null>
  inputRef: MutableRefObject<HTMLInputElement | null>
  panelRef: MutableRefObject<HTMLDivElement | null>
  optionRefs: MutableRefObject<(HTMLDivElement | null)[]>
  openPanel: () => void
  closePanel: () => void
  setActiveIndex: (index: number) => void
  commit: (index: number) => void
  handleInput: (next: string) => void
  handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  handleBlur: (event: FocusEvent<HTMLInputElement>) => void
} {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [rect, setRect] = useState<PanelRect | null>(null)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const optionRefs = useRef<(HTMLDivElement | null)[]>([])
  /**
   * 上一帧量到的几何。
   *
   * 给 open 期间的 rAF 循环做「先比较、后 setState」用：几何没变就绝不触发
   * 重渲染。放在 ref 里而不是 state，因为它只服务于比较、不参与渲染。
   */
  const lastRectRef = useRef<PanelRect | null>(null)
  const listId = `${useId()}-listbox`

  const flat = useMemo(() => flatten(options, groups), [options, groups])

  // 自由输入模式下，"要筛什么"就是 value 本身；只有仅选择模式才有一个独立的 query。
  // 把这一点写清楚很重要 —— 否则自由输入时会去筛一个永远为空的 query，筛选看起来失效。
  const needle = selectOnly ? query : value
  const filtered = useMemo(() => filterOptions(flat, needle), [flat, needle])
  const selectedLabel = useMemo(() => labelOf(flat, value), [flat, value])
  const text = resolveTriggerText(selectOnly, value, query, open, selectedLabel)
  const active = clampIndex(activeIndex, filtered.length)

  /* ---------------- 定位 ---------------- */

  /**
   * 量一次触发器，算出面板该放哪（**纯函数，不碰 state**）。
   *
   * 坐标一律是**视口坐标**（`getBoundingClientRect` 的原始值），因为面板是
   * `position: fixed` + portal 到 body。这一点和下面 `panelStyle` 的处理是配套的。
   */
  const computeRect = useCallback((): PanelRect | null => {
    const input = inputRef.current
    if (input === null) return null
    const bounds = input.getBoundingClientRect()
    const below = window.innerHeight - bounds.bottom - 8
    // 下面塞不下、而上面更宽裕 → 向上弹
    const flip = below < PANEL_FLIP_THRESHOLD && bounds.top > below
    return { top: bounds.bottom + 4, left: bounds.left, width: bounds.width, flip }
  }, [])

  // 在布局阶段量，首帧就不会先画到 (0,0) 再跳过去
  useLayoutEffect(() => {
    if (open) {
      const next = computeRect()
      lastRectRef.current = next
      setRect(next)
    } else {
      lastRectRef.current = null
      setRect(null)
    }
  }, [open, computeRect])

  /*
   * 面板打开期间**每帧**重新量一次。
   *
   * 为什么非得轮询、而不是监听 scroll/resize（旧做法）：
   *   1. 卡片的入场动画 `rise-in` 用 `transform: translateY(6px)` 把触发器往上推。
   *      transform **不改变元素的 layout size**，所以 ResizeObserver 收不到；
   *      动画跑完也不会发 scroll/resize —— 旧做法于是把"动画中途量到的 Y"当成最终位置，
   *      卡片归位后浮层就卡在旧位置，出现最多 6px 的竖向漂移（每张卡 delay 不同，
   *      所以是"不同程度的漂移"）。
   *   2. 视图模式切换给 padding / gap / grid-template-columns 挂了 180ms 过渡，
   *      它常由**祖先**挪动触发器，同样不发 scroll/resize。
   *   只有每帧重读 rect 才能同时覆盖这两种"无事件"的位移。
   *
   * 代价可忽略：浮层只开一小会儿、同一时刻最多一个；且用「先比较、后 setState」
   * 把渲染压到"几何真正变化的那几帧"，之后每帧只做一次读取。
   */
  useEffect(() => {
    if (!open) return
    let frame = 0
    const tick = (): void => {
      const next = computeRect()
      if (next !== null) {
        const last = lastRectRef.current
        if (
          last === null ||
          last.top !== next.top ||
          last.left !== next.left ||
          last.width !== next.width ||
          last.flip !== next.flip
        ) {
          lastRectRef.current = next
          setRect(next)
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    // 视口一变就把缓存的"上一帧"作废，逼下一次 tick 重算。
    // （其实 rAF 每帧都会重算，这里置空只是让比较短路、少一次字段比对，语义上也更清楚。）
    // ★ 必须用捕获阶段：scroll 事件不冒泡，冒泡监听收不到 .main 这个滚动容器的滚动。
    const onViewportChange = (): void => {
      lastRectRef.current = null
    }
    document.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [open, computeRect])

  /* ---------------- 开关 ---------------- */

  const openPanel = useCallback((): void => {
    if (disabled) return
    setQuery('')
    // 打开之后要显示哪一份列表：仅选择模式下 query 清空 = 全部选项；
    // 自由输入模式没有 query 这个概念，显示的仍是按当前文字筛过的那份。
    // 高亮必须落在**即将显示的那份**列表里，否则打开时会高亮错行。
    const source = selectOnly ? flat : filtered
    const index = source.findIndex((option) => option.value === value)
    setActiveIndex(index < 0 ? 0 : index)
    setOpen(true)
  }, [disabled, filtered, flat, selectOnly, value])

  const closePanel = useCallback((): void => {
    setOpen(false)
    // 清掉 query 就等于"退回当前真值" —— 显示文字是算出来的，不是存下来的。
    // 绝不要反过来去改 value。
    setQuery('')
  }, [])

  const commit = useCallback(
    (index: number): void => {
      const option = filtered[index]
      if (option === undefined || option.disabled === true) return
      onCommit(option.value)
      // 注意这里**不做乐观更新**：组件不记住"刚点了什么"。
      // 母项目那个哨兵项被点了之后 value 并不会变，此时触发器必须继续显示
      // 原来选中的母项目，而不是「+ 新建母项目…」。
      setOpen(false)
      setQuery('')
    },
    [filtered, onCommit]
  )

  /* ---------------- 键盘 ---------------- */

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      // 中文输入法组合期间，回车 / 上下键是"选字"，不是"确认下拉项"。
      // 不拦掉的话，在职务框里打「导演」再回车会同时确认候选字和下拉项。
      if (event.nativeEvent.isComposing || event.keyCode === 229) return

      const count = filtered.length

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          if (!open) openPanel()
          else if (count > 0) setActiveIndex(moveActive(active, 1, count))
          return
        case 'ArrowUp':
          event.preventDefault()
          if (!open) openPanel()
          else if (count > 0) setActiveIndex(moveActive(active, -1, count))
          return
        case 'Home':
          if (!open) return
          event.preventDefault()
          setActiveIndex(0)
          return
        case 'End':
          if (!open) return
          event.preventDefault()
          setActiveIndex(count - 1)
          return
        case 'Enter':
          event.preventDefault()
          if (open && count > 0) commit(active)
          else setOpen(false)
          return
        case 'Escape':
          if (!open) return
          event.preventDefault()
          closePanel()
          return
        case 'Tab':
          // 不 preventDefault：焦点要能正常走到下一个字段
          closePanel()
          return
        default:
          return
      }
    },
    [active, closePanel, commit, filtered.length, open, openPanel]
  )

  const handleInput = useCallback(
    (next: string): void => {
      if (selectOnly) {
        setQuery(next)
        setActiveIndex(0)
        if (!open) setOpen(true)
        return
      }
      onType?.(next)
      if (!open) setOpen(true)
    },
    [onType, open, selectOnly]
  )

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLInputElement>): void => {
      // 焦点挪到本组件内部（理论上不会，面板里的项不可聚焦）就别收
      const root = rootRef.current
      const next = event.relatedTarget
      if (root !== null && next instanceof Node && root.contains(next)) return
      closePanel()
    },
    [closePanel]
  )

  /* ---------------- 副作用 ---------------- */

  // 点组件以外的任何地方就收起来。用捕获阶段，免得被中间层 stopPropagation 挡住。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current
      const panel = panelRef.current
      if (event.target instanceof Node) {
        if (root !== null && root.contains(event.target)) return
        /*
         * ⚠️ 面板挂在 body 的 portal 下，已经不在 root 里了。
         * 漏掉这一条：点选项的 pointerdown 阶段就会先把面板收掉，
         * 紧接着的 click 永远到不了选项 —— 自研下拉最经典的"点不中"。
         */
        if (panel !== null && panel.contains(event.target)) return
      }
      closePanel()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, closePanel])

  // 高亮项滚进视野。block: 'nearest' 在鼠标悬停时本来就是 no-op，不用区分来源。
  useEffect(() => {
    if (!open) return
    optionRefs.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const panelStyle: CSSProperties | null =
    rect === null
      ? null
      : {
          left: rect.left,
          width: rect.width,
          ...(rect.flip
            ? { bottom: window.innerHeight - rect.top, top: 'auto' }
            : { top: rect.top, bottom: 'auto' })
        }

  return {
    value,
    open,
    text,
    filtered,
    active,
    panelStyle,
    listId,
    rootRef,
    inputRef,
    panelRef,
    optionRefs,
    openPanel,
    closePanel,
    setActiveIndex,
    commit,
    handleInput,
    handleKeyDown,
    handleBlur
  }
}

/** 两种模式共用的骨架：输入框 + 箭头 + 面板 */
function ComboShell<T extends string>({
  ariaLabel,
  listLabel,
  placeholder,
  disabled,
  style,
  className,
  selectOnly,
  combo
}: {
  ariaLabel: string
  listLabel?: string
  placeholder: string | undefined
  disabled: boolean
  style: CSSProperties | undefined
  className: string | undefined
  selectOnly: boolean
  combo: ReturnType<typeof useComboBox<T>>
}): ReactNode {
  const { t } = useI18n()
  const {
    open,
    text,
    filtered,
    active,
    panelStyle,
    listId,
    rootRef,
    inputRef,
    panelRef,
    optionRefs,
    openPanel,
    closePanel,
    setActiveIndex,
    commit,
    handleInput,
    handleKeyDown,
    handleBlur
  } = combo

  const optionId = (index: number): string => `${listId}-opt-${index}`

  /**
   * 把筛完的一维数组切成"渲染段"：一段要么是一个分组（带标题），
   * 要么是不分组时的整片列表。切段只是为了生成合法的 ARIA 分组结构，
   * 键盘索引仍然只在那个一维数组上跑。
   */
  const segments = useMemo(() => {
    const out: { key: string; label?: string; from: number; to: number }[] = []
    filtered.forEach((option, index) => {
      const last = out[out.length - 1]
      if (option.groupStart !== undefined || last === undefined) {
        out.push({
          key: `${option.groupStart ?? 'flat'}-${index}`,
          ...(option.groupStart === undefined ? {} : { label: option.groupStart }),
          from: index,
          to: index
        })
        return
      }
      last.to = index
    })
    return out
  }, [filtered])

  const renderOption = (option: FlatOption<T>, index: number): ReactNode => (
    <div
      key={optionId(index)}
      ref={(node) => {
        optionRefs.current[index] = node
      }}
      id={optionId(index)}
      className="combo-option"
      role="option"
      aria-selected={option.value === combo.value}
      {...(option.disabled === true ? { 'aria-disabled': true } : {})}
      {...(index === active ? { 'data-active': true } : {})}
      {...(option.tone === 'action' ? { 'data-tone': 'action' } : {})}
      onMouseEnter={() => setActiveIndex(index)}
      // preventDefault 是关键：否则输入框先失焦触发 onBlur 把面板收起来，
      // 随后的 click 永远到不了这一行 —— 自研下拉最经典的 bug。
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => commit(index)}
    >
      {option.label}
    </div>
  )

  return (
    <div
      ref={rootRef}
      className={className === undefined ? 'combo' : `combo ${className}`}
      style={style}
      {...(disabled ? { 'data-disabled': true } : {})}
    >
      <input
        ref={inputRef}
        className="input combo-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        {...(open ? { 'aria-controls': listId } : {})}
        {...(open && filtered.length > 0 ? { 'aria-activedescendant': optionId(active) } : {})}
        value={text}
        {...(placeholder === undefined ? {} : { placeholder })}
        disabled={disabled}
        // 不加 autoComplete="off" 的话 Chromium 的自动填充浮层会叠上来，
        // 出现"两个下拉"（Electron 里同样会触发）。
        autoComplete="off"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(event) => handleInput(event.target.value)}
        onKeyDown={handleKeyDown}
        onMouseDown={() => {
          if (selectOnly && open) closePanel()
          else if (!open) openPanel()
        }}
        onBlur={handleBlur}
      />
      <button
        type="button"
        className="combo-caret"
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => (open ? closePanel() : openPanel())}
      >
        ▾
      </button>

      {open &&
        panelStyle !== null &&
        createPortal(
          <div
            ref={panelRef}
            className="combo-panel"
            id={listId}
            role="listbox"
            aria-label={listLabel ?? ariaLabel}
            style={panelStyle}
          >
            {filtered.length === 0 ? (
              <div className="combo-empty">{t('common.noMatch')}</div>
            ) : (
              segments.map((segment) => {
                const items = filtered
                  .slice(segment.from, segment.to + 1)
                  .map((option, offset) => renderOption(option, segment.from + offset))
                if (segment.label === undefined) return <Fragment key={segment.key}>{items}</Fragment>
                const labelId = `${listId}-group-${segment.from}`
                return (
                  <div key={segment.key} role="group" aria-labelledby={labelId}>
                    <div className="combo-group-label" id={labelId}>
                      {segment.label}
                    </div>
                    {items}
                  </div>
                )
              })
            )}
          </div>,
          document.body
        )}
    </div>
  )
}

/**
 * 只能从列表里选。
 *
 * 打字不会被丢弃 —— 它用来筛选。松开手（Esc / 点到别处）就退回当前真值，
 * 所以永远不会出现"输入框显示的字和数据里的值不一致"。
 */
export function SelectBox<T extends string>({
  value,
  options,
  groups,
  onChange,
  style,
  className,
  placeholder,
  disabled = false,
  ariaLabel,
  listLabel
}: SelectBoxProps<T>): ReactNode {
  const combo = useComboBox<T>({
    selectOnly: true,
    value,
    ...(options === undefined ? {} : { options }),
    ...(groups === undefined ? {} : { groups }),
    disabled,
    onCommit: onChange
  })
  return (
    <ComboShell<T>
      ariaLabel={ariaLabel}
      {...(listLabel === undefined ? {} : { listLabel })}
      placeholder={placeholder}
      disabled={disabled}
      style={style}
      className={className}
      selectOnly
      combo={combo}
    />
  )
}

/**
 * 可以自由输入，同时给常用值做建议。
 *
 * 「职务」用的就是这个：剧组里的职务五花八门，预设只能算是路牌，
 * 不能变成白名单 —— 敲什么就存什么，报告里原样出现。
 */
export function ComboBox({
  value,
  options,
  onChange,
  style,
  className,
  placeholder,
  disabled = false,
  ariaLabel,
  listLabel
}: ComboBoxProps): ReactNode {
  const combo = useComboBox<string>({
    selectOnly: false,
    value,
    options,
    disabled,
    onCommit: onChange,
    onType: onChange
  })
  return (
    <ComboShell<string>
      ariaLabel={ariaLabel}
      {...(listLabel === undefined ? {} : { listLabel })}
      placeholder={placeholder}
      disabled={disabled}
      style={style}
      className={className}
      selectOnly={false}
      combo={combo}
    />
  )
}
