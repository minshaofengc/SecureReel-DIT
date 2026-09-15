import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  DriveUsage,
  HashAlgorithm,
  ManifestFormat,
  ParentProject,
  ProjectDraft,
  ScanResult,
  VolumeKind
} from '@shared/types'
import { HASH_ALGORITHMS, HASH_ALGORITHM_LABELS, MANIFEST_FORMATS, MAX_COPY_NOTES_LENGTH } from '@shared/types'
import { humanBytes } from '@shared/format'
import { emptyProjectDraft, normalizeProjectDetails } from '@shared/project'
import { Card, Field, Note, PathPicker, Progress, Toggle } from '../components/ui'
import { SelectBox, type ComboOption } from '../components/ComboBox'
import { ProjectInfoFields } from '../components/ProjectInfoFields'
import { unwrap, useAppState } from '../state/AppState'
import { useI18n } from '../i18n'

/** 下拉里表示「新建母项目」的哨兵值，不会与真实 ID 冲突 */
const NEW_PARENT_VALUE = '__new_parent__'

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
    pushToast
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

  const [parentId, setParentId] = useState<string | null>(null)
  const [newParentOpen, setNewParentOpen] = useState(false)
  const [newParentName, setNewParentName] = useState('')

  const requiredBytes = scan?.totalBytes ?? null

  // 首次进入拷贝页时准备好项目信息草稿。
  // 只做一次：草稿本身存在全局状态里，切页面回来不该被重新覆盖。
  const draftLoaded = useRef(false)
  useEffect(() => {
    if (draftLoaded.current || projectDraft !== null) return
    draftLoaded.current = true
    void (async () => {
      try {
        const template = await unwrap(window.securereel.project.template())
        setProjectDraft(
          template === null
            ? { ...emptyProjectDraft(), shootDay: new Date().toISOString().slice(0, 10) }
            : {
                projectName: template.projectName,
                shootDay: template.shootDay,
                camera: template.camera,
                lenses: template.lenses,
                notes: template.notes,
                crew: template.crew,
                // 卡号与本次备注属于"这一张卡"，绝不沿用上一次
                cardLabel: '',
                copyNotes: ''
              }
        )
      } catch {
        setProjectDraft({ ...emptyProjectDraft(), shootDay: new Date().toISOString().slice(0, 10) })
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

  const applyParentDetails = useCallback(
    (project: ParentProject | null) => {
      if (draft === null) return
      setProjectDraft({
        ...draft,
        ...(project === null ? emptyProjectDraft() : normalizeProjectDetails(project.details)),
        // 卡号与本次备注不受母项目影响
        cardLabel: draft.cardLabel,
        copyNotes: draft.copyNotes
      })
    },
    [draft, setProjectDraft]
  )

  const pickParent = useCallback(
    (value: string) => {
      const next = value === '' ? null : value
      setParentId(next)
      applyParentDetails(parents.find((project) => project.id === next) ?? null)
    },
    [applyParentDetails, parents]
  )

  const createParent = useCallback(async () => {
    const name = newParentName.trim()
    if (name === '') return
    try {
      const created = await unwrap(window.securereel.parents.create(name, emptyProjectDraft()))
      await refreshParents()
      setParentId(created.id)
      setNewParentName('')
      setNewParentOpen(false)
      pushToast('success', t('parent.created'))
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : String(error))
    }
  }, [newParentName, pushToast, refreshParents, t])

  const clearAll = useCallback(() => {
    setParentId(null)
    setProjectDraft({ ...emptyProjectDraft(), shootDay: new Date().toISOString().slice(0, 10) })
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
      setJobName(path.split('/').filter(Boolean).slice(-1)[0] ?? '')
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
      pushToast('warn', '该目标已在列表里。')
      return
    }
    if (targets.length >= 8) {
      pushToast('warn', '最多支持 8 个目标。')
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
    async (start: boolean) => {
      if (sourcePath.trim() === '') {
        pushToast('warn', t('copy.sourcePlaceholder'))
        return
      }
      if (targets.length === 0) {
        pushToast('warn', t('copy.noTarget'))
        return
      }
      setBusy(true)
      try {
        // 项目信息随创建一次带全，不在创建后再补一次保存 ——
        // 那样会多一次 IPC，而且整包覆盖容易把主进程按来源盘推出的卡号冲掉。
        const created = await unwrap(
          window.securereel.jobs.create({
            name: jobName.trim() === '' ? sourcePath.split('/').slice(-1)[0] ?? 'DIT 任务' : jobName.trim(),
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
        setJobName('')
        setSourcePath('')
        setTargets([])
        setScan(null)
        setUsage([])
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
      setProjectDraft,
      settings.hashAlgorithm,
      settings.manifestFormat,
      sourcePath,
      t,
      targets,
      verify,
      verifyOnlyMode
    ]
  )

  const insufficient = useMemo(() => usage.filter((item) => item.sufficient === false), [usage])

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
              pickParent(next)
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

            {scan.kind === 'hde-vfs' && <Note tone="warn">{t('hde.zeroByte')}</Note>}

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
                onClick={() => applyParentDetails(selectedParent)}
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
                有 {insufficient.length} 个目标剩余空间可能不足。写入过程中若目标盘写满，该盘会被单独隔离，
                其余目标仍会继续 —— 但请尽量先腾出空间。
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

      {busy && <Progress value={40} />}
    </div>
  )
}
