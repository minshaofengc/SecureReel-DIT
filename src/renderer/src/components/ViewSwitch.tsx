import type { CSSProperties, ReactNode } from 'react'
import { NavIcon } from './NavIcon'
import { useI18n } from '../i18n'

/**
 * 视图模式。
 *
 * 同一份内容，三种排法。它们**不改任何业务数据**，只是同一批 DOM
 * 换一套 CSS —— 所以切换是瞬时的，也不需要主进程参与。
 *
 *   cards   卡片式：主区块 + 两列卡片，分区最清楚。默认，给第一次用的人
 *   compact 紧凑式：列更宽、间距与字号收紧，一屏看得最多。给熟练工
 *   focus   专注式：单列窄栏、字号放大，一次只面对一件事。给现场照着做、
 *           或者投影/教学时用
 *
 * 三档都不是"换皮"：卡片式靠色带分区、紧凑式靠密度、专注式靠留白，
 * 排布逻辑是真的不一样（见 app.css 的「视图模式」一节）。
 */
export type ViewMode = 'cards' | 'compact' | 'focus'

export const VIEW_MODES: ViewMode[] = ['cards', 'compact', 'focus']

const ICONS: Record<ViewMode, string> = {
  cards: 'view-cards',
  compact: 'view-compact',
  focus: 'view-focus'
}

/**
 * 视图切换器。
 *
 * 常驻在内容区右下角（见 app.css 的 .dock / .viewswitch），
 * 而不是塞进设置页：它是个**试一下就知道**的东西 —— 藏在设置里，
 * 用户永远不会去点；放在手边，三秒就能找到自己喜欢的那一档。
 *
 * ## 动效为什么这么做
 *
 * 选中态用一块**会滑动的绿色底板**表达，而不是给当前按钮换个背景色。
 * 底板从旧位置滑到新位置，中间那 280ms 里用户能看见"我从哪来、到哪去"；
 * 换背景色只有"啪"的一下，没有过程。回弹用 --ease-spring（末段轻微过冲），
 * 让这个小控件显得"活"，同时不至于像果冻 —— 只有小控件配用这条曲线。
 *
 * 滑块的位置靠 `--i` 这个下标变量算，不写死像素宽度：
 * 三个按钮是等宽的（flex: 1 1 0），所以 `translateX(var(--i) * 100%)`
 * 永远落在正确的格子上，改文案、改字号都不会错位。
 */
export function ViewSwitch({
  value,
  onChange
}: {
  value: ViewMode
  onChange: (next: ViewMode) => void
}): ReactNode {
  const { t } = useI18n()
  const index = Math.max(0, VIEW_MODES.indexOf(value))

  return (
    <div
      className="viewswitch"
      role="group"
      aria-label={t('view.label')}
      /* 只用来驱动滑块位移，不是颜色 —— 渲染层"零内联色值"那条铁律不受影响 */
      style={{ '--i': index } as CSSProperties}
    >
      <span className="viewswitch__thumb" aria-hidden="true" />
      {VIEW_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          className="viewswitch__btn"
          aria-pressed={mode === value}
          title={t(`view.${mode}` as never)}
          onClick={() => onChange(mode)}
        >
          <span className="viewswitch__icon" aria-hidden="true">
            <NavIcon name={ICONS[mode]} />
          </span>
          <span className="viewswitch__label">{t(`view.${mode}` as never)}</span>
        </button>
      ))}
    </div>
  )
}
