/**
 * 任务总进度的口径。
 *
 * ## 为什么不能只看"读了多少源字节"
 *
 * 这个软件每拷一个文件其实做三件事：
 *   1. 读源盘（顺便算源侧校验值）
 *   2. 把数据写进每一个目标盘
 *   3. **把每个目标盘上的成品重新读一遍**，比对校验值
 *
 * 第 3 步不是可有可无的收尾，它是"目标盘上的文件确实是对的"这条结论的唯一来源，
 * 而且它的代价和第 1 步一样大（要把每个目标上的文件完整重读）。
 * 老口径只统计第 1 步，于是收尾阶段（拷贝早读完了、校验还在排队跑）
 * 进度条会**停在接近 100% 但一动不动**，看起来像卡死。
 *
 * ## 口径
 *
 * 把"一个源字节"换算成工作量：
 *
 *     每个文件的工作量 = 1 次读取 + (要校验的目标数) 次重读
 *     总工作量 = 总字节 × (1 + 要校验的目标数)
 *
 * 分母**在任务开始前就能定下来**（总字节 × (1 + 目标数)），不随后续的
 * 调度而变化 —— 这一点很要紧：如果分母边跑边长，进度会往回退，
 * 那比"不准"更让人恼火。分子只增，分母只减（见 planAdjustment），
 * 所以整体一定是单调不减的。
 *
 * ## 两个兜底
 *
 *   · 所有文件都判定了（成功或失败）→ 直接 100%。
 *     现实里总有"某些校验本来就不会发生"的情况（目标被用户中途停用、
 *     某个目标盘中途掉线），分子分母都算不干净，与其卡在 97% 不如据实收尾。
 *   · 分母为 0（空任务）→ 0%，不要除零得 NaN。NaN 会让进度条宽度变成字符串
 *     "NaN%" 而被 CSS 丢掉，界面表现是"条不见了"，比显示 0% 更难查。
 */

export interface OverallProgressInput {
  /** 任务总字节数（源侧口径） */
  totalBytes: number
  /**
   * 已完成拷贝读取的字节数。
   *
   * 包含两部分：已经读完的（含已判定的与"读完但还在校验"的），
   * 以及当前正在读的那一段。**不能只用数据库里的 bytesDone** ——
   * 那个值只在文件判定后才跳一次，大文件期间会长时间不动。
   */
  copiedBytes: number
  /** 已经重读完并比对的字节数（校验阶段） */
  verifyBytesDone: number
  /** 每个文件默认要重读几遍（= 参与写入的目标数；不校验时为 0） */
  verifyPasses: number
  /** 已判定的文件数（成功 + 失败） */
  filesSettled: number
  totalFiles: number
}

/** 计划总工作量（字节口径）。分母，只减不增。 */
export function planTotalBytes(totalBytes: number, verifyPasses: number): number {
  if (totalBytes <= 0) return 0
  // verifyPasses 是外部传进来的（目标数），负值没有意义，直接当 0
  return totalBytes * (1 + Math.max(0, verifyPasses))
}

/** 算出 0–100 的总进度。输入都是"已完成量"或"计划量"，函数本身不持有状态。 */
export function computeOverallPercent(input: OverallProgressInput): number {
  const { totalBytes, copiedBytes, verifyBytesDone, verifyPasses, filesSettled, totalFiles } = input

  // 全部文件都已判定 → 这件事就是做完了，不去纠结分子分母还剩几个字节
  if (totalFiles > 0 && filesSettled >= totalFiles) return 100

  const plan = planTotalBytes(totalBytes, verifyPasses)
  if (plan <= 0) {
    // 空任务：没有字节要处理。有文件却没有任何字节（全是 0 字节文件）时，
    // 用文件数兜一个进度，否则会永远停在 0%。
    if (totalFiles > 0) return clampPercent((filesSettled / totalFiles) * 100)
    return 0
  }

  // 拷贝阶段的完成量不能超过总量：文件被跳过、目标被停用时实际读的字节会少，
  // 但不该让进度超过 100%。
  const copyDone = Math.min(Math.max(0, copiedBytes), totalBytes)
  const verifyDone = Math.max(0, verifyBytesDone)
  return clampPercent(((copyDone + verifyDone) / plan) * 100)
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}
