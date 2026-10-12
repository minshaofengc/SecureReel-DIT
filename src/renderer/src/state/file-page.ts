import type { CopyJobFile } from '../../../shared/types'
import { shouldApplyFileStateChange } from '../../../shared/types'

/** Keep streamed updates inside the loaded page; ignore delayed intermediate states. */
export function updateVisibleFilePage(list: CopyJobFile[], incoming: CopyJobFile): CopyJobFile[] {
  const at = list.findIndex((file) => file.relPath === incoming.relPath)
  if (at < 0) return list
  const previous = list[at]
  if (previous === undefined || !shouldApplyFileStateChange(previous.state, incoming.state))
    return list
  const next = list.slice()
  next[at] = incoming
  return next
}
