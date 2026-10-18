// SPDX-License-Identifier: GPL-3.0-only
import type { Draft, Job } from './domain';
import {
  preflightSchema,
  type TargetPreflightResult,
  type PreflightConfirmation,
} from './backupSafety';
export interface DurableMutations {
  get?: (
    key: string,
  ) => Promise<
    { requestId: string; body: Record<string, unknown> } | undefined
  >;
  pending: (
    key: string,
    body: Record<string, unknown>,
  ) => Promise<{ requestId: string; body: Record<string, unknown> }>;
  complete: (key: string) => Promise<void>;
}
type Request = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<unknown>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function sameMutationBody(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function draftIdentity(draft: Draft): string {
  const value = { ...draft };
  delete value.preflightConfirmation;
  return fingerprint(value);
}
function fingerprint(value: unknown): string {
  return JSON.stringify(canonical(value));
}
export function isDefinitePeerRejection(cause: unknown): boolean {
  return Boolean(
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    ['PEER_VALIDATION', 'PEER_AUTH', 'PEER_VERSION'].includes(
      String(cause.code),
    ),
  );
}
export async function projectMutation(
  request: Request,
  durable: DurableMutations,
  key: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const previous = await durable.get?.(key);
  const pending = await durable.pending(key, body);
  if (!sameMutationBody(pending.body, body))
    throw Error('上次项目操作尚未确认，请恢复原内容重试');
  try {
    const result = await request('POST', '/api/v1/projects', {
      ...pending.body,
      requestId: pending.requestId,
    });
    await durable.complete(key);
    return result;
  } catch (cause) {
    if (isDefinitePeerRejection(cause) && !previous)
      await durable.complete(key);
    throw cause;
  }
}
/** Retain mutation identities until receipt; a transport timeout is not rejection. */
export class DesktopCommands {
  private creation?: {
    fingerprint: string;
    body: Record<string, unknown>;
    uncertain?: boolean;
  };
  private controls = new Map<
    string,
    { requestId: string; uncertain: boolean; body: Record<string, unknown> }
  >();
  constructor(
    private request: Request,
    private identity: () => string,
    private durable?: DurableMutations,
  ) {}
  async preflight(
    draft: Pick<
      Draft,
      | 'sourceRootId'
      | 'targetRootIds'
      | 'mode'
      | 'hashAlgorithm'
      | 'manifestFormat'
    >,
    jobId?: string,
  ): Promise<TargetPreflightResult> {
    try {
      const result = preflightSchema.safeParse(
        await this.request('POST', '/api/v1/preflight', {
          sourceRootId: draft.sourceRootId,
          targetRootIds: draft.targetRootIds,
          mode: draft.mode,
          hashAlgorithm: draft.hashAlgorithm,
          manifestFormat: draft.manifestFormat,
          ...(jobId ? { jobId } : {}),
        }),
      );
      if (!result.success)
        throw Error(
          '电脑端尚不支持安全预检，请升级电脑端至 2.0.8；已有任务仍可监控',
        );
      return result.data;
    } catch (cause) {
      if (
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        cause.code === 'PEER_VERSION'
      )
        throw Error(
          '电脑端尚不支持安全预检，请升级电脑端至 2.0.8；已有任务仍可监控',
        );
      throw cause;
    }
  }
  async create(draft: Draft): Promise<Job> {
    const projectName = draft.projectName.trim() || draft.name.trim();
    if (
      projectName.length > 120 ||
      projectName.includes('/') ||
      projectName.includes('\\') ||
      [...projectName].some(c => (c.codePointAt(0) ?? 0) < 32)
    )
      throw new Error('电脑项目名称不能包含路径符号或换行，且最多120个字符');
    const draftFingerprint = draftIdentity(draft);
    if (this.creation && this.creation.fingerprint !== draftFingerprint)
      throw new Error(
        '上一次创建结果尚未确认，请恢复原来的填写内容并重试；也可先查看电脑任务列表',
      );
    this.creation ??= {
      fingerprint: draftFingerprint,
      body: {
        requestId: this.identity(),
        name: draft.name.trim(),
        sourceRootId: draft.sourceRootId,
        targetRootIds: [...draft.targetRootIds],
        mode: draft.mode,
        hashAlgorithm: draft.hashAlgorithm,
        manifestFormat: draft.manifestFormat,
        projectName,
        ...(draft.preflightConfirmation
          ? { preflightConfirmation: { ...draft.preflightConfirmation } }
          : {}),
        ...(draft.parentProjectId !== undefined
          ? { parentProjectId: draft.parentProjectId }
          : {}),
        ...(draft.project
          ? { project: JSON.parse(JSON.stringify(draft.project)) }
          : {}),
      },
    };
    const creation = this.creation;
    if (this.durable) {
      if (await this.durable.get?.('create')) creation.uncertain = true;
      const payload = { ...creation.body };
      delete payload.requestId;
      const receipt = await this.durable.pending('create', payload);
      if (!sameMutationBody(receipt.body, payload))
        throw Error(
          '上一次创建结果尚未确认，请恢复原来的填写内容并重试；也可先查看电脑任务列表',
        );
      creation.body = { ...receipt.body, requestId: receipt.requestId };
    }
    try {
      const job = (await this.request(
        'POST',
        '/api/v1/jobs',
        creation.body,
      )) as Job;
      if (this.durable) await this.durable.complete('create');
      this.creation = undefined;
      return job;
    } catch (cause) {
      if (
        isDefinitePeerRejection(cause) &&
        (!creation.uncertain ||
          (cause as { code?: string }).code === 'PEER_VALIDATION')
      ) {
        if (this.durable) await this.durable.complete('create');
        this.creation = undefined;
      } else creation.uncertain = true;
      throw cause;
    }
  }
  async restoreCreation(): Promise<Draft | undefined> {
    const pending = this.durable?.get
      ? await this.durable.get('create')
      : this.creation;
    if (!pending) return undefined;
    const body = JSON.parse(JSON.stringify(pending.body)) as Draft & {
      requestId?: string;
    };
    delete body.requestId;
    this.creation = {
      fingerprint: draftIdentity(body),
      uncertain: true,
      body: {
        ...body,
        requestId:
          'requestId' in pending
            ? pending.requestId
            : this.creation?.body.requestId,
      },
    };
    return body;
  }
  async abandonCreation(): Promise<void> {
    if (this.durable) await this.durable.complete('create');
    this.creation = undefined;
  }
  async control(
    jobId: string,
    command: string,
    preflightConfirmation?: PreflightConfirmation,
  ): Promise<void> {
    const path = '/api/v1/jobs/' + encodeURIComponent(jobId) + '/' + command;
    const control = this.controls.get(path) ?? {
      requestId: this.identity(),
      uncertain: false,
      body: preflightConfirmation
        ? { preflightConfirmation: { ...preflightConfirmation } }
        : {},
    };
    const previous = await this.durable?.get?.(path);
    if (previous) {
      control.uncertain = true;
      control.body = previous.body;
    }
    const requestId = control.requestId;
    this.controls.set(path, control);
    const body = control.body;
    const receipt = this.durable
      ? await this.durable.pending(path, body)
      : { requestId, body };
    if (!sameMutationBody(receipt.body, body))
      throw Error('上次任务操作结果未确认，请恢复原预检确认后重试');
    try {
      await this.request('POST', path, {
        ...receipt.body,
        requestId: receipt.requestId,
      });
      if (this.durable) await this.durable.complete(path);
      this.controls.delete(path);
    } catch (cause) {
      if (
        isDefinitePeerRejection(cause) &&
        (!control.uncertain ||
          (cause as { code?: string }).code === 'PEER_VALIDATION')
      ) {
        if (this.durable) await this.durable.complete(path);
        this.controls.delete(path);
      } else control.uncertain = true;
      throw cause;
    }
  }
}
