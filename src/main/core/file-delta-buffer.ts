/**
 * 中间态变更的合并缓冲。
 *
 * 为什么单独成一个类：端到端跑一次拷贝时，文件可能在几百毫秒内全部跑完，
 * 中间态还没来得及送出去就被终态盖过去了，测试根本观察不到。
 * 抽出来之后可以精确地测"窗口内折叠"这个行为本身。
 *
 * 语义只有三条：
 *   1. 同一个 `relPath` 在窗口内的多次变更**折叠成一条**（后来的字段覆盖先前的）
 *   2. 窗口到点自动送出；也可以手动 `flush()` —— 任务收尾必须手动调一次，
 *      否则最后 200ms 内的变更永远发不出去
 *   3. `flush()` 之后缓冲清空；空缓冲不发事件（省掉无谓的 IPC）
 *
 * ⚠️ 这里**刻意不做"文件结清后撤销"**。
 * 撤销看起来更省流量，但它需要在每一条结清路径上都记得调一次，
 * 漏掉任何一条界面就会倒退（显示"校验完了又倒回去"）。
 * 迟到的中间态改由 `shouldApplyFileStateChange()`（见 `@shared/types`）
 * 在界面侧无状态地挡掉，漏不掉。
 */
import type { FileStateDelta } from '@shared/types'

export class FileDeltaBuffer {
  private readonly pending = new Map<string, FileStateDelta>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly flushMs: number,
    private readonly onFlush: (deltas: FileStateDelta[]) => void
  ) {}

  /** 当前攒着多少条（同一个文件只算一条）。 */
  get size(): number {
    return this.pending.size
  }

  /** 记一次变更。同一文件在同一窗口内反复变更会自然折叠。 */
  record(relPath: string, patch: Omit<FileStateDelta, 'relPath'>): void {
    const previous = this.pending.get(relPath)
    this.pending.set(relPath, { relPath, ...previous, ...patch })
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.flushMs)
      // 攒变更的定时器不该拖住进程退出
      this.timer.unref()
    }
  }

  /** 立刻送出攒下的变更。 */
  flush(): void {
    this.cancelTimer()
    if (this.pending.size === 0) return
    const deltas = [...this.pending.values()]
    this.pending.clear()
    this.onFlush(deltas)
  }

  /** 丢弃尚未送出的变更（引擎重新开始、任务被取消时用）。 */
  clear(): void {
    this.cancelTimer()
    this.pending.clear()
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
