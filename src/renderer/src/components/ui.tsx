/**
 * 基础组件。
 *
 * 刻意做得很薄：只是一层 CSS 类名的封装。
 * 没有引入任何 UI 组件库 —— 一个 DIT 工具用不上几百 KB 的组件依赖，
 * 而且离线可用性要求下，依赖越少越稳。
 */
import type { ChangeEvent, ReactNode } from 'react'
import type { CopyJob, FileState, JobState } from '@shared/types'
import { HASH_ALGORITHM_LABELS } from '@shared/types'
import { useI18n } from '../i18n'

/**
 * 页头（masthead）。
 *
 * 2026-10-05 第五次改（方案 E）收形。此前是一条**横向铺满的彩色条带**，
 * 带 38px/800 的标题和两位编号 —— 那是海报语言，已随方案 B/C 一起退场。
 *
 * 现在它只是"一行小号眉标 + 一个 22px/500 的标题 + 一行说明"：
 * 分区靠面板底色差，不靠色块。专业工具里标题只需要压住下面的正文，
 * 不需要喊。
 *
 * ⚠️ `index` 已**废弃**（导航不再有 01–07 编号，见 nav.ts）。
 * 传空串就不渲染那个编号块 —— 现有的几处视图还在传 `PAGE_INDEX[x]`，
 * 那些值现在恒为空串，所以行为上已经等于"没有编号"。
 */
export function PageHead({
  index,
  kicker,
  title,
  subtitle
}: {
  /** @deprecated 传空串即不渲染编号块 */
  index?: string
  /** 眉标文字（一般是这一页在导航里的名字） */
  kicker: string
  title: string
  subtitle?: string
}): ReactNode {
  const showIndex = index !== undefined && index !== ''
  return (
    <header className="page-head">
      <span className="page-head__kicker">
        {showIndex && <span className="page-head__index">{index}</span>}
        {kicker}
      </span>
      <h2>{title}</h2>
      {subtitle !== undefined && <p>{subtitle}</p>}
    </header>
  )
}

/**
 * 主步骤区块（2026-10-04 推倒重做引入，2026-10-05 改形）。
 *
 * 一个页面里通常只有一件事是"用户现在最该做的"（拷贝页是选来源、
 * 队列页是看进度、设置页是改参数）。这个区块把那一件事**抬成唯一的重心**。
 *
 * ⚠️ 曾经的实现是"电光绿标题带 + 墨色编号方块" —— 那是方案 B 的视觉语言，
 * 随荧光绿一起退场了（boss 原话"太丑太卡通"）。现在的做法是
 * **左侧 3px 强调色竖条 + 比底亮一档的面板**，见 workbench.css 的 `.lead`。
 *
 * 编号保留：它同时表达"顺序"和"数量"（一共几步），这是不靠颜色也能读出的信息。
 */
export function LeadBlock({
  step,
  title,
  hint,
  actions,
  children
}: {
  /** 第几步，从 1 起。传 undefined 就不渲染编号圆点 */
  step?: number
  title: string
  hint?: string
  /** 标题右侧的操作区（暂停/取消/删除这类） */
  actions?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <section className="block--lead">
      <div className="block__head">
        {step !== undefined && <span className="block__num">{step}</span>}
        <div className="block__headText">
          <h2 className="block__title">{title}</h2>
          {hint !== undefined && <div className="block__hint">{hint}</div>}
        </div>
        {actions !== undefined && <div className="block__actions">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/**
 * 次要区块并排容器。
 *
 * 配合 LeadBlock 使用：主步骤一块，次要步骤两列并排。
 * 此前它们是一列到底的等宽卡片，一屏要滚很久；
 * 两列之后一屏能看完一整个流程。
 */
export function BlockGrid({ children }: { children: ReactNode }): ReactNode {
  return <div className="block-grid">{children}</div>
}

export function Card({
  title,
  hint,
  actions,
  children
}: {
  title?: string
  hint?: string
  actions?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <section className="card">
      {(title !== undefined || actions !== undefined) && (
        <div className="card-head">
          <div>
            {title !== undefined && <h3>{title}</h3>}
            {hint !== undefined && <div className="hint">{hint}</div>}
          </div>
          {actions !== undefined && <div className="row-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): ReactNode {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint !== undefined && <span className="hint faint" style={{ fontSize: 11 }}>{hint}</span>}
    </label>
  )
}

/**
 * 进度条。
 *
 * `indeterminate` 是"在动、但说不清还剩多久"的那一档，用在扫源盘这类
 * **时长完全未知**的等待上（大卡扫描可能几分钟）。
 *
 * 这里曾经为那种场景画过一个**写死的 40%**：条子稳稳停在那儿，
 * 看起来像个真实读数，其实和实际进度毫无关系 —— 那比不画更容易误导人。
 * 说不清就不说，只表达"在动"。
 */
export function Progress({
  value,
  tone,
  indeterminate = false
}: {
  /** 0–100。不定态下会被忽略。 */
  value?: number
  tone?: 'warn' | 'danger'
  indeterminate?: boolean
}): ReactNode {
  const clamped = Math.max(0, Math.min(100, value ?? 0))
  const classes = ['progress']
  if (tone !== undefined) classes.push(tone)
  if (indeterminate) classes.push('indeterminate')
  return (
    <div className={classes.join(' ')}>
      <span style={indeterminate ? undefined : { width: `${clamped}%` }} />
    </div>
  )
}

export function Meter({ items }: { items: { label: string; value: ReactNode }[] }): ReactNode {
  return (
    <div className="meter">
      {items.map((item) => (
        <div className="item" key={item.label}>
          <div className="label">{item.label}</div>
          <div className="value">{item.value}</div>
        </div>
      ))}
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
  disabled?: boolean
}): ReactNode {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

const JOB_STATE_TONE: Record<JobState, string> = {
  draft: '',
  queued: 'info',
  running: 'accent',
  paused: 'warn',
  completed: 'ok',
  'completed-with-errors': 'warn',
  failed: 'danger',
  cancelled: ''
}

const FILE_STATE_TONE: Record<FileState, string> = {
  pending: '',
  copying: 'info',
  verifying: 'info',
  verified: 'ok',
  failed: 'danger',
  skipped: '',
  cancelled: ''
}

export function JobStateBadge({ state }: { state: JobState }): ReactNode {
  const { t } = useI18n()
  const tone = JOB_STATE_TONE[state]
  return <span className={`badge${tone === '' ? '' : ` ${tone}`}`}>{t(`state.${state}` as never)}</span>
}

export function FileStateBadge({ state }: { state: FileState }): ReactNode {
  const { t } = useI18n()
  const tone = FILE_STATE_TONE[state]
  return <span className={`badge${tone === '' ? '' : ` ${tone}`}`}>{t(`filestate.${state}` as never)}</span>
}

export function Note({
  tone,
  children
}: {
  tone?: 'warn' | 'danger'
  children: ReactNode
}): ReactNode {
  return <div className={`note${tone === undefined ? '' : ` ${tone}`}`}>{children}</div>
}

export function PathPicker({
  value,
  placeholder,
  buttonLabel,
  onPick,
  onChange,
  disabled
}: {
  value: string
  placeholder?: string
  buttonLabel: string
  onPick: () => void
  onChange?: (next: string) => void
  disabled?: boolean
}): ReactNode {
  return (
    <div className="path-row">
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange?.(event.target.value)}
      />
      <button type="button" className="btn" onClick={onPick} disabled={disabled}>
        {buttonLabel}
      </button>
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}): ReactNode {
  return (
    <label className="row-actions" style={{ cursor: disabled === true ? 'not-allowed' : 'pointer' }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

export function HashAlgorithmLabel({ job }: { job: CopyJob }): ReactNode {
  return <>{HASH_ALGORITHM_LABELS[job.hashAlgorithm]}</>
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="empty">{children}</div>
}
