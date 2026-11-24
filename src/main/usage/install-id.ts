/**
 * 安装 ID：随机、可重置、与硬件无关。
 *
 * 刻意**不**做机器码：那会把"匿名统计"变成"设备指纹"，
 * 与隐私说明里"不采集硬件信息"的承诺直接冲突。
 */
import { randomUUID } from 'node:crypto'
import { formatInstallId, isValidInstallId } from '@shared/usage'
import type { Store } from '../db/store'

export const INSTALL_ID_KV = 'usage.installId'

function createId(): string {
  return formatInstallId(randomUUID().replace(/-/g, ''))
}

/** 读现有 ID；没有或格式坏了就生成一个新的。 */
export function ensureInstallId(store: Store): string {
  const existing = store.getKv(INSTALL_ID_KV)
  if (existing !== null && isValidInstallId(existing)) return existing
  const id = createId()
  store.setKv(INSTALL_ID_KV, id)
  return id
}

/**
 * 重置：换一个新 ID，并清空本机历史。
 *
 * 旧 ID 在服务端的记录不会删（它本来就无法关联到人），
 * 但从此再也接不上这台机器 —— 这就是隐私说明里承诺的"断开关联"。
 */
export function resetInstallId(store: Store): string {
  const id = createId()
  store.setKv(INSTALL_ID_KV, id)
  store.clearUsage()
  return id
}
