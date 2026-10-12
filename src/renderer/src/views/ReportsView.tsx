import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CopyJob, ReportRevision, ReportTheme } from '@shared/types'
import { isJobLive, REPORT_THEMES } from '@shared/types'
import { humanBytes, humanDuration } from '@shared/format'
import { Card, Empty, Field, Note, PageHead } from '../components/ui'
import { SelectBox, type ComboGroup, type ComboOption } from '../components/ComboBox'
import { PAGE_INDEX } from '../nav'
import { unwrap, useAppState } from '../state/AppState'
import { useI18n } from '../i18n'
import { revealLabelKey } from '../platform'

export function ReportsView(): ReactNode {
  const { t } = useI18n()
  const { jobs, parents, reports, refreshReports, pushToast, appInfo, settings, progress } =
    useAppState()
  const [jobId, setJobId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [theme, setTheme] = useState<ReportTheme>(settings.reportTheme)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const previewRequest = useRef(0)
  const [revisionNumber, setRevisionNumber] = useState<string | null>(null)
  useEffect(() => {
    previewRequest.current += 1
    setPreview(null)
    setPreviewBusy(false)
    setRevisionNumber(null)
  }, [jobId])
  useEffect(() => {
    previewRequest.current += 1
    setPreview(null)
    setPreviewBusy(false)
  }, [theme])

  useEffect(() => {
    if (jobId === null && jobs.length > 0) setJobId(jobs[0]?.id ?? null)
  }, [jobId, jobs])

  useEffect(() => {
    if (jobId !== null) void refreshReports(jobId)
  }, [jobId, refreshReports])

  /**
   * 下拉按母项目分组。
   *
   * 原来用的是原生 `<optgroup>`；换成自研下拉之后，分组标题由组件顶替，
   * 这里只负责把任务按母项目分好桶。
   */
  const reportGroups = useMemo<ComboGroup<string>[]>(() => {
    const known = new Set(parents.map((project) => project.id))
    const buckets = new Map<string, CopyJob[]>()
    for (const job of jobs) {
      const key =
        job.parentProjectId !== null && known.has(job.parentProjectId) ? job.parentProjectId : ''
      const bucket = buckets.get(key)
      if (bucket === undefined) buckets.set(key, [job])
      else bucket.push(job)
    }
    const ordered = parents
      .map((project) => ({
        label: project.name,
        options: (buckets.get(project.id) ?? []).map((job) => ({ value: job.id, label: job.name }))
      }))
      .filter((group) => group.options.length > 0)
    const ungrouped = buckets.get('')
    if (ungrouped !== undefined) {
      ordered.push({
        label: t('parent.ungrouped'),
        options: ungrouped.map((job) => ({ value: job.id, label: job.name }))
      })
    }
    return ordered
  }, [jobs, parents, t])

  /**
   * 「请选择任务」不是分组里的东西，它排在最前面，是列表的头部一项。
   * 空值 `''` 在这里是**真值**（表示"还没选"），组件内部一律用显式比较判断。
   */
  const reportHeadOptions = useMemo<ComboOption<string>[]>(
    () => [{ value: '', label: t('reports.selectJob') }],
    [t]
  )

  const list = useMemo<ReportRevision[]>(
    () => (jobId === null ? [] : (reports[jobId] ?? [])),
    [jobId, reports]
  )

  /**
   * 选中的任务是否还在跑。
   *
   * 运行中不许生成报告 —— 报告要通读全部文件行，而任务结束后 JobManager
   * 自己还会再出一份修订；更重要的是这曾经会让引擎重做已经处理过的文件
   * （见 JobManager.generateReports 里的说明）。这里先把按钮禁掉，
   * 让用户一眼看出"现在不行"，而不是点了才弹错误。
   */
  const selectedJob = useMemo(
    () => (jobId === null ? null : (jobs.find((job) => job.id === jobId) ?? null)),
    [jobId, jobs]
  )
  const blocked =
    selectedJob !== null &&
    (isJobLive(selectedJob.state) || progress[selectedJob.id]?.phase === 'reporting')

  const open = useCallback(
    async (path: string | undefined) => {
      if (path === undefined) return
      try {
        await unwrap(window.securereel.reports.open(path))
      } catch (error) {
        pushToast('error', error instanceof Error ? error.message : String(error))
      }
    },
    [pushToast]
  )

  const reveal = useCallback(
    async (path: string) => {
      try {
        await unwrap(window.securereel.reports.reveal(path))
      } catch (error) {
        pushToast('error', error instanceof Error ? error.message : String(error))
      }
    },
    [pushToast]
  )

  const regenerate = useCallback(async () => {
    if (jobId === null) return
    if (blocked) {
      pushToast('warn', t('reports.runningBlocked'))
      return
    }
    setBusy(true)
    try {
      const summary = await unwrap(window.securereel.reports.regenerate(jobId, theme))
      setRevisionNumber(summary.revision)
      await refreshReports(jobId)
      pushToast('success', t('reports.generated'))
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [blocked, jobId, pushToast, refreshReports, t, theme])

  const showPreview = useCallback(async () => {
    if (jobId === null || blocked) return
    const request = ++previewRequest.current
    setPreviewBusy(true)
    try {
      const html = await unwrap(window.securereel.reports.preview(jobId, theme))
      if (request === previewRequest.current) setPreview(html)
    } catch (error) {
      if (request === previewRequest.current)
        pushToast('error', error instanceof Error ? error.message : String(error))
    } finally {
      if (request === previewRequest.current) setPreviewBusy(false)
    }
  }, [blocked, jobId, pushToast, theme])
  const selectedRevision = list.find((revision) => revision.revision === revisionNumber) ?? list[0]

  return (
    <div className="page page--delivery">
      <PageHead
        index={PAGE_INDEX.reports}
        kicker={t('nav.reports')}
        title={t('reports.title')}
        subtitle={t('reports.subtitle')}
      />

      <Card>
        <div className="report-controls">
          <Field label={t('reports.selectJob')}>
            <SelectBox<string>
              value={jobId ?? ''}
              ariaLabel={t('reports.selectJob')}
              options={reportHeadOptions}
              groups={reportGroups}
              onChange={(next) => setJobId(next === '' ? null : next)}
            />
          </Field>
          <Field label={t('workbench.reportTheme')}>
            <SelectBox<ReportTheme>
              value={theme}
              ariaLabel={t('workbench.reportTheme')}
              options={REPORT_THEMES.map((value) => ({
                value,
                label: t(`workbench.theme.${value}`)
              }))}
              onChange={setTheme}
            />
          </Field>
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={previewBusy || jobId === null || blocked}
              onClick={() => void showPreview()}
            >
              {previewBusy ? t('common.loading') : t('workbench.preview')}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || jobId === null || blocked}
              title={blocked ? t('reports.runningBlocked') : undefined}
              onClick={() => void regenerate()}
            >
              {busy ? t('reports.regenerating') : t('reports.regenerate')}
            </button>
          </div>
        </div>
        <Note>{t('reports.immutable')}</Note>
      </Card>

      {blocked && <Note>{t('reports.runningBlocked')}</Note>}
      {preview !== null && (
        <section className="report-preview" aria-label={t('workbench.preview')}>
          <div className="pane-h">
            {t('workbench.preview')} · {t(`workbench.theme.${theme}`)}
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => setPreview(null)}>
              {t('workbench.closePreview')}
            </button>
          </div>
          <iframe
            title={t('workbench.preview')}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={preview}
          />
        </section>
      )}
      <div className="delivery-workbench">
        <aside className="delivery-revisions" aria-label={t('reports.revision')}>
          <div className="pane-h">
            {t('reports.revision')} · {list.length}
          </div>
          {list.map((revision) => (
            <button
              type="button"
              key={revision.revision}
              className="qrow"
              aria-current={selectedRevision?.revision === revision.revision ? 'true' : undefined}
              onClick={() => setRevisionNumber(revision.revision)}
            >
              <span className="qrow__id">
                <span className="qrow__name">{revision.revision}</span>
                <span className="qrow__sub">{new Date(revision.createdAt).toLocaleString()}</span>
              </span>
              <span className="badge">
                {t(`workbench.theme.${revision.theme ?? revision.summary.theme ?? 'delivery'}`)}
              </span>
            </button>
          ))}
        </aside>
        <section className="delivery-detail">
          {jobId === null ? (
            <Empty>{t('reports.selectJob')}</Empty>
          ) : list.length === 0 ? (
            <Empty>{t('reports.empty')}</Empty>
          ) : (
            (selectedRevision === undefined ? [] : [selectedRevision]).map((revision) => (
              <Card
                key={`${revision.jobId}-${revision.revision}`}
                title={`${t('reports.revision')} ${revision.revision}`}
                hint={`${t('reports.createdAt')} ${new Date(revision.createdAt).toLocaleString()}`}
                actions={
                  <>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void open(revision.files.html)}
                    >
                      {t('reports.openHtml')}
                    </button>
                    {revision.files.pdf !== undefined && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void open(revision.files.pdf)}
                      >
                        {t('reports.openPdf')}
                      </button>
                    )}
                    {revision.files.json !== undefined && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void open(revision.files.json)}
                      >
                        {t('reports.openJson')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => void reveal(revision.files.html ?? revision.dir)}
                    >
                      {t(revealLabelKey(appInfo?.platform))}
                    </button>
                  </>
                }
              >
                {revision.summary.failedFiles > 0 && (
                  <Note tone="danger">
                    {t('reports.failed')} {revision.summary.failedFiles} /{' '}
                    {revision.summary.totalFiles}
                  </Note>
                )}

                <div className="meter" style={{ marginTop: 0 }}>
                  <div className="item">
                    <div className="label">{t('common.files')}</div>
                    <div className="value">
                      {revision.summary.verifiedFiles} / {revision.summary.totalFiles}
                    </div>
                  </div>
                  <div className="item">
                    <div className="label">{t('common.bytes')}</div>
                    <div className="value">{humanBytes(revision.summary.totalBytes)}</div>
                  </div>
                  <div className="item">
                    <div className="label">{t('reports.duration')}</div>
                    <div className="value">{humanDuration(revision.summary.durationSeconds)}</div>
                  </div>
                  <div className="item">
                    <div className="label">{t('copy.hashAlgorithm')}</div>
                    <div className="value" style={{ fontSize: 13 }}>
                      {revision.summary.hashAlgorithm}
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 14 }}>
                  <div className="field-label">{t('reports.targetsTable')}</div>
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>{t('common.path')}</th>
                          <th className="num">{t('reports.verified')}</th>
                          <th className="num">{t('reports.failed')}</th>
                          <th className="num">{t('common.bytes')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {revision.summary.targets.map((target) => (
                          <tr key={target.targetId}>
                            <td>
                              <div>{target.label}</div>
                              <div className="mono faint">{target.path}</div>
                            </td>
                            <td className="num">{target.filesCopied}</td>
                            <td className={`num${target.filesFailed > 0 ? ' danger' : ''}`}>
                              {target.filesFailed}
                            </td>
                            <td className="num">{humanBytes(target.bytesCopied)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {revision.delivery !== undefined && (
                  <div className="delivery-status">
                    <div className="field-label">{t('workbench.deliveryStatus')}</div>
                    {revision.delivery.map((target) => (
                      <div key={target.targetId} className="delivery-status__row">
                        <span>{target.label}</span>
                        <span className={`badge ${target.state === 'published' ? 'ok' : 'danger'}`}>
                          {t(
                            target.state === 'published'
                              ? 'workbench.published'
                              : 'workbench.deliveryFailed'
                          )}
                        </span>
                        {target.reason !== undefined && (
                          <span className="hint danger">{target.reason}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="mono faint" style={{ marginTop: 10 }}>
                  {revision.dir}
                </div>
              </Card>
            ))
          )}
        </section>
      </div>
    </div>
  )
}
