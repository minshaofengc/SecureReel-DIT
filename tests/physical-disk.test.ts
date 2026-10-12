import { describe, expect, it } from 'vitest'
import { physicalDisksFromPlist, physicalVolumeProbe } from '../src/main/platform'
describe('physical disk identity', () => {
  it('groups APFS volumes with their backing physical disk', () => {
    expect(
      physicalDisksFromPlist(
        '<key>APFSPhysicalStore</key><string>disk0s2</string><key>ParentWholeDisk</key><string>disk3</string>'
      )
    ).toEqual(['disk0'])
  })
  it('groups exFAT partitions with their parent disk', () => {
    expect(physicalDisksFromPlist('<key>ParentWholeDisk</key><string>disk4</string>')).toEqual([
      'disk4'
    ])
  })
  it('does not guess a device when information is unavailable', () => {
    expect(physicalDisksFromPlist('unavailable')).toEqual([])
  })
  it('Windows drive letter stays separate from executable command', () => {
    const command = physicalVolumeProbe('E:\\clips', 'win32')
    expect(command?.env).toEqual({ SECUREREEL_DRIVE: 'E' })
    expect(command?.args.join(' ')).not.toContain('E:\\clips')
  })
})
