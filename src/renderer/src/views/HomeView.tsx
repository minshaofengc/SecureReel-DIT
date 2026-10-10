import type { ReactNode } from 'react'
import { humanBytes, humanDuration, humanRate, todayLocalDate } from '@shared/format'
import { useAppState } from '../state/AppState'
import { useNav } from '../state/NavState'
import { useI18n } from '../i18n'
import { Empty, JobStateBadge, Progress } from '../components/ui'

/**
 * 工作台 —— 打开软件第一眼落在哪一页。
 *
 * 2026-10-05 第五次改（方案 E）新增。此前默认落在**拷贝页**，
 * 那等于假设"你每次打开都是来建任务的" —— 可现场更常见的是
 * "我开一下看看昨天那卡跑完了没"。
 *
 * 这一页只回答一个问题：**我现在该干什么。** 所以它是**状态感知**的：
 * 有任务在跑，主块就是那个任务；没任务在跑，主块就是"选来源"。
 * 空态与运行态**共用同一组区块，只换权重** —— 这是对"内容还在遮挡"
 * 那个老问题的正面回答（不再是"没内容时留一片空白"）。
 *
 * ⚠️ 刻意不摆空值。某个区块没内容就不渲染它，而不是渲染一个空表 ——
 * 屏幕上每一行都要有信息，这是本版和前四版最大的区别。
 */
export function HomeView(): ReactNode {
  const { t } = useI18n()
  const { jobs, progress, recovered, parents } = useAppState()
  const { navigate, focusJob } = useNav()

  const today = todayLocalDate()

  const running = jobs.filter((job) => job.state === 'running' || job.state === 'queued')
  const failed = jobs.filter(
    (job) => job.state === 'failed' || job.state === 'completed-with-errors'
  )
  const doneToday = jobs.filter(
    (job) => job.state === 'completed' && (job.finishedAt ?? '').startsWith(today)
  )

  /** 最近的任务，按创建时间倒序 —— 不做二次排序，主进程给的就是这个顺序。 */
  const recent = jobs.slice(0, 6)

  /** 主块：优先正在跑的，没有才落到"新建"。 */
  const lead = running[0] ?? null
  const leadProgress = lead !== null ? progress[lead.id] : undefined

  /** 待处理：中断恢复 + 出错，两类都是"需要你动手"的。 */
  const pending = [...recovered, ...failed.filter((job) => !recovered.some((r) => r.id === job.id))]

  const parentName = (id: string | null): string | null =>
    id === null ? null : (parents.find((item) => item.id === id)?.name ?? null)

  /** `2026-10-05T21:04:12.000Z` → `10-05 21:04`（本机时区）。 */
  const stamp = (iso: string | null): string => {
    if (iso === null) return ''
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return ''
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  return (
    <div className="page page--home">
      <div className="home">
        <div className="home__main">
          {/* ---------- 状态条：四格，全是"现在的状况" ---------- */}
          <div className="hstrip">
            <div className="hs" data-hot={running.length > 0 ? 'true' : undefined}>
              <div className="hs__k">{t('home.running')}</div>
              <div className="hs__v">
                {running.length}
                <small>{t('home.jobs')}</small>
              </div>
            </div>
            <div className="hs">
              <div className="hs__k">{t('home.doneToday')}</div>
              <div className="hs__v">
                {doneToday.length}
                <small>{t('home.jobs')}</small>
              </div>
            </div>
            <div className="hs">
              <div className="hs__k">{t('home.pending')}</div>
              <div className="hs__v">
                {pending.length}
                <small>{t('home.items')}</small>
              </div>
            </div>
            <div className="hs">
              <div className="hs__k">{t('home.parents')}</div>
              <div className="hs__v">{parents.length}</div>
            </div>
          </div>

          {/* ---------- 主块：一屏只有这一块是"重的" ---------- */}
          {lead !== null ? (
            <section className="lead">
              <div className="lead__head">
                <span className="dot" data-tone="run" aria-hidden="true" />
                <span className="lead__title">{lead.name}</span>
                <div className="lead__acts">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => focusJob(lead.id)}
                  >
                    {t('home.open')}
                  </button>
                </div>
              </div>

              <div className="lead__stats">
                <div className="bigrow">
                  <span className="big">{Math.round(leadProgress?.overallPercent ?? 0)}</span>
                  <span className="unit">%</span>
                </div>
                <div className="statline">
                  <div className="st">
                    <div className="st__k">{t('common.files')}</div>
                    <div className="st__v">
                      {leadProgress?.filesDone ?? lead.filesDone} / {lead.totalFiles}
                    </div>
                  </div>
                  <div className="st">
                    <div className="st__k">{t('queue.speed')}</div>
                    <div className="st__v">
                      {leadProgress !== undefined && leadProgress.bytesPerSecond > 0
                        ? humanRate(leadProgress.bytesPerSecond)
                        : '—'}
                    </div>
                  </div>
                  <div className="st">
                    <div className="st__k">{t('queue.eta')}</div>
                    <div className="st__v">
                      {leadProgress?.etaSeconds != null
                        ? humanDuration(leadProgress.etaSeconds)
                        : '—'}
                    </div>
                  </div>
                </div>
              </div>
              <Progress value={leadProgress?.overallPercent ?? 0} />
            </section>
          ) : (
            <section className="lead lead--idle">
              <div className="lead__head">
                <span className="lead__title">{t('home.newJob')}</span>
              </div>
              <div className="steps">
                <div className="step" data-on="true">
                  <div className="step__n">1</div>
                  <div className="step__t">{t('home.step1')}</div>
                  <div className="step__s">{t('home.step1hint')}</div>
                </div>
                <div className="step">
                  <div className="step__n">2</div>
                  <div className="step__t">{t('home.step2')}</div>
                  <div className="step__s">{t('home.step2hint')}</div>
                </div>
                <div className="step">
                  <div className="step__n">3</div>
                  <div className="step__t">{t('home.step3')}</div>
                  <div className="step__s">{t('home.step3hint')}</div>
                </div>
              </div>
              <div className="lead__acts lead__acts--start">
                <button type="button" className="btn btn-primary" onClick={() => navigate('copy')}>
                  {t('home.pickSource')}
                </button>
                <button type="button" className="btn" onClick={() => navigate('project')}>
                  {t('home.useTemplate')}
                </button>
              </div>
            </section>
          )}

          {/* ---------- 最近任务：行式，不是卡片 ---------- */}
          {recent.length > 0 && (
            <>
              <div className="sec-h">{t('home.recent')}</div>
              <div className="rowlist">
                {recent.map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    className="rw"
                    onClick={() => focusJob(job.id)}
                  >
                    <div className="rw__id">
                      <div className="rw__name">{job.name}</div>
                      <div className="rw__sub">
                        {parentName(job.parentProjectId) ?? t('common.ungrouped')} ·{' '}
                        {stamp(job.createdAt)}
                      </div>
                    </div>
                    <div className="rw__state">
                      <JobStateBadge state={job.state} />
                    </div>
                    <div className="rw__num">{humanBytes(job.bytesDone)}</div>
                    <div className="rw__num">{job.totalFiles}</div>
                  </button>
                ))}
              </div>
            </>
          )}

          {recent.length === 0 && pending.length === 0 && (
            <Empty>{t('home.empty')}</Empty>
          )}
        </div>

        {/* ---------- 右栏：需要你动手的，和已经交出去的 ---------- */}
        <div className="home__side">
          {pending.length > 0 && (
            <>
              <div className="sec-h">{t('home.pending')}</div>
              {pending.map((job) => {
                const broken = job.state === 'failed' || job.state === 'completed-with-errors'
                return (
                  <div className="todo" key={job.id} data-tone={broken ? 'danger' : 'warn'}>
                    <span className="todo__ic" aria-hidden="true">
                      {broken ? '!' : '↻'}
                    </span>
                    <div className="todo__tx">
                      <div>{job.name}</div>
                      <div className="todo__s">
                        {broken ? t('home.errHint') : t('home.recoveredHint')}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => focusJob(job.id)}
                    >
                      {t('home.handle')}
                    </button>
                  </div>
                )
              })}
            </>
          )}

          {recent.some((job) => job.state === 'completed') && (
            <>
              <div className="sec-h">{t('home.delivered')}</div>
              <div className="rowlist">
                {recent
                  .filter((job) => job.state === 'completed')
                  .slice(0, 4)
                  .map((job) => (
                    <button
                      key={job.id}
                      type="button"
                      className="rw rw--tight"
                      onClick={() => navigate('reports')}
                    >
                      <div className="rw__id">
                        <div className="rw__name">{job.name}</div>
                        <div className="rw__sub">
                          {job.hashAlgorithm.toUpperCase()} · {job.manifestFormat}
                        </div>
                      </div>
                      <div className="rw__num">{stamp(job.finishedAt)}</div>
                    </button>
                  ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
