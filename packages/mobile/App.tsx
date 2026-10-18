// SPDX-License-Identifier: GPL-3.0-only
import React, {
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  AppState,
  AccessibilityInfo,
  BackHandler,
  Alert,
  Modal,
  Keyboard,
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  Text,
  View,
  useColorScheme,
  useWindowDimensions,
} from 'react-native';
import {
  SafeAreaProvider,
  initialWindowMetrics,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { useContext } from 'react';
import {
  Button,
  HelpLink,
  Card,
  ModalPage,
  PageTransition,
  ProgressBar,
  Input,
  Theme,
  s,
  light,
  dark,
} from './src/components/ui';
import {
  ProjectEditor,
  type RemovalRecord,
} from './src/components/ProjectEditor';
import { HelpSheet, type HelpTopic } from './src/components/HelpSheet';
import {
  LocalSettings,
  ConnectionSettings,
} from './src/components/SettingsPanel';
import {
  defaultSettings,
  emptyDetails,
  normalizeProject,
  normalizeSettings,
  validateProjectDetails,
  type ProjectDetails,
  type Settings,
} from './src/projectData';
import Native from './src/native/NativeSecureReel';
import {
  preflightSchema,
  requirePreflight,
  riskLabels,
  type TargetPreflightResult,
  type PreflightConfirmation,
} from './src/backupSafety';
import {
  sameMutationBody,
  DesktopCommands,
  projectMutation as sendProjectMutation,
} from './src/desktopCommands';
import { rootPosition, selectTargetSlot } from './src/storageSelection';
import {
  HASHES,
  canReport,
  compatible,
  normalizeSnapshot,
  reportBundle,
  validateDraft,
  validateSetup,
  type Draft,
  type Job,
  type Project,
  type Root,
  type Snapshot,
  type ManifestFormat,
  type HashAlgorithm,
} from './src/domain';
type Screen = 'work' | 'jobs' | 'projects' | 'reports' | 'settings';
type EditorDraft = {
  details: ProjectDetails;
  id?: string;
  baseline: string;
  removals?: RemovalRecord[];
  mutation?: { key: string; body: Record<string, unknown> };
};
const screenLabels: Record<Screen, string> = {
  work: '工作台',
  jobs: '任务',
  projects: '项目',
  reports: '报告',
  settings: '设置',
};
type Report = {
  id?: string;
  revision: number | string;
  createdAt: string;
  formats: string[];
};
const empty: Snapshot = { jobs: [], projects: [] };
const states: Record<string, string> = {
  draft: '待开始',
  queued: '排队中',
  running: '执行中',
  paused: '已暂停',
  interrupted: '等待恢复',
  completed: '已完成',
  'completed-with-errors': '部分失败',
  failed: '失败',
  cancelled: '已取消',
};
function decode<T>(value: string): T {
  return JSON.parse(value) as T;
}
function bytes(value: number) {
  if (value < 1024) return value + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let n = value / 1024,
    i = 0;
  while (n >= 1024 && i < 3) {
    n /= 1024;
    i++;
  }
  return n.toFixed(1) + ' ' + units[i];
}
function requestId() {
  return (
    'mob_' +
    Date.now().toString(36) +
    '_' +
    Math.random().toString(36).slice(2, 14)
  );
}
function ReviewLocation({
  root,
  label,
  source = false,
}: {
  root: Root;
  label: string;
  source?: boolean;
}) {
  const { colors: c } = useContext(Theme);
  return (
    <View
      style={{
        padding: 16,
        gap: 10,
        borderRadius: 16,
        backgroundColor: c.bg,
        borderWidth: 1,
        borderColor: source ? c.accent : c.line,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <Text
          style={{
            color: source ? c.accent : c.muted,
            fontSize: 12,
            fontWeight: '700',
          }}
        >
          {label}
        </Text>
        {source && (
          <Text
            style={{
              fontSize: 11,
              color: c.accent,
              borderWidth: 1,
              borderColor: c.line,
              borderRadius: 6,
              paddingHorizontal: 8,
              paddingVertical: 3,
            }}
          >
            只读
          </Text>
        )}
      </View>
      <Text
        style={{
          color: c.ink,
          fontSize: 18,
          fontWeight: '600',
          lineHeight: 26,
        }}
      >
        {root.diskName ?? root.label}
      </Text>
      <View style={{ gap: 3 }}>
        <Text style={{ color: c.muted, fontSize: 11 }}>文件夹位置</Text>
        <Text selectable style={{ color: c.ink, fontSize: 14, lineHeight: 21 }}>
          {root.folderName ?? root.label}
        </Text>
      </View>
      {root.freeBytes != null && (
        <Text style={{ color: c.muted, fontSize: 12 }}>
          可用空间 {bytes(root.freeBytes)}
        </Text>
      )}
    </View>
  );
}
function Workspace() {
  const systemTheme = useColorScheme();
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  // Settings UI must not wait for disk persistence or disable every button.
  // Serialize native writes so fast theme toggles cannot be persisted out of order.
  const settingsRef = useRef<Settings>(defaultSettings);
  const settingsWriteRef = useRef<Promise<void>>(Promise.resolve());
  const insets = useSafeAreaInsets(),
    { width } = useWindowDimensions(),
    native = Native;
  const [screen, setScreen] = useState<Screen>('work'),
    [location, setLocation] = useState<'local' | 'desktop'>('local');
  const locationRef = useRef(location);
  const [reduceMotion, setReduceMotion] = useState(true);
  const c = (
    settings.themeMode === 'system'
      ? systemTheme === 'dark'
      : settings.themeMode === 'dark'
  )
    ? dark
    : light;
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then(value => {
        if (active) setReduceMotion(value);
      })
      .catch(() => undefined);
    const listener = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion,
    );
    return () => {
      active = false;
      listener.remove();
    };
  }, []);
  const [snapshot, setSnapshot] = useState<Snapshot>(empty),
    [roots, setRoots] = useState<Root[]>([]),
    [paired, setPaired] = useState(false),
    [connected, setConnected] = useState(false),
    [access, setAccess] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [manualPairingOpen, setManualPairingOpen] = useState(false);
  const [name, setName] = useState('素材备份'),
    [projectName, setProjectName] = useState(''),
    [source, setSource] = useState(''),
    [targets, setTargets] = useState<string[]>([]);
  const [mode, setMode] = useState<'copy' | 'verify'>('copy'),
    [algorithm, setAlgorithm] = useState<HashAlgorithm>('xxhash64'),
    [format, setFormat] = useState<ManifestFormat>('asc-mhl-2.0');
  const [setup, setSetup] = useState(''),
    [deviceName, setDeviceName] = useState('安卓工作台'),
    [projectDetails, setProjectDetails] =
      useState<ProjectDetails>(emptyDetails()),
    [editingProject, setEditingProject] = useState<string | undefined>();
  const [parentProjectId, setParentProjectId] = useState<string | null>(null),
    [cardLabel, setCardLabel] = useState(''),
    [copyNotes, setCopyNotes] = useState('');
  const [restoredTaskProject, setRestoredTaskProject] =
    useState<Draft['project']>();
  const [peerIdentity, setPeerIdentity] = useState('');
  const peerIdentityRef = useRef('');
  const [pendingCreation, setPendingCreation] = useState<Draft>();
  const [restoredProjectMutation, setRestoredProjectMutation] = useState<{
    key: string;
    body: Record<string, unknown>;
  }>();
  const [helpOpen, setHelpOpen] = useState(false),
    [firstHelp, setFirstHelp] = useState(false),
    [desktopName, setDesktopName] = useState('配对电脑'),
    [lastSeen, setLastSeen] = useState<number | null>(null),
    [pairCandidate, setPairCandidate] = useState<ReturnType<
      typeof validateSetup
    > | null>(null),
    [runtime, setRuntime] = useState({
      notificationsEnabled: false,
      batteryUnrestricted: false,
    });
  const [helpTopic, setHelpTopic] = useState<HelpTopic | undefined>();
  const [projectEditorOpen, setProjectEditorOpen] = useState(false);
  const [projectRemovals, setProjectRemovals] = useState<RemovalRecord[]>([]);
  const projectBaseline = useRef(JSON.stringify(emptyDetails()));
  const savedProjectDrafts = useRef<Record<string, EditorDraft>>({});
  const liveProjectDraft = useRef<{ scope: string; value: EditorDraft }>({
    scope: 'local',
    value: {
      details: emptyDetails(),
      baseline: JSON.stringify(emptyDetails()),
    },
  });
  useEffect(() => {
    liveProjectDraft.current = {
      scope: location === 'local' ? 'local' : 'desktop:' + peerIdentity,
      value: {
        details: projectDetails,
        id: editingProject,
        baseline: projectBaseline.current,
        removals: projectRemovals,
        mutation: restoredProjectMutation,
      },
    };
  }, [
    location,
    peerIdentity,
    projectDetails,
    editingProject,
    projectRemovals,
    restoredProjectMutation,
  ]);
  const [pendingProjectKeys, setPendingProjectKeys] = useState<Set<string>>(
    new Set(),
  );
  const scrollRef = useRef<React.ElementRef<typeof ScrollView>>(null),
    scrollPositions = useRef<Record<string, number>>({});
  const savedDrafts = useRef<Partial<Record<'local' | 'desktop', Draft>>>({});
  const [taskProjectFilter, setTaskProjectFilter] = useState<{
    id: string;
    name: string;
  }>();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [preflight, setPreflight] = useState<TargetPreflightResult>();
  const [reviewedDraft, setReviewedDraft] = useState('');
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [selectedJob, setSelectedJob] = useState<Job | undefined>(),
    [reports, setReports] = useState<Report[]>([]);
  const scrollKey =
    (location === 'local' ? 'local' : 'desktop:' + peerIdentity) + ':' + screen;
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      scrollRef.current?.scrollTo({
        y: scrollPositions.current[scrollKey] ?? 0,
        animated: false,
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [scrollKey]);
  function openHelp(topic?: HelpTopic) {
    setFirstHelp(false);
    setHelpTopic(topic);
    setHelpOpen(true);
  }
  function discardProjectDraft() {
    const discard = () => {
      setProjectDetails(emptyDetails());
      setProjectRemovals([]);
      setEditingProject(undefined);
      setRestoredProjectMutation(undefined);
      projectBaseline.current = JSON.stringify(emptyDetails());
      delete savedProjectDrafts.current[
        location === 'local' ? 'local' : 'desktop:' + peerIdentity
      ];
      setProjectEditorOpen(false);
    };
    if (JSON.stringify(projectDetails) !== projectBaseline.current)
      Alert.alert(
        '放弃未保存的母项目修改？',
        '已保存项目与历史任务保持原样。',
        [
          { text: '继续编辑', style: 'cancel' },
          { text: '放弃修改', style: 'destructive', onPress: discard },
        ],
      );
    else discard();
  }
  function newProject() {
    const begin = () => {
      setEditingProject(undefined);
      setProjectDetails(emptyDetails());
      setProjectRemovals([]);
      setRestoredProjectMutation(undefined);
      projectBaseline.current = JSON.stringify(emptyDetails());
      setProjectEditorOpen(true);
    };
    if (JSON.stringify(projectDetails) !== projectBaseline.current)
      Alert.alert('已有未保存的草稿', '新建会替换当前设备的编辑草稿。', [
        {
          text: '继续原草稿',
          style: 'cancel',
          onPress: () => setProjectEditorOpen(true),
        },
        { text: '放弃草稿并新建', style: 'destructive', onPress: begin },
      ]);
    else begin();
  }
  useEffect(() => {
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen !== 'work') {
        setScreen('work');
        return true;
      }
      return false;
    });
    return () => handler.remove();
  }, [screen]);
  const projectReceiptIds = snapshot.projects
    .map(project => project.id)
    .join('|');
  useEffect(() => {
    if (!native || !peerIdentity || busy) return;
    let active = true;
    const keys = [
      'project:new',
      ...projectReceiptIds
        .split('|')
        .filter(Boolean)
        .flatMap(id => ['project:' + id, 'copy:' + id]),
    ];
    void Promise.all(
      keys.map(async key => ({
        key,
        receipt: await native.getPendingMutation(peerIdentity + ':peer:' + key),
      })),
    )
      .then(values => {
        if (active)
          setPendingProjectKeys(
            new Set(values.filter(v => v.receipt !== 'null').map(v => v.key)),
          );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [native, peerIdentity, busy, projectReceiptIds]);
  const generation = useRef(0),
    foreground = useRef(true),
    polling = useRef(false),
    pending = useRef(false);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  function chooseLocation(next: 'local' | 'desktop', internal = false) {
    if ((!internal && pending.current) || next === location) return;
    const currentKey =
      location === 'local' ? 'local' : 'desktop:' + peerIdentity;
    savedProjectDrafts.current[currentKey] = {
      details: projectDetails,
      id: editingProject,
      baseline: projectBaseline.current,
      removals: projectRemovals,
      mutation: restoredProjectMutation,
    };
    const nextKey = next === 'local' ? 'local' : 'desktop:' + peerIdentity;
    const motherDraft = savedProjectDrafts.current[nextKey];
    setProjectEditorOpen(false);
    savedDrafts.current[location] = draft;
    const nextDraft = savedDrafts.current[next];
    setName(nextDraft?.name ?? '素材备份');
    setProjectName(nextDraft?.projectName ?? '');
    setSource(nextDraft?.sourceRootId ?? '');
    setTargets(nextDraft?.targetRootIds ?? []);
    setMode(nextDraft?.mode ?? 'copy');
    setAlgorithm(
      nextDraft?.hashAlgorithm ??
        (next === 'local' ? settings : defaultSettings).hashAlgorithm,
    );
    setFormat(
      nextDraft?.manifestFormat ??
        (next === 'local' ? settings : defaultSettings).manifestFormat,
    );
    setParentProjectId(nextDraft?.parentProjectId ?? null);
    setCardLabel(nextDraft?.project?.cardLabel ?? '');
    setCopyNotes(nextDraft?.project?.copyNotes ?? '');
    setRestoredTaskProject(nextDraft?.project);
    setRestoredProjectMutation(motherDraft?.mutation);
    setEditingProject(motherDraft?.id);
    setProjectDetails(motherDraft?.details ?? emptyDetails());
    setProjectRemovals(motherDraft?.removals ?? []);
    projectBaseline.current =
      motherDraft?.baseline ?? JSON.stringify(emptyDetails());
    setReviewOpen(false);
    setTaskProjectFilter(undefined);
    invalidate();
    setError('');
    setNotice('');
    setSelectedJob(undefined);
    setReports([]);
    setSnapshot(empty);
    setRoots([]);
    setConnected(false);
    locationRef.current = next;
    setLocation(next);
  }
  const peer = useCallback(
    async (method: string, path: string, body?: unknown) => {
      if (!native) throw new Error('原生模块尚未连接，请安装原生构建版本');
      const value = decode<{ version: number; ok: boolean; data?: unknown }>(
        await native.peerRequest(
          method,
          path,
          body === undefined ? '' : JSON.stringify(body),
        ),
      );
      if (value.version !== 1 || !value.ok)
        throw new Error('电脑操作未完成，请刷新状态后重试');
      return value.data;
    },
    [native],
  );
  const resetDesktopCache = useCallback(
    (nextIdentity = '') => {
      delete savedDrafts.current.desktop;
      const previous = liveProjectDraft.current;
      if (nextIdentity && previous.scope.startsWith('desktop:'))
        savedProjectDrafts.current[previous.scope] = previous.value;
      if (!nextIdentity && previous.scope.startsWith('desktop:'))
        delete savedProjectDrafts.current[previous.scope];
      const nextMother = nextIdentity
        ? savedProjectDrafts.current['desktop:' + nextIdentity]
        : undefined;
      setPendingProjectKeys(new Set());
      setPendingCreation(undefined);
      setTaskProjectFilter(undefined);
      setConnectionError('');
      setConnected(false);
      setLastSeen(null);
      setDesktopName('配对电脑');
      if (location === 'desktop') {
        setSnapshot(empty);
        setRoots([]);
        setSource('');
        setTargets([]);
        setName('素材备份');
        setProjectName('');
        setParentProjectId(null);
        setCardLabel('');
        setCopyNotes('');
        setMode('copy');
        setAlgorithm(defaultSettings.hashAlgorithm);
        setFormat(defaultSettings.manifestFormat);
        setRestoredTaskProject(undefined);
        setRestoredProjectMutation(nextMother?.mutation);
        setEditingProject(nextMother?.id);
        setProjectDetails(nextMother?.details ?? emptyDetails());
        setProjectRemovals(nextMother?.removals ?? []);
        projectBaseline.current =
          nextMother?.baseline ?? JSON.stringify(emptyDetails());
        setProjectEditorOpen(false);
        setSelectedJob(undefined);
        setReports([]);
        setReviewOpen(false);
      }
    },
    [location],
  );
  const peerMutationKey = useCallback(
    async (key: string) => {
      if (!peerIdentity) throw Error('请先配对电脑');
      return peerIdentity + ':' + key;
    },
    [peerIdentity],
  );
  const desktop = useMemo(
    () =>
      new DesktopCommands(
        peer,
        requestId,
        native
          ? {
              get: async key => {
                const value = decode<{
                  requestId: string;
                  body: string;
                } | null>(
                  await native.getPendingMutation(
                    await peerMutationKey('desktop:' + key),
                  ),
                );
                return value
                  ? {
                      ...value,
                      body: decode<Record<string, unknown>>(value.body),
                    }
                  : undefined;
              },
              pending: async (key, body) => {
                const v = decode<{ requestId: string; body: string }>(
                  await native.pendingMutation(
                    await peerMutationKey('desktop:' + key),
                    JSON.stringify(body),
                  ),
                );
                return { ...v, body: decode<Record<string, unknown>>(v.body) };
              },
              complete: key =>
                peerMutationKey('desktop:' + key).then(scope =>
                  native.completeMutation(scope),
                ),
            }
          : undefined,
      ),
    [peer, native, peerMutationKey],
  );
  useEffect(() => {
    if (!native || !peerIdentity || busy) return;
    let current = true;
    void native
      .getPendingMutation(peerIdentity + ':desktop:create')
      .then(raw => {
        if (!current) return;
        const receipt = decode<{ body: string } | null>(raw);
        setPendingCreation(receipt ? decode<Draft>(receipt.body) : undefined);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [native, peerIdentity, busy]);
  useEffect(() => {
    if (!native) return;
    void native
      .getSettings()
      .then(raw => {
        const saved = normalizeSettings(decode(raw));
        settingsRef.current = saved;
        setSettings(saved);
        if (locationRef.current === 'local') {
          setAlgorithm(saved.hashAlgorithm);
          setFormat(saved.manifestFormat);
        }
        if (!saved.onboardingDone) {
          setFirstHelp(true);
          setHelpOpen(true);
        }
      })
      .catch(() => undefined);
    void native
      .runtimeStatus()
      .then(raw => setRuntime(decode(raw)))
      .catch(() => undefined);
  }, [native]);
  useEffect(() => {
    if (native)
      void native
        .setKeepScreenOn(
          location === 'local' &&
            settings.keepScreenOn &&
            snapshot.jobs.some(j => ['running', 'queued'].includes(j.state)),
        )
        .catch(() => undefined);
    return () => {
      if (native) void native.setKeepScreenOn(false).catch(() => undefined);
    };
  }, [location, native, settings.keepScreenOn, snapshot.jobs]);
  const refresh = useCallback(
    async (inspect = false) => {
      if (!native) return;
      let version = generation.current;
      const info = decode<{
        clientId?: string;
        paired?: boolean;
        desktopName?: string;
        fingerprint?: string;
      }>(await native.peerInfo());
      if (version !== generation.current) return;
      const identity = info.clientId
        ? info.clientId + ':' + (info.fingerprint ?? '')
        : '';
      if (identity !== peerIdentityRef.current) {
        peerIdentityRef.current = identity;
        setPeerIdentity(identity);
        resetDesktopCache(identity);
        generation.current++;
        version = generation.current;
        inspect = true;
      }
      setPaired(Boolean(info.clientId || info.paired));
      if (info.desktopName) setDesktopName(info.desktopName);
      if (location === 'desktop' && !info.clientId && !info.paired) {
        setSnapshot(empty);
        setRoots([]);
        return;
      }
      const value =
        location === 'local'
          ? decode<unknown>(await native.snapshot())
          : await peer('GET', '/api/v1/snapshot');
      if (version !== generation.current) return;
      setSnapshot(normalizeSnapshot(value));
      if (location === 'desktop') {
        setConnected(true);
        setConnectionError('');
        setLastSeen(Date.now());
        const identity = value as { desktopName?: string };
        if (identity.desktopName) setDesktopName(identity.desktopName);
      }
      if (inspect) {
        const list =
          location === 'local'
            ? decode<Root[]>(await native.roots(false))
            : (
                (await peer('GET', '/api/v1/roots')) as Pick<
                  Root,
                  'id' | 'label' | 'role'
                >[]
              ).map(root => ({
                ...root,
                accessible: true,
                writable: true,
                supportsVerifiedCommit: true,
                volumeId: null,
              }));
        if (version !== generation.current) return;
        setRoots(list);
        setSource(prev =>
          list.some(root => root.id === prev && root.role === 'source')
            ? prev
            : (list.find(root => root.role === 'source')?.id ?? ''),
        );
        setTargets(prev => {
          const kept = prev.filter(id =>
            list.some(root => root.id === id && root.role === 'target'),
          );
          return kept.length
            ? kept
            : list
                .filter(root => root.role === 'target')
                .slice(0, 2)
                .map(root => root.id);
        });
        setAccess(await native.storageAccess());
      }
    },
    [location, native, peer, resetDesktopCache],
  );
  useEffect(() => {
    invalidate();
    void Promise.resolve()
      .then(() => refresh(true))
      .catch(cause => {
        if (location === 'desktop') {
          setConnected(false);
          setConnectionError(
            cause instanceof Error
              ? cause.message
              : '电脑连接未完成，请检查网络与协作服务',
          );
          return;
        }
        setError(
          cause instanceof Error
            ? cause.message
            : '读取任务失败，请检查存储授权或电脑连接',
        );
      });
    const timer = setInterval(() => {
      if (foreground.current && !pending.current && !polling.current) {
        polling.current = true;
        void refresh()
          .catch(cause => {
            if (location === 'desktop') {
              setConnected(false);
              setConnectionError(
                cause instanceof Error
                  ? cause.message
                  : '电脑连接中断，请检查网络与协作服务',
              );
            }
          })
          .finally(() => {
            polling.current = false;
          });
      }
    }, 1500);
    const listener = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      if (state === 'active') void refresh(true).catch(() => undefined);
    });
    return () => {
      invalidate();
      clearInterval(timer);
      listener.remove();
    };
  }, [refresh, invalidate, location]);
  async function action(run: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await run();
    } catch (cause) {
      if (
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        [
          'PEER_NETWORK',
          'PEER_REFUSED',
          'PEER_CERTIFICATE',
          'PEER_AUTH',
          'PEER_VERSION',
        ].includes(String(cause.code))
      ) {
        setConnected(false);
        setConnectionError(
          cause instanceof Error
            ? cause.message
            : '电脑连接未完成，请检查网络与配对',
        );
      }
      if (
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        cause.code === 'SCAN_MANUAL'
      ) {
        setManualPairingOpen(true);
        return;
      }
      if (
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        ['PICKER_CANCELLED', 'SCAN_CANCELLED'].includes(String(cause.code))
      )
        return;
      setError(
        cause instanceof Error && !cause.message.startsWith('[')
          ? cause.message
          : '操作未完成，请检查输入、存储授权或连接',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const draft: Draft = {
    name,
    mode,
    sourceRootId: source,
    targetRootIds: targets,
    hashAlgorithm: algorithm,
    manifestFormat: format,
    projectName,
    parentProjectId,
    project: restoredTaskProject ?? {
      ...(snapshot.projects.find(p => p.id === parentProjectId)?.details ??
        emptyDetails()),
      projectName,
      cardLabel,
      copyNotes,
    },
  };
  let ready = false,
    draftIssue = '';
  const pickedSource = roots.find(root => root.id === source);
  const pickedTargets = targets
    .map(id => roots.find(root => root.id === id))
    .filter((root): root is Root => Boolean(root));
  try {
    validateDraft(draft, roots);
    ready = Boolean(native) && (location === 'local' || (paired && connected));
  } catch (cause) {
    draftIssue = !source
      ? '先选择来源素材文件夹'
      : !targets.length
        ? '再选择至少一份目标位置'
        : cause instanceof Error && !cause.message.startsWith('[')
          ? cause.message
          : '请检查任务名称和位置选择';
  }
  function reviewPositions() {
    if (pending.current || !ready || !pickedSource || !native) return;
    Keyboard.dismiss();
    void action(async () => {
      const result =
        location === 'local'
          ? preflightSchema.parse(
              decode<unknown>(await native.preflightJob(JSON.stringify(draft))),
            )
          : await desktop.preflight(draft);
      setPreflight(result);
      setReviewedDraft(JSON.stringify(draft));
      setRiskAccepted(false);
      setReviewOpen(true);
    });
  }
  async function pickLocation(role: 'source' | 'target', slot = 0) {
    if (!native) return;
    const root = decode<Root>(await native.pickRoot(role));
    if (role === 'source') setSource(root.id);
    else setTargets(selectTargetSlot(targets, root.id, slot));
    await refresh(true);
  }
  async function create() {
    if (!native) return;
    validateDraft(draft, roots);
    if (!preflight || reviewedDraft !== JSON.stringify(draft))
      throw Error('任务位置或资料已改变，请重新预检');
    const confirmation: PreflightConfirmation = {
      fingerprint: preflight.fingerprint,
      acceptRisks: riskAccepted,
    };
    requirePreflight(preflight, confirmation);
    const confirmedDraft = { ...draft, preflightConfirmation: confirmation };
    const job =
      location === 'local'
        ? decode<Job>(await native.createJob(JSON.stringify(confirmedDraft)))
        : await desktop.create(confirmedDraft);
    setSnapshot(current => ({
      ...current,
      jobs: [job, ...current.jobs.filter(entry => entry.id !== job.id)],
    }));
    setTaskProjectFilter(undefined);
    setScreen('jobs');
    if (location === 'local') await native.control(job.id, 'start');
    else await desktop.control(job.id, 'start', confirmation);
    await refresh();
  }
  async function control(job: Job, command: string) {
    if (!native) return;
    if (location === 'desktop' && !connected)
      throw new Error('电脑连接中断，请连接并刷新后再操作');
    let confirmation: PreflightConfirmation | undefined;
    if (command === 'start' || command === 'resume') {
      const input = {
        ...job,
        hashAlgorithm: job.hashAlgorithm ?? ('xxhash64' as const),
        manifestFormat: job.manifestFormat ?? ('asc-mhl-2.0' as const),
      };
      const result =
        location === 'local'
          ? preflightSchema.parse(
              decode<unknown>(await native.preflightJob(JSON.stringify(input))),
            )
          : await desktop.preflight(input, job.id);
      if (result.blockingReasons.length)
        throw Error(result.blockingReasons.join('；'));
      let accepted = false;
      if (result.risks.length)
        accepted = await new Promise<boolean>(resolve =>
          Alert.alert(
            '核对存储风险',
            result.risks.map(r => riskLabels[r.code]).join('\n'),
            [
              { text: '返回', style: 'cancel', onPress: () => resolve(false) },
              { text: '我已理解并继续', onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          ),
        );
      if (result.risks.length && !accepted) return;
      confirmation = { fingerprint: result.fingerprint, acceptRisks: accepted };
      requirePreflight(result, confirmation);
    }
    if (location === 'local')
      await native.control(
        job.id,
        confirmation
          ? JSON.stringify({
              action: command,
              preflightConfirmation: confirmation,
            })
          : command,
      );
    else await desktop.control(job.id, command, confirmation);
    await refresh();
  }
  async function openReports(job: Job) {
    if (!native) return;
    setSelectedJob(job);
    setReports(
      location === 'local'
        ? decode<Report[]>(await native.reports(job.id))
        : ((await peer(
            'GET',
            '/api/v1/reports/' + encodeURIComponent(job.id),
          )) as Report[]),
    );
    setScreen('reports');
  }
  async function saveReport() {
    if (!native || !selectedJob || location !== 'local') return;
    const job = normalizeSnapshot({
      jobs: [decode<unknown>(await native.getJob(selectedJob.id))],
      projects: [],
    }).jobs[0];
    if (!job || !canReport(job.state))
      throw new Error('任务结束后才能生成报告');
    await native.saveReport(job.id, JSON.stringify(reportBundle(job)));
    await openReports(job);
    setNotice('新报告修订已保存');
  }
  async function persistSettings(change: Partial<Settings>) {
    if (!native) return;
    const value = normalizeSettings({ ...settingsRef.current, ...change });
    settingsRef.current = value;
    setSettings(value);
    // Keep updates in order while leaving the interface responsive.
    const write = settingsWriteRef.current
      .catch(() => undefined)
      .then(async () => {
        const saved = normalizeSettings(
          decode(await native.saveSettings(JSON.stringify(value))),
        );
        if (settingsRef.current === value) {
          settingsRef.current = saved;
          setSettings(saved);
        }
      });
    settingsWriteRef.current = write;
    return write;
  }
  async function projectMutation(body: Record<string, unknown>, key: string) {
    if (!native) throw Error('原生模块尚未连接');
    const scope = await peerMutationKey('peer:' + key);
    return sendProjectMutation(
      peer,
      {
        get: async () => {
          const receipt = decode<{ requestId: string; body: string } | null>(
            await native.getPendingMutation(scope),
          );
          return receipt
            ? {
                ...receipt,
                body: decode<Record<string, unknown>>(receipt.body),
              }
            : undefined;
        },
        pending: async (_key, value) => {
          const receipt = decode<{ requestId: string; body: string }>(
            await native.pendingMutation(scope, JSON.stringify(value)),
          );
          return {
            ...receipt,
            body: decode<Record<string, unknown>>(receipt.body),
          };
        },
        complete: () => native.completeMutation(scope),
      },
      key,
      body,
    );
  }
  async function restorePendingCreation() {
    const original = await desktop.restoreCreation();
    if (!original) throw Error('这台电脑没有未确认的任务请求');
    setName(original.name);
    setProjectName(original.projectName);
    setMode(original.mode);
    setSource(original.sourceRootId);
    setTargets([...original.targetRootIds]);
    setAlgorithm(original.hashAlgorithm);
    setFormat(original.manifestFormat);
    setParentProjectId(original.parentProjectId ?? null);
    setCardLabel(original.project?.cardLabel ?? '');
    setCopyNotes(original.project?.copyNotes ?? '');
    setRestoredTaskProject(original.project);
    setScreen('work');
    setNotice(
      '已恢复原任务及当时的项目资料；重试使用原请求编号，不读取母项目的后续改动。',
    );
  }
  function abandonPendingCreation() {
    if (!connected) return;
    Alert.alert(
      '核对后放弃此请求',
      '这个请求可能已在电脑创建任务。请先查看电脑任务列表。放弃仅清除手机重试记录，不取消或删除电脑任务。',
      [
        { text: '返回核对', style: 'cancel' },
        {
          text: '我已核对，放弃重试',
          style: 'destructive',
          onPress: () =>
            void action(async () => {
              await desktop.abandonCreation();
              setPendingCreation(undefined);
              setRestoredTaskProject(undefined);
              setNotice('已放弃手机上的任务重试记录；电脑任务保持原样。');
            }),
        },
      ],
    );
  }
  async function restorePendingProject(
    key = restoredProjectMutation?.key ??
      'project:' + (editingProject ?? 'new'),
  ) {
    if (!native) throw Error('原生模块尚未连接');
    const receipt = decode<{ body: string } | null>(
      await native.getPendingMutation(await peerMutationKey('peer:' + key)),
    );
    if (!receipt) throw Error('这台电脑没有对应的未确认项目请求');
    const body = decode<Record<string, unknown>>(receipt.body);
    const original = normalizeProject({
      id: typeof body.id === 'string' ? body.id : 'prj_restored',
      ...body,
    });
    const targetDraft =
      location === 'desktop'
        ? { details: projectDetails, baseline: projectBaseline.current }
        : savedProjectDrafts.current['desktop:' + peerIdentity];
    if (
      targetDraft &&
      JSON.stringify(targetDraft.details) !== targetDraft.baseline
    ) {
      const replace = await new Promise<boolean>(resolve =>
        Alert.alert(
          '替换未保存的电脑项目草稿？',
          '恢复原请求会替换当前电脑的编辑资料及撤销记录；电脑上的已保存项目保持原样。',
          [
            {
              text: '保留当前草稿',
              style: 'cancel',
              onPress: () => resolve(false),
            },
            {
              text: '替换并恢复原请求',
              style: 'destructive',
              onPress: () => resolve(true),
            },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        ),
      );
      if (!replace) return;
    }
    chooseLocation('desktop', true);
    setScreen('projects');
    setProjectEditorOpen(true);
    setEditingProject(typeof body.id === 'string' ? body.id : undefined);
    setProjectDetails(original.details);
    setProjectRemovals([]);
    projectBaseline.current = JSON.stringify(original.details);
    setRestoredProjectMutation({ key, body });
    setNotice('已恢复原项目资料；保存将重试原请求。');
  }
  function abandonPendingProject() {
    if (!connected || !native) return;
    const key =
      restoredProjectMutation?.key ?? 'project:' + (editingProject ?? 'new');
    Alert.alert(
      '核对后放弃项目重试',
      '这个请求可能已在电脑保存项目。请先查看电脑项目；放弃只清除手机重试记录，不修改电脑项目。',
      [
        { text: '返回核对', style: 'cancel' },
        {
          text: '我已核对，放弃项目重试',
          style: 'destructive',
          onPress: () =>
            void action(async () => {
              await native.completeMutation(
                await peerMutationKey('peer:' + key),
              );
              setRestoredProjectMutation(undefined);
              setNotice('已放弃手机上的项目重试记录。');
            }),
        },
      ],
    );
  }
  async function saveProject() {
    if (!native) return;
    const original = restoredProjectMutation?.body;
    const restoring =
      original && sameMutationBody(original.details, projectDetails);
    const details = restoring
      ? projectDetails
      : validateProjectDetails(projectDetails);
    if (!restoring && !details.projectName.trim())
      throw Error('请输入项目名称');
    const body = restoring
      ? original
      : {
          ...(editingProject ? { id: editingProject } : {}),
          name: details.projectName.trim(),
          details,
        };
    if (location === 'local') await native.saveProject(JSON.stringify(body));
    else {
      if (!connected) throw Error('请先连接电脑');
      await projectMutation(
        body,
        restoredProjectMutation?.key ?? 'project:' + (editingProject ?? 'new'),
      );
      setRestoredProjectMutation(undefined);
    }
    setEditingProject(undefined);
    setProjectDetails(emptyDetails());
    setProjectRemovals([]);
    projectBaseline.current = JSON.stringify(emptyDetails());
    delete savedProjectDrafts.current[
      location === 'local' ? 'local' : 'desktop:' + peerIdentity
    ];
    setProjectEditorOpen(false);
    await refresh();
    setNotice('母项目已保存');
  }
  function requestEditProject(project: Project) {
    if (editingProject === project.id) {
      setProjectEditorOpen(true);
      return;
    }
    const open = () => void action(() => editProject(project));
    if (JSON.stringify(projectDetails) !== projectBaseline.current)
      Alert.alert(
        '放弃未保存的母项目修改？',
        '打开另一个项目会替换当前设备的编辑草稿。',
        [
          {
            text: '继续原草稿',
            style: 'cancel',
            onPress: () => setProjectEditorOpen(true),
          },
          { text: '放弃草稿并打开', style: 'destructive', onPress: open },
        ],
      );
    else open();
  }
  async function editProject(project: Project) {
    const value =
      location === 'desktop'
        ? ((await peer('GET', '/api/v1/projects')) as Project[]).find(
            p => p.id === project.id,
          )
        : project;
    if (!value) throw Error('项目不可用');
    setEditingProject(project.id);
    const details = normalizeProject(value).details;
    setProjectDetails(details);
    setProjectRemovals([]);
    projectBaseline.current = JSON.stringify(details);
    setProjectEditorOpen(true);
  }
  async function copyProject(project: Project) {
    if (!native) return;
    const value =
      location === 'desktop'
        ? ((await peer('GET', '/api/v1/projects')) as Project[]).find(
            p => p.id === project.id,
          )
        : project;
    if (!value) throw Error('项目不可用');
    const normalized = normalizeProject(value);
    const body = { name: normalized.name, details: normalized.details };
    if (location === 'desktop') await native.saveProject(JSON.stringify(body));
    else {
      if (!paired) throw Error('请先扫码配对电脑');
      await projectMutation(body, 'copy:' + project.id);
    }
    setNotice(
      '已复制到' + (location === 'local' ? '电脑' : '手机') + '，原项目保留',
    );
  }
  async function confirmPair() {
    if (!native || !pairCandidate) return;
    await native.pairPeer(
      JSON.stringify(validateSetup(pairCandidate)),
      deviceName,
    );
    setPairCandidate(null);
    setSetup('');
    await refresh(true);
    setNotice('电脑已配对，进入电脑监控查看任务');
  }
  function choices(role: 'source' | 'target') {
    const list = roots.filter(root => root.role === role);
    return (
      <View style={{ gap: 10 }}>
        {list.map(root => {
          const ordinal = targets.indexOf(root.id),
            selected = role === 'source' ? source === root.id : ordinal >= 0;
          return (
            <View
              key={root.id}
              style={{
                gap: 6,
                borderWidth: 1,
                borderColor: selected ? c.accent : c.line,
                borderRadius: 12,
                padding: 12,
              }}
            >
              <Text style={[s.body, { color: c.muted }]}>
                {role === 'source'
                  ? selected
                    ? '已选来源 · 只读'
                    : '可选来源'
                  : ordinal >= 0
                    ? '已选目标 ' + (ordinal + 1)
                    : '可选备份位置'}
              </Text>
              <Button
                label={(selected ? '✓ ' : '') + (root.diskName ?? root.label)}
                primary={selected}
                disabled={!root.accessible}
                onPress={() =>
                  role === 'source'
                    ? setSource(root.id)
                    : setTargets(current =>
                        current.includes(root.id)
                          ? current.filter(id => id !== root.id)
                          : current.length < 2
                            ? [...current, root.id]
                            : current,
                      )
                }
              />
              {root.folderName && (
                <Text selectable style={[s.body, { color: c.ink }]}>
                  文件夹：{root.folderName}
                </Text>
              )}
              {root.freeBytes != null && (
                <Text style={[s.body, { color: c.muted }]}>
                  可用空间 {bytes(root.freeBytes)}
                </Text>
              )}
              {!root.accessible && (
                <Text style={{ color: c.danger }}>
                  {root.connected === false
                    ? '磁盘未连接，请重新连接'
                    : '目录授权失效，请重新选择'}
                </Text>
              )}
              {role === 'target' && (
                <Text
                  style={[
                    s.body,
                    { color: root.supportsVerifiedCommit ? c.accent : c.muted },
                  ]}
                >
                  {root.supportsVerifiedCommit && root.writable
                    ? '可安全拷贝与校验'
                    : mode === 'verify'
                      ? '将读取已有备份，不写入这个位置'
                      : (root.disabledReason ??
                        (root.writable
                          ? '开始拷贝前，请检测拷贝支持'
                          : '当前为只读授权，可用于仅校验'))}
                </Text>
              )}
              {location === 'local' && (
                <Pressable
                  accessibilityLabel={'移除授权 ' + root.label}
                  onPress={() =>
                    void action(async () => {
                      await native?.forgetRoot(root.id);
                      await refresh(true);
                    })
                  }
                >
                  <Text style={{ color: c.muted, paddingVertical: 8 }}>
                    移除目录授权
                  </Text>
                </Pressable>
              )}
            </View>
          );
        })}
        {!list.length && (
          <Text style={[s.body, { color: c.muted }]}>
            {location === 'local'
              ? role === 'source'
                ? '选择相机卡或项目素材所在的文件夹。'
                : '选择备份盘上的项目文件夹。'
              : '请先在电脑设置中添加允许使用的目录。'}
          </Text>
        )}
        {location === 'local' &&
          (role === 'source' ? (
            <Button
              label={source ? '更换来源目录' : '选择来源目录'}
              disabled={!native}
              onPress={() => void action(() => pickLocation('source'))}
            />
          ) : (
            <>
              <Button
                label={
                  targets[0] ? '更换目标盘 1 的文件夹' : '选择目标盘 1 的文件夹'
                }
                disabled={!native}
                onPress={() => void action(() => pickLocation('target', 0))}
              />
              <Button
                label={
                  targets[1] ? '更换目标盘 2 的文件夹' : '添加目标盘 2（可选）'
                }
                disabled={!native || !targets[0]}
                onPress={() => void action(() => pickLocation('target', 1))}
              />
              <Text style={[s.body, { color: c.muted }]}>
                {mode === 'copy'
                  ? '在系统选择器侧栏选磁盘，再选项目文件夹；需要新建文件夹时，使用选择器的菜单。'
                  : '请选择已有备份文件夹，与来源保持相同的内部文件结构。'}
              </Text>
            </>
          ))}
      </View>
    );
  }
  function jobCard(job: Job) {
    const ratio = job.totalBytes
      ? Math.min(1, job.bytesDone / job.totalBytes)
      : 0;
    return (
      <Card key={job.id} title={job.name}>
        <Text style={[s.body, { color: c.muted }]}>
          {states[job.state] ?? job.state} ·{' '}
          {job.mode === 'verify' ? '仅校验' : '拷贝与校验'} ·{' '}
          {location === 'local' ? '本机手机执行' : desktopName + '执行'}
        </Text>
        {(job.parentProjectName || job.project) && (
          <Text style={[s.body, { color: c.muted }]}>
            母项目：{job.parentProjectName ?? '未归属'} · 卡号：
            {job.project?.cardLabel || '未填写'} · 摄影机：
            {job.project?.camera || '未填写'} · {job.project?.crew.length ?? 0}{' '}
            位人员
          </Text>
        )}
        <ProgressBar ratio={ratio} />
        <Text style={[s.body, { color: c.ink }]}>
          已校验 {job.filesDone} / {job.totalFiles} · 失败 {job.filesFailed}
        </Text>
        <Text style={[s.body, { color: c.muted }]}>
          {bytes(job.bytesDone)} / {bytes(job.totalBytes)}
          {job.phase ? ' · ' + job.phase : ''}
        </Text>
        <View style={s.row}>
          {['draft', 'queued', 'interrupted'].includes(job.state) && (
            <Button
              label="开始／恢复"
              disabled={location === 'desktop' && !connected}
              onPress={() =>
                void action(() =>
                  control(
                    job,
                    job.state === 'interrupted' ? 'resume' : 'start',
                  ),
                )
              }
            />
          )}
          {job.state === 'running' && (
            <Button
              label="暂停"
              disabled={location === 'desktop' && !connected}
              onPress={() => void action(() => control(job, 'pause'))}
            />
          )}
          {job.state === 'paused' && (
            <Button
              label="继续"
              disabled={location === 'desktop' && !connected}
              onPress={() => void action(() => control(job, 'resume'))}
            />
          )}
          {['draft', 'queued', 'running', 'paused', 'interrupted'].includes(
            job.state,
          ) && (
            <Button
              label="取消任务"
              disabled={location === 'desktop' && !connected}
              onPress={() =>
                Alert.alert(
                  '取消任务',
                  '保留已校验文件，未完成文件不会标记为成功。',
                  [
                    { text: '返回', style: 'cancel' },
                    {
                      text: '取消任务',
                      onPress: () => void action(() => control(job, 'cancel')),
                    },
                  ],
                )
              }
            />
          )}
          {canReport(job.state) && (
            <Button
              label="查看报告"
              disabled={location === 'desktop' && !connected}
              onPress={() => void action(() => openReports(job))}
            />
          )}
        </View>
      </Card>
    );
  }
  return (
    <Theme.Provider value={{ colors: c, busy, reduceMotion }}>
      <View
        testID="workspace"
        style={[s.page, { backgroundColor: c.bg, paddingTop: insets.top }]}
      >
        <StatusBar barStyle={c === dark ? 'light-content' : 'dark-content'} />
        {helpOpen && (
          <HelpSheet
            first={firstHelp}
            initialTopic={helpTopic}
            onClose={() => {
              setHelpOpen(false);
              setHelpTopic(undefined);
              setFirstHelp(false);
              void action(() => persistSettings({ onboardingDone: true }));
            }}
          />
        )}
        {projectEditorOpen && (
          <ModalPage
            title={
              (editingProject ? '编辑母项目' : '新建母项目') +
              ' · ' +
              (location === 'local' ? '手机' : desktopName)
            }
            onClose={() => setProjectEditorOpen(false)}
            footer={
              <>
                <Button
                  label="保存母项目"
                  primary
                  disabled={!native || (location === 'desktop' && !connected)}
                  onPress={() => void action(saveProject)}
                />
                <Button label="放弃编辑草稿" onPress={discardProjectDraft} />
              </>
            }
          >
            <ProjectEditor
              value={projectDetails}
              onChange={setProjectDetails}
              removalHistory={projectRemovals}
              onRemovalHistoryChange={setProjectRemovals}
            />
            {!!error && (
              <Text
                accessibilityRole="alert"
                style={[s.body, { color: c.danger }]}
              >
                {error}
              </Text>
            )}
            {location === 'desktop' &&
              (restoredProjectMutation ||
                pendingProjectKeys.has(
                  'project:' + (editingProject ?? 'new'),
                )) && (
                <Card title="未确认的项目请求">
                  <Button
                    label="恢复未确认项目填写"
                    onPress={() => void action(() => restorePendingProject())}
                  />
                  <Button
                    label="查看电脑项目"
                    disabled={!connected}
                    onPress={() => {
                      setProjectEditorOpen(false);
                      void action(() => refresh(true));
                    }}
                  />
                  <Button
                    label="放弃项目重试"
                    disabled={!connected}
                    onPress={abandonPendingProject}
                  />
                </Card>
              )}
          </ModalPage>
        )}
        {pairCandidate && (
          <Modal
            transparent
            animationType={reduceMotion ? 'none' : 'fade'}
            onRequestClose={() => setPairCandidate(null)}
          >
            <View
              style={{
                flex: 1,
                justifyContent: 'center',
                padding: 24,
                backgroundColor: '#0008',
              }}
            >
              <Card title="核对电脑身份">
                <Text style={[s.h2, { color: c.ink }]}>
                  {pairCandidate.desktopName ?? '局域网电脑'}
                </Text>
                <Text selectable style={[s.body, { color: c.muted }]}>
                  {pairCandidate.url}
                </Text>
                <Text style={[s.body, { color: c.muted }]}>
                  请确认这就是电脑屏幕上的配对二维码。素材不会传到手机。
                </Text>
                <Button
                  label="确认连接这台电脑"
                  primary
                  onPress={() => void action(confirmPair)}
                />
                <Button
                  label="取消连接"
                  onPress={() => setPairCandidate(null)}
                />
              </Card>
            </View>
          </Modal>
        )}
        {reviewOpen && pickedSource && (
          <Modal
            transparent
            animationType={reduceMotion ? 'none' : 'fade'}
            statusBarTranslucent
            visible
            onRequestClose={() => setReviewOpen(false)}
          >
            <View
              style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                paddingHorizontal: 20,
                paddingTop: insets.top + 24,
                paddingBottom: insets.bottom + 24,
                backgroundColor: 'rgba(8,15,22,0.52)',
              }}
            >
              <View
                accessibilityLabel="位置确认面板"
                accessibilityViewIsModal
                style={{
                  width: '100%',
                  maxWidth: 560,
                  maxHeight: '100%',
                  borderRadius: 24,
                  backgroundColor: c.surface,
                  borderWidth: 1,
                  borderColor: c.line,
                  overflow: 'hidden',
                  elevation: 16,
                  shadowColor: '#000000',
                  shadowOpacity: 0.18,
                  shadowRadius: 24,
                  shadowOffset: { width: 0, height: 12 },
                }}
              >
                <View style={{ padding: 22, paddingBottom: 16, gap: 10 }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <Text
                      style={{
                        color: c.accent,
                        fontSize: 12,
                        fontWeight: '700',
                        letterSpacing: 1,
                      }}
                    >
                      {mode === 'verify' ? '只读校验' : '素材备份'}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="关闭位置核对"
                      onPress={() => setReviewOpen(false)}
                      style={{
                        width: 40,
                        height: 40,
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 20,
                        backgroundColor: c.bg,
                      }}
                    >
                      <Text style={{ color: c.muted, fontSize: 24 }}>×</Text>
                    </Pressable>
                  </View>
                  <Text
                    accessibilityRole="header"
                    style={{ fontSize: 24, fontWeight: '700', color: c.ink }}
                  >
                    核对来源与目标
                  </Text>
                  <Text
                    style={{ fontSize: 14, lineHeight: 21, color: c.muted }}
                  >
                    执行设备：{location === 'local' ? '本机手机' : desktopName}
                    。确认磁盘与文件夹，再开始本次操作。
                  </Text>
                </View>
                <ScrollView
                  contentContainerStyle={{
                    paddingHorizontal: 22,
                    paddingBottom: 18,
                  }}
                  bounces={false}
                >
                  <ReviewLocation root={pickedSource} label="来源素材" source />
                  <View
                    style={{
                      paddingVertical: 12,
                      flexDirection: 'row',
                      gap: 10,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ color: c.accent, fontSize: 24 }}>↓</Text>
                    <Text style={{ fontSize: 12, color: c.muted }}>
                      {mode === 'verify'
                        ? '逐文件比较校验值'
                        : '写入目标后独立重读'}
                    </Text>
                  </View>
                  <View style={{ gap: 10 }}>
                    {pickedTargets.map((root, index) => (
                      <ReviewLocation
                        key={root.id}
                        root={root}
                        label={
                          (mode === 'verify' ? '校验目标 ' : '备份目标 ') +
                          (index + 1)
                        }
                      />
                    ))}
                  </View>
                  <View
                    style={{
                      marginTop: 16,
                      padding: 14,
                      borderRadius: 12,
                      backgroundColor: c.bg,
                    }}
                  >
                    <Text
                      style={{ color: c.muted, fontSize: 13, lineHeight: 20 }}
                    >
                      {mode === 'verify'
                        ? '本次仅比较现有素材，不写入来源和目标。'
                        : '目标写入后会独立重读校验，已存在的文件不会被覆盖。'}
                    </Text>
                  </View>
                  {preflight && (
                    <View style={{ gap: 10, marginTop: 14 }}>
                      <Text style={{ color: c.muted }}>
                        独立物理设备组：
                        {preflight.independentDeviceGroups ?? '未知'}
                      </Text>
                      {preflight.groups.map(group => (
                        <Text
                          key={group.id}
                          style={{
                            color: group.sufficient ? c.muted : c.danger,
                          }}
                        >
                          共享容量组：需 {group.requiredBytes} 字节 / 可用{' '}
                          {group.availableBytes ?? '未知'} 字节
                        </Text>
                      ))}
                      {preflight.risks.map((risk, index) => (
                        <Text
                          key={index}
                          accessibilityRole="alert"
                          style={{ color: c.danger }}
                        >
                          {riskLabels[risk.code]}
                        </Text>
                      ))}
                      {preflight.blockingReasons.map((reason, index) => (
                        <Text
                          key={index}
                          accessibilityRole="alert"
                          style={{ color: c.danger }}
                        >
                          {reason}
                        </Text>
                      ))}
                      {!!preflight.risks.length && (
                        <Button
                          label={
                            riskAccepted
                              ? '已接受上述存储风险'
                              : '我已理解并接受上述存储风险'
                          }
                          onPress={() => setRiskAccepted(!riskAccepted)}
                          primary={riskAccepted}
                        />
                      )}
                    </View>
                  )}
                  {!ready && (
                    <Text
                      accessibilityRole="alert"
                      style={{ color: c.danger, marginTop: 12 }}
                    >
                      {draftIssue || '连接已中断，请返回检查'}
                    </Text>
                  )}
                </ScrollView>
                <View
                  style={{
                    borderTopWidth: 1,
                    borderColor: c.line,
                    padding: 18,
                    flexDirection: width >= 360 ? 'row' : 'column',
                    gap: 10,
                  }}
                >
                  <View style={{ flex: width >= 360 ? 1 : undefined }}>
                    <Button
                      label="返回修改"
                      onPress={() => setReviewOpen(false)}
                    />
                  </View>
                  <View style={{ flex: width >= 360 ? 1.35 : undefined }}>
                    <Button
                      label={
                        (location === 'local' ? '在本机' : '在电脑') +
                        (mode === 'copy' ? '开始拷贝' : '开始校验')
                      }
                      accessibilityLabel={
                        mode === 'copy' ? '确认并开始拷贝' : '确认并开始校验'
                      }
                      primary
                      disabled={
                        !ready ||
                        !preflight ||
                        reviewedDraft !== JSON.stringify(draft) ||
                        !!preflight.blockingReasons.length ||
                        (!!preflight.risks.length && !riskAccepted)
                      }
                      onPress={() => {
                        setReviewOpen(false);
                        void action(create);
                      }}
                    />
                  </View>
                </View>
              </View>
            </View>
          </Modal>
        )}

        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 10,
            gap: 8,
            borderBottomWidth: 1,
            borderColor: c.line,
            backgroundColor: c.surface,
          }}
        >
          <View style={[s.row, { justifyContent: 'space-between' }]}>
            <Text style={[s.h1, { color: c.ink }]}>
              SecureReel{' '}
              <Text style={{ fontSize: 14, color: c.muted }}>
                {screenLabels[screen]}
              </Text>
            </Text>
            {busy && <ActivityIndicator color={c.accent} />}
          </View>
          <View style={s.row}>
            <Button
              label="本机拷贝"
              primary={location === 'local'}
              onPress={() => chooseLocation('local')}
            />
            <Button
              label="电脑监控"
              primary={location === 'desktop'}
              onPress={() => chooseLocation('desktop')}
            />
            <Button
              label="刷新"
              onPress={() => void action(() => refresh(true))}
            />
          </View>
          <Text numberOfLines={2} style={[s.body, { color: c.muted }]}>
            {location === 'local'
              ? '手机执行 · 本机磁盘'
              : desktopName + ' · ' + (connected ? '已连接' : '未连接')}
          </Text>
        </View>
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={s.content}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={100}
          onScroll={event => {
            scrollPositions.current[scrollKey] =
              event.nativeEvent.contentOffset.y;
          }}
        >
          <PageTransition identity={scrollKey}>
            {screen === 'work' && (
              <View
                style={[
                  s.card,
                  {
                    backgroundColor:
                      location === 'local' ? c.surface : c.accent,
                    borderColor: c.accent,
                  },
                ]}
              >
                <Text
                  style={[
                    s.h2,
                    { color: location === 'local' ? c.ink : c.onAccent },
                  ]}
                >
                  {location === 'local'
                    ? '本机拷贝 · 手机执行'
                    : desktopName + ' · ' + (connected ? '已连接' : '未连接')}
                </Text>
                <View style={s.row}>
                  <HelpLink
                    label="操作指南"
                    onPress={() =>
                      openHelp(
                        location === 'local'
                          ? mode === 'verify'
                            ? 'verify'
                            : 'copy'
                          : 'connect',
                      )
                    }
                  />
                  {location === 'desktop' && !connected && (
                    <Button
                      label="连接设置"
                      onPress={() => setScreen('settings')}
                    />
                  )}
                </View>
              </View>
            )}
            {!native && (
              <Text accessibilityRole="alert" style={{ color: c.danger }}>
                原生模块尚未连接，请安装原生构建版本。
              </Text>
            )}
            {location === 'desktop' && paired && !connected && (
              <Text accessibilityRole="alert" style={{ color: c.danger }}>
                {connectionError || '电脑连接尚未恢复'}
                ，当前显示缓存。最后更新：
                {lastSeen
                  ? new Date(lastSeen).toLocaleTimeString()
                  : '尚未连接'}
                。电脑已有任务继续执行，恢复后自动刷新。
              </Text>
            )}
            {location === 'desktop' && !paired && (
              <Text style={[s.body, { color: c.muted }]}>
                请在设置中扫码连接电脑，素材和磁盘留在电脑。
              </Text>
            )}
            {location === 'desktop' &&
              pendingCreation &&
              (screen === 'work' || screen === 'settings') && (
                <Card title="未确认的电脑任务请求">
                  <Text style={{ color: c.ink }}>
                    {pendingCreation.name} ·{' '}
                    {pendingCreation.project?.cardLabel ?? ''}
                  </Text>
                  <Text style={[s.body, { color: c.muted }]}>
                    请求可能已执行；先核对电脑任务，或恢复原资料用原编号重试。
                  </Text>
                  <Button
                    label="查看电脑任务"
                    disabled={!connected}
                    onPress={() => setScreen('jobs')}
                  />
                  <Button
                    label="恢复未确认任务填写"
                    disabled={!paired}
                    onPress={() => void action(restorePendingCreation)}
                  />
                  <Button
                    label="核对后放弃此请求"
                    disabled={!connected}
                    onPress={abandonPendingCreation}
                  />
                </Card>
              )}
            {!!error && !(screen === 'settings' && location === 'desktop') && (
              <Text
                accessibilityRole="alert"
                style={[s.body, { color: c.danger }]}
              >
                {error}
              </Text>
            )}
            {!!notice && (
              <Text style={[s.body, { color: c.ink }]}>{notice}</Text>
            )}
            {screen === 'work' && (
              <View style={width >= 700 ? s.row : { gap: 16 }}>
                <View style={s.column}>
                  <Card title="本次操作">
                    <View style={s.row}>
                      <Button
                        label="拷贝与校验"
                        primary={mode === 'copy'}
                        onPress={() => setMode('copy')}
                      />
                      <Button
                        label="仅校验"
                        primary={mode === 'verify'}
                        onPress={() => setMode('verify')}
                      />
                    </View>
                    <Text style={[s.body, { color: c.muted }]}>
                      {mode === 'copy'
                        ? '写入 · 重读校验 · 安全提交'
                        : '只读比对 · 不修改素材'}
                    </Text>
                  </Card>
                  <Card title="1 · 来源素材">{choices('source')}</Card>
                  <Card title="2 · 备份目标">
                    {choices('target')}
                    {location === 'local' && mode === 'copy' && (
                      <Button
                        label="检测拷贝支持"
                        onPress={() =>
                          void action(async () => {
                            if (native)
                              setRoots(
                                decode<Root[]>(await native.roots(true)),
                              );
                          })
                        }
                      />
                    )}
                  </Card>
                </View>
                <View style={s.column}>
                  <Card title="本次任务">
                    <Text style={[s.body, { color: c.muted }]}>
                      母项目 · {location === 'local' ? '手机资料' : desktopName}
                    </Text>
                    <View style={s.row}>
                      <Button
                        label="不归属母项目"
                        primary={!parentProjectId}
                        onPress={() => {
                          setRestoredTaskProject(undefined);
                          setParentProjectId(null);
                        }}
                      />
                      {snapshot.projects.map(p => (
                        <Button
                          key={p.id}
                          label={p.name}
                          primary={parentProjectId === p.id}
                          onPress={() => {
                            setRestoredTaskProject(undefined);
                            setParentProjectId(p.id);
                            setProjectName(p.details?.projectName ?? p.name);
                          }}
                        />
                      ))}
                    </View>
                    <Input
                      label="任务名称"
                      value={name}
                      onChange={setName}
                      maxLength={120}
                    />
                    <Input
                      label="项目名称"
                      value={projectName}
                      onChange={value => {
                        setRestoredTaskProject(undefined);
                        setProjectName(value);
                      }}
                      maxLength={120}
                    />
                    <Input
                      label="卡号／卷号"
                      value={cardLabel}
                      onChange={value => {
                        setRestoredTaskProject(current =>
                          current
                            ? { ...current, cardLabel: value }
                            : undefined,
                        );
                        setCardLabel(value);
                      }}
                      maxLength={120}
                    />
                    <Input
                      label="本次拷贝备注"
                      value={copyNotes}
                      onChange={value => {
                        setRestoredTaskProject(current =>
                          current
                            ? { ...current, copyNotes: value }
                            : undefined,
                        );
                        setCopyNotes(value);
                      }}
                      multiline
                    />
                  </Card>
                  <Card title="3 · 核对位置与开始">
                    {pickedSource && (
                      <Text selectable style={[s.body, { color: c.ink }]}>
                        读取来源：{rootPosition(pickedSource)}
                      </Text>
                    )}
                    {pickedTargets.map((root, index) => (
                      <Text
                        key={root.id}
                        selectable
                        style={[s.body, { color: c.ink }]}
                      >
                        目标 {index + 1}：{rootPosition(root)}
                      </Text>
                    ))}
                    {!!draftIssue && (
                      <Text
                        accessibilityRole="alert"
                        style={[s.body, { color: c.danger }]}
                      >
                        {draftIssue}
                      </Text>
                    )}
                    <Text style={[s.body, { color: c.muted }]}>校验算法</Text>
                    <View style={s.row}>
                      {HASHES.map(hash => (
                        <Button
                          key={hash}
                          label={hash}
                          primary={algorithm === hash}
                          onPress={() => {
                            setAlgorithm(hash);
                            if (!compatible(format, hash)) setFormat('json');
                          }}
                        />
                      ))}
                    </View>
                    <Text style={[s.body, { color: c.muted }]}>清单格式</Text>
                    <View style={s.row}>
                      {(
                        [
                          'asc-mhl-2.0',
                          'mhl-v1',
                          'csv',
                          'json',
                        ] as ManifestFormat[]
                      ).map(kind => (
                        <Button
                          key={kind}
                          label={kind}
                          primary={format === kind}
                          disabled={!compatible(kind, algorithm)}
                          onPress={() => setFormat(kind)}
                        />
                      ))}
                    </View>
                    <Button
                      label={
                        (location === 'local' ? '在本机' : '在电脑') +
                        (mode === 'copy' ? '开始拷贝' : '开始校验')
                      }
                      primary
                      disabled={!ready}
                      onPress={reviewPositions}
                    />
                  </Card>
                  {location === 'local' && !access && (
                    <Card title="安卓存储访问">
                      <Text style={[s.body, { color: c.muted }]}>
                        独立拷贝需要在系统设置授予“全部文件访问”权限。应用只对你选择的目标目录写入。仅校验和电脑协作可继续使用。
                      </Text>
                      <Button
                        label="设置全部文件访问"
                        disabled={!native}
                        onPress={() =>
                          void action(async () => {
                            await native?.requestStorageAccess();
                            await refresh(true);
                          })
                        }
                      />
                    </Card>
                  )}
                  <Card title="任务概览">
                    <Text style={[s.body, { color: c.ink }]}>
                      {
                        snapshot.jobs.filter(job =>
                          ['queued', 'running', 'paused'].includes(job.state),
                        ).length
                      }{' '}
                      个进行中任务
                    </Text>
                    <Text style={[s.body, { color: c.muted }]}>
                      {location === 'local'
                        ? '本机任务可在通知中查看，系统中断后可恢复。'
                        : '电脑任务在手机断开后仍会继续。'}
                    </Text>
                  </Card>
                </View>
              </View>
            )}
            {screen === 'jobs' && (
              <View style={{ gap: 16 }}>
                <HelpLink
                  label="任务恢复帮助"
                  onPress={() => openHelp('recovery')}
                />
                {taskProjectFilter && (
                  <Card title={'母项目任务 · ' + taskProjectFilter.name}>
                    <Button
                      label="查看全部任务"
                      onPress={() => setTaskProjectFilter(undefined)}
                    />
                  </Card>
                )}
                {snapshot.jobs
                  .filter(
                    job =>
                      !taskProjectFilter ||
                      job.parentProjectId === taskProjectFilter.id,
                  )
                  .map(jobCard)}
                {!snapshot.jobs.some(
                  job =>
                    !taskProjectFilter ||
                    job.parentProjectId === taskProjectFilter.id,
                ) && (
                  <Card title="还没有任务">
                    <Text style={{ color: c.muted }}>
                      在工作台选择来源和目标，开始拷贝或校验。
                    </Text>
                  </Card>
                )}
              </View>
            )}
            {screen === 'projects' && (
              <View style={{ gap: 16 }}>
                <Card
                  title={
                    '母项目 · ' +
                    (location === 'local' ? '手机资料' : desktopName)
                  }
                >
                  <Text style={[s.body, { color: c.muted }]}>
                    选择项目查看关联任务，或打开独立编辑页管理拍摄资料。
                  </Text>
                  <Button label="新建母项目" primary onPress={newProject} />
                  {(editingProject ||
                    JSON.stringify(projectDetails) !==
                      JSON.stringify(emptyDetails())) && (
                    <Button
                      label="继续编辑母项目"
                      onPress={() => setProjectEditorOpen(true)}
                    />
                  )}
                  <HelpLink
                    label="项目帮助"
                    onPress={() => openHelp('projects')}
                  />
                  {location === 'desktop' &&
                    pendingProjectKeys.has('project:new') && (
                      <Button
                        label="恢复未确认项目填写"
                        onPress={() =>
                          void action(() =>
                            restorePendingProject('project:new'),
                          )
                        }
                      />
                    )}
                </Card>
                {snapshot.projects.length === 0 && (
                  <Card title="还没有母项目">
                    <Text style={[s.body, { color: c.muted }]}>
                      点击新建，填写项目名称和拍摄资料。
                    </Text>
                  </Card>
                )}
                {snapshot.projects.map(project => (
                  <Card key={project.id} title={project.name}>
                    <Text style={[s.body, { color: c.muted }]}>
                      {location === 'local'
                        ? '手机项目'
                        : desktopName + '的项目'}{' '}
                      ·{' '}
                      {
                        snapshot.jobs.filter(
                          job => job.parentProjectId === project.id,
                        ).length
                      }{' '}
                      个拷贝任务 · {project.details?.crew.length ?? 0} 位人员 ·{' '}
                      {project.details?.lenses.length ?? 0} 颗镜头
                    </Text>
                    <Button
                      label="查看该项目任务"
                      accessibilityLabel={'查看该项目任务 ' + project.name}
                      onPress={() => {
                        setTaskProjectFilter({
                          id: project.id,
                          name: project.name,
                        });
                        setScreen('jobs');
                      }}
                    />
                    <Button
                      label={'编辑 ' + project.name}
                      onPress={() => requestEditProject(project)}
                    />
                    {location === 'local' &&
                      paired &&
                      pendingProjectKeys.has('copy:' + project.id) && (
                        <Button
                          label={'恢复未确认复制 ' + project.name}
                          onPress={() =>
                            void action(() =>
                              restorePendingProject('copy:' + project.id),
                            )
                          }
                        />
                      )}
                    <Button
                      label={location === 'local' ? '复制到电脑' : '复制到手机'}
                      disabled={location === 'local' && !paired}
                      onPress={() => void action(() => copyProject(project))}
                    />
                  </Card>
                ))}
              </View>
            )}
            {screen === 'reports' && (
              <View style={{ gap: 16 }}>
                <HelpLink
                  label="报告帮助"
                  onPress={() => openHelp('reports')}
                />
                {selectedJob ? (
                  <>
                    <Card title={selectedJob.name}>
                      <Text style={[s.body, { color: c.muted }]}>
                        执行设备：
                        {location === 'local' ? '本机手机' : desktopName}
                      </Text>
                      <Text style={[s.body, { color: c.muted }]}>
                        新增修订 · 不覆盖旧报告
                      </Text>
                      {location === 'local' && (
                        <Button
                          label="生成新报告修订"
                          disabled={!canReport(selectedJob.state)}
                          onPress={() => void action(saveReport)}
                        />
                      )}
                    </Card>
                    {reports.map(report => (
                      <Card
                        key={String(report.revision)}
                        title={'报告 ' + String(report.revision)}
                      >
                        <Text style={{ color: c.muted }}>
                          {report.createdAt}
                        </Text>
                        <View style={s.row}>
                          {report.formats.map(kind => (
                            <Button
                              key={kind}
                              label={'分享 ' + kind.toUpperCase()}
                              disabled={location === 'desktop' && !connected}
                              onPress={() =>
                                void action(async () => {
                                  if (location === 'local' && report.id)
                                    await native?.shareReport(report.id, kind);
                                  else
                                    await native?.sharePeerReport(
                                      '/api/v1/reports/' +
                                        encodeURIComponent(selectedJob.id) +
                                        '/' +
                                        encodeURIComponent(
                                          String(report.revision),
                                        ) +
                                        '/' +
                                        kind,
                                    );
                                })
                              }
                            />
                          ))}
                        </View>
                      </Card>
                    ))}
                  </>
                ) : (
                  snapshot.jobs
                    .filter(job => canReport(job.state))
                    .map(job => (
                      <Card key={job.id} title={job.name}>
                        <Button
                          label={'报告 ' + job.name}
                          onPress={() => void action(() => openReports(job))}
                        />
                      </Card>
                    ))
                )}
              </View>
            )}
            {screen === 'settings' && (
              <View style={{ gap: 16 }}>
                {location === 'local' ? (
                  <LocalSettings
                    settings={settings}
                    runtime={runtime}
                    access={access}
                    onChange={change => {
                      void persistSettings(change).catch(() => {
                        setError('设置未能保存，请重试');
                      });
                    }}
                    onPermission={kind =>
                      void action(async () => {
                        if (kind === 'notifications')
                          await native?.requestNotifications();
                        if (kind === 'battery')
                          await native?.openBatterySettings();
                        if (kind === 'storage') {
                          await native?.requestStorageAccess();
                          await refresh(true);
                        }
                        if (native)
                          setRuntime(decode(await native.runtimeStatus()));
                      })
                    }
                  />
                ) : (
                  <ConnectionSettings
                    themeMode={settings.themeMode}
                    onThemeChange={themeMode => {
                      void persistSettings({ themeMode }).catch(() => {
                        setError('设置未能保存，请重试');
                      });
                    }}
                    manual={manualPairingOpen}
                    onManualChange={setManualPairingOpen}
                    paired={paired}
                    connected={connected}
                    desktopName={desktopName}
                    lastSeen={lastSeen}
                    deviceName={deviceName}
                    onDeviceName={setDeviceName}
                    setup={setup}
                    onSetup={setSetup}
                    error={error || connectionError}
                    onScan={() =>
                      void action(async () => {
                        if (native)
                          setPairCandidate(
                            validateSetup(
                              decode(await native.scanPairingCode()),
                            ),
                          );
                      })
                    }
                    onConnect={() =>
                      void action(async () => {
                        setPairCandidate(validateSetup(decode(setup)));
                      })
                    }
                    onForget={() =>
                      Alert.alert(
                        '解除这台手机的配对？',
                        '手机将停止连接该电脑；电脑任务继续执行。',
                        [
                          { text: '保留配对', style: 'cancel' },
                          {
                            text: '解除配对',
                            style: 'destructive',
                            onPress: () =>
                              void action(async () => {
                                await native?.forgetPeer();
                                resetDesktopCache();
                                setPaired(false);
                                setConnected(false);
                                setDesktopName('配对电脑');
                                await refresh(true);
                              }),
                          },
                        ],
                      )
                    }
                    onRefresh={() => void action(() => refresh(true))}
                    onHelp={() => openHelp('connect')}
                  />
                )}
                <Card title="帮助">
                  <Button label="使用教程" onPress={() => openHelp()} />
                  <Button
                    label="重看首次引导"
                    onPress={() => {
                      setFirstHelp(true);
                      setHelpTopic(undefined);
                      setHelpOpen(true);
                    }}
                  />
                </Card>
                <Card title="关于 SecureReel">
                  <Text style={[s.body, { color: c.muted }]}>
                    v2.0.8 · 安卓内测 · GPL-3.0-only
                  </Text>
                </Card>
              </View>
            )}
          </PageTransition>
        </ScrollView>
        <View
          style={[
            s.nav,
            {
              borderColor: c.line,
              backgroundColor: c.surface,
              paddingBottom: Math.max(8, insets.bottom),
            },
          ]}
        >
          {(
            [
              ['work', '工作台'],
              ['jobs', '任务'],
              ['projects', '项目'],
              ['reports', '报告'],
              ['settings', '设置'],
            ] as [Screen, string][]
          ).map(([key, label]) => (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: screen === key }}
              onPress={() => {
                setTaskProjectFilter(undefined);
                setScreen(key);
              }}
              style={({ pressed }) => [
                s.navItem,
                {
                  backgroundColor: screen === key ? c.bg : c.surface,
                  opacity: pressed ? 0.65 : 1,
                },
              ]}
            >
              <Text
                style={{
                  color: screen === key ? c.accent : c.muted,
                  fontWeight: '600',
                }}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Theme.Provider>
  );
}
export default function App() {
  return (
    <SafeAreaProvider
      initialMetrics={
        initialWindowMetrics ?? {
          frame: { x: 0, y: 0, width: 360, height: 800 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }
      }
    >
      <Workspace />
    </SafeAreaProvider>
  );
}
