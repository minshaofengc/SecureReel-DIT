/**
 * 流式文本写入器。
 *
 * 需要它的原因：清单和报告 JSON 都可能是几十 MB（十万级文件的卡），
 * 一次性拼字符串会在内存里留下巨大峰值，所以必须边生成边写。
 *
 * 这里解决的坑：Node 的 WriteStream 如果每写一次就 `once('error')`，
 * 监听器数量会随写入次数线性增长 —— 十万次写入就是十万个监听器，
 * 既触发 MaxListenersExceededWarning，也是实打实的内存泄漏。
 * 正确做法是**只挂一次** error 处理器，把错误存下来，后续写入时抛出去。
 */
import type { WriteStream } from 'node:fs'

export class StreamWriter {
  private failure: Error | null = null
  private ended = false

  constructor(private readonly stream: WriteStream) {
    stream.on('error', (error: Error) => {
      this.failure = error
    })
  }

  async write(chunk: string): Promise<void> {
    if (this.failure !== null) throw this.failure
    if (this.ended) throw new Error('写入流已关闭')

    if (this.stream.write(chunk)) return

    // 背压：等 drain 再继续，避免把整个文件堆在内存里
    await new Promise<void>((resolve) => {
      this.stream.once('drain', () => resolve())
    })
    if (this.failure !== null) throw this.failure
  }

  async end(): Promise<void> {
    if (this.ended) return
    this.ended = true
    await new Promise<void>((resolve, reject) => {
      this.stream.end(() => {
        if (this.failure !== null) reject(this.failure)
        else resolve()
      })
    })
  }
}
