import { expect, it } from 'vitest';
import { normalizeSnapshot, reportBundle, validateSetup } from '../src/domain';
import {
  normalizeProject,
  validateProjectDetails,
  normalizeSettings,
} from '../src/projectData';
it('preserves mother-project people/lenses and migrates old flat fields without changing id', () => {
  const old = normalizeProject({
    id: 'prj_old',
    name: '电影',
    camera: 'A35',
    notes: '保留',
  });
  expect(old.id).toBe('prj_old');
  expect(old.details.camera).toBe('A35');
  expect(old.details.crew).toEqual([]);
  const details = validateProjectDetails({
    ...old.details,
    crew: [{ name: '张三', role: '摄影指导' }],
    lenses: [{ model: 'Prime', detail: '50mm' }],
  });
  const snapshot = normalizeSnapshot({
    jobs: [],
    projects: [{ ...old, details }],
  });
  expect(snapshot.projects[0]?.details?.crew[0]?.role).toBe('摄影指导');
});
it('rejects too many people and incompatible persisted defaults', () => {
  const details = normalizeProject({ id: 'prj_1', name: '项目' }).details;
  expect(() =>
    validateProjectDetails({
      ...details,
      crew: Array(51).fill({ role: '摄影', name: '姓名' }),
    }),
  ).toThrow();
  expect(
    normalizeSettings({
      hashAlgorithm: 'sha256',
      manifestFormat: 'asc-mhl-2.0',
    }).manifestFormat,
  ).toBe('json');
});
it('accepts desktop identity without weakening pairing validation', () => {
  expect(
    validateSetup({
      version: 1,
      url: 'https://192.168.1.2:1234',
      fingerprint: 'ab'.repeat(32),
      pairingCode: 'abcdefgh',
      expiresAt: Date.now() + 10000,
      desktopName: '现场Mac',
    }).desktopName,
  ).toBe('现场Mac');
});
it('full project snapshots survive JSON reports and escape HTML', () => {
  const project = {
    ...normalizeProject({ id: 'prj_1', name: '电影' }).details,
    crew: [{ role: 'DIT', name: '<张三>' }],
    cardLabel: 'A001',
    copyNotes: '现场',
    parentProjectName: '电影',
  };
  const job = {
    id: 'job_1',
    name: '卡1',
    mode: 'verify' as const,
    state: 'completed',
    totalFiles: 0,
    totalBytes: 0,
    filesDone: 0,
    filesFailed: 0,
    bytesDone: 0,
    sourceRootId: 'src',
    targetRootIds: ['a'],
    project,
    origin: 'local' as const,
    parentProjectName: '电影',
  };
  const report = reportBundle(job);
  expect(JSON.parse(report.json).project.crew[0].name).toBe('<张三>');
  expect(report.html).toContain('&lt;张三&gt;');
  expect(report.html).toContain('A001');
});
it('reads desktop-compatible multiline people and lens metadata and legacy long task notes', () => {
  const details = {
    ...normalizeProject({ id: 'prj_1', name: '电影' }).details,
    crew: [{ role: '摄影\n指导', name: '张\u0000三' }],
    lenses: [{ model: 'Prime\n35', detail: 'T\t2' }],
    notes: '旧'.repeat(5000),
  };
  const project = normalizeProject({ id: 'prj_1', name: '电影', details });
  expect(project.details.crew[0]?.role).toBe('摄影\n指导');
  const snapshot = normalizeSnapshot({
    projects: [project],
    jobs: [
      {
        id: 'job_1',
        name: '任务',
        mode: 'verify',
        state: 'completed',
        totalFiles: 0,
        totalBytes: 0,
        filesDone: 0,
        filesFailed: 0,
        bytesDone: 0,
        sourceRootId: 'src',
        targetRootIds: ['a'],
        project: {
          ...details,
          cardLabel: 'A001',
          copyNotes: '旧'.repeat(5000),
        },
      },
    ],
  });
  expect(snapshot.jobs[0]?.project?.notes.length).toBe(5000);
});
