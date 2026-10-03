import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CopyJob, CopyJobFile, ProjectInfo, TargetProgress } from '@shared/types'
import { HASH_ALGORITHM_LABELS, MAX_COPY_NOTES_LENGTH, isJobLive } from '@shared/types'
import { describeLenses } from '@shared/project'
import { humanBytes, humanDuration, humanRate, percent } from '@shared/format'
import { frameUrl } from '@shared/frames'
import { Card, Empty, FileStateBadge, JobStateBadge, Meter, Note, Progress } from '../components/ui'
import { SelectBox, type ComboOption } from '../components/ComboBox'
import { unwrap, useAppState } from '../state/AppState'
import { useI18n } from '../i18n'

type Tab = 'files' | 'log' | 'info'

/**
 * 文件表的单行。
 *
 * 单独抽出来并套 `memo` 不是为了好看：一张五千条素材的卡上，中间态事件
 * 每 200ms 就会弄脏几行，若整表一起重渲染，光 React 的 reconciliation
 * 就够让进度卡住。memo 之后只有真正变化的那几行会重画。
 *
 * ⚠️ 前提是 `AppState` 里的 `patchFiles` 只为变化的行新建对象 ——
 * 两处必须一起改：这里 memo 了、那边每行都换引用的话等于白搭。
 */
const FileRow = memo(function FileRow({
  file,
  jobId,
  dash
}: {
  file: CopyJobFile
  jobId: string
  dash: string
}): ReactNode {
  return (
    <tr>
      <td>
        {file.probe?.firstFrame == null ? (
          <span className="faint">—</span>
        ) : (
          <img
            className="thumb"
            src={frameUrl(jobId, file.probe.firstFrame)}
            alt=""
            loading="lazy"
            title={file.probe.note ?? undefined}
          />
        )}
      </td>
      <td className="mono">{file.relPath}</td>
      <td className="num">{humanBytes(file.sizeBytes)}</td>
      <td>
        {file.probe?.format == null ? (
          <span className="faint">—</span>
        ) : (
          <span className="badge">{file.probe.format}</span>
        )}
      </td>
      <td>
        <FileStateBadge state={file.state} />
      </td>
      <td className="mono faint">{file.sourceHash ?? dash}</td>
    </tr>
  )
})

export function QueueView({
  onCreate,
  onReports
}: {
  onCreate: () => void
  onReports: () => void
}): ReactNode {
  const { t } = useI18n()
  const {
    jobs,
    parents,
    progress,
    files,
    logs,
    recovered,
    refreshJobs,
    refreshParents,
    refreshReports,
    loadFiles,
    seedProgress,
    pushToast
  } = useAppState()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('files')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (selectedId === null && jobs.length > 0) {
      setSelectedId(jobs[0]?.id ?? null)
    }
  }, [jobs, selectedId])

  const selected = useMemo(
    () => jobs.find((job) => job.id === selectedId) ?? null,
    [jobs, selectedId]
  )
  const selectedJobId = selected?.id ?? null

  const parentOptions = useMemo<ComboOption<string>[]>(
    () => [
      { value: '', label: t('parent.ungrouped') },
      ...parents.map((project) => ({ value: project.id, label: project.name }))
    ],
    [parents, t]
  )

  /**
   * 选中任务后拉一次文件清单与已落库的进度（事件只推送增量）。
   *
   * ⚠️ 依赖里放的是 **id** 而不是 `selected` 对象。
   * 进度事件会把 `jobs` 换成新数组，`selected` 每次都是新对象引用 ——
   * 用对象当依赖，等于拷贝期间每收到一次进度就重新拉一遍上千行文件清单，
   * 一秒好几次。这是实打实的性能问题，不只是理论上的。
   */
  useEffect(() => {
    if (selectedJobId === null) return
    void loadFiles(selectedJobId, 1500)
    void refreshReports(selectedJobId)
    // 已完成（或重启后重新打开）的任务不会再收到进度事件，
    // 必须主动读一次，否则各目标统计会显示成 0 和「进行中」
    void seedProgress(selectedJobId)
  }, [loadFiles, refreshReports, seedProgress, selectedJobId])

  /* ---------------- 拷贝信息（卡号 / 本次备注 / 归属） ---------------- */

  const [info, setInfo] = useState<ProjectInfo | null>(null)
  const [infoToken, setInfoToken] = useState(0)
  const infoTimer = useRef<number | null>(null)

  useEffect(() => {
    if (selectedJobId === null) {
      setInfo(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const loaded = await unwrap(window.securereel.project.get(selectedJobId))
        if (!cancelled) setInfo(loaded)
      } catch {
        if (!cancelled) setInfo(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedJobId, infoToken])

  const saveInfo = useCallback(
    (patch: Partial<ProjectInfo>) => {
      if (info === null || selectedJobId === null) return
      // 先本地生效，700ms 后再落库
      const next = { ...info, ...patch }
      setInfo(next)
      if (infoTimer.current !== null) window.clearTimeout(infoTimer.current)
      infoTimer.current = window.setTimeout(() => {
        void (async () => {
          try {
            await unwrap(window.securereel.project.save(selectedJobId, next))
          } catch (error) {
            pushToast('error', error instanceof Error ? error.message : String(error))
          }
        })()
      }, 700)
    },
    [info, pushToast, selectedJobId]
  )

  const changeParent = useCallback(
    async (value: string) => {
      if (selectedJobId === null) return
      try {
        await unwrap(window.securereel.jobs.setParent(selectedJobId, value === '' ? null : value))
        await Promise.all([refreshJobs(), refreshParents()])
        // 母项目名快照变了，重新读一次
        setInfoToken((current) => current + 1)
      } catch (error) {
        pushToast('error', error instanceof Error ? error.message : String(error))
      }
    },
    [pushToast, refreshJobs, refreshParents, selectedJobId]
  )

  /**
   * 把任务按母项目分组。
   *
   * 母项目已被删除、但任务还挂着旧 id 的（理论上不该出现）也归到「未分组」，
   * 免得出现一个没有名字的组。
   */
  const groups = useMemo(() => {
    const known = new Set(parents.map((project) => project.id))
    const buckets = new Map<string, CopyJob[]>()
    for (const job of jobs) {
      const key = job.parentProjectId !== null && known.has(job.parentProjectId) ? job.parentProjectId : ''
      const list = buckets.get(key)
      if (list === undefined) buckets.set(key, [job])
      else list.push(job)
    }
    const ordered = parents
      .map((project) => ({ key: project.id, label: project.name, list: buckets.get(project.id) ?? [] }))
      .filter((group) => group.list.length > 0)
    const ungrouped = buckets.get('')
    if (ungrouped !== undefined) {
      ordered.push({ key: '', label: t('parent.ungrouped'), list: ungrouped })
    }
    return ordered
  }, [jobs, parents, t])

  // 只有一个「未分组」时不显示组标题 —— 那是纯噪音
  const showGroupHeaders = groups.length > 1 || (groups[0]?.key ?? '') !== ''

  const jobProgress = selected === null ? undefined : progress[selected.id]

  /**
   * 目标状态徽标。
   *
   * 用显式映射而不是三元表达式链：之前正是"没覆盖到 completed 就掉进 else"，
   * 导致已完成的任务里每个目标都显示「进行中」，和任务状态自相矛盾。
   */
  const targetTone: Record<TargetProgress['state'], string> = {
    pending: '',
    running: 'accent',
    completed: 'ok',
    failed: 'danger',
    disabled: ''
  }
  const targetText: Record<TargetProgress['state'], string> = {
    pending: t('state.queued'),
    running: t('state.running'),
    completed: t('state.completed'),
    failed: t('state.failed'),
    disabled: t('filestate.skipped')
  }

  const jobFiles = useMemo<CopyJobFile[]>(
    () => (selected === null ? [] : (files[selected.id] ?? [])),
    [files, selected]
  )
  const jobLogs = useMemo(
    () => (selected === null ? [] : (logs[selected.id] ?? [])),
    [logs, selected]
  )

  const act = useCallback(
    async (action: 'start' | 'pause' | 'resume' | 'cancel') => {
      if (selected === null) return
      setBusy(true)
      try {
        await unwrap(window.securereel.jobs[action](selected.id))
        await refreshJobs()
      } catch (error) {
        pushToast('error', error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [pushToast, refreshJobs, selected]
  )

  const remove = useCallback(async () => {
    if (selected === null) return
    if (!window.confirm(t('queue.confirmDelete'))) return
    setBusy(true)
    try {
      await unwrap(window.securereel.jobs.remove(selected.id))
      setSelectedId(null)
      await refreshJobs()
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [pushToast, refreshJobs, selected, t])

  const generateReport = useCallback(async () => {
    if (selected === null) return
    // 运行中不许生成报告：会让引擎重做已经处理过的文件（详见
    // JobManager.generateReports 的说明）。按钮也会禁用，这里再挡一道。
    if (isJobLive(selected.state)) {
      pushToast('warn', t('reports.runningBlocked'))
      return
    }
    setBusy(true)
    try {
      await unwrap(window.securereel.reports.regenerate(selected.id))
      await refreshReports(selected.id)
      pushToast('success', t('reports.generated'))
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [pushToast, refreshReports, selected, t])

  const resumeAll = useCallback(async () => {
    for (const job of recovered) {
      try {
        await unwrap(window.securereel.jobs.start(job.id))
      } catch {
        /* 单个失败不阻塞其余 */
      }
    }
    await refreshJobs()
  }, [recovered, refreshJobs])

  return (
    <div className="page">
      <header className="page-head">
        <h2>{t('queue.title')}</h2>
        <p>{t('queue.subtitle')}</p>
      </header>

      {recovered.length > 0 && (
        <Card
          title={t('queue.recovered')}
          hint={t('queue.recoveredHint')}
          actions={
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void resumeAll()}>
              {t('queue.resumeAll')}
            </button>
          }
        >
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {recovered.map((job) => (
                  <tr key={job.id}>
                    <td>{job.name}</td>
                    <td className="mono faint">{job.sourcePath}</td>
                    <td className="num">{job.filesDone} / {job.totalFiles}</td>
                    <td>
                      <JobStateBadge state={job.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {jobs.length === 0 ? (
        <Empty>
          <p>{t('queue.empty')}</p>
          <button type="button" className="btn btn-primary" onClick={onCreate}>
            {t('nav.copy')}
          </button>
        </Empty>
      ) : (
        <>
          <Card>
            <div className="table-wrap scroll-area">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('copy.jobName')}</th>
                    <th>{t('common.status')}</th>
                    <th className="num">{t('common.files')}</th>
                    <th className="num">{t('common.bytes')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <Fragment key={group.key === '' ? '__ungrouped__' : group.key}>
                      {showGroupHeaders && (
                        <tr className="group-row">
                          <td colSpan={5}>
                            {group.label}
                            <span className="faint">
                              {' · '}
                              {group.list.length} {t('parent.jobsSuffix')}
                            </span>
                          </td>
                        </tr>
                      )}
                      {group.list.map((job) => (
                        <tr
                          key={job.id}
                          style={{ cursor: 'pointer' }}
                          onClick={() => setSelectedId(job.id)}
                          aria-selected={job.id === selectedId}
                        >
                          <td>
                            <div>
                              {job.name}
                              {/* 仅校验任务单独标注 —— 否则隔天分不清哪个是复核哪个是拷贝 */}
                              {job.mode === 'verify' && (
                                <span className="badge accent" style={{ marginLeft: 8 }}>
                                  {t('queue.mode.verify')}
                                </span>
                              )}
                            </div>
                            <div className="mono faint">{job.sourcePath}</div>
                          </td>
                          <td>
                            <JobStateBadge state={job.state} />
                          </td>
                          <td className="num">
                            {job.filesDone} / {job.totalFiles}
                            {job.filesFailed > 0 && (
                              <div className="danger" style={{ fontSize: 11 }}>
                                {t('queue.failedCount')} {job.filesFailed}
                              </div>
                            )}
                          </td>
                          <td className="num">{humanBytes(job.bytesDone)}</td>
                          <td className="num">
                            {job.id === selectedId ? <span className="badge accent">●</span> : null}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {selected !== null && (
            <Card
              title={selected.name}
              hint={
                selected.mode === 'verify'
                  ? `${t('queue.mode.verify')} · ${HASH_ALGORITHM_LABELS[selected.hashAlgorithm]}`
                  : `${HASH_ALGORITHM_LABELS[selected.hashAlgorithm]} · ${selected.manifestFormat}`
              }
              actions={
                <>
                  {(selected.state === 'draft' || selected.state === 'cancelled' || selected.state === 'failed') && (
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act('start')}>
                      {t('queue.start')}
                    </button>
                  )}
                  {(selected.state === 'running' || selected.state === 'queued') && (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act('pause')}>
                      {t('queue.pause')}
                    </button>
                  )}
                  {selected.state === 'paused' && (
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act('resume')}>
                      {t('queue.resume')}
                    </button>
                  )}
                  {isJobLive(selected.state) && (
                    <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void act('cancel')}>
                      {t('queue.cancel')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy || isJobLive(selected.state)}
                    title={isJobLive(selected.state) ? t('reports.runningBlocked') : undefined}
                    onClick={() => void generateReport()}
                  >
                    {t('queue.regenReport')}
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={onReports}>
                    {t('nav.reports')}
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost btn-danger" disabled={busy} onClick={() => void remove()}>
                    {t('queue.delete')}
                  </button>
                </>
              }
            >
              {(() => {
                const done = jobProgress?.filesDone ?? selected.filesDone
                const failed = jobProgress?.filesFailed ?? selected.filesFailed
                const bytesDone = jobProgress?.bytesDone ?? selected.bytesDone
                const total = jobProgress?.totalBytes ?? selected.totalBytes
                const pct = percent(bytesDone, total)
                const phase = jobProgress?.phase ?? 'done'
                const active = selected.state === 'running' || selected.state === 'queued'
                // 任务不跑的时候 activeFiles 是陈旧数据，别显示
                const activeFiles = active ? (jobProgress?.activeFiles ?? []) : []
                // 已用时按任务真实的 startedAt 算，而不是从界面挂载算起 ——
                // 切走再切回来，这个数字不能归零
                const elapsedSeconds =
                  selected.startedAt === null
                    ? null
                    : Math.max(0, (Date.now() - Date.parse(selected.startedAt)) / 1000)
                return (
                  <>
                    {active && (
                      <div className="row-actions" style={{ marginBottom: 8 }}>
                        <span className="badge accent">{t(`queue.phase.${phase}` as never)}</span>
                      </div>
                    )}
                    <Progress
                      value={pct}
                      tone={failed > 0 ? 'warn' : undefined}
                    />
                    <Meter
                      items={[
                        { label: t('queue.progress'), value: `${pct.toFixed(1)}%` },
                        { label: t('queue.done'), value: `${done} / ${selected.totalFiles}` },
                        {
                          label: t('queue.failedCount'),
                          value: failed > 0 ? <span className="danger">{failed}</span> : 0
                        },
                        { label: t('common.bytes'), value: `${humanBytes(bytesDone)} / ${humanBytes(total)}` },
                        { label: t('queue.speed'), value: humanRate(jobProgress?.bytesPerSecond ?? null) },
                        { label: t('queue.elapsed'), value: humanDuration(elapsedSeconds) },
                        { label: t('queue.eta'), value: humanDuration(jobProgress?.etaSeconds ?? null) }
                      ]}
                    />

                    {/* 正在处理中的文件。
                        整条进度只回答"还剩多久"，回答不了"现在到底在动没有" ——
                        大文件拷贝期间字节数会长时间不动，没有这一块用户会以为卡死了。
                        串行时通常只有一条，并发时最多等于文件级并发数。 */}
                    {activeFiles.length > 0 && (
                      <div className="active-files">
                        <div className="field-label">{t('queue.activeFiles')}</div>
                        <ul>
                          {activeFiles.map((item) => (
                            <li key={item.relPath}>
                              <span className="mono" title={item.relPath}>
                                {item.relPath}
                              </span>
                              <span className="num faint">
                                {humanBytes(item.bytesRead)} / {humanBytes(item.sizeBytes)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* 素材分析是拷贝之后一段不短的工作，单独给一条进度，
                        否则进度条停在 100% 不动会让人以为程序卡死了 */}
                    {(jobProgress?.analyzeTotal ?? 0) > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div className="field-label">
                          {t('queue.analyze')} — {jobProgress?.analyzeDone ?? 0} / {jobProgress?.analyzeTotal ?? 0}
                        </div>
                        <Progress
                          value={percent(jobProgress?.analyzeDone ?? 0, jobProgress?.analyzeTotal ?? 1)}
                        />
                      </div>
                    )}

                    {selected.degradationNotice !== null && (
                      <Note tone="warn">{selected.degradationNotice}</Note>
                    )}

                    <div style={{ marginTop: 16 }}>
                      <div className="field-label">{t('queue.targets')}</div>
                      <div className="table-wrap">
                        <table className="data">
                          <thead>
                            <tr>
                              <th>{t('common.path')}</th>
                              <th>{t('common.status')}</th>
                              <th className="num">{t('queue.done')}</th>
                              <th className="num">{t('queue.failedCount')}</th>
                              <th className="num">{t('common.bytes')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selected.targets.map((target) => {
                              const live = jobProgress?.targets.find((item) => item.targetId === target.id)
                              return (
                                <tr key={target.id}>
                                  <td>
                                    <div>{target.label}</div>
                                    <div className="mono faint">{target.path}</div>
                                  </td>
                                  <td>
                                    <span className={`badge ${targetTone[live?.state ?? 'pending']}`}>
                                      {targetText[live?.state ?? 'pending']}
                                    </span>
                                    {live?.error != null && (
                                      <div className="danger" style={{ fontSize: 11 }}>
                                        {live.error}
                                      </div>
                                    )}
                                  </td>
                                  <td className="num">{live?.filesDone ?? 0}</td>
                                  <td className="num">{live?.filesFailed ?? 0}</td>
                                  <td className="num">{humanBytes(live?.bytesCopied ?? 0)}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                )
              })()}
            </Card>
          )}

          {selected !== null && (
            <Card
              actions={
                <div className="segmented">
                  <button
                      type="button"
                      data-action="tab-files"
                      aria-pressed={tab === 'files'}
                      onClick={() => setTab('files')}
                    >
                    {t('queue.filesTab')}
                  </button>
                  <button
                      type="button"
                      data-action="tab-log"
                      aria-pressed={tab === 'log'}
                      onClick={() => setTab('log')}
                    >
                    {t('queue.logTab')}
                  </button>
                  <button
                      type="button"
                      data-action="tab-info"
                      aria-pressed={tab === 'info'}
                      onClick={() => setTab('info')}
                    >
                    {t('queue.infoTab')}
                  </button>
                </div>
              }
            >
              {tab === 'files' ? (
                jobFiles.length === 0 ? (
                  <div className="faint">{t('queue.noFiles')}</div>
                ) : (
                  <div className="table-wrap scroll-area">
                    <table className="data">
                      <thead>
                        <tr>
                          <th style={{ width: 96 }}>{t('queue.frames')}</th>
                          <th>{t('common.path')}</th>
                          <th className="num">{t('common.bytes')}</th>
                          <th>{t('queue.format')}</th>
                          <th>{t('common.status')}</th>
                          <th>{t('copy.hashAlgorithm')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {jobFiles.map((file) => (
                          <FileRow key={file.id} file={file} jobId={selected.id} dash={t('common.dash')} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              ) : tab === 'info' ? (
                <div className="info-pane">
                  {/*
                   * 外层不能用 <label>：自研下拉的触发器是个 <button>，
                   * label 会把点击再转发一次给它，等于一点开一关。
                   */}
                  <div className="field">
                    <span className="field-label">{t('queue.assignedParent')}</span>
                    <SelectBox<string>
                      value={selected.parentProjectId ?? ''}
                      ariaLabel={t('queue.assignedParent')}
                      options={parentOptions}
                      onChange={(next) => void changeParent(next)}
                    />
                  </div>

                  {info === null ? (
                    <div className="faint">{t('queue.noProjectInfo')}</div>
                  ) : (
                    <>
                      <div className="grid-2">
                        <label className="field">
                          <span className="field-label">{t('copy.cardLabel')}</span>
                          <input
                            className="input"
                            value={info.cardLabel}
                            onChange={(event) => saveInfo({ cardLabel: event.target.value })}
                          />
                        </label>
                        <label className="field">
                          <span className="field-label">{t('project.projectName')}</span>
                          <input
                            className="input"
                            value={info.projectName}
                            onChange={(event) => saveInfo({ projectName: event.target.value })}
                          />
                        </label>
                      </div>

                      <label className="field">
                        <span className="field-label">{t('copy.copyNotes')}</span>
                        <textarea
                          className="textarea"
                          maxLength={MAX_COPY_NOTES_LENGTH}
                          value={info.copyNotes}
                          onChange={(event) => saveInfo({ copyNotes: event.target.value })}
                        />
                        <span className="hint faint" style={{ fontSize: 11 }}>
                          {t('copy.copyNotesHint')}
                        </span>
                        <div className="counter">
                          {info.copyNotes.length} / {MAX_COPY_NOTES_LENGTH}
                        </div>
                      </label>

                      <Note>{t('queue.snapshotHint')}</Note>

                      <h4 className="sub-title">{t('queue.inherited')}</h4>
                      <table>
                        <tbody>
                          <tr>
                            <th style={{ width: 150 }}>{t('queue.assignedParent')}</th>
                            <td>{info.parentProjectName ?? '—'}</td>
                          </tr>
                          <tr>
                            <th>{t('project.shootDay')}</th>
                            <td>{info.shootDay === '' ? '—' : info.shootDay}</td>
                          </tr>
                          <tr>
                            <th>{t('project.camera')}</th>
                            <td>{info.camera === '' ? '—' : info.camera}</td>
                          </tr>
                          <tr>
                            <th>{t('project.lenses')}</th>
                            <td>{describeLenses(info) === '' ? '—' : describeLenses(info)}</td>
                          </tr>
                          <tr>
                            <th>{t('project.notes')}</th>
                            <td>{info.notes === '' ? '—' : info.notes}</td>
                          </tr>
                        </tbody>
                      </table>

                      <h4 className="sub-title">{t('project.crew')}</h4>
                      {info.crew.length === 0 ? (
                        <div className="faint">{t('common.none')}</div>
                      ) : (
                        <table className="data">
                          <tbody>
                            {info.crew.map((member, index) => (
                              <tr key={`${member.role}-${member.name}-${index}`}>
                                <td>{member.role === '' ? '—' : member.role}</td>
                                <td>{member.name === '' ? '—' : member.name}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </>
                  )}
                </div>
              ) : jobLogs.length === 0 ? (
                <div className="faint">{t('common.none')}</div>
              ) : (
                <div className="log">
                  {jobLogs
                    .slice(-200)
                    .map((entry, index) => (
                      <div key={`${entry.at}-${index}`}>
                        {entry.at.slice(11, 19)} [{entry.level.toUpperCase()}] {entry.message}
                      </div>
                    ))}
                </div>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  )
}
