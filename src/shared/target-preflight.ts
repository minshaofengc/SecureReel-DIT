import type { DriveUsage } from './types'

export type TargetPreflightState =
  | 'not_checked'
  | 'checking'
  | 'ready'
  | 'insufficient'
  | 'unknown'
  | 'failed'
  | 'missing'
  | 'conflict'

export interface TargetPreflightInput {
  path: string
  usage: DriveUsage[]
  sourceScanned: boolean
  checking: boolean
  lookupFailed: boolean
  verifyOnly: boolean
}
/** Only measured capacity qualifies for ready. It never implies write/Hash success. */
export function targetPreflightState(input: TargetPreflightInput): TargetPreflightState {
  if (!input.sourceScanned) return 'not_checked'
  if (input.checking) return 'checking'
  if (input.lookupFailed) return 'failed'
  const record = input.usage.find((row) => row.path === input.path)
  if (record?.missing === true) return 'missing'
  if (record === undefined || record.measured !== true) return 'unknown'
  if (input.verifyOnly) return 'ready'
  if (record.sufficient === false) return 'insufficient'
  return record.sufficient === true ? 'ready' : 'unknown'
}
export function targetPreflightStatusList(
  paths: readonly string[],
  input: Omit<TargetPreflightInput, 'path'>
): TargetPreflightState[] {
  return paths.map((path) => targetPreflightState({ ...input, path }))
}

/** Early, conservative user-facing guard against obvious source/target nesting.
 * The main process still owns canonical path, symlink and volume validation.
 * This intentionally NEVER claims two non-overlapping paths are on separate drives.
 */
export function obviousSourceTargetOverlap(
  source: string,
  target: string,
  windows: boolean
): boolean {
  const normalize = (value: string): string => {
    const base = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
      .replace(/\/$/, '') || '/'
    return windows ? base.toLocaleLowerCase('en-US') : base
  }
  if (!source.trim() || !target.trim()) return false
  const a = normalize(source)
  const b = normalize(target)
  const within = (child: string, parent: string): boolean =>
    child === parent || child.startsWith(parent === '/' ? '/' : parent + '/')
  return within(a, b) || within(b, a)
}
