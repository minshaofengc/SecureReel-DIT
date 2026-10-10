/**
 * 跨进程共用的格式化工具（纯函数，无环境依赖）。
 */

export function humanBytes(bytes: number | null | undefined, fractionDigits = 2): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const exponent = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  const digits = exponent === 0 ? 0 : fractionDigits
  return `${value.toFixed(digits)} ${units[exponent]}`
}

export function humanRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) {
    return '—'
  }
  return `${humanBytes(bytesPerSecond, 1)}/s`
}

export function humanDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${secs} 秒`
  return `${secs} 秒`
}

/** 把秒数格式化成时:分:秒，用于媒体时长。 */
export function clockDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`
}

/** 进度百分比，0–100；总量为 0 时返回 0。 */
export function percent(done: number, total: number, fractionDigits = 1): number {
  if (total <= 0) return 0
  const value = (done / total) * 100
  return Number(value.toFixed(fractionDigits))
}

/** 把相对路径截断成中间省略的形式，便于在窄列里显示。 */
export function truncateMiddle(value: string, maxLength = 48): string {
  if (value.length <= maxLength) return value
  const head = Math.ceil((maxLength - 1) / 2)
  const tail = Math.floor((maxLength - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

/**
 * 在扫描得到的后缀直方图里数某个扩展名有多少个文件。
 *
 * 传入的 `ext` 不带点、大小写不敏感（直方图里的 `ext` 一律小写，
 * 见主进程的扫描实现）。用于拷贝页判断"这批来源里有没有某类素材"，例如
 * 有没有佳能 Cinema RAW Light（`.crm`）—— 那种素材出不了画面，要提前提示。
 */
export function countExtension(
  extensions: readonly { ext: string; count: number }[],
  ext: string
): number {
  const wanted = ext.toLowerCase().replace(/^\./, '')
  return extensions.find((item) => item.ext.toLowerCase() === wanted)?.count ?? 0
}

/**
 * 今天的日期，`YYYY-MM-DD`，**按本机时区**。
 *
 * 为什么不直接用 `new Date().toISOString().slice(0, 10)`：
 * `toISOString()` 走的是 UTC。东八区的凌晨 0 点到 8 点之间，UTC 还停在前一天 ——
 * 于是通宵拍完、凌晨拷卡的时候，"今天"会变成"昨天"，
 * 拍摄日默默错一天，而且因为格式合法，谁都不会发现。
 * 剧组恰恰最爱在这个时间段拷卡。
 *
 * 日期取整用本地字段拼，不走任何 Date 序列化。
 */
export function todayLocalDate(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
