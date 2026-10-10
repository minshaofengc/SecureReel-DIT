import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CopyJob, CopyJobFile, ProjectInfo, TargetProgress } from '@shared/types'
import { HASH_ALGORITHM_LABELS, MAX_COPY_NOTES_LENGTH, isJobLive } from '@shared/types'
import { describeLenses } from '@shared/project'
import { humanBytes, humanDuration, humanRate, percent } from '@shared/format'
import { frameUrl } from '@shared/frames'
import { FileStateBadge, JobStateBadge, Note, Progress } from '../components/ui'
import { SelectBox, type ComboOption } from '../components/ComboBox'
import { useNav } from '../state/NavState'
import { unwrap, useAppState } from '../state/AppState'
import { useI18n } from '../i18n'

/**
 * 右栏的两个标签。
 *
 * ⚠️ 2026-10-05 之前还有一个 `files` —— 文件明细是这一页**最常看**的东西，
 * 藏在标签里等于每次都要多点一次。现在它常驻中栏，标签只剩"参数"与"日志"。
 */
type Tab = 'info' | 'log'

/** 任务状态 → 左栏圆点的色调。用显式映射，别写三元链（漏一种就静默走 else）。 */
function dotTone(state: string): string {
  if (state === 'running' || state === 'queued') return 'run'
  if (state === 'completed') return 'ok'
  if (state === 'paused' || state === 'completed-with-errors') return 'warn'
  if (state === 'failed') return 'danger'
  return ''
}

/**
 * 把 ISO 时刻格式化成**本机时区**的 HH:MM。
 *
 * 刻意不用 `toISOString()` 取时分秒 —— 那是 UTC，东八区会差 8 小时。
 * 用 `Intl.DateTimeFormat` 让它按本机时区输出，与用户手表上的时间一致。
 */
function formatClockTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date)
}

/**
 * 写入速度波形图。
 *
 * 纯手绘 SVG 折线，不引任何图表库 —— 运行时零依赖是这个项目的硬约束。
 * 只画相对趋势：纵轴按序列自身的最大值归一化，所以两端的绝对高度没有含义，
 * "有没有掉速"才是要看的。低于 8% 的峰谷不放大，避免噪声糊满整块。
 */
function SpeedSparkline({ values }: { values: number[] }): ReactNode {
  const w = 320
  const h = 44
  const max = Math.max(...values, 1)
  const n = values.length
  const step = n > 1 ? w / (n - 1) : w
  const points = values
    .map((v, i) => {
      const x = i * step
      // 保留 4px 上下内边距，速度快时线不贴边
      const y = h - 4 - (v / max) * (h - 8)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg
      className="spark__svg"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="写入速度趋势"
    >
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
    </svg>
  )
}

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
      <td className="w-thumb">
        {file.probe?.firstFrame == null ? (
          <span className="thumb thumb--empty" aria-hidden="true" />
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
        {file.probe?.format == null ? null : <span className="badge">{file.probe.format}</span>}
      </td>
      <td>
        <FileStateBadge state={file.state} />
      </td>
      <td className="mono faint">{file.sourceHash ?? dash}</td>
    </tr>
  )
})

/**
 * 监控 —— 原「任务队列」。
 *
 * 2026-10-05 第五次改（方案 E）**重排为三栏**。此前是"任务表 → 详情 → 文件表"
 * 三块同权重的卡片往下堆，被 boss 评为"特别丑"。病根有两条：
 *
 *   ① **三种不同的信息被排成了同一种东西。** "有哪些任务"是导航、
 *      "这一个在干什么"是内容、"它的参数是什么"是参考 —— 它们不该长得一样。
 *      三栏之后，左窄中宽右窄，权重自己就分出来了。
 *   ② **一半的格子是空值。** 原来的 Meter 固定摆七个数字，
 *      任务没在跑时"速度 0 B/s""预计剩余 —"照样占位置。现在**有值才渲染**：
 *      速度、预计剩余、失败数都是条件项，没有就整格不出现。
 *
 * 配色沿用近黑底（见 tokens.css 的默认皮肤）：面板比底亮一档、
 * 蓝色是唯一强调色、分区靠细线不靠卡片。
 */
export function QueueView(): ReactNode {
  const { t } = useI18n()
  /*
   * 跳转此前是 App 传下来的 `onCreate` / `onReports` 回调，
   * 2026-10-05 改成从导航上下文取（见 state/NavState.tsx）。
   * `focusJobId` 是"从别处跳过来并选中某个任务"的落点。
   */
  const { navigate, focusJobId, clearFocus } = useNav()
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
  const [tab, setTab] = useState<Tab>('info')
  const [busy, setBusy] = useState(false)

  /*
   * 别处跳过来并要求"选中这个任务"（工作台点一条最近任务、
   * 或者点一条待处理）。消费掉就清空 —— 否则用户手动切到别的任务后，
   * 这个 id 还在，下一次任何重渲染都会把它抢回来。
   */
  useEffect(() => {
    if (focusJobId === null) return
    setSelectedId(focusJobId)
    clearFocus()
  }, [focusJobId, clearFocus])

  useEffect(() => {
    if (selectedId === null && jobs.length > 0 && focusJobId === null) {
      setSelectedId(jobs[0]?.id ?? null)
    }
  }, [focusJobId, jobs, selectedId])

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

  /**
   * 重试失败项：只把 failed 的文件放回待处理，已校验通过的目标不重拷。
   *
   * 与「开始」的分工：开始只跑 pending；任务以 completed-with-errors 结束时
   * 失败文件刻意留在失败态，必须走这个入口才能重新处理。
   */
  const retryFailed = useCallback(async () => {
    if (selected === null) return
    setBusy(true)
    try {
      await unwrap(window.securereel.jobs.retryFailed(selected.id))
      await refreshJobs()
      await loadFiles(selected.id, 1500)
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [loadFiles, pushToast, refreshJobs, selected])

  return (
    <div className="page page--monitor">
      <div className="monitor">
        {/* ==================== 左：有哪些任务 ==================== */}
        <aside className="monitor__list">
          <div className="pane-h">
            {t('queue.title')}
            <span className="pane-h__n">{jobs.length}</span>
          </div>
          <div className="monitor__scroll">
            {recovered.length > 0 && (
              <div className="recov">
                <div className="recov__h">
                  <span>{t('queue.recovered')}</span>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => void resumeAll()}
                  >
                    {t('queue.resumeAll')}
                  </button>
                </div>
                {recovered.map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    className="qrow"
                    onClick={() => setSelectedId(job.id)}
                  >
                    <span className="dot" data-tone="warn" aria-hidden="true" />
                    <span className="qrow__id">
                      <span className="qrow__name">{job.name}</span>
                      <span className="qrow__sub">
                        {job.filesDone} / {job.totalFiles}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            {jobs.length === 0 ? (
              <div className="monitor__empty">
                <p className="faint">{t('queue.empty')}</p>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => navigate('copy')}
                >
                  {t('nav.copy')}
                </button>
              </div>
            ) : (
              groups.map((group) => (
                <Fragment key={group.key === '' ? '__ungrouped__' : group.key}>
                  {showGroupHeaders && (
                    <div className="qgroup">
                      {group.label}
                      <span className="faint">
                        {' · '}
                        {group.list.length} {t('parent.jobsSuffix')}
                      </span>
                    </div>
                  )}
                  {group.list.map((job) => (
                    <button
                      key={job.id}
                      type="button"
                      className="qrow"
                      aria-current={job.id === selectedId ? 'true' : undefined}
                      onClick={() => setSelectedId(job.id)}
                    >
                      <span className="dot" data-tone={dotTone(job.state)} aria-hidden="true" />
                      <span className="qrow__id">
                        <span className="qrow__name">
                          {job.name}
                          {job.mode === 'verify' && (
                            <span className="qrow__flag">{t('queue.mode.verify')}</span>
                          )}
                        </span>
                        <span className="qrow__sub">
                          {job.filesDone} / {job.totalFiles} · {humanBytes(job.bytesDone)}
                        </span>
                      </span>
                      <span className="qrow__rt">
                        {job.filesFailed > 0 ? (
                          <span className="badge danger">
                            {t('queue.failedCount')} {job.filesFailed}
                          </span>
                        ) : (
                          <JobStateBadge state={job.state} />
                        )}
                      </span>
                    </button>
                  ))}
                </Fragment>
              ))
            )}
          </div>
        </aside>

        {/* ==================== 中：这一个在干什么 ==================== */}
        <section className="monitor__main">
          {selected === null ? (
            <div className="monitor__empty">
              <p className="faint">{t('queue.pickOne')}</p>
            </div>
          ) : (
            <>
              <header className="mhead">
                <div className="mhead__id">
                  <h2>{selected.name}</h2>
                  <div className="mhead__tags">
                    <span className="tag">
                      {HASH_ALGORITHM_LABELS[selected.hashAlgorithm]}
                    </span>
                    <span className="tag">
                      {selected.mode === 'verify'
                        ? t('queue.mode.verify')
                        : selected.manifestFormat}
                    </span>
                    <JobStateBadge state={selected.state} />
                  </div>
                </div>
                <div className="mhead__acts">
                  {(selected.state === 'draft' ||
                    selected.state === 'cancelled' ||
                    selected.state === 'failed') &&
                    selected.filesFailed === 0 && (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={busy}
                      onClick={() => void act('start')}
                    >
                      {t('queue.start')}
                    </button>
                  )}
                  {!isJobLive(selected.state) && selected.filesFailed > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={busy}
                      title={t('queue.retryFailedHint')}
                      onClick={() => void retryFailed()}
                    >
                      {t('queue.retryFailed')}
                    </button>
                  )}
                  {(selected.state === 'running' || selected.state === 'queued') && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => void act('pause')}
                    >
                      {t('queue.pause')}
                    </button>
                  )}
                  {selected.state === 'paused' && (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={busy}
                      onClick={() => void act('resume')}
                    >
                      {t('queue.resume')}
                    </button>
                  )}
                  {isJobLive(selected.state) && (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busy}
                      onClick={() => void act('cancel')}
                    >
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
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => navigate('reports')}
                  >
                    {t('nav.reports')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost btn-danger"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    {t('queue.delete')}
                  </button>
                </div>
              </header>

              {(() => {
                const done = jobProgress?.filesDone ?? selected.filesDone
                const failed = jobProgress?.filesFailed ?? selected.filesFailed
                const bytesDone = jobProgress?.bytesDone ?? selected.bytesDone
                const total = jobProgress?.totalBytes ?? selected.totalBytes
                /*
                 * 进度条的口径由主进程给（含"每个目标盘重读一遍"的校验工作量），
                 * 界面不再自己按字节拼 —— 自己拼的那一份漏掉校验阶段，
                 * 收尾时会停在接近 100% 一动不动，看起来像卡死。
                 * 没有实时进度时（任务没在跑）退回按字节算，给一个静态值。
                 */
                const pct = jobProgress?.overallPercent ?? percent(bytesDone, total)
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
                const speed = jobProgress?.bytesPerSecond ?? 0
                const avgSpeed = jobProgress?.averageBytesPerSecond ?? 0
                const eta = jobProgress?.etaSeconds ?? null
                const etaFinishAt = jobProgress?.etaFinishAt ?? null
                const speedHistory = jobProgress?.speedHistory ?? []

                return (
                  <>
                    {/*
                     * 进度块。
                     *
                     * ⚠️ 统计列是**条件渲染**的 —— 没在跑就没有速度、没有预计剩余，
                     * 那就整格不出现。旧版固定摆七格，任务跑完后
                     * "0 B/s""—""84 小时 19 分"占了一整行，是这一页看起来
                     * 又空又乱的主要来源。
                     */}
                    <div className="progwrap">
                      <div className="progtop">
                        <div>
                          <div className="lb">
                            {active ? t(`queue.phase.${phase}` as never) : t('queue.progress')}
                          </div>
                          <div className="bigrow">
                            <span className="big">{pct.toFixed(1)}</span>
                            <span className="unit">%</span>
                          </div>
                        </div>
                        <div className="statline">
                          <div className="st">
                            <div className="st__k">{t('queue.done')}</div>
                            <div className="st__v">
                              {done} / {selected.totalFiles}
                            </div>
                          </div>
                          {failed > 0 && (
                            <div className="st">
                              <div className="st__k">{t('queue.failedCount')}</div>
                              <div className="st__v danger">{failed}</div>
                            </div>
                          )}
                          <div className="st">
                            <div className="st__k">{t('common.bytes')}</div>
                            <div className="st__v">{humanBytes(bytesDone)}</div>
                          </div>
                          {active && speed > 0 && (
                            <div className="st">
                              <div className="st__k">{t('queue.speed')}</div>
                              <div className="st__v">{humanRate(speed)}</div>
                            </div>
                          )}
                          {active && avgSpeed > 0 && (
                            <div className="st">
                              <div className="st__k">{t('queue.avgSpeed')}</div>
                              <div className="st__v">{humanRate(avgSpeed)}</div>
                            </div>
                          )}
                          {elapsedSeconds !== null && (
                            <div className="st">
                              <div className="st__k">{t('queue.elapsed')}</div>
                              <div className="st__v">{humanDuration(elapsedSeconds)}</div>
                            </div>
                          )}
                          {active && eta !== null && (
                            <div className="st">
                              <div className="st__k">{t('queue.eta')}</div>
                              <div className="st__v">{humanDuration(eta)}</div>
                            </div>
                          )}
                          {active && etaFinishAt !== null && (
                            <div className="st">
                              <div className="st__k">{t('queue.etaFinishAt')}</div>
                              <div className="st__v">{formatClockTime(etaFinishAt)}</div>
                            </div>
                          )}
                        </div>
                      </div>
                      <Progress value={pct} tone={failed > 0 ? 'warn' : undefined} />
                    </div>

                    {/* 写入速度波形图。
                        单个速度数字看不出"盘是稳定跑还是越跑越慢"，
                        趋势图能一眼看出 I/O 是否健康 —— 对现场判断盘况很有用。 */}
                    {active && speedHistory.length > 2 && (
                      <div className="spark">
                        <div className="sec-h">{t('queue.speedTrend')}</div>
                        <SpeedSparkline values={speedHistory} />
                      </div>
                    )}

                    {/* 正在处理中的文件。
                        整条进度只回答"还剩多久"，回答不了"现在到底在动没有" ——
                        大文件拷贝期间字节数会长时间不动，没有这一块用户会以为卡死了。 */}
                    {activeFiles.length > 0 && (
                      <div className="active-files">
                        <div className="sec-h">{t('queue.activeFiles')}</div>
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
                      <div className="progwrap progwrap--sub">
                        <div className="progtop">
                          <div className="lb">
                            {t('queue.analyze')} — {jobProgress?.analyzeDone ?? 0} /{' '}
                            {jobProgress?.analyzeTotal ?? 0}
                          </div>
                        </div>
                        <Progress
                          value={percent(
                            jobProgress?.analyzeDone ?? 0,
                            jobProgress?.analyzeTotal ?? 1
                          )}
                        />
                      </div>
                    )}

                    {selected.degradationNotice !== null && (
                      <Note tone="warn">{selected.degradationNotice}</Note>
                    )}

                    {/* 各目标：行式 + 细进度条，不用表格。
                        表格在这里是"用四列去装两列的信息" —— 目标数最多 8 个，
                        但每行只有"写了多少 / 多快 / 什么状态"三件事。 */}
                    <div className="sec-h">
                      {t('queue.targets')} · {selected.targets.length}
                    </div>
                    {selected.targets.map((target) => {
                      const live = jobProgress?.targets.find((item) => item.targetId === target.id)
                      const state = live?.state ?? 'pending'
                      return (
                        <div className="tgt" key={target.id}>
                          <div className="tgt__id">
                            <div className="tgt__name">{target.label}</div>
                            <div className="tgt__path mono">{target.path}</div>
                          </div>
                          <div className="tgt__bar">
                            <Progress
                              value={percent(live?.bytesCopied ?? 0, total)}
                              tone={state === 'failed' ? 'danger' : undefined}
                            />
                          </div>
                          <div className="tgt__v">
                            {live?.filesDone ?? 0} / {selected.totalFiles}
                          </div>
                          <div className="tgt__v">{humanBytes(live?.bytesCopied ?? 0)}</div>
                          <span className={`badge ${targetTone[state]}`}>{targetText[state]}</span>
                          {live?.error != null && <div className="tgt__err danger">{live.error}</div>}
                        </div>
                      )
                    })}

                    <div className="sec-h">
                      {t('queue.filesTab')} · {jobFiles.length}
                    </div>
                    {jobFiles.length === 0 ? (
                      <div className="faint">{t('queue.noFiles')}</div>
                    ) : (
                      <div className="table-wrap">
                        <table className="data">
                          <thead>
                            <tr>
                              <th className="w-thumb" />
                              <th>{t('common.path')}</th>
                              <th className="num">{t('common.bytes')}</th>
                              <th>{t('queue.format')}</th>
                              <th>{t('common.status')}</th>
                              <th>{t('copy.hashAlgorithm')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {jobFiles.map((file) => (
                              <FileRow
                                key={file.id}
                                file={file}
                                jobId={selected.id}
                                dash={t('common.dash')}
                              />
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )
              })()}
            </>
          )}
        </section>

        {/* ==================== 右：它的参数是什么 ==================== */}
        <aside className="monitor__meta">
          <div className="pane-h">
            <span className="segmented seg-tight">
              <button
                type="button"
                data-action="tab-info"
                aria-pressed={tab === 'info'}
                onClick={() => setTab('info')}
              >
                {t('queue.infoTab')}
              </button>
              <button
                type="button"
                data-action="tab-log"
                aria-pressed={tab === 'log'}
                onClick={() => setTab('log')}
              >
                {t('queue.logTab')}
              </button>
            </span>
          </div>
          <div className="monitor__scroll">
            {selected === null ? (
              <div className="faint">{t('queue.pickOne')}</div>
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

                    <div className="sec-h">{t('queue.inherited')}</div>
                    <table className="kv">
                      <tbody>
                        <tr>
                          <th>{t('queue.assignedParent')}</th>
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

                    <div className="sec-h">{t('project.crew')}</div>
                    {info.crew.length === 0 ? (
                      <div className="faint">{t('common.none')}</div>
                    ) : (
                      <table className="kv">
                        <tbody>
                          {info.crew.map((member, index) => (
                            <tr key={`${member.role}-${member.name}-${index}`}>
                              <th>{member.role === '' ? '—' : member.role}</th>
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
                {jobLogs.slice(-200).map((entry, index) => (
                  <div key={`${entry.at}-${index}`}>
                    {entry.at.slice(11, 19)} [{entry.level.toUpperCase()}] {entry.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
