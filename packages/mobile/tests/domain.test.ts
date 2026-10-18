import { describe, it, expect } from 'vitest';
import {
  validateDraft,
  validateSetup,
  reportBundle,
  canReport,
  normalizeSnapshot,
  type Root,
  type Job,
} from '../src/domain';
const roots: Root[] = [
  {
    id: 'src',
    label: 'Card',
    role: 'source',
    accessible: true,
    writable: false,
    supportsVerifiedCommit: false,
    volumeId: 'card',
  },
  ...['a', 'b'].map(id => ({
    id,
    label: id,
    role: 'target' as const,
    accessible: true,
    writable: true,
    supportsVerifiedCommit: true,
    volumeId: id,
  })),
];
const draft = {
  name: '卡 A001',
  mode: 'copy',
  sourceRootId: 'src',
  targetRootIds: ['a', 'b'],
  hashAlgorithm: 'xxhash64',
  manifestFormat: 'asc-mhl-2.0',
  projectName: '片场',
};
const completed: Job = {
  id: 'local-1',
  ...draft,
  mode: 'copy',
  hashAlgorithm: 'xxhash64',
  manifestFormat: 'json',
  state: 'completed',
  totalFiles: 1,
  totalBytes: 3,
  filesDone: 1,
  filesFailed: 0,
  bytesDone: 3,
  files: [
    {
      relativePath: '目录/<镜头>.mov',
      bytes: 3,
      sourceHash: '44bc2cf5ad770999',
      targets: [
        { rootId: 'a', status: 'verified', hash: '44bc2cf5ad770999', bytes: 3 },
      ],
    },
  ],
};
describe('mobile domain safety', () => {
  it('accepts a read-only source and two independent writable targets', () => {
    expect(validateDraft(draft, roots).targetRootIds).toEqual(['a', 'b']);
  });
  it('rejects unknown or overlapping source and duplicate/more than two targets', () => {
    for (const patch of [
      { sourceRootId: '/private/file' },
      { targetRootIds: ['src'] },
      { targetRootIds: ['a', 'a'] },
      { targetRootIds: ['a', 'b', 'c'] },
    ])
      expect(() => validateDraft({ ...draft, ...patch }, roots)).toThrow();
  });
  it('blocks copy to unproven commit provider but allows read-only verification', () => {
    const limited = roots.map(r =>
      r.id === 'a'
        ? { ...r, writable: false, supportsVerifiedCommit: false }
        : r,
    );
    expect(() =>
      validateDraft({ ...draft, targetRootIds: ['a'] }, limited),
    ).toThrow();
    expect(
      validateDraft({ ...draft, mode: 'verify', targetRootIds: ['a'] }, limited)
        .mode,
    ).toBe('verify');
  });
  it('rejects same-volume backup and incompatible SHA256 ASC MHL', () => {
    expect(() =>
      validateDraft(
        draft,
        roots.map(r => (r.id === 'a' ? { ...r, volumeId: 'card' } : r)),
      ),
    ).toThrow();
    expect(() =>
      validateDraft({ ...draft, hashAlgorithm: 'sha256' }, roots),
    ).toThrow();
  });
  it('blocks reports for draft/queued/running/paused/interrupted states', () => {
    for (const state of ['draft', 'queued', 'running', 'paused', 'interrupted'])
      expect(canReport(state)).toBe(false);
    expect(canReport('completed-with-errors')).toBe(true);
  });
  it('escapes HTML and includes independent target verification in reports', () => {
    const report = reportBundle(completed);
    expect(report.html).toContain('&lt;镜头&gt;');
    expect(JSON.parse(report.json).files[0].targets[0].hash).toBe(
      '44bc2cf5ad770999',
    );
    expect(() => reportBundle({ ...completed, state: 'paused' })).toThrow();
  });
  it('prevents XML traversal and CSV formula injection', () => {
    expect(() =>
      reportBundle({
        ...completed,
        files: [{ ...completed.files![0], relativePath: '../outside' }],
      }),
    ).toThrow();
    const csv = reportBundle({
      ...completed,
      manifestFormat: 'csv',
      files: [{ ...completed.files![0], relativePath: '=1+2.mov' }],
    }).manifest;
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(csv).toContain("'=1+2.mov");
  });
  it('accepts only unexpired LAN HTTPS setups and normalizes fingerprint', () => {
    const setup = {
      version: 1,
      url: 'https://192.168.1.2:9450',
      fingerprint: 'AB:'.repeat(31) + 'AB',
      pairingCode: 'abcd1234',
      expiresAt: Date.parse('2026-10-12T02:00:00Z'),
    };
    expect(
      validateSetup(setup, Date.parse('2026-10-12T01:00:00Z')).fingerprint,
    ).toBe('ab'.repeat(32));
    for (const url of [
      'http://192.168.1.2:9450',
      'https://example.com',
      'https://192.168.1.2:9450/evil',
      'https://192.168.1.2:9450@evil.com',
    ])
      expect(() => validateSetup({ ...setup, url }, 0)).toThrow();
    expect(() =>
      validateSetup(setup, Date.parse('2026-10-13T00:00:00Z')),
    ).toThrow();
  });
  it('resynchronizes completed counts instead of accumulating stale events', () => {
    const next = normalizeSnapshot({ jobs: [completed], projects: [] });
    expect(next.jobs[0]?.filesDone).toBe(1);
    expect(() =>
      normalizeSnapshot({
        jobs: [{ ...completed, filesDone: NaN }],
        projects: [],
      }),
    ).toThrow();
  });
});
