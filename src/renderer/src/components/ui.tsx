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

export function Progress({ value, tone }: { value: number; tone?: 'warn' | 'danger' }): ReactNode {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <div className={`progress${tone === undefined ? '' : ` ${tone}`}`}>
      <span style={{ width: `${clamped}%` }} />
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
