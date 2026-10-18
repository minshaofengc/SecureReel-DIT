import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, Text, TextInput } from 'react-native';
import App from '../App';
const mockPreflight = {
  fingerprint: 'current',
  checkedAt: '2026-10-18T00:00:00Z',
  source: {
    path: 'src',
    label: 'Card',
    filesystemId: 'source',
    capacityPoolId: 'source',
    physicalDeviceIds: [],
    availableBytes: null,
    present: true,
  },
  targets: [
    {
      path: 'a',
      label: 'Disk',
      filesystemId: 'target',
      capacityPoolId: 'target',
      physicalDeviceIds: [],
      availableBytes: 100,
      present: true,
    },
  ],
  groups: [],
  risks: [],
  blockingReasons: [],
  requiredBytes: 0,
  independentDeviceGroups: null,
};
const mockNative = {
  preflightJob: jest.fn(async () => JSON.stringify(mockPreflight)),
  getSettings: jest.fn(async () =>
    JSON.stringify({
      themeMode: 'system',
      hashAlgorithm: 'xxhash64',
      manifestFormat: 'asc-mhl-2.0',
      keepScreenOn: false,
      onboardingDone: true,
    }),
  ),
  saveSettings: jest.fn(async (value: string) => value),
  runtimeStatus: jest.fn(async () =>
    JSON.stringify({ notificationsEnabled: false, batteryUnrestricted: false }),
  ),
  setKeepScreenOn: jest.fn(async () => undefined),
  pendingMutation: jest.fn(async (_key: string, body: string) =>
    JSON.stringify({ requestId: 'test_id', body }),
  ),
  getPendingMutation: jest.fn(async (_key: string) => {
    void _key;
    return 'null';
  }),
  completeMutation: jest.fn(async () => undefined),
  scanPairingCode: jest.fn(),
  pairPeer: jest.fn(),
  requestNotifications: jest.fn(async () => false),
  openBatterySettings: jest.fn(async () => undefined),
  storageAccess: jest.fn(async () => false),
  roots: jest.fn(async () =>
    JSON.stringify([
      {
        id: 'src',
        label: 'Card',
        role: 'source',
        accessible: true,
        writable: false,
        supportsVerifiedCommit: false,
        volumeId: 'source',
      },
      {
        id: 'a',
        label: 'Disk',
        role: 'target',
        accessible: true,
        writable: false,
        supportsVerifiedCommit: false,
        volumeId: 'target',
      },
    ]),
  ),
  snapshot: jest.fn(async () => JSON.stringify({ jobs: [], projects: [] })),
  peerInfo: jest.fn(async () => JSON.stringify({ paired: false })),
  createJob: jest.fn(async (draft: string) =>
    JSON.stringify({
      ...JSON.parse(draft),
      id: 'job_123456',
      name: '素材备份',
      mode: 'verify',
      state: 'queued',
      totalFiles: 0,
      totalBytes: 0,
      filesDone: 0,
      filesFailed: 0,
      bytesDone: 0,
      sourceRootId: 'src',
      targetRootIds: ['a'],
    }),
  ),
  control: jest.fn(async () =>
    JSON.stringify({
      id: 'job_123456',
      name: '素材备份',
      mode: 'verify',
      state: 'running',
      totalFiles: 0,
      totalBytes: 0,
      filesDone: 0,
      filesFailed: 0,
      bytesDone: 0,
      sourceRootId: 'src',
      targetRootIds: ['a'],
    }),
  ),
  pickRoot: jest.fn(),
  requestStorageAccess: jest.fn(),
  peerRequest: jest.fn(),
  saveProject: jest.fn(),
  saveReport: jest.fn(),
  reports: jest.fn(),
};
let mockJobs: unknown[] = [];
let mockProjects: unknown[] = [];
mockNative.snapshot.mockImplementation(async () =>
  JSON.stringify({ jobs: mockJobs, projects: mockProjects }),
);
const create = mockNative.createJob.getMockImplementation()!;
mockNative.createJob.mockImplementation(async (draft: string) => {
  const value = await create(draft);
  mockJobs = [JSON.parse(value)];
  return value;
});
const control = mockNative.control.getMockImplementation()!;
const originalRoots = mockNative.roots.getMockImplementation()!;
mockNative.control.mockImplementation(async () => {
  const value = await control();
  mockJobs = [JSON.parse(value)];
  return value;
});
beforeEach(() => {
  mockJobs = [];
  mockProjects = [];
  mockNative.preflightJob.mockResolvedValue(JSON.stringify(mockPreflight));
  mockNative.peerInfo.mockResolvedValue(JSON.stringify({ paired: false }));
  mockNative.completeMutation.mockClear();
  mockNative.pairPeer.mockClear();
  mockNative.peerRequest.mockClear();
  mockNative.getPendingMutation.mockResolvedValue('null');
  mockNative.pendingMutation.mockImplementation(
    async (_key: string, body: string) =>
      JSON.stringify({ requestId: 'test_id', body }),
  );
  mockNative.roots.mockImplementation(originalRoots);
});
jest.mock('../src/native/NativeSecureReel', () => ({
  __esModule: true,
  get default() {
    return mockNative;
  },
}));
let tree: renderer.ReactTestRenderer;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  jest.restoreAllMocks();
});
function text() {
  return tree.root
    .findAllByType(Text)
    .map(t => t.props.children)
    .flat(5)
    .join(' ');
}
function button(label: string) {
  return tree.root.findAll(
    t =>
      t.props.accessibilityLabel === label &&
      typeof t.props.onPress === 'function',
  )[0]!;
}
test('read-only target keeps copying disabled and enables verify workflow', async () => {
  await act(async () => {
    tree = renderer.create(<App />);
  });
  expect(text()).toContain('只读授权');
  expect(button('在本机开始拷贝').props.disabled).toBe(true);
  await act(async () => button('仅校验').props.onPress());
  expect(button('在本机开始校验').props.disabled).toBe(false);
  await act(async () => button('在本机开始校验').props.onPress());
  expect(mockJobs).toHaveLength(0);
  expect(
    tree.root.findAllByProps({ accessibilityLabel: '位置确认面板' }).length,
  ).toBeGreaterThan(0);
  expect(text()).toContain('核对来源与目标');
  await act(async () => button('确认并开始校验').props.onPress());
  expect(text()).toContain('素材备份');
  expect(text()).toContain('执行中');
});
test('unsafe public-network pairing shows a visible error without accepting setup', async () => {
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('电脑监控').props.onPress());
  await act(async () => button('设置').props.onPress());
  await act(async () => button('手动配对').props.onPress());
  const setup = tree.root
    .findAllByType(TextInput)
    .find(t => t.props.accessibilityLabel === '配对信息')!;
  await act(async () =>
    setup.props.onChangeText(
      JSON.stringify({
        version: 1,
        url: 'https://example.com',
        fingerprint: 'ab'.repeat(32),
        pairingCode: 'abcdefgh',
        expiresAt: Date.parse('2030-01-01T00:00:00Z'),
      }),
    ),
  );
  await act(async () => button('连接电脑').props.onPress());
  expect(text()).toContain('局域网配对信息');
});
test('choosing another source selects that folder immediately and reviews its disk and folder before starting', async () => {
  const existing = JSON.parse(await originalRoots());
  const next = {
    ...existing[0],
    id: 'new-source',
    label: 'New Camera Card',
    diskName: '新摄影卡',
    folderName: 'DCIM/A002',
    volumeId: 'new-card',
  };
  mockNative.roots
    .mockResolvedValueOnce(JSON.stringify(existing))
    .mockResolvedValueOnce(JSON.stringify([...existing, next]));
  mockNative.pickRoot.mockResolvedValueOnce(JSON.stringify(next));
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('更换来源目录').props.onPress());
  expect(text()).toContain('DCIM/A002');
  await act(async () => button('仅校验').props.onPress());
  await act(async () => button('在本机开始校验').props.onPress());
  expect(
    tree.root.findAllByProps({ accessibilityLabel: '位置确认面板' }).length,
  ).toBeGreaterThan(0);
  expect(text()).toContain('新摄影卡');
  expect(text()).toContain('DCIM/A002');
  expect(mockJobs).toHaveLength(0);
});
test('returning from the position review preserves choices and starts no task', async () => {
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('仅校验').props.onPress());
  await act(async () => button('在本机开始校验').props.onPress());
  await act(async () => button('返回修改').props.onPress());
  expect(
    tree.root.findAllByProps({ accessibilityLabel: '位置确认面板' }),
  ).toHaveLength(0);
  expect(mockJobs).toHaveLength(0);
  expect(button('在本机开始校验').props.disabled).toBe(false);
});
test('mode switch keeps each device draft separate and explains where copying runs', async () => {
  await act(async () => {
    tree = renderer.create(<App />);
  });
  expect(text()).toContain('本机拷贝');
  expect(text()).toContain('手机执行 · 本机磁盘');
  const input = () =>
    tree.root
      .findAllByType(TextInput)
      .find(t => t.props.accessibilityLabel === '任务名称')!;
  await act(async () => input().props.onChangeText('手机A001'));
  await act(async () => button('电脑监控').props.onPress());
  expect(text()).toContain('未连接');
  await act(async () => button('本机拷贝').props.onPress());
  expect(input().props.value).toBe('手机A001');
});
test('mother-project editor adds crew role/name and settings offer offline help', async () => {
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('项目').props.onPress());
  expect(text()).toContain('母项目');
  await act(async () => button('新建母项目').props.onPress());
  await act(async () => button('管理人员').props.onPress());
  await act(async () => button('添加人员').props.onPress());
  const name = tree.root
    .findAllByType(TextInput)
    .find(t => t.props.accessibilityLabel === '人员姓名')!;
  const role = tree.root
    .findAllByType(TextInput)
    .find(t => t.props.accessibilityLabel === '人员职位')!;
  await act(async () => {
    name.props.onChangeText('张三');
    role.props.onChangeText('摄影指导');
  });
  expect(
    tree.root
      .findAllByType(TextInput)
      .find(t => t.props.accessibilityLabel === '人员职位')!.props.value,
  ).toBe('摄影指导');
  await act(async () => button('保存人员').props.onPress());
  await act(async () => button('返回 人员管理').props.onPress());
  await act(async () => button('返回 新建母项目 · 手机').props.onPress());
  await act(async () => button('设置').props.onPress());
  expect(text()).toContain('后台运行');
  await act(async () => button('使用教程').props.onPress());
  expect(text()).toContain('锁屏与中断恢复');
});

test('scanning asks for identity confirmation before accepting a computer', async () => {
  mockNative.scanPairingCode.mockResolvedValueOnce(
    JSON.stringify({
      version: 1,
      url: 'https://192.168.1.2:1234',
      fingerprint: 'ab'.repeat(32),
      pairingCode: 'abcdefgh',
      expiresAt: Date.now() + 60000,
      desktopName: '现场Mac',
    }),
  );
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('电脑监控').props.onPress());
  await act(async () => button('设置').props.onPress());
  await act(async () => button('扫码连接电脑').props.onPress());
  expect(text()).toContain('核对电脑身份');
  expect(text()).toContain('现场Mac');
  expect(mockNative.pairPeer).not.toHaveBeenCalled();
  await act(async () => button('取消连接').props.onPress());
  expect(mockNative.pairPeer).not.toHaveBeenCalled();
});
test('a mother project supplies full crew and card metadata to a newly created task', async () => {
  const id = 'prj_123456';
  mockProjects = [
    {
      id,
      name: '电影',
      details: {
        projectName: '电影',
        camera: 'A35',
        shootDay: '2026-10-13',
        notes: '项目备注',
        lenses: [{ model: 'Prime', detail: '50' }],
        crew: [{ role: '摄影指导', name: '张三' }],
      },
    },
  ];
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('电影').props.onPress());
  await act(async () => button('仅校验').props.onPress());
  const card = tree.root
    .findAllByType(TextInput)
    .find(t => t.props.accessibilityLabel === '卡号／卷号')!;
  await act(async () => card.props.onChangeText('A001'));
  await act(async () => button('在本机开始校验').props.onPress());
  await act(async () => button('确认并开始校验').props.onPress());
  const draft = JSON.parse(
    mockNative.createJob.mock.calls.at(-1)![0] as string,
  );
  expect(draft.parentProjectId).toBe(id);
  expect(draft.project.crew[0]).toEqual({ role: '摄影指导', name: '张三' });
  expect(draft.project.cardLabel).toBe('A001');
});
test('scanner manual fallback opens pairing input without an error or accepting a computer', async () => {
  mockNative.scanPairingCode.mockRejectedValueOnce(
    Object.assign(new Error('使用手动配对'), { code: 'SCAN_MANUAL' }),
  );
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('电脑监控').props.onPress());
  await act(async () => button('设置').props.onPress());
  await act(async () => button('扫码连接电脑').props.onPress());
  expect(
    tree.root
      .findAllByType(TextInput)
      .some(t => t.props.accessibilityLabel === '配对信息'),
  ).toBe(true);
  expect(text()).not.toContain('使用手动配对');
  expect(mockNative.pairPeer).not.toHaveBeenCalled();
});
function remoteRoots(label = '电脑A') {
  return [
    { id: 'remote_src', label: label + ' 来源', role: 'source' },
    { id: 'remote_target', label: label + ' 目标', role: 'target' },
  ];
}
test('monitor settings exclude phone controls and local defaults never leak into a new computer draft', async () => {
  configureRemote();
  mockNative.getSettings.mockResolvedValueOnce(
    JSON.stringify({
      themeMode: 'dark',
      hashAlgorithm: 'sha256',
      manifestFormat: 'json',
      keepScreenOn: false,
      onboardingDone: true,
    }),
  );
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('设置').props.onPress());
  expect(text()).toContain('界面主题');
  await act(async () => button('电脑监控').props.onPress());
  expect(tree.root.findAllByProps({ title: '界面主题' })).toHaveLength(1);
  expect(text()).not.toContain('后台运行');
  expect(text()).not.toContain('允许任务通知');
  expect(text()).toContain('连接电脑');
  const workspace = tree.root.findByProps({ testID: 'workspace' });
  expect(workspace.props.style.flat().at(-1).backgroundColor).toBe('#121316');
  await act(async () => button('浅色').props.onPress());
  expect(
    tree.root.findByProps({ testID: 'workspace' }).props.style.flat().at(-1)
      .backgroundColor,
  ).toBe('#f4f5f6');
  await act(async () => button('深色').props.onPress());
  expect(
    tree.root.findByProps({ testID: 'workspace' }).props.style.flat().at(-1)
      .backgroundColor,
  ).toBe('#121316');
  await act(async () => button('工作台').props.onPress());
  expect(button('xxhash64').props.accessibilityState.selected).toBe(true);
});
test('project drafts survive device mode switches and the list opens before the editor', async () => {
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('项目').props.onPress());
  expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
  await act(async () => button('新建母项目').props.onPress());
  const projectName = () =>
    tree.root
      .findAllByType(TextInput)
      .find(t => t.props.accessibilityLabel === '项目名称')!;
  await act(async () => projectName().props.onChangeText('本机草稿'));
  await act(async () => button('返回 新建母项目 · 手机').props.onPress());
  await act(async () => button('电脑监控').props.onPress());
  await act(async () => button('本机拷贝').props.onPress());
  await act(async () => button('继续编辑母项目').props.onPress());
  expect(projectName().props.value).toBe('本机草稿');
});
test('help is contextual instead of a persistent banner and opens one chapter at a time', async () => {
  await act(async () => {
    tree = renderer.create(<App />);
  });
  expect(text()).not.toContain('如何操作');
  await act(async () => button('任务').props.onPress());
  expect(text()).not.toContain('素材盘连接在手机上');
  await act(async () => button('设置').props.onPress());
  await act(async () => button('使用教程').props.onPress());
  await act(async () => button('教程 母项目与拍摄人员').props.onPress());
  expect(text()).toContain('每次任务保存当时资料');
  expect(text()).not.toContain('系统后台时限');
});
test('mother drafts remain scoped to a paired computer identity when another computer is selected', async () => {
  configureRemote();
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('电脑监控').props.onPress());
  await act(async () => button('项目').props.onPress());
  await act(async () => button('新建母项目').props.onPress());
  const name = () =>
    tree.root
      .findAllByType(TextInput)
      .find(t => t.props.accessibilityLabel === '项目名称')!;
  await act(async () => name().props.onChangeText('电脑A专属草稿'));
  await act(async () => button('返回 新建母项目 · 电脑A').props.onPress());
  configureRemote('client_B', '电脑B');
  await act(async () => button('刷新').props.onPress());
  expect(text()).not.toContain('继续编辑母项目');
  configureRemote();
  await act(async () => button('刷新').props.onPress());
  await act(async () => button('继续编辑母项目').props.onPress());
  expect(name().props.value).toBe('电脑A专属草稿');
});
test('opening another mother project cannot silently replace an unsaved draft', async () => {
  mockProjects = [
    {
      id: 'prj_other',
      name: '已有项目',
      details: {
        projectName: '已有项目',
        shootDay: '',
        camera: '',
        notes: '',
        crew: [],
        lenses: [],
      },
    },
  ];
  const confirm = jest.spyOn(Alert, 'alert');
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('项目').props.onPress());
  await act(async () => button('新建母项目').props.onPress());
  await act(async () =>
    tree.root
      .findAllByType(TextInput)
      .find(t => t.props.accessibilityLabel === '项目名称')!
      .props.onChangeText('未保存资料'),
  );
  await act(async () => button('返回 新建母项目 · 手机').props.onPress());
  await act(async () => button('编辑 已有项目').props.onPress());
  expect(confirm).toHaveBeenCalled();
  expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
});
test('removal can still be undone after closing and resuming the unsaved mother draft', async () => {
  mockProjects = [
    {
      id: 'prj_crew',
      name: '摄影项目',
      details: {
        projectName: '摄影项目',
        shootDay: '',
        camera: '',
        notes: '',
        crew: [{ name: '张三', role: 'DIT' }],
        lenses: [],
      },
    },
  ];
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('项目').props.onPress());
  await act(async () => button('编辑 摄影项目').props.onPress());
  await act(async () => button('管理人员').props.onPress());
  await act(async () => button('编辑人员 张三').props.onPress());
  await act(async () => button('移除人员').props.onPress());
  await act(async () => button('返回 人员管理').props.onPress());
  await act(async () => button('返回 编辑母项目 · 手机').props.onPress());
  await act(async () => button('继续编辑母项目').props.onPress());
  await act(async () => button('管理人员').props.onPress());
  await act(async () => button('撤销移除').props.onPress());
  expect(text()).toContain('张三');
});
test('recovering an unacknowledged project asks before replacing a dirty computer draft', async () => {
  configureRemote();
  const details = {
    projectName: '原请求项目',
    shootDay: '',
    camera: '',
    notes: '',
    crew: [],
    lenses: [],
  };
  mockNative.getPendingMutation.mockImplementation(async key =>
    key.endsWith('peer:project:new')
      ? JSON.stringify({
          requestId: 'receipt',
          body: JSON.stringify({ name: '原请求项目', details }),
        })
      : 'null',
  );
  const confirm = jest.spyOn(Alert, 'alert');
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('电脑监控').props.onPress());
  await act(async () => button('项目').props.onPress());
  await act(async () => button('新建母项目').props.onPress());
  await act(async () =>
    tree.root
      .findAllByType(TextInput)
      .find(t => t.props.accessibilityLabel === '项目名称')!
      .props.onChangeText('不能丢失的草稿'),
  );
  await act(async () => button('返回 新建母项目 · 电脑A').props.onPress());
  await act(async () => button('恢复未确认项目填写').props.onPress());
  expect(confirm).toHaveBeenCalled();
  expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
  await act(async () =>
    confirm.mock.calls.at(-1)![2]!.find(b => b.text === '保留当前草稿')!
      .onPress!(),
  );
  await act(async () => button('继续编辑母项目').props.onPress());
  expect(
    tree.root
      .findAllByType(TextInput)
      .find(t => t.props.accessibilityLabel === '项目名称')!.props.value,
  ).toBe('不能丢失的草稿');
});
test('in-flight mother save locks inputs so submitted metadata cannot be edited before acknowledgement', async () => {
  let finish: () => void = () => undefined;
  mockNative.saveProject.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      }),
  );
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('项目').props.onPress());
  await act(async () => button('新建母项目').props.onPress());
  await act(async () =>
    tree.root
      .findAllByType(TextInput)
      .find(t => t.props.accessibilityLabel === '项目名称')!
      .props.onChangeText('等待保存'),
  );
  await act(async () => button('保存母项目').props.onPress());
  expect(
    tree.root.findAllByType(TextInput).every(t => t.props.editable === false),
  ).toBe(true);
  await act(async () => finish());
});
function configureRemote(identity = 'client_A', label = '电脑A') {
  mockNative.peerInfo.mockResolvedValue(
    JSON.stringify({
      clientId: identity,
      fingerprint: identity === 'client_A' ? 'ab'.repeat(32) : 'cd'.repeat(32),
      desktopName: label,
    }),
  );
  mockNative.peerRequest.mockImplementation(
    async (method: string, path: string, body: string) => {
      if (path === '/api/v1/preflight')
        return JSON.stringify({ version: 1, ok: true, data: mockPreflight });
      if (method === 'GET')
        return JSON.stringify({
          version: 1,
          ok: true,
          data:
            path === '/api/v1/roots'
              ? remoteRoots(label)
              : { jobs: [], projects: mockProjects },
        });
      return JSON.stringify({
        version: 1,
        ok: true,
        data: {
          ...JSON.parse(body),
          id: 'remote_job',
          state: 'queued',
          totalFiles: 0,
          totalBytes: 0,
          filesDone: 0,
          filesFailed: 0,
          bytesDone: 0,
        },
      });
    },
  );
}
test('switching paired computers clears only desktop draft and directory caches', async () => {
  configureRemote();
  await act(async () => {
    tree = renderer.create(<App />);
  });
  const taskName = () =>
    tree.root
      .findAllByType(TextInput)
      .find(t => t.props.accessibilityLabel === '任务名称')!;
  await act(async () => taskName().props.onChangeText('手机保留'));
  await act(async () => button('电脑监控').props.onPress());
  await act(async () => taskName().props.onChangeText('旧电脑任务'));
  configureRemote('client_B', '电脑B');
  await act(async () => button('刷新').props.onPress());
  expect(taskName().props.value).toBe('素材备份');
  expect(text()).not.toContain('电脑A 来源');
  expect(text()).toContain('电脑B 来源');
  await act(async () => button('本机拷贝').props.onPress());
  expect(taskName().props.value).toBe('手机保留');
});
test('restores an unacknowledged desktop draft using its original crew snapshot after mother project changes', async () => {
  configureRemote();
  const details = {
    projectName: '电影',
    camera: 'A35',
    shootDay: '',
    notes: '原项目备注',
    crew: [{ role: 'DIT', name: '原姓名' }],
    lenses: [],
    cardLabel: 'A001',
    copyNotes: '',
  };
  const body = {
    name: '待确认任务',
    mode: 'verify',
    sourceRootId: 'remote_src',
    targetRootIds: ['remote_target'],
    hashAlgorithm: 'xxhash64',
    manifestFormat: 'json',
    projectName: '电影',
    parentProjectId: 'prj_1',
    project: details,
  };
  mockProjects = [
    {
      id: 'prj_1',
      name: '电影',
      details: { ...details, crew: [{ role: 'DIT', name: '已改名' }] },
    },
  ];
  mockNative.getPendingMutation.mockImplementation(async (key: string) =>
    key.endsWith('desktop:create')
      ? JSON.stringify({ requestId: 'old_request', body: JSON.stringify(body) })
      : 'null',
  );
  mockNative.pendingMutation.mockImplementation(
    async (key: string, input: string) =>
      JSON.stringify({
        requestId: key.endsWith('desktop:create')
          ? 'old_request'
          : 'control_request',
        body: key.endsWith('desktop:create') ? JSON.stringify(body) : input,
      }),
  );
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('电脑监控').props.onPress());
  await act(async () => button('恢复未确认任务填写').props.onPress());
  expect(
    tree.root
      .findAllByType(TextInput)
      .find(t => t.props.accessibilityLabel === '任务名称')!.props.value,
  ).toBe('待确认任务');
  await act(async () => button('在电脑开始校验').props.onPress());
  await act(async () => button('确认并开始校验').props.onPress());
  const sent = mockNative.peerRequest.mock.calls.find(
    c => c[0] === 'POST' && c[1] === '/api/v1/jobs',
  )!;
  expect(JSON.parse(sent[2]!).project.crew[0].name).toBe('原姓名');
  expect(JSON.parse(sent[2]!).requestId).toBe('old_request');
  mockNative.getPendingMutation.mockResolvedValue('null');
});
test('mother-project task filter displays immutable task metadata after current project edits', async () => {
  const details = {
    projectName: '电影',
    camera: '原摄影机',
    shootDay: '',
    notes: '',
    crew: [{ role: 'DIT', name: '原姓名' }],
    lenses: [],
    cardLabel: 'A001',
    copyNotes: '',
  };
  mockProjects = [
    {
      id: 'prj_1',
      name: '改过的母项目',
      details: { ...details, camera: '新摄影机' },
    },
  ];
  mockJobs = [
    {
      id: 'job_1',
      name: '关联卡',
      mode: 'verify',
      state: 'completed',
      totalFiles: 0,
      totalBytes: 0,
      filesDone: 0,
      filesFailed: 0,
      bytesDone: 0,
      sourceRootId: 'src',
      targetRootIds: ['a'],
      parentProjectId: 'prj_1',
      parentProjectName: '拍摄时母项目',
      project: details,
    },
    {
      id: 'job_2',
      name: '其他任务',
      mode: 'verify',
      state: 'completed',
      totalFiles: 0,
      totalBytes: 0,
      filesDone: 0,
      filesFailed: 0,
      bytesDone: 0,
      sourceRootId: 'src',
      targetRootIds: ['a'],
    },
  ];
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('项目').props.onPress());
  await act(async () => button('查看该项目任务 改过的母项目').props.onPress());
  expect(text()).toContain('关联卡');
  expect(text()).not.toContain('其他任务');
  expect(text()).toContain('拍摄时母项目');
  expect(text()).toContain('A001');
  expect(text()).toContain('原摄影机');
  expect(text()).not.toContain('新摄影机');
  await act(async () => button('查看全部任务').props.onPress());
  expect(text()).toContain('其他任务');
});
test('unknown task receipt is abandoned only after the explicit reconciliation confirmation', async () => {
  configureRemote();
  const original = {
    name: '待确认任务',
    mode: 'verify',
    sourceRootId: 'remote_src',
    targetRootIds: ['remote_target'],
    hashAlgorithm: 'xxhash64',
    manifestFormat: 'json',
    projectName: '电影',
  };
  mockNative.getPendingMutation.mockImplementation(async (key: string) =>
    key.endsWith('desktop:create')
      ? JSON.stringify({ requestId: 'old', body: JSON.stringify(original) })
      : 'null',
  );
  const confirm = jest.spyOn(Alert, 'alert');
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('电脑监控').props.onPress());
  await act(async () => button('核对后放弃此请求').props.onPress());
  expect(mockNative.completeMutation).not.toHaveBeenCalled();
  const buttons = confirm.mock.calls.at(-1)![2]!;
  expect(confirm.mock.calls.at(-1)![1]).toContain('不取消或删除电脑任务');
  await act(async () =>
    buttons.find(b => b.text === '我已核对，放弃重试')!.onPress!(),
  );
  expect(mockNative.completeMutation).toHaveBeenCalledWith(
    'client_A:' + 'ab'.repeat(32) + ':desktop:create',
  );
});

test('requires fresh actual preflight before showing confirmation', async () => {
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('仅校验').props.onPress());
  mockNative.preflightJob.mockRejectedValueOnce(Error('磁盘未连接'));
  await act(async () => button('在本机开始校验').props.onPress());
  expect(text()).toContain('磁盘未连接');
  expect(
    tree.root.findAllByProps({ accessibilityLabel: '位置确认面板' }),
  ).toHaveLength(0);
});
test('shared target consent is explicit and bound to the displayed preflight', async () => {
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => button('仅校验').props.onPress());
  mockNative.preflightJob.mockResolvedValueOnce(
    JSON.stringify({
      ...mockPreflight,
      risks: [{ code: 'shared-filesystem', paths: ['a', 'b'] }],
    }),
  );
  await act(async () => button('在本机开始校验').props.onPress());
  expect(button('确认并开始校验').props.disabled).toBe(true);
  expect(text()).toContain('不能算作独立物理备份');
  await act(async () => button('我已理解并接受上述存储风险').props.onPress());
  expect(button('确认并开始校验').props.disabled).toBe(false);
});
