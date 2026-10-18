import { describe, expect, it } from 'vitest';
import {
  evaluatePreflight,
  requirePreflight,
  preflightSchema,
  type StorageIdentity,
} from '../src/backupSafety';
const identity = (
  path: string,
  filesystemId: string | null,
  availableBytes: number | null = 100,
): StorageIdentity => ({
  path,
  label: path,
  filesystemId,
  capacityPoolId: filesystemId,
  physicalDeviceIds: [],
  availableBytes,
  present: true,
});
const source = identity('source', 'card');
describe('backup safety', () => {
  it('aggregates two 60 byte copies in the same 100 byte volume', () => {
    const result = evaluatePreflight('copy', 60, source, [
      identity('a', 'usb'),
      identity('b', 'usb'),
    ]);
    expect(result.groups[0]).toMatchObject({
      requiredBytes: 120,
      availableBytes: 100,
      sufficient: false,
    });
    expect(result.blockingReasons).toEqual([]);
    expect(() => requirePreflight(result)).toThrow();
    expect(() => requirePreflight(result, {fingerprint: result.fingerprint, acceptRisks: true})).not.toThrow();
  });
  it('allows shared targets only with the current fingerprint acknowledgement and never calls them independent', () => {
    const result = evaluatePreflight('copy', 30, source, [
      identity('a', 'usb'),
      identity('b', 'usb'),
    ]);
    expect(result.risks.some(r => r.code === 'shared-filesystem')).toBe(true);
    expect(result.independentDeviceGroups).toBeNull();
    expect(() => requirePreflight(result)).toThrow();
    expect(() =>
      requirePreflight(result, {
        fingerprint: result.fingerprint,
        acceptRisks: true,
      }),
    ).not.toThrow();
    expect(() =>
      requirePreflight(result, { fingerprint: 'old', acceptRisks: true }),
    ).toThrow();
  });
  it('blocks unknown capacity for copy and permits readonly verification', () => {
    expect(
      evaluatePreflight('copy', 10, source, [identity('a', 'usb', null)])
        .blockingReasons.length,
    ).toBeGreaterThan(0);
    const result = evaluatePreflight('verify', 10, source, [
      identity('a', 'card', null),
    ]);
    expect(result.blockingReasons).toEqual([]);
    expect(() => requirePreflight(result)).not.toThrow();
  });
});
it('counts overlapping physical devices as one group even when a volume spans multiple disks', () => {
  const a = { ...identity('a', 'one'), physicalDeviceIds: ['disk1', 'disk2'] };
  const b = { ...identity('b', 'two'), physicalDeviceIds: ['disk2', 'disk3'] };
  const result = evaluatePreflight(
    'copy',
    10,
    { ...source, physicalDeviceIds: ['card-disk'] },
    [a, b],
  );
  expect(result.independentDeviceGroups).toBe(1);
  expect(result.risks.some(r => r.code === 'shared-device')).toBe(true);
});
it('invalidates accepted consent when paths or required bytes change and still rechecks available capacity', () => {
  const original = evaluatePreflight('copy', 30, source, [
    identity('a', 'usb'),
  ]);
  const confirmation = { fingerprint: original.fingerprint, acceptRisks: true };
  expect(() =>
    requirePreflight(
      evaluatePreflight('copy', 31, source, [identity('a', 'usb')]),
      confirmation,
    ),
  ).toThrow();
  expect(() =>
    requirePreflight(
      evaluatePreflight('copy', 30, source, [identity('b', 'usb')]),
      confirmation,
    ),
  ).toThrow();
  expect(() =>
    requirePreflight(
      evaluatePreflight('copy', 30, source, [identity('a', 'usb', 20)]),
      confirmation,
    ),
  ).not.toThrow();
});
it('permits the 60GB task after 20GB was written from 70GB free only with current explicit consent', () => {
  const gb=1024**3;
  const result=evaluatePreflight('copy',60*gb,source,[identity('a','usb',50*gb)]);
  expect(result.groups[0]).toMatchObject({requiredBytes:60*gb,availableBytes:50*gb,sufficient:false});
  expect(result.risks.some(r=>r.code==='insufficient-space')).toBe(true);
  expect(result.blockingReasons).toEqual([]);
  expect(()=>requirePreflight(result)).toThrow();
  expect(()=>requirePreflight(result,{fingerprint:result.fingerprint,acceptRisks:true})).not.toThrow();
});
it('accepts desktop unknown-capacity sufficient null and preserves the copy block',()=>{
 const result=evaluatePreflight('copy',10,source,[identity('a','usb',null)]);
 const desktop={...result,groups:result.groups.map(g=>({...g,sufficient:null}))};
 expect(preflightSchema.safeParse(desktop).success).toBe(true);
 expect(()=>requirePreflight(preflightSchema.parse(desktop),{fingerprint:result.fingerprint,acceptRisks:true})).toThrow('未知');
});
