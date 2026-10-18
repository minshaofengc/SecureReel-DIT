import { expect, it } from 'vitest';
import { selectTargetSlot, rootPosition } from '../src/storageSelection';
it('replaces the requested backup slot while preserving the other target and refuses duplicates', () => {
  expect(selectTargetSlot(['disk-a', 'disk-b'], 'disk-c', 0)).toEqual([
    'disk-c',
    'disk-b',
  ]);
  expect(selectTargetSlot(['disk-a'], 'disk-b', 1)).toEqual([
    'disk-a',
    'disk-b',
  ]);
  expect(() => selectTargetSlot(['disk-a', 'disk-b'], 'disk-b', 0)).toThrow();
  expect(() => selectTargetSlot([], 'disk-b', 1)).toThrow();
});
it('makes identical folder names on different disks distinguishable in the position review', () => {
  const base = {
    id: 'root',
    label: 'A001',
    role: 'target' as const,
    accessible: true,
    writable: true,
    supportsVerifiedCommit: true,
    volumeId: 'volume',
  };
  expect(
    rootPosition({ ...base, diskName: '摄影卡', folderName: 'DCIM/A001' }),
  ).toBe('摄影卡\nDCIM/A001');
  expect(
    rootPosition({ ...base, diskName: '备份SSD', folderName: '片名/A001' }),
  ).toBe('备份SSD\n片名/A001');
});
