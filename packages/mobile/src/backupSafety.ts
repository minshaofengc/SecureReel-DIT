// SPDX-License-Identifier: GPL-3.0-only
import { z } from 'zod';
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identitySchema = z.object({
  path: z.string(),
  label: z.string(),
  filesystemId: z.string().nullable(),
  physicalDeviceIds: z.array(z.string()),
  capacityPoolId: z.string().nullable(),
  availableBytes: bytes.nullable(),
  present: z.boolean(),
});
export const preflightSchema = z.object({
  fingerprint: z.string().min(1),
  checkedAt: z.string(),
  source: identitySchema,
  targets: z.array(identitySchema),
  groups: z.array(
    z.object({
      id: z.string(),
      paths: z.array(z.string()),
      requiredBytes: bytes,
      availableBytes: bytes.nullable(),
      sufficient: z.boolean().nullable(),
    }),
  ),
  risks: z.array(
    z.object({
      code: z.enum([
        'shared-filesystem',
        'shared-device',
        'independence-unknown',
        'insufficient-space',
        'source-device',
      ]),
      paths: z.array(z.string()),
    }),
  ),
  blockingReasons: z.array(z.string()),
  requiredBytes: bytes,
  independentDeviceGroups: z.number().int().nonnegative().nullable(),
});
export type StorageIdentity = z.infer<typeof identitySchema>;
export type TargetPreflightResult = z.infer<typeof preflightSchema>;
export const confirmationSchema = z
  .object({
    fingerprint: z.string().min(1).max(4096),
    acceptRisks: z.boolean(),
  })
  .strict();
export type PreflightConfirmation = z.infer<typeof confirmationSchema>;
/** Pure evaluator for provider facts. Physical identities must come from a trusted probe, never a volume UUID. */
export function evaluatePreflight(
  mode: 'copy' | 'verify',
  requiredBytes: number,
  source: StorageIdentity,
  targets: StorageIdentity[],
): TargetPreflightResult {
  bytes.parse(requiredBytes);
  const risks: TargetPreflightResult['risks'] = [],
    blockingReasons: string[] = [],
    groups: TargetPreflightResult['groups'] = [];
  for (const root of [source, ...targets])
    if (!root.present) blockingReasons.push('存储未连接：' + root.label);
  if (mode === 'copy') {
    for (const target of targets)
      if (source.filesystemId && source.filesystemId === target.filesystemId)
        blockingReasons.push('来源和目标位于同一存储卷');
    const pools = new Map<string, StorageIdentity[]>();
    for (const target of targets) {
      const id = target.capacityPoolId ?? target.filesystemId ?? target.path;
      pools.set(id, [...(pools.get(id) ?? []), target]);
    }
    for (const [id, roots] of pools) {
      const known = roots.every(r => r.availableBytes !== null),
        availableBytes = known
          ? Math.min(...roots.map(r => r.availableBytes!))
          : null,
        required = requiredBytes * roots.length;
      bytes.parse(required);
      const sufficient = availableBytes !== null && availableBytes >= required;
      groups.push({
        id,
        paths: roots.map(r => r.path),
        requiredBytes: required,
        availableBytes,
        sufficient,
      });
      if (!sufficient) {
        if (availableBytes === null)
          blockingReasons.push('目标剩余容量未知，无法开始拷贝');
        risks.push({
          code: 'insufficient-space',
          paths: roots.map(r => r.path),
        });
      }
    }
    for (let i = 0; i < targets.length; i++)
      for (let j = i + 1; j < targets.length; j++) {
        const a = targets[i]!,
          b = targets[j]!;
        if (a.filesystemId && a.filesystemId === b.filesystemId)
          risks.push({ code: 'shared-filesystem', paths: [a.path, b.path] });
        if (a.physicalDeviceIds.some(id => b.physicalDeviceIds.includes(id)))
          risks.push({ code: 'shared-device', paths: [a.path, b.path] });
      }
    for (const target of targets)
      if (
        source.physicalDeviceIds.some(id =>
          target.physicalDeviceIds.includes(id),
        )
      )
        risks.push({
          code: 'source-device',
          paths: [source.path, target.path],
        });
    if ([source, ...targets].some(r => !r.physicalDeviceIds.length))
      risks.push({
        code: 'independence-unknown',
        paths: targets.map(r => r.path),
      });
  }
  const physicalGroups: Set<string>[] = [];
  for (const target of targets) {
    const devices = new Set(target.physicalDeviceIds);
    for (let i = physicalGroups.length - 1; i >= 0; i--)
      if ([...physicalGroups[i]!].some(id => devices.has(id))) {
        for (const id of physicalGroups[i]!) devices.add(id);
        physicalGroups.splice(i, 1);
      }
    physicalGroups.push(devices);
  }
  const independentDeviceGroups = targets.every(t => t.physicalDeviceIds.length)
    ? physicalGroups.length
    : null;
  // This opaque local identity excludes free capacity and timestamp: capacity is rechecked at every gate.
  const fingerprint = JSON.stringify([
    mode,
    requiredBytes,
    [source, ...targets].map(r => [
      r.path,
      r.filesystemId,
      r.capacityPoolId,
      r.physicalDeviceIds,
      r.present,
    ]),
  ]);
  return {
    fingerprint,
    checkedAt: new Date().toISOString(),
    source,
    targets,
    groups,
    risks,
    blockingReasons,
    requiredBytes,
    independentDeviceGroups,
  };
}
export function requirePreflight(
  result: TargetPreflightResult,
  confirmation?: PreflightConfirmation,
): void {
  if (result.blockingReasons.length)
    throw Error(result.blockingReasons.join('；'));
  if (
    result.risks.length &&
    (!confirmation?.acceptRisks ||
      confirmation.fingerprint !== result.fingerprint)
  )
    throw Error('存储风险或位置已改变，请重新预检并明确确认');
}
export const riskLabels: Record<
  TargetPreflightResult['risks'][number]['code'],
  string
> = {
  'shared-filesystem': '多个目标共用存储卷，容量合计计算，不能算作独立物理备份',
  'shared-device': '多个目标位于同一物理设备，不能算作独立备份',
  'independence-unknown': '无法确认物理设备独立性；卷标不同不代表独立硬盘',
  'insufficient-space': '目标可用容量不足或未知',
  'source-device': '来源和目标位于同一物理设备，设备损坏会同时影响素材与备份',
};
