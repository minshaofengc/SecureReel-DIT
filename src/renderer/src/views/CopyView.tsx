import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  DriveUsage,
  HashAlgorithm,
  ManifestFormat,
  ProjectDetails,
  ProjectDraft,
  ScanResult,
  VolumeKind
} from '@shared/types'
import { HASH_ALGORITHMS, HASH_ALGORITHM_LABELS, MANIFEST_FORMATS, MAX_COPY_NOTES_LENGTH } from '@shared/types'
import { humanBytes, todayLocalDate } from '@shared/format'
import {
  emptyProjectDetails,
  emptyProjectDraft,
  mergeTalentIntoParent,
  nextAutoShootDay,
  normalizeProjectDetails
} from '@shared/project'
import { Card, Field, Note, PathPicker, Progress, Toggle } from '../components/ui'
import { SelectBox, type ComboOption } from '../components/ComboBox'
import { ProjectInfoFields } from '../components/ProjectInfoFields'
import { unwrap, useAppState } from '../state/AppState'
import { useI18n } from '../i18n'
import { zeroByteNoteKey } from '../platform'

/** 下拉里表示「新建母项目」的哨兵值，不会与真实 ID 冲突 */
const NEW_PARENT_VALUE = '__new_parent__'

/**
 * 取路径的最后一段，用来推默认任务名。
 *
 * 必须 `filter` 掉空段：从文件管理器/终端粘贴的路径常带尾斜杠，
 * `'/Volumes/CARD/'.split('/').slice(-1)[0]` 得到的是**空字符串**而不是 'CARD'，
 * 于是任务名变成空串、创建请求被校验直接拒掉，只弹一句
 * 「请填写任务名称」—— 而用户看到的输入框里本来就是空的，莫名其妙。
 *
 * 两种分隔符都要切：Windows 的路径是 `D:\Cards\A001`，只按 `/` 切会
 * 把整条路径当成任务名（含盘符与反斜杠），既难看又会让落盘目录名走样。
 */
function lastPathSegment(path: string): string | null {
  return path.split(/[/\\]/).filter((part) => part !== '').slice(-1)[0] ?? null
}

/**
 * 上一次**自动**填进「拍摄日」的值。
 *
 * 它只回答一个问题：这个框里现在的内容是程序填的，还是人改过的？
 * 只有"程序填的"才允许被新的日期覆盖 —— 有人故意填昨天的日期去补拷昨天的卡，
 * 那种值绝不能因为过了半夜就被悄悄改掉。
 *
 * 放模块级而不是组件 ref：拷贝页切页时会整个卸载，组件级 ref 跟着丢，
 * 于是"切到别的页跨过午夜、再切回来"就找不回判断依据了。
 * 它不参与任何业务计算，只在这一处判断里用。
 */
let lastAutoShootDay: string | null = null

/** 取这台电脑今天的日期，并记下"这次是程序填的"。 */
function freshShootDay(): string {
  const today = todayLocalDate()
  lastAutoShootDay = today
  return today
}

const KIND_LABEL: Record<VolumeKind, string> = {
  generic: 'copy.type.generic',
  'hde-vfs': 'copy.type.hde-vfs',
  'hde-mxf': 'copy.type.hde-mxf',
  arriraw: 'copy.type.arriraw'
}

export function CopyView({ onCreated }: { onCreated: () => void }): ReactNode {
  const { t } = useI18n()
  const {
    settings,
    updateSettings,
    refreshJobs,
    refreshParents,
    parents,
    projectDraft,
    setProjectDraft,
    pushToast,
    appInfo
  } = useAppState()

  const [jobName, setJobName] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [targets, setTargets] = useState<string[]>([])
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [usage, setUsage] = useState<DriveUsage[]>([])
  const [busy, setBusy] = useState(false)
  const [verify, setVerify] = useState(settings.verifyAfterWrite)
  /** 仅校验模式：选好源和已有拷贝目录后，只比对校验值，不写任何数据 */
  const [verifyOnlyMode, setVerifyOnlyMode] = useState(false)
  /** 用户对"空间可能不足仍要继续"的明确确认（P1 #11：只提醒不拦 → 需明确勾选） */
  const [spaceAck, setSpaceAck] = useState(false)

  const [parentId, setParentId] = useState<string | null>(null)
  const [newParentOpen, setNewParentOpen] = useState(false)
  const [newParentName, setNewParentName] = useState('')

  const requiredBytes = scan?.totalBytes ?? null

  // 首次进入拷贝页时准备好表单。
  // 只做一次：这些状态在切页面回来后不该被重新覆盖。
  const draftLoaded = useRef(false)
  useEffect(() => {
    if (draftLoaded.current || projectDraft !== null) return
    draftLoaded.current = true
    void (async () => {
      /*
       * 两条预填来源各管一摊：
       *   · template  —— "跟着戏走"的项目信息（机型 / 镜头 / 人员）
       *   · lastDraft —— "跟着操作走"的来源、目标与项目名
       * 各自失败也不影响：最差就是一张空表单。
       */
      const [template, lastDraft] = await Promise.all([
        unwrap(window.securereel.project.template()).catch(() => null),
        unwrap(window.securereel.jobs.lastDraft()).catch(() => null)
      ])

      const base =
        template === null
          ? { ...emptyProjectDraft(), shootDay: freshShootDay() }
          : {
              projectName: template.projectName,
              /*
               * 拍摄日**刻意不沿用**上一次填的。
               *
               * 它记的是"上一回拷的那批卡是哪天拍的"，隔天再拷就必然错一天 ——
               * 而且格式完全合法（`2026-9-30`），不报任何错，一路错进报告和清单，
               * 等发现时报告已经发出去了。默认永远是这台电脑今天的日期，要改随手改。
               * 也正因此 `hasSubstance()` 不看这个字段。
               */
              shootDay: freshShootDay(),
              camera: template.camera,
              lenses: template.lenses,
              notes: template.notes,
              crew: template.crew,
              // 卡号与本次备注属于"这一张卡"，绝不沿用上一次 ——
              // 卡号会进报告，填错比空着更糟
              cardLabel: '',
              copyNotes: ''
            }

      setProjectDraft(
        // 上次实际填过的项目名优先：母项目下的任务不会被 template 覆盖到
        lastDraft !== null && lastDraft.projectName !== ''
          ? { ...base, projectName: lastDraft.projectName }
          : base
      )

      if (lastDraft !== null) {
        // 现场常是同一张卡连拷到几块盘，每次都重新选一遍路径纯属浪费。
        // 目标盘列表也一并带回来 —— 这是最省事的一步。
        setSourcePath(lastDraft.sourcePath)
        setTargets(lastDraft.targetPaths)
      }
    })()
  }, [projectDraft, setProjectDraft])

  const draft = projectDraft
  const selectedParent = parents.find((project) => project.id === parentId) ?? null

  const patchDraft = useCallback(
    (patch: Partial<ProjectDraft>) => {
      if (draft === null) return
      setProjectDraft({ ...draft, ...patch })
    },
    [draft, setProjectDraft]
  )

  /**
   * 把母项目的项目信息带进表单。
   *
   * 传进来的 `details` 来自主进程的 `parents.recall()`：**档案里空着的职员与镜头，
   * 会从该母项目名下历史任务的快照里补回来**。旧版本只把内容存进任务、不写回档案，
   * 不补的话切到母项目会看到一份空档案，用户会以为从前填的丢了。
   *
   * 拍摄日**不跟随母项目**：它是"这一次拷的卡是哪天拍的"，每次重置为当天。
   */
  const applyParentDetails = useCallback(
    (parentDetails: ProjectDetails | null) => {
      if (draft === null) return
      setProjectDraft({
        ...draft,
        ...(parentDetails === null ? emptyProjectDraft() : parentDetails),
        shootDay: freshShootDay(),
        // 卡号与本次备注不受母项目影响
        cardLabel: draft.cardLabel,
        copyNotes: draft.copyNotes
      })
    },
    [draft, setProjectDraft]
  )

  const pickParent = useCallback(
    async (value: string) => {
      const next = value === '' ? null : value
      setParentId(next)
      if (next === null) {
        applyParentDetails(null)
        return
      }
      try {
        applyParentDetails(await unwrap(window.securereel.parents.recall(next)))
      } catch (error) {
        // 回捞失败退回档案本身：取不到历史不该挡住选母项目这件正事
        const fallback = parents.find((project) => project.id === next)
        applyParentDetails(fallback === undefined ? null : normalizeProjectDetails(fallback.details))
        pushToast('warn', error instanceof Error ? error.message : String(error))
      }
    },
    [applyParentDetails, parents, pushToast]
  )

  const createParent = useCallback(async () => {
    const name = newParentName.trim()
    if (name === '') return
    try {
      const created = await unwrap(
        window.securereel.parents.create(name, {
          ...emptyProjectDetails(),
          // 把刚填好的职员与镜头一起带进新母项目：现场常常是先填了才想起建档，
          // 建完还要再填一遍纯属折腾。
          ...(draft === null ? {} : { lenses: draft.lenses, crew: draft.crew })
        })
      )
      await refreshParents()
      setParentId(created.id)
      setNewParentName('')
      setNewParentOpen(false)
      pushToast('success', t('parent.created'))
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : String(error))
    }
  }, [draft, newParentName, pushToast, refreshParents, t])

  const clearAll = useCallback(() => {
    setParentId(null)
    setProjectDraft({ ...emptyProjectDraft(), shootDay: freshShootDay() })
  }, [setProjectDraft])

  /*
   * 开着软件跨过午夜时，把「拍摄日」跟上电脑的日期。
   *
   * 为什么需要它：日期是在**进拷贝页那一刻**填好的。现场很常见的是
   * "晚上把软件打开放那儿不动，凌晨/第二天接着拷" —— 那时框里还停在前一天，
   * 谁也不会想到去改它，于是整批卡的拍摄日默默错一天，格式还完全合法。
   *
   * 只改**程序填的值**：`lastAutoShootDay` 对得上才动。有人故意填昨天的日期
   * 去补拷昨天的卡，那种值必须原样留着。
   *
   * 三个触发点缺一不可：挂载时（切页面回来）、窗口重新获得焦点（盖着盖子打开）、
   * 以及每分钟一次（一直开着不动的机器）。拷贝是长跑，中途没人会去点窗口。
   */
  useEffect(() => {
    const syncShootDay = (): void => {
      const today = todayLocalDate()
      const previous = lastAutoShootDay
      if (previous === null || today === previous) return
      /*
       * 先记账再改表单。`setProjectDraft` 的更新函数必须是纯的（React 可能调用两次），
       * 所以"这次是程序填的"这个记录只能写在外面。
       *
       * 即使最终没改表单也要记账：那说明用户手动填过日期了，不该再每分钟去撞他的输入。
       */
      lastAutoShootDay = today
      setProjectDraft((current) => {
        if (current === null) return current
        const next = nextAutoShootDay(current.shootDay, previous, today)
        return next === null ? current : { ...current, shootDay: next }
      })
    }

    syncShootDay()
    const timer = window.setInterval(syncShootDay, 60_000)
    window.addEventListener('focus', syncShootDay)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', syncShootDay)
    }
  }, [setProjectDraft])

  const refreshUsage = useCallback(
    async (paths: string[], required: number | null) => {
      if (paths.length === 0) {
        setUsage([])
        return
      }
      try {
        const result = await window.securereel.volumes.usage(paths)
        if (result.ok) {
          setUsage(
            result.data.map((item) => ({ ...item, requiredBytes: required, sufficient: required === null ? null : item.freeBytes >= required }))
          )
        }
      } catch {
        setUsage([])
      }
    },
    []
  )

  const pickSource = useCallback(async () => {
    const picked = await window.securereel.volumes.pickPath('directory', t('copy.pickSource'))
    if (!picked.ok || picked.data === null) return
    const path = picked.data
    setSourcePath(path)
    if (jobName.trim() === '') {
      const derived = lastPathSegment(path)
      if (derived !== null) setJobName(derived)
    }
    setScanning(true)
    try {
      const result = await unwrap(window.securereel.volumes.scan(path))
      setScan(result)
      await refreshUsage(targets, result.totalBytes)
      if (result.warnings.length > 0) {
        pushToast('warn', result.warnings[0] as string)
      }
    } catch (error) {
      setScan(null)
      pushToast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setScanning(false)
    }
  }, [jobName, pushToast, refreshUsage, t, targets])

  const addTarget = useCallback(async () => {
    const picked = await window.securereel.volumes.pickPath('directory', t('copy.pickTargetTitle'))
    if (!picked.ok || picked.data === null) return
    const path = picked.data
    if (targets.includes(path)) {
      pushToast('warn', t('copy.targetDuplicate'))
      return
    }
    if (targets.length >= 8) {
      pushToast('warn', t('copy.targetLimit', { count: 8 }))
      return
    }
    const next = [...targets, path]
    setTargets(next)
    await refreshUsage(next, requiredBytes)
  }, [pushToast, refreshUsage, requiredBytes, t, targets])

  const removeTarget = useCallback(
    async (path: string) => {
      const next = targets.filter((item) => item !== path)
      setTargets(next)
      await refreshUsage(next, requiredBytes)
    },
    [refreshUsage, requiredBytes, targets]
  )

  const submit = useCallback(
    async (start: boolean) => {      if (sourcePath.trim() === '') {
        pushToast('warn', t('copy.sourcePlaceholder'))
        return
      }
      if (targets.length === 0) {
        pushToast('warn', t('copy.noTarget'))
        return
      }
      // 空间不足不再"只提醒不拦"：必须明确勾选确认才能带着已知风险开跑
      const hasInsufficient = usage.some((item) => item.sufficient === false)
      if (!verifyOnlyMode && hasInsufficient && !spaceAck) {
        pushToast('warn', t('copy.spaceAckRequired'))
        return
      }
      /*
       * 预判主进程接下来会不会真的把职员与镜头写进母项目。
       *
       * 用的是与主进程同一个纯函数，两边判断一致。只在"填了、而且和档案里不一样"
       * 时才成立 —— 没变化还弹一句"已记入"是空话，用户下次就不会信这个提示了。
       */
      const willRememberTalent =
        draft !== null &&
        selectedParent !== null &&
        mergeTalentIntoParent(normalizeProjectDetails(selectedParent.details), {
          lenses: draft.lenses,
          crew: draft.crew
        }).changed
      setBusy(true)
      try {
        // 项目信息随创建一次带全，不在创建后再补一次保存 ——
        // 那样会多一次 IPC，而且整包覆盖容易把主进程按来源盘推出的卡号冲掉。
        const created = await unwrap(
          window.securereel.jobs.create({
            name:
              jobName.trim() === ''
                ? (lastPathSegment(sourcePath) ?? t('copy.defaultJobName'))
                : jobName.trim(),
            sourcePath,
            targets: targets.map((path) => ({ path })),
            mode: verifyOnlyMode ? 'verify' : 'copy',
            hashAlgorithm: settings.hashAlgorithm,
            manifestFormat: settings.manifestFormat,
            verifyAfterWrite: verify,
            parentProjectId: parentId,
            ...(draft === null ? {} : { project: draft })
          })
        )
        if (start) {
          await unwrap(window.securereel.jobs.start(created.job.id))
        }
        await refreshJobs()
        pushToast('success', t('copy.created'))
        // 主进程会在创建任务时把职员与镜头记进母项目档案，这里把列表拉回来同步。
        if (parentId !== null) await refreshParents()
        // 只有真的会记进去才提示，避免"什么都没变却说已保存"的空话
        if (willRememberTalent && selectedParent !== null) {
          pushToast('info', t('copy.talentRemembered', { name: selectedParent.name }))
        }
        setJobName('')
        setSourcePath('')
        setTargets([])
        setScan(null)
        setUsage([])
        setSpaceAck(false)
        // 母项目选择与项目信息草稿都清掉：下一张卡重新开始，
        // 未分组时下一次会自动沿用这次填的内容（由主进程挑最近一条）。
        setParentId(null)
        setProjectDraft(null)
        onCreated()
      } catch (error) {
        pushToast('error', error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [
      draft,
      jobName,
      onCreated,
      parentId,
      pushToast,
      refreshJobs,
      refreshParents,
      selectedParent,
      setProjectDraft,
      settings.hashAlgorithm,
      settings.manifestFormat,
      sourcePath,
      spaceAck,
      usage,
      t,
      targets,
      verify,
      verifyOnlyMode
    ]
  )

  const insufficient = useMemo(() => usage.filter((item) => item.sufficient === false), [usage])

  // 目标或扫描结果一变，之前的"空间不足我知晓"确认就作废 —— 必须重新确认
  useEffect(() => {
    setSpaceAck(false)
  }, [usage])

  /*
   * 母项目下拉的选项。
   *
   * 最后那一项「+ 新建母项目…」是**哨兵值**：它看起来是个选项，其实不是值 ——
   * 选中它只会打开下面的新建输入行，parentId 一点都不变。所以给它 tone: 'action'，
   * 渲染成带分隔线、用辅色的一行，和真实母项目分开。
   * 它必须留在列表末尾（原生 <select> 里也是这个位置）。
   */
  const parentOptions = useMemo<ComboOption<string>[]>(
    () => [
      { value: '', label: t('copy.parentNone') },
      ...parents.map((project) => ({ value: project.id, label: project.name })),
      { value: NEW_PARENT_VALUE, label: t('copy.parentCreate'), tone: 'action' }
    ],
    [parents, t]
  )

  const manifestOptions = useMemo<ComboOption<ManifestFormat>[]>(
    () =>
      MANIFEST_FORMATS.map((format) => ({
        value: format,
        label: t(format === 'asc-mhl-2.0' ? 'manifest.asc-mhl-2.0' : 'manifest.mhl-v1')
      })),
    [t]
  )

  return (
    <div className="page">
      <header className="page-head">
        <h2>{t('copy.title')}</h2>
        <p>{t('copy.subtitle')}</p>
      </header>

      <Card title={t('copy.parentSection')} hint={t('copy.parentHintTitle')}>
        <div className="path-row">
          <SelectBox<string>
            value={parentId ?? ''}
            disabled={busy}
            ariaLabel={t('copy.parentSection')}
            options={parentOptions}
            onChange={(next) => {
              if (next === NEW_PARENT_VALUE) {
                setNewParentOpen(true)
                return
              }
              void pickParent(next)
            }}
          />
        </div>

        {newParentOpen && (
          <div className="path-row" style={{ marginTop: 10 }}>
            <input
              className="input"
              autoFocus
              value={newParentName}
              placeholder={t('copy.parentNamePlaceholder')}
              onChange={(event) => setNewParentName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void createParent()
                if (event.key === 'Escape') {
                  setNewParentOpen(false)
                  setNewParentName('')
                }
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={newParentName.trim() === ''}
              onClick={() => void createParent()}
            >
              {t('copy.parentCreateConfirm')}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setNewParentOpen(false)
                setNewParentName('')
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        )}

        <div className="hint faint" style={{ marginTop: 10 }}>
          {selectedParent === null
            ? t('copy.parentHintUnassigned')
            : `${t('copy.parentHintAssigned')}${selectedParent.name}`}
        </div>
      </Card>

      <Card title={t('copy.modeTitle')}>
        <label className="row-actions" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={verifyOnlyMode}
            onChange={(event) => setVerifyOnlyMode(event.target.checked)}
          />
          <span>{t('copy.verifyOnly')}</span>
        </label>
        <div className="hint faint" style={{ marginTop: 8 }}>
          {t('copy.verifyOnlyHint')}
        </div>
      </Card>

      <Card title={t('copy.source')}>
        <Field label={t('copy.jobName')}>
          <input
            className="input"
            value={jobName}
            placeholder={t('copy.jobNamePlaceholder')}
            onChange={(event) => setJobName(event.target.value)}
          />
        </Field>
        <PathPicker
          value={sourcePath}
          placeholder={t('copy.sourcePlaceholder')}
          buttonLabel={t('copy.pickSource')}
          onPick={() => void pickSource()}
          onChange={setSourcePath}
          disabled={scanning || busy}
        />

        {scanning && <Note>{t('copy.scanning')}</Note>}

        {scan !== null && (
          <>
            <div className="grid-2" style={{ marginTop: 14 }}>
              <div>
                <div className="field-label">{t('copy.fileCount')}</div>
                <div style={{ fontSize: 17 }}>{scan.fileCount}</div>
              </div>
              <div>
                <div className="field-label">{t('copy.totalSize')}</div>
                <div style={{ fontSize: 17 }}>{humanBytes(scan.totalBytes)}</div>
              </div>
              <div>
                <div className="field-label">{t('copy.kind')}</div>
                <div>
                  <span className="badge accent">{t(KIND_LABEL[scan.kind] as never)}</span>
                </div>
              </div>
            </div>

            {scan.kind === 'hde-vfs' && <Note tone="warn">{t(zeroByteNoteKey(appInfo?.platform))}</Note>}

            {scan.warnings.length > 0 && (
              <Note tone="warn">
                <strong>{t('copy.scanWarnings')}</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {scan.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </Note>
            )}

            {scan.preview.length > 0 && (
              <details style={{ marginTop: 10 }}>
                <summary className="field-label" style={{ cursor: 'pointer' }}>
                  {t('copy.biggestFiles')}
                </summary>
                <div className="table-wrap" style={{ marginTop: 8 }}>
                  <table className="data">
                    <tbody>
                      {scan.preview.slice(0, 12).map((file) => (
                        <tr key={file.relPath}>
                          <td className="mono">{file.relPath}</td>
                          <td className="num">{humanBytes(file.sizeBytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </>
        )}
      </Card>

      <Card
        title={t('copy.projectInfo')}
        hint={t('copy.projectHint')}
        actions={
          <>
            {selectedParent !== null && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || draft === null}
                onClick={() => void pickParent(selectedParent.id)}
              >
                {t('copy.resetToParent')}
              </button>
            )}
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={clearAll}>
              {t('common.clear')}
            </button>
          </>
        }
      >
        {selectedParent !== null && (
          <Note>
            {t('copy.inheritedFrom')}
            {selectedParent.name} · {t('copy.inheritedHint')}
          </Note>
        )}

        {draft === null ? (
          <div className="faint">{t('common.loading')}</div>
        ) : (
          <>
            <ProjectInfoFields
              value={draft}
              disabled={busy}
              sections={['basic', 'lenses', 'crew', 'notes']}
              onChange={(next) => patchDraft(next)}
            />

            <div className="sub-block">
              <label className="field">
                <span className="field-label">{t('copy.cardLabel')}</span>
                <input
                  className="input"
                  value={draft.cardLabel}
                  disabled={busy}
                  placeholder={t('copy.cardLabelAuto')}
                  onChange={(event) => patchDraft({ cardLabel: event.target.value })}
                />
                <span className="hint faint" style={{ fontSize: 11 }}>
                  {t('copy.cardLabelAuto')}
                </span>
              </label>

              <label className="field">
                <span className="field-label">{t('copy.copyNotes')}</span>
                <textarea
                  className="textarea"
                  value={draft.copyNotes}
                  disabled={busy}
                  maxLength={MAX_COPY_NOTES_LENGTH}
                  onChange={(event) => patchDraft({ copyNotes: event.target.value })}
                />
                <span className="hint faint" style={{ fontSize: 11 }}>
                  {t('copy.copyNotesHint')}
                </span>
                <div className="counter">
                  {draft.copyNotes.length} / {MAX_COPY_NOTES_LENGTH}
                </div>
              </label>
            </div>
          </>
        )}
      </Card>

      <Card
        title={t('copy.targets')}
        hint={`${targets.length} / 8`}
        actions={
          <button type="button" className="btn btn-sm" onClick={() => void addTarget()} disabled={busy}>
            + {t('copy.addTarget')}
          </button>
        }
      >
        {targets.length === 0 ? (
          <div className="faint">{t('copy.noTarget')}</div>
        ) : (
          <div className="target-list">
            {targets.map((path, index) => {
              const info = usage.find((item) => item.path === path)
              return (
                <div className="target-item" key={path}>
                  <span className="badge">{index + 1}</span>
                  <span className="target-path" title={path}>
                    {path}
                  </span>
                  {info !== undefined && (
                    <span className={`badge ${info.sufficient === false ? 'danger' : 'ok'}`}>
                      {info.sufficient === false
                        ? `${t('copy.insufficient')} · ${humanBytes(info.freeBytes)}`
                        : `${t('copy.free')} ${humanBytes(info.freeBytes)}`}
                    </span>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => void removeTarget(path)}
                    disabled={busy}
                  >
                    {t('common.remove')}
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {requiredBytes !== null && targets.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="field-label">
              {t('copy.required')} {humanBytes(requiredBytes)}
            </div>
            {insufficient.length > 0 && (
              <Note tone="danger">
                {t('copy.insufficientNotice', { count: insufficient.length })}
                <label className="row-actions" style={{ cursor: 'pointer', marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={spaceAck}
                    onChange={(event) => setSpaceAck(event.target.checked)}
                  />
                  <span>{t('copy.spaceAck')}</span>
                </label>
              </Note>
            )}
          </div>
        )}
      </Card>

      <Card title={t('copy.advanced')}>
        <Field label={t('copy.hashAlgorithm')}>
          <SelectBox<HashAlgorithm>
            value={settings.hashAlgorithm}
            ariaLabel={t('copy.hashAlgorithm')}
            options={HASH_ALGORITHMS.map((algorithm) => ({
              value: algorithm,
              label: HASH_ALGORITHM_LABELS[algorithm]
            }))}
            onChange={(next) => void updateSettings({ hashAlgorithm: next })}
          />
        </Field>

        <Field label={t('copy.manifestFormat')}>
          <SelectBox<ManifestFormat>
            value={settings.manifestFormat}
            ariaLabel={t('copy.manifestFormat')}
            options={manifestOptions}
            onChange={(next) => void updateSettings({ manifestFormat: next })}
          />
        </Field>

        <Toggle checked={verify} onChange={setVerify} label={t('copy.verifyAfterWrite')} />
        <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
          {t('copy.verifyHint')}
        </div>
        {!verify && <Note tone="warn">{t('copy.verifyHint')}</Note>}
      </Card>

      <div className="row-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || scanning}
          onClick={() => void submit(true)}
        >
          {t('copy.createAndStart')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || scanning}
          onClick={() => void submit(false)}
        >
          {t('copy.createOnly')}
        </button>
        <span className="faint" style={{ fontSize: 12 }}>
          {t('copy.willStartHint')}
        </span>
      </div>

      {/*
        这里曾经是 <Progress value={40} />。
        创建任务时要先把源盘扫一遍统计文件数与总字节，一张满卡可能是好几分钟 ——
        那是一段**时长完全未知**的工作，画一个固定 40% 的条等于谎报进度：
        它一动不动地挂在那儿，反而让人以为程序卡死了。
        改成不定态（来回走的条）+ 一句说明，只表达"在动、还没完"。
      */}
      {busy && (
        <div>
          <Progress indeterminate />
          <span className="hint faint">{t('copy.creating')}</span>
        </div>
      )}
    </div>
  )
}
