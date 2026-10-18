// SPDX-License-Identifier: GPL-3.0-only
export const HASHES = [
  'xxhash64',
  'xxh3',
  'xxh128',
  'md5',
  'sha1',
  'sha256',
  'asc-c4',
] as const;
export type HashAlgorithm = (typeof HASHES)[number];
export type ManifestFormat = 'asc-mhl-2.0' | 'mhl-v1' | 'csv' | 'json';
export interface Root {
  id: string;
  label: string;
  role: 'source' | 'target';
  accessible: boolean;
  writable: boolean;
  supportsVerifiedCommit: boolean;
  volumeId: string | null;
  diskName?: string;
  folderName?: string;
  freeBytes?: number | null;
  connected?: boolean;
  disabledReason?: string;
}
import {
  readTaskProjectSchema,
  normalizeProject,
  taskProjectSchema,
  type ProjectDetails,
  type TaskProject,
} from './projectData';
import {
  confirmationSchema,
  preflightSchema,
  type PreflightConfirmation,
  type TargetPreflightResult,
} from './backupSafety';
export interface Draft {
  preflightConfirmation?: PreflightConfirmation;
  name: string;
  mode: 'copy' | 'verify';
  sourceRootId: string;
  targetRootIds: string[];
  hashAlgorithm: HashAlgorithm;
  manifestFormat: ManifestFormat;
  projectName: string;
  parentProjectId?: string | null;
  project?: TaskProject;
}
export interface FileResult {
  relativePath: string;
  bytes: number;
  sourceHash: string;
  targets: { rootId: string; status: string; hash: string; bytes: number }[];
}
export interface Job {
  backupSafety?: TargetPreflightResult;
  id: string;
  name: string;
  mode: 'copy' | 'verify';
  state: string;
  totalFiles: number;
  totalBytes: number;
  filesDone: number;
  filesFailed: number;
  bytesDone: number;
  sourceRootId: string;
  targetRootIds: string[];
  hashAlgorithm?: HashAlgorithm;
  manifestFormat?: ManifestFormat;
  projectName?: string;
  files?: FileResult[];
  phase?: string;
  origin?: 'local' | 'desktop';
  project?: TaskProject;
  parentProjectId?: string | null;
  parentProjectName?: string | null;
}
export interface Project {
  id: string;
  name: string;
  details?: ProjectDetails;
  createdAt?: string;
  updatedAt?: string | null;
  notes?: string;
  camera?: string;
  shootDay?: string;
}
export interface Snapshot {
  jobs: Job[];
  projects: Project[];
}
export interface Setup {
  version: 1;
  url: string;
  fingerprint: string;
  pairingCode: string;
  expiresAt: number;
  desktopName?: string;
}
export interface ReportBundle {
  html: string;
  json: string;
  manifest: string;
  manifestName: string;
}
import { z } from 'zod';
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z
  .string()
  .max(4000)
  .refine(
    value =>
      ![...value].some(character => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 && ![9, 10, 13].includes(code);
      }),
  );
const rootId = z.string().min(1).max(256);
const draftSchema = z
  .object({
    preflightConfirmation: confirmationSchema.optional(),
    name: text.refine(value => value.trim().length > 0),
    mode: z.enum(['copy', 'verify']),
    sourceRootId: rootId,
    targetRootIds: z.array(rootId).min(1).max(2),
    hashAlgorithm: z.enum(HASHES),
    manifestFormat: z.enum(['asc-mhl-2.0', 'mhl-v1', 'csv', 'json']),
    projectName: text,
    parentProjectId: rootId.nullable().optional(),
    project: taskProjectSchema.optional(),
  })
  .strict();
const states = [
  'draft',
  'queued',
  'running',
  'paused',
  'interrupted',
  'completed',
  'completed-with-errors',
  'failed',
  'cancelled',
] as const;
const targetSchema = z.object({
  rootId,
  status: z.enum(['verified', 'collision', 'failed', 'cancelled', 'mismatch']),
  hash: z.string().max(128),
  bytes: count,
});
const fileSchema = z.object({
  relativePath: text.refine(validRelative),
  bytes: count,
  sourceHash: z.string().max(128),
  targets: z.array(targetSchema).max(2),
});
const jobSchema = z
  .object({
    id: rootId,
    backupSafety: preflightSchema.optional(),
    name: text,
    mode: z.enum(['copy', 'verify']),
    state: z.enum(states),
    totalFiles: count,
    totalBytes: count,
    filesDone: count,
    filesFailed: count,
    bytesDone: count,
    sourceRootId: rootId,
    targetRootIds: z.array(rootId).max(8),
    hashAlgorithm: z.enum(HASHES).optional(),
    manifestFormat: z.enum(['asc-mhl-2.0', 'mhl-v1', 'csv', 'json']).optional(),
    projectName: text.optional(),
    files: z.array(fileSchema).optional(),
    phase: text.optional(),
    origin: z.enum(['local', 'desktop']).optional(),
    project: readTaskProjectSchema.optional(),
    parentProjectId: rootId.nullable().optional(),
    parentProjectName: text.nullable().optional(),
  })
  .refine(
    job =>
      job.filesDone + job.filesFailed <= job.totalFiles &&
      job.bytesDone <= job.totalBytes,
  );
function validRelative(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value
      .split('/')
      .some(part => part === '..' || part === '.' || part === '') &&
    !/^[A-Za-z]:/.test(value)
  );
}
export function compatible(
  format: ManifestFormat,
  algorithm: HashAlgorithm,
): boolean {
  if (format === 'asc-mhl-2.0') return algorithm !== 'sha256';
  if (format === 'mhl-v1')
    return ['xxhash64', 'md5', 'asc-c4'].includes(algorithm);
  return true;
}
export function validateDraft(input: unknown, roots: Root[]): Draft {
  const draft = draftSchema.parse(input);
  if (!compatible(draft.manifestFormat, draft.hashAlgorithm))
    throw new Error('清单格式不支持所选校验算法');
  const source = roots.find(
    root =>
      root.id === draft.sourceRootId &&
      root.role === 'source' &&
      root.accessible,
  );
  if (!source) throw new Error('请重新授权来源目录');
  const selected = draft.targetRootIds.map(id =>
    roots.find(
      root => root.id === id && root.role === 'target' && root.accessible,
    ),
  );
  if (
    new Set(draft.targetRootIds).size !== draft.targetRootIds.length ||
    draft.targetRootIds.includes(source.id)
  )
    throw new Error('来源与目标必须独立');
  for (const target of selected) {
    if (!target) throw new Error('请重新授权目标目录');
    if (draft.mode === 'copy') {
      if (!target.writable || !target.supportsVerifiedCommit)
        throw new Error('此目标尚不支持安全拷贝，可使用仅校验模式');
      if (source.volumeId && source.volumeId === target.volumeId)
        throw new Error('拷贝来源与目标必须位于不同存储卷');
    }
  }
  return draft;
}
export function validateSetup(input: unknown, now: number = Date.now()): Setup {
  const value = z
    .object({
      version: z.literal(1),
      url: z.string().max(512),
      fingerprint: z.string().max(128),
      pairingCode: z.string().min(8).max(128),
      expiresAt: z.number().int().positive(),
      desktopName: z.string().max(120).optional(),
    })
    .strict()
    .parse(input);
  const url = new URL(value.url);
  const octets = url.hostname.split('.').map(Number);
  const privateHost =
    octets.length === 4 &&
    octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (octets[0] === 10 ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
  const expiry = value.expiresAt;
  if (
    url.protocol !== 'https:' ||
    !privateHost ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !Number.isFinite(expiry) ||
    expiry <= now
  )
    throw new Error('请输入未过期的局域网配对信息');
  const fingerprint = value.fingerprint.replace(/:/g, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('配对证书指纹无效');
  return { ...value, url: url.origin, fingerprint };
}
export function canReport(state: string): boolean {
  return ['completed', 'completed-with-errors', 'failed', 'cancelled'].includes(
    state,
  );
}
export function normalizeSnapshot(input: unknown): Snapshot {
  return z
    .object({
      jobs: z.array(jobSchema),
      projects: z
        .array(z.unknown())
        .transform(list => list.map(normalizeProject)),
    })
    .parse(input);
}
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
function csv(value: string): string {
  const safe = /^[\s]*[=+\-@]/.test(value) ? "'" + value : value;
  return '"' + safe.replace(/"/g, '""') + '"';
}
export function reportBundle(input: Job): ReportBundle {
  const job = jobSchema.parse(input);
  if (!canReport(job.state)) throw new Error('任务结束后才能生成报告');
  const algorithm = job.hashAlgorithm ?? 'xxhash64',
    format = job.manifestFormat ?? 'asc-mhl-2.0';
  if (!compatible(format, algorithm))
    throw new Error('清单格式不支持所选校验算法');
  const files = job.files ?? [];
  const verified = files.filter(file =>
    file.targets.some(
      target => target.status === 'verified' && target.hash === file.sourceHash,
    ),
  );
  const payload = {
    format: 'securereel-mobile-report',
    version: 1,
    ...job,
    hashAlgorithm: algorithm,
    manifestFormat: format,
  };
  const json = JSON.stringify(payload, null, 2);
  const rows = files
    .map(
      file =>
        '<tr><td>' +
        xml(file.relativePath) +
        '</td><td>' +
        file.bytes +
        '</td><td>' +
        xml(file.sourceHash) +
        '</td><td>' +
        file.targets
          .map(
            target =>
              xml(target.rootId) +
              ': ' +
              xml(target.status) +
              ' / ' +
              xml(target.hash),
          )
          .join('<br>') +
        '</td></tr>',
    )
    .join('');
  const title = job.mode === 'verify' ? '素材复核报告' : '素材拷贝与校验报告';
  const html =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;"><title>' +
    title +
    '</title><style>body{font:14px -apple-system,sans-serif;padding:24px;color:#121316}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:8px;overflow-wrap:anywhere}h1{font-size:24px}</style></head><body><h1>' +
    title +
    '</h1><p>' +
    xml(job.name) +
    ' · ' +
    xml(job.projectName ?? '') +
    '</p><p>状态：' +
    xml(job.state) +
    ' · 校验算法：' +
    algorithm +
    '</p><p>已校验 ' +
    job.filesDone +
    ' / ' +
    job.totalFiles +
    '；失败 ' +
    job.filesFailed +
    '。' +
    (job.mode === 'verify'
      ? '仅校验，未写入源与目标素材。'
      : '目标写入后独立重读校验；代理不能替代原素材备份。') +
    '</p>' +
    (job.project
      ? '<h2>项目资料</h2><p>母项目：' +
        xml(job.parentProjectName ?? job.project.parentProjectName ?? '') +
        '<br>拍摄日期：' +
        xml(job.project.shootDay) +
        '<br>摄影机：' +
        xml(job.project.camera) +
        '<br>卡号：' +
        xml(job.project.cardLabel) +
        '<br>人员：' +
        job.project.crew
          .map(p => xml(p.role) + ' · ' + xml(p.name))
          .join('<br>') +
        '<br>镜头：' +
        job.project.lenses
          .map(p => xml(p.model) + ' ' + xml(p.detail))
          .join('<br>') +
        '<br>项目备注：' +
        xml(job.project.notes) +
        '<br>拷贝备注：' +
        xml(job.project.copyNotes) +
        '</p>'
      : '') +
    (job.backupSafety
      ? '<h2>备份存储安全</h2><p>独立物理设备组：' +
        (job.backupSafety.independentDeviceGroups ?? '未知') +
        '</p><pre>' +
        xml(JSON.stringify(job.backupSafety, null, 2)) +
        '</pre>'
      : '') +
    '<table><thead><tr><th>文件</th><th>字节</th><th>源校验值</th><th>各目标结果</th></tr></thead><tbody>' +
    rows +
    '</tbody></table></body></html>';
  let manifest: string, manifestName: string;
  if (format === 'json') {
    manifest = JSON.stringify(
      { format: 'securereel-hashlist', version: 1, algorithm, files: verified },
      null,
      2,
    );
    manifestName = 'hashes.json';
  } else if (format === 'csv') {
    manifest =
      '\ufeff"path","size","algorithm","source_hash","target","target_hash","status"\r\n' +
      files
        .flatMap(file =>
          file.targets.map(target =>
            [
              file.relativePath,
              String(file.bytes),
              algorithm,
              file.sourceHash,
              target.rootId,
              target.hash,
              target.status,
            ]
              .map(csv)
              .join(','),
          ),
        )
        .join('\r\n');
    manifestName = 'hashes.csv';
  } else {
    const stamp = new Date().toISOString(),
      element =
        algorithm === 'asc-c4'
          ? 'c4'
          : algorithm === 'xxhash64'
            ? format === 'asc-mhl-2.0'
              ? 'xxh64'
              : 'xxhash64'
            : algorithm;
    const hashes = verified
      .map(file =>
        format === 'asc-mhl-2.0'
          ? '<hash><path size="' +
            file.bytes +
            '">' +
            xml(file.relativePath) +
            '</path><' +
            element +
            ' action="original" hashdate="' +
            stamp +
            '">' +
            xml(file.sourceHash) +
            '</' +
            element +
            '></hash>'
          : '<hash><path>' +
            xml(file.relativePath) +
            '</path><size>' +
            file.bytes +
            '</size><' +
            element +
            '>' +
            xml(file.sourceHash) +
            '</' +
            element +
            '><hashdate>' +
            stamp +
            '</hashdate></hash>',
      )
      .join('');
    manifest =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      (format === 'asc-mhl-2.0'
        ? '<hashlist xmlns="urn:ASC:MHL:v2.0" version="2.0"><creatorinfo><creationdate>' +
          stamp +
          '</creationdate><hostname>mobile</hostname><tool version="2.0.8">SecureReel DIT</tool></creatorinfo><processinfo><process>' +
          (job.mode === 'verify' ? 'in-place' : 'transfer') +
          '</process></processinfo>' +
          (hashes ? '<hashes>' + hashes + '</hashes>' : '') +
          '</hashlist>'
        : '<mhl xmlns="http://mediahashlist.org/ns/1.0"><creator><name>SecureReel DIT</name><version>2.0.8</version></creator><hashes>' +
          hashes +
          '</hashes></mhl>');
    manifestName = format === 'asc-mhl-2.0' ? 'ascmhl.mhl' : 'hashlist.mhl';
  }
  return { html, json, manifest, manifestName };
}
