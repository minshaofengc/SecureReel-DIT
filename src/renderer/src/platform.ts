/**
 * 渲染层的平台判断。
 *
 * 平台信息来自主进程的 `IPC.appInfo`（那里返回 `process.platform`），
 * 所以这里不需要新增任何 IPC 通道 —— 只做「拿到的字符串怎么解释」。
 */

export type RevealLabelKey = 'reports.revealDir' | 'reports.revealDirWindows'

export function isWindows(platform: string | undefined | null): boolean {
  return platform === 'win32'
}

/**
 * 「在访达中显示」这个动作，Windows 上要叫「在资源管理器中显示」。
 *
 * 该动作本身走的是 Electron 的 `shell.showItemInFolder`，**两个平台都能用**，
 * 只有文案需要跟着平台走。
 */
export function revealLabelKey(platform: string | undefined | null): RevealLabelKey {
  return isWindows(platform) ? 'reports.revealDirWindows' : 'reports.revealDir'
}

export type ZeroByteNoteKey = 'hde.zeroByte' | 'hde.zeroByteWindows'

/**
 * 「这些文件显示 0 字节是正常的」这条提示里点名的文件管理器。
 *
 * 这句话本来写死了「访达」，Windows 上要改成资源管理器 ——
 * 否则用户会去找一个这台电脑上不存在的程序。
 */
export function zeroByteNoteKey(platform: string | undefined | null): ZeroByteNoteKey {
  return isWindows(platform) ? 'hde.zeroByteWindows' : 'hde.zeroByte'
}
