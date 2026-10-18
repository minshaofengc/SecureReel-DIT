/** Snapshot of storage topology, safe to expose to the renderer and reports. */
export interface StorageIdentity {
  path: string
  label: string
  filesystemId: string | null
  physicalDeviceIds: string[]
  capacityPoolId: string | null
  availableBytes: number | null
  present: boolean
}

export interface StorageRisk {
  code:
    | 'shared-filesystem'
    | 'shared-device'
    | 'independence-unknown'
    | 'insufficient-space'
    | 'source-device'
  paths: string[]
}

export interface TargetPreflightResult {
  fingerprint: string
  checkedAt: string
  source: StorageIdentity
  targets: StorageIdentity[]
  groups: {
    id: string
    paths: string[]
    requiredBytes: number
    availableBytes: number | null
    sufficient: boolean | null
  }[]
  risks: StorageRisk[]
  blockingReasons: string[]
  requiredBytes: number
  independentDeviceGroups: number | null
}

export interface PreflightConfirmation {
  fingerprint: string
  acceptRisks: boolean
}
