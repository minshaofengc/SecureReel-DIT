import { describe, expect, it } from 'vitest';
import { DesktopCommands } from '../src/desktopCommands';
const draft = {
  name: 'A001',
  mode: 'verify' as const,
  sourceRootId: 'source_1',
  targetRootIds: ['target_1'],
  hashAlgorithm: 'xxhash64' as const,
  manifestFormat: 'json' as const,
  projectName: '',
};
describe('desktop commands', () => {
  it('uses the desktop strict creation contract and supplies an empty project name from the task name', async () => {
    let accepted: unknown;
    const client = new DesktopCommands(
      async (_method, _path, body) => {
        accepted = body;
        return { id: 'job_1' };
      },
      () => 'request_1',
    );
    await client.create(draft);
    expect(accepted).toEqual({
      requestId: 'request_1',
      name: 'A001',
      mode: 'verify',
      sourceRootId: 'source_1',
      targetRootIds: ['target_1'],
      hashAlgorithm: 'xxhash64',
      manifestFormat: 'json',
      projectName: 'A001',
    });
  });
  it('reuses the exact request after an ambiguous lost response and refuses a different creation until resolved', async () => {
    const bodies: unknown[] = [];
    let fail = true,
      number = 0;
    const client = new DesktopCommands(
      async (_method, _path, body) => {
        bodies.push(body);
        if (fail) throw Error('offline');
        return { id: 'job_1' };
      },
      () => 'request_' + ++number,
    );
    await expect(client.create(draft)).rejects.toThrow();
    await expect(client.create({ ...draft, name: 'A002' })).rejects.toThrow(
      '上一次',
    );
    fail = false;
    await client.create(draft);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    await client.create(draft);
    expect(bodies[2]).not.toEqual(bodies[0]);
  });
  it('retries a lost start response with the same identity', async () => {
    const ids: unknown[] = [];
    let fail = true,
      number = 0;
    const client = new DesktopCommands(
      async (_method, _path, body) => {
        ids.push(body);
        if (fail) throw Error('offline');
        return {};
      },
      () => 'request_' + ++number,
    );
    await expect(client.control('job_1', 'start')).rejects.toThrow();
    fail = false;
    await client.control('job_1', 'start');
    expect(ids[0]).toEqual(ids[1]);
  });
});
it('restores a lost creation identity after a mobile process restart and retains project snapshot', async () => {
  let stored: { requestId: string; body: Record<string, unknown> } | undefined;
  const bodies: unknown[] = [];
  const durable = {
    pending: async (_key: string, body: Record<string, unknown>) =>
      (stored ??= { requestId: 'durable_1', body }),
    complete: async () => {
      stored = undefined;
    },
  };
  const a = new DesktopCommands(
    async (_m, _p, b) => {
      bodies.push(b);
      throw Error('offline');
    },
    () => 'unused',
    durable,
  );
  const full = {
    ...draft,
    parentProjectId: 'prj_1',
    project: {
      projectName: '电影',
      camera: '',
      shootDay: '',
      notes: '',
      crew: [{ role: 'DIT', name: '张三' }],
      lenses: [],
      cardLabel: 'A001',
      copyNotes: '',
    },
  };
  await expect(a.create(full)).rejects.toThrow('offline');
  const b = new DesktopCommands(
    async (_m, _p, body) => {
      bodies.push(body);
      return { id: 'job_1' };
    },
    () => 'new_id',
    durable,
  );
  await b.create(full);
  expect(bodies[0]).toEqual(bodies[1]);
  expect((bodies[1] as typeof full).project?.crew[0]?.name).toBe('张三');
  expect(stored).toBeUndefined();
});
it('releases known validation rejection so corrected inputs create a fresh request, but retains server uncertainty', async () => {
  let stored: { requestId: string; body: Record<string, unknown> } | undefined,
    ids = 0;
  const durable = {
    pending: async (_key: string, body: Record<string, unknown>) =>
      (stored ??= { requestId: 'saved_' + ++ids, body }),
    complete: async () => {
      stored = undefined;
    },
    get: async () => stored,
  };
  let failure: string | undefined = 'PEER_VALIDATION';
  const bodies: unknown[] = [];
  const client = new DesktopCommands(
    async (_m, _p, b) => {
      bodies.push(b);
      if (failure) throw Object.assign(Error('rejected'), { code: failure });
      return { id: 'job_ok' };
    },
    () => 'memory_' + ++ids,
    durable,
  );
  await expect(client.create(draft)).rejects.toMatchObject({
    code: 'PEER_VALIDATION',
  });
  expect(stored).toBeUndefined();
  failure = undefined;
  await client.create({ ...draft, sourceRootId: 'corrected_source' });
  expect(bodies).toHaveLength(2);
  failure = 'PEER_UNCERTAIN';
  await expect(client.create(draft)).rejects.toThrow();
  expect(stored).toBeDefined();
});
it('retrieves an unknown creation without allocating and restores the original project snapshot after mother edits', async () => {
  let stored: { requestId: string; body: Record<string, unknown> } | undefined;
  const durable = {
    pending: async (_k: string, body: Record<string, unknown>) =>
      (stored ??= { requestId: 'original', body }),
    get: async () => stored,
    complete: async () => {
      stored = undefined;
    },
  };
  const original = {
    ...draft,
    projectName: '电影',
    parentProjectId: 'prj_1',
    project: {
      projectName: '电影',
      camera: 'A35',
      shootDay: '',
      notes: '原资料',
      crew: [{ role: 'DIT', name: '原姓名' }],
      lenses: [],
      cardLabel: 'A001',
      copyNotes: '',
    },
  };
  const client = new DesktopCommands(
    async () => {
      throw Error('lost');
    },
    () => 'new',
    durable,
  );
  expect(await client.restoreCreation()).toBeUndefined();
  expect(stored).toBeUndefined();
  await expect(client.create(original)).rejects.toThrow('lost');
  const restored = await client.restoreCreation();
  expect(restored).toEqual(original);
  original.project.crew[0].name = '母项目已改名';
  expect(restored?.project?.crew[0]?.name).toBe('原姓名');
});
it('uses independent memory queues for two computer identities', async () => {
  const a = new DesktopCommands(
    async () => {
      throw Error('lost');
    },
    () => 'a',
  );
  await expect(a.create(draft)).rejects.toThrow('lost');
  const b = new DesktopCommands(
    async () => ({ id: 'job_b' }),
    () => 'b',
  );
  await expect(b.create({ ...draft, name: 'B001' })).resolves.toMatchObject({
    id: 'job_b',
  });
});
it('releases definite control rejection while retaining a lost response', async () => {
  let stored: { requestId: string; body: Record<string, unknown> } | undefined,
    count = 0,
    failure: string | undefined = 'PEER_VALIDATION';
  const durable = {
    pending: async (_key: string, body: Record<string, unknown>) =>
      (stored ??= { requestId: 'id_' + ++count, body }),
    complete: async () => {
      stored = undefined;
    },
  };
  const client = new DesktopCommands(
    async () => {
      if (failure) throw Object.assign(Error('failure'), { code: failure });
      return {};
    },
    () => 'unused',
    durable,
  );
  await expect(client.control('job_1', 'start')).rejects.toThrow();
  expect(stored).toBeUndefined();
  failure = 'PEER_NETWORK';
  await expect(client.control('job_1', 'start')).rejects.toThrow();
  expect(stored).toBeDefined();
});
it('releases a rejected project copy and retries corrected metadata while unknown copies retain the receipt', async () => {
  const { projectMutation } = await import('../src/desktopCommands');
  let saved: { requestId: string; body: Record<string, unknown> } | undefined,
    count = 0,
    failure: string | undefined = 'PEER_VALIDATION';
  const durable = {
    pending: async (_key: string, body: Record<string, unknown>) =>
      (saved ??= {
        requestId: 'copy_' + ++count,
        body: JSON.parse(JSON.stringify(body)),
      }),
    complete: async () => {
      saved = undefined;
    },
  };
  const request = async () => {
    if (failure) throw Object.assign(Error('rejected'), { code: failure });
    return { id: 'project_copied' };
  };
  await expect(
    projectMutation(request, durable, 'copy:local_project', {
      name: 'original',
    }),
  ).rejects.toThrow();
  expect(saved).toBeUndefined();
  failure = undefined;
  await expect(
    projectMutation(request, durable, 'copy:local_project', {
      name: 'corrected',
    }),
  ).resolves.toMatchObject({ id: 'project_copied' });
  failure = 'PEER_UNCERTAIN';
  await expect(
    projectMutation(request, durable, 'copy:local_project', {
      name: 'unknown',
    }),
  ).rejects.toThrow();
  expect(saved?.body.name).toBe('unknown');
  await expect(
    projectMutation(request, durable, 'copy:local_project', {
      name: 'changed',
    }),
  ).rejects.toThrow('原内容');
  expect(saved?.body.name).toBe('unknown');
});
it('preserves an earlier unknown creation when later root revocation returns a definite auth rejection', async () => {
  let stored: { requestId: string; body: Record<string, unknown> } | undefined;
  const durable = {
    get: async () => stored,
    pending: async (_key: string, body: Record<string, unknown>) =>
      (stored ??= { requestId: 'original', body }),
    complete: async () => {
      stored = undefined;
    },
  };
  let error = 'PEER_NETWORK';
  const client = new DesktopCommands(
    async () => {
      throw Object.assign(Error('failed'), { code: error });
    },
    () => 'new',
    durable,
  );
  await expect(client.create(draft)).rejects.toThrow();
  error = 'PEER_AUTH';
  await expect(client.create(draft)).rejects.toThrow();
  expect(stored?.requestId).toBe('original');
  const resumed = new DesktopCommands(
    async () => {
      throw Object.assign(Error('403'), { code: 'PEER_AUTH' });
    },
    () => 'new',
    durable,
  );
  await expect(resumed.create(draft)).rejects.toThrow();
  expect(stored?.requestId).toBe('original');
});
it('keeps an earlier unknown project-copy receipt after a later auth rejection', async () => {
  const { projectMutation } = await import('../src/desktopCommands');
  let saved: { requestId: string; body: Record<string, unknown> } | undefined;
  const durable = {
    get: async () => saved,
    pending: async (_key: string, body: Record<string, unknown>) =>
      (saved ??= { requestId: 'old', body }),
    complete: async () => {
      saved = undefined;
    },
  };
  let code = 'PEER_NETWORK';
  const request = async () => {
    throw Object.assign(Error('failed'), { code });
  };
  await expect(
    projectMutation(request, durable, 'copy:p', { name: 'project' }),
  ).rejects.toThrow();
  code = 'PEER_AUTH';
  await expect(
    projectMutation(request, durable, 'copy:p', { name: 'project' }),
  ).rejects.toThrow();
  expect(saved?.requestId).toBe('old');
});
it('explicit abandonment clears only the old mobile receipt and permits a new draft', async () => {
  let stored: { requestId: string; body: Record<string, unknown> } | undefined,
    count = 0,
    unknown = true;
  const durable = {
    get: async () => stored,
    pending: async (_key: string, body: Record<string, unknown>) =>
      (stored ??= { requestId: 'id_' + ++count, body }),
    complete: async () => {
      stored = undefined;
    },
  };
  const client = new DesktopCommands(
    async () => {
      if (unknown) throw Error('lost');
      return { id: 'new' };
    },
    () => 'unused',
    durable,
  );
  await expect(client.create(draft)).rejects.toThrow();
  await client.abandonCreation();
  expect(stored).toBeUndefined();
  unknown = false;
  await expect(client.create({ ...draft, name: 'new' })).resolves.toMatchObject(
    { id: 'new' },
  );
});
it('retries a restored creation when the UI constructs draft fields in a different order', async () => {
  let stored: { requestId: string; body: Record<string, unknown> } | undefined;
  const durable = {
    get: async () => stored,
    pending: async (_key: string, body: Record<string, unknown>) =>
      (stored ??= { requestId: 'original', body }),
    complete: async () => {
      stored = undefined;
    },
  };
  let fail = true;
  const sent: unknown[] = [];
  const client = new DesktopCommands(
    async (_m, _p, b) => {
      sent.push(b);
      if (fail) throw Error('lost');
      return { id: 'job_1' };
    },
    () => 'unused',
    durable,
  );
  await expect(client.create(draft)).rejects.toThrow('lost');
  const original = await client.restoreCreation();
  fail = false;
  await expect(
    client.create({
      name: original!.name,
      mode: original!.mode,
      sourceRootId: original!.sourceRootId,
      targetRootIds: original!.targetRootIds,
      hashAlgorithm: original!.hashAlgorithm,
      manifestFormat: original!.manifestFormat,
      projectName: original!.projectName,
    }),
  ).resolves.toMatchObject({ id: 'job_1' });
  expect(sent[0]).toEqual(sent[1]);
});
it('requires a supported desktop preflight and carries confirmation in durable creation', async () => {
  const requests: { path: string; body: unknown }[] = [];
  const client = new DesktopCommands(
    async (_m, path, body) => {
      requests.push({ path, body });
      if (path === '/api/v1/preflight')
        throw Object.assign(Error('missing'), { code: 'PEER_VERSION' });
      return { id: 'a' };
    },
    () => 'id',
  );
  await expect(client.preflight(draft)).rejects.toThrow('升级');
  const confirmed = {
    ...draft,
    preflightConfirmation: { fingerprint: 'current', acceptRisks: true },
  };
  await client.create(confirmed);
  expect(requests.at(-1)?.body).toMatchObject({
    preflightConfirmation: confirmed.preflightConfirmation,
  });
});
it('releases a definitive validation rejection after an uncertain transport', async () => {
  let failure = 'PEER_NETWORK';
  const client = new DesktopCommands(
    async () => {
      throw Object.assign(Error('rejected'), { code: failure });
    },
    () => 'id',
  );
  await expect(client.create(draft)).rejects.toThrow();
  failure = 'PEER_VALIDATION';
  await expect(client.create(draft)).rejects.toThrow();
  failure = 'PEER_NETWORK';
  await expect(client.create({ ...draft, name: 'new' })).rejects.not.toThrow(
    '上一次',
  );
});
it('retries the exact consent body after an unknown start result even when a newer preflight is displayed', async () => {
  const bodies: unknown[] = [];
  let first = true;
  const client = new DesktopCommands(
    async (_m, _p, b) => {
      bodies.push(b);
      if (first) {
        first = false;
        throw Error('lost');
      }
      return {};
    },
    () => 'same',
  );
  await expect(
    client.control('job', 'start', { fingerprint: 'old', acceptRisks: true }),
  ).rejects.toThrow();
  await client.control('job', 'start', {
    fingerprint: 'new',
    acceptRisks: true,
  });
  expect(bodies[1]).toEqual(bodies[0]);
});
it('shows an upgrade instruction for a desktop response without the safety contract',async()=>{
 const client=new DesktopCommands(async()=>({id:'old-server'}),()=> 'id');
 await expect(client.preflight(draft)).rejects.toThrow('升级');
});
