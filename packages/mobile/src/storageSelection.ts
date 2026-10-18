// SPDX-License-Identifier: GPL-3.0-only
import type { Root } from './domain';
export function selectTargetSlot(
  current: string[],
  rootId: string,
  slot: number,
): string[] {
  if (slot !== 0 && slot !== 1) throw new Error('最多选择两份备份');
  if (slot === 1 && !current[0]) throw new Error('请先选择目标盘 1');
  if (current.some((id, index) => index !== slot && id === rootId))
    throw new Error('这个位置已被另一份备份使用，请选择其他位置');
  const next = [...current];
  next[slot] = rootId;
  return next.slice(0, 2);
}
export function rootPosition(root: Root): string {
  return root.diskName && root.folderName
    ? root.diskName + '\n' + root.folderName
    : root.label;
}
