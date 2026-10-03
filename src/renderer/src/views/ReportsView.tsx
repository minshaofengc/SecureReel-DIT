import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { CopyJob, ReportRevision } from '@shared/types'
import { isJobLive } from '@shared/types'
import { humanBytes, humanDuration } from '@shared/format'
import { Card, Empty, Note } from '../components/ui'
import { SelectBox, type ComboGroup, type ComboOption } from '../components/ComboBox'
import { unwrap, useAppState } from '../state/AppState'
import { useI18n } from '../i18n'
import { revealLabelKey } from '../platform'

export function ReportsView(): ReactNode {
  const { t } = useI18n()
  const { jobs, parents, reports, refreshReports, pushToast, appInfo } = useAppState()
  const [jobId, setJobId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
      const key = job.parentProjectId !== null && known.has(job.parentProjectId) ? job.parentProjectId : ''
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
  const blocked = selectedJob !== null && isJobLive(selectedJob.state)

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
      await unwrap(window.securereel.reports.regenerate(jobId))
      await refreshReports(jobId)
      pushToast('success', t('reports.generated'))
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [blocked, jobId, pushToast, refreshReports, t])

  return (
    <div className="page">
      <header className="page-head">
        <h2>{t('reports.title')}</h2>
        <p>{t('reports.subtitle')}</p>
      </header>

      <Card
        actions={
          <>
            <SelectBox<string>
              value={jobId ?? ''}
              ariaLabel={t('reports.selectJob')}
              style={{ width: 280 }}
              options={reportHeadOptions}
              groups={reportGroups}
              onChange={(next) => setJobId(next === '' ? null : next)}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || jobId === null || blocked}
              title={blocked ? t('reports.runningBlocked') : undefined}
              onClick={() => void regenerate()}
            >
              {busy ? t('reports.regenerating') : t('reports.regenerate')}
            </button>
          </>
        }
      >
        <Note>{t('reports.immutable')}</Note>
      </Card>

      {jobId === null ? (
        <Empty>{t('reports.selectJob')}</Empty>
      ) : list.length === 0 ? (
        <Empty>{t('reports.empty')}</Empty>
      ) : (
        list.map((revision) => (
          <Card
            key={`${revision.jobId}-${revision.revision}`}
            title={`${t('reports.revision')} ${revision.revision}`}
            hint={`${t('reports.createdAt')} ${revision.createdAt.replace('T', ' ').slice(0, 19)}`}
            actions={
              <>
                <button type="button" className="btn btn-sm" onClick={() => void open(revision.files.html)}>
                  {t('reports.openHtml')}
                </button>
                {revision.files.pdf !== undefined && (
                  <button type="button" className="btn btn-sm" onClick={() => void open(revision.files.pdf)}>
                    {t('reports.openPdf')}
                  </button>
                )}
                {revision.files.json !== undefined && (
                  <button type="button" className="btn btn-sm" onClick={() => void open(revision.files.json)}>
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
                {t('reports.failed')} {revision.summary.failedFiles} / {revision.summary.totalFiles}
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

            <div className="mono faint" style={{ marginTop: 10 }}>
              {revision.dir}
            </div>
          </Card>
        ))
      )}
    </div>
  )
}
