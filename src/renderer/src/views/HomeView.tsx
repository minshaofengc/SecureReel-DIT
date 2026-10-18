
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { SourceDrive } from '@shared/types'
import { humanBytes, humanDuration, humanRate } from '@shared/format'
import { unwrap, useAppState } from '../state/AppState'
import { useNav } from '../state/NavState'
import { useI18n } from '../i18n'
import { JobStateBadge, Progress } from '../components/ui'
import { destinationOutcome, classifyJobIssue } from '@shared/target-verification'

/**
 * 2.0.8 P0: 作业控制台。所有任务、校验进度来自主进程。
 * 设备只做只读枚举；“可见”不是“可写/预检已通过”。
 */
/**
 * Only prioritizes plausible workspace mounts. This is NOT a removable-media
 * or hardware-health classifier: path conventions are only presentation hints.
 */
function likelyWorkspaceMount(path: string, label: string): boolean {
  const p = path.replace(/\\/g, '/').toLowerCase()
  const n = label.toLowerCase()
  if (p.startsWith('/volumes/')) {
    return !/(recovery|macintosh hd|preboot|vm|com\.apple|secure.?reel|installer|install)/i.test(p + ' ' + n)
  }
  if (/^[d-z]:\//.test(p)) return true
  return false
}

export function HomeView(): ReactNode {
  const { t } = useI18n()
  const { jobs, progress, recovered, parents } = useAppState()
  const { navigate, focusJob } = useNav()
  const [volumes, setVolumes] = useState<SourceDrive[] | null>(null)
  const [volumeError, setVolumeError] = useState(false)
  const [volumeBusy, setVolumeBusy] = useState(false)

  const refreshVolumes = useCallback(async (): Promise<void> => {
    setVolumeBusy(true)
    try {
      const discovered = await unwrap(window.securereel.volumes.list())
      setVolumes(discovered)
      setVolumeError(false)
    } catch {
      setVolumeError(true)
    } finally {
      setVolumeBusy(false)
    }
  }, [])

  useEffect(() => {
    void refreshVolumes()
  }, [refreshVolumes])

  const active = jobs.filter((j) => j.state === 'running' || j.state === 'queued')
  const lead = active.find((j) => j.state === 'running') ?? active[0] ?? null
  const problems = [
    ...recovered,
    ...jobs.filter(
      (j) =>
        (j.state === 'failed' || j.state === 'completed-with-errors') &&
        !recovered.some((r) => r.id === j.id)
    )
  ]
  const issue = problems[0] ?? null
  const candidateVolumes = (volumes ?? []).filter((volume) => likelyWorkspaceMount(volume.path, volume.label))
  const otherVolumes = (volumes ?? []).filter((volume) => !likelyWorkspaceMount(volume.path, volume.label))
  const issueKind = issue === null ? null : classifyJobIssue(
    issue.state, issue.filesFailed, progress[issue.id]?.proxy?.failed ?? null
  )
  const live = lead === null ? undefined : progress[lead.id]
  const recent = jobs.slice(0, 9)
  const mode: 'issue' | 'active' | 'idle' = lead ? 'active' : issue ? 'issue' : 'idle'
  const parentName = (id: string | null): string =>
    (id !== null && parents.find((project) => project.id === id)?.name) || t('common.ungrouped')

  return (
    <div className="page page--home">
      <div className="ops">
        <header className="ops__header">
          <div className="ops__heading">
            <span className="ops__eyebrow">{t('ops.console')}</span>
            <h1>{t('ops.title')}</h1>
            <p>{t('ops.subtitle')}</p>
          </div>
          <div className="ops__global-actions">
            <span className="ops__state" data-tone={mode}>
              <span className="dot" data-tone={mode === 'issue' ? 'danger' : mode === 'active' ? 'run' : undefined} aria-hidden="true" />
              {mode === 'issue'
                ? t('ops.attention', { count: problems.length })
                : mode === 'active'
                  ? t('ops.running', { count: active.length })
                  : t('ops.standby')}
            </span>
            <button type="button" className="btn btn-primary" onClick={() => navigate('copy')}>
              + {t('ops.newJob')}
            </button>
          </div>
        </header>

        <div className="ops__grid">
          <div className="ops__primary">
            <div className="ops__section-head">
              <span>{t('ops.current')}</span>
              <span className="ops__eyebrow">{t('ops.workflow')}</span>
            </div>
            {issue !== null && lead === null ? (
              <section className="ops__stage ops__stage--issue" aria-label={t('ops.issue')}>
                <div className="ops__stage-type" data-tone="danger">
                  <span className="dot" data-tone="danger" aria-hidden="true" />
                  {t('ops.actionRequired')}
                </div>
                <h2>{issue.name}</h2>
                <JobStateBadge state={issue.state} />
                <p>
                  {issueKind === 'proxy'
                    ? t('p0.proxyIssueDetail', { count: progress[issue.id]?.proxy?.failed ?? 0 })
                    : issueKind === 'media'
                      ? t('p0.mediaIssueDetail', { count: issue.filesFailed })
                      : issue.state === 'failed' || issue.state === 'completed-with-errors'
                        ? t('p0.otherIssueDetail')
                        : t('ops.recoveryWarning')}
                </p>
                {problems.length > 1 && (
                  <span className="ops__minor">{t('ops.otherIssues', { count: problems.length - 1 })}</span>
                )}
                <div className="ops__stage-actions">
                  <button type="button" className="btn btn-primary" onClick={() => focusJob(issue.id)}>
                    {t('ops.inspectJob')}
                  </button>

                </div>
              </section>
            ) : lead !== null ? (
              <section className="ops__stage" aria-label={t('ops.current')}>
                <div className="ops__stage-type" data-tone="run">
                  <span className="dot" data-tone="run" aria-hidden="true" />
                  {t('ops.activeOperation')}
                </div>
                <div className="ops__job-title">
                  <h2>{lead.name}</h2>
                  <JobStateBadge state={lead.state} />
                </div>
                <div className="ops__metric">
                  <strong>{live !== undefined ? String(Math.round(live.overallPercent)) + '%' : '—'}</strong>
                  <span>{t('ops.processingNotVerified')}</span>
                </div>
                {live !== undefined && <Progress value={live.overallPercent} />}
                <div className="ops__telemetry">
                  <span title={t('safety.allTargetsCount')}>{t('common.files')} <b>{lead.filesDone} / {lead.totalFiles}</b></span>
                  {live !== undefined && <span>{t('p0.currentPhase')}: <b>{t(`queue.phase.${live.phase}` as never)}</b></span>}
                  {live !== undefined && live.bytesPerSecond > 0 && (
                    <span>{t('queue.speed')} <b>{humanRate(live.bytesPerSecond)}</b></span>
                  )}
                  {live?.etaSeconds != null && (
                    <span>{t('queue.eta')} <b>{humanDuration(live.etaSeconds)}</b></span>
                  )}
                </div>
                {live !== undefined && live.targets.length > 0 && (
                  <div className="ops__target-lines">
                    <div className="ops__minor">{t('ops.perTarget')}</div>
                    {live.targets.map((target) => {
                      const outcome = destinationOutcome(lead.totalFiles, target)
                      return (
                        <div key={target.targetId} className="ops__target-line">
                          <span className="dot" data-tone={outcome === 'failed' ? 'danger' : outcome === 'verified' ? 'ok' : 'run'} aria-hidden="true" />
                          <span className="ops__truncate">{target.label}</span>
                          <span>{outcome === 'failed'
                            ? target.filesFailed > 0 ? t('p0.targetHasFailures', { count: target.filesFailed }) : t('p0.targetFailed')
                            : outcome === 'verified' ? t('p0.targetVerified')
                              : outcome === 'unavailable' ? t('p0.resultUnavailable')
                                : outcome === 'pending' ? t('state.queued')
                                  : outcome === 'disabled' ? t('filestate.skipped') : t('state.running')}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
                <div className="ops__stage-actions">
                  <button type="button" className="btn btn-primary" onClick={() => focusJob(lead.id)}>
                    {t('ops.openMonitor')}
                  </button>
                </div>
              </section>
            ) : (
              <section className="ops__stage ops__stage--idle" aria-label={t('ops.standby')}>
                <div className="ops__stage-type">
                  <span className="dot" data-tone="ok" aria-hidden="true" />
                  {t('ops.noActiveJob')}
                </div>
                <h2>{t('ops.readyToStart')}</h2>
                <p>{t('ops.idleHint')}</p>
                <div className="ops__workflow-rail" aria-label={t('ops.workflow')}>
                  <span>{t('ops.source')}</span><i aria-hidden="true">→</i>
                  <span>{t('ops.destinations')}</span><i aria-hidden="true">→</i>
                  <span>{t('ops.preflight')}</span><i aria-hidden="true">→</i>
                  <span>{t('ops.verifiedDelivery')}</span>
                </div>
                <div className="ops__stage-actions">
                  <button type="button" className="btn btn-primary" onClick={() => navigate('copy')}>
                    {t('ops.newJob')}
                  </button>
                  <button type="button" className="btn" onClick={() => navigate('queue')}>
                    {t('ops.openMonitor')}
                  </button>
                </div>
              </section>
            )}

            {issue !== null && lead !== null && (
              <div className="ops__pending-alert">
                <span className="dot" data-tone="warn" aria-hidden="true" />
                {t('p1.openIssues', { count: problems.length })}
                <button type="button" className="ops__link" onClick={() => focusJob(issue.id)}>
                  {t('p0.inspectLog')}
                </button>
              </div>
            )}
            <section className="ops__recent" aria-label={t('home.recent')}>
              <div className="ops__section-head">
                <span>{t('home.recent')}</span>
                {recent.length > 0 && <span className="ops__eyebrow">{t('ops.recentCount', { count: recent.length })}</span>}
              </div>
              {recent.length === 0 ? (
                <div className="ops__history-empty">{t('ops.noHistory')}</div>
              ) : (
                <div className="ops__history">
                  {recent.map((job) => (
                    <button type="button" key={job.id} className="ops__history-row" onClick={() => focusJob(job.id)}>
                      <span className="ops__truncate"><b>{job.name}</b><small>{parentName(job.parentProjectId)}</small></span>
                      <span><JobStateBadge state={job.state} /></span>
                      <span className="ops__numeric">{humanBytes(job.bytesDone)}</span>
                      <span className="ops__numeric" title={t('safety.allTargetsCount')}>{job.filesDone} / {job.totalFiles}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>

          <aside className="ops__devices" aria-label={t('ops.media')}>
            <div className="ops__section-head">
              <span>{t('ops.media')}</span>
              <button className="ops__link" type="button" disabled={volumeBusy} onClick={() => void refreshVolumes()}>
                {volumeBusy ? t('ops.loading') : t('ops.refresh')}
              </button>
            </div>
            <div className="ops__device-intro">
              {volumeError
                ? t('ops.volumeError')
                : volumes === null
                  ? t('ops.loading')
                  : t('ops.volumeCount', { count: volumes.length })}
            </div>
            {volumes !== null && candidateVolumes.length > 0 && (
              <div className="ops__device-list">
                {candidateVolumes.map((volume) => (
                  <div className="ops__device" key={volume.path} title={volume.path}>
                    <span className="ops__device-mark" aria-hidden="true" />
                    <div className="ops__device-info">
                      <strong className="ops__truncate">{volume.label}</strong>
                      <span title={volume.path}>{volume.path} · {volume.readOnly ? t('ops.readOnly') : t('ops.visible')}</span>
                    </div>
                    <span className="ops__numeric">{volume.freeBytes === null ? '—' : humanBytes(volume.freeBytes)}</span>
                  </div>
                ))}
              </div>
            )}
            {volumes !== null && candidateVolumes.length === 0 && !volumeError && (
              <div className="ops__device-empty">
                <strong>{t('ops.noMedia')}</strong>
                <span>{t('ops.noMediaHint')}</span>
              </div>
            )}
            <p className="ops__device-note">{t('ops.mediaDisclaimer')}</p>

            {otherVolumes.length > 0 && (
              <details className="ops__other-volumes">
                <summary>{t('p1.otherVolumes', { count: otherVolumes.length })}</summary>
                <div className="ops__device-list">
                  {otherVolumes.map((volume) => (
                    <div className="ops__device" key={volume.path} title={volume.path}>
                      <span className="ops__device-mark" aria-hidden="true" />
                      <div className="ops__device-info">
                        <strong className="ops__truncate">{volume.label}</strong>
                        <span title={volume.path}>{volume.path}</span>
                      </div>
                      <span className="ops__numeric">{volume.freeBytes === null ? '—' : humanBytes(volume.freeBytes)}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
            <details className="ops__safety">
              <summary className="ops__section-head">{t('ops.safetyTitle')}</summary>
              <div className="ops__safety-row"><span>01</span>{t('ops.safetyRead')}</div>
              <div className="ops__safety-row"><span>02</span>{t('ops.safetyVerify')}</div>
              <div className="ops__safety-row"><span>03</span>{t('ops.safetyNeverOverwrite')}</div>
            </details>
          </aside>
        </div>
      </div>
    </div>
  )
}
