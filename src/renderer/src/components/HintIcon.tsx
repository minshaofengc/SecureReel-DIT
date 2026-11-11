/**
 * 行内问号提示。
 *
 * 用途：把原先常驻在页面上的解释性小字收起来，鼠标悬停或键盘聚焦时才显示。
 * 页面因此干净，但信息没有丢 —— 这一点很重要：这些说明里有一部分是
 * 「容量检查不代表校验通过」这类安全语义，直接删掉会让界面变得不诚实。
 *
 * 无障碍：
 *   · 触发器本身可聚焦，`aria-describedby` 指向 tooltip 全文；
 *   · hover 与 `:focus-within` 都能显示，键盘用户不会漏；
 *   · Escape 临时收起并移走焦点，避免 tooltip 卡在屏幕上。
 */
import { useId, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'

export function HintIcon({
  text,
  label,
  inline = false
}: {
  /** tooltip 全文 */
  text: string
  /** 触发器的简短无障碍名（一般用字段名或区块标题） */
  label: string
  /** 放在 `<label>` 内部时用 span，避免抢走 label 的关联目标 */
  inline?: boolean
}): ReactNode {
  const id = useId()
  const [dismissed, setDismissed] = useState(false)

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return
    setDismissed(true)
    event.currentTarget.blur()
  }

  const onClick = (event: MouseEvent<HTMLElement>): void => {
    // inline 形态位于 <label> 内：点击不能触发 label 的默认聚焦行为
    event.preventDefault()
    event.stopPropagation()
    setDismissed(false)
  }

  return (
    <span className="hint-icon-wrap" data-dismissed={dismissed ? 'true' : undefined}>
      {inline ? (
        <span
          role="button"
          tabIndex={0}
          className="hint-icon"
          aria-label={label}
          aria-describedby={id}
          onClick={onClick}
          onKeyDown={onKeyDown}
          onFocus={() => setDismissed(false)}
        >
          ?
        </span>
      ) : (
        <button
          type="button"
          className="hint-icon"
          aria-label={label}
          aria-describedby={id}
          onClick={onClick}
          onKeyDown={onKeyDown}
          onFocus={() => setDismissed(false)}
        >
          ?
        </button>
      )}
      <span role="tooltip" id={id} className="hint-tip">
        {text}
      </span>
    </span>
  )
}
