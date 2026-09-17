/**
 * 母项目管理页。
 *
 * 一部戏一个母项目（例如《母亲》），拷贝时选它，机型、镜头、主创自动带入。
 * 这一页只改母项目本身；单个拷贝任务的卡号与本次备注在「任务队列」页改。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ProjectDetails } from '@shared/types'
import { emptyProjectDetails } from '@shared/project'
import { humanBytes } from '@shared/format'
import { Card, Empty, JobStateBadge, Note } from '../components/ui'
import { SelectBox, type ComboOption } from '../components/ComboBox'
import { ProjectInfoFields } from '../components/ProjectInfoFields'
import { unwrap, useAppState } from '../state/AppState'
import { useI18n } from '../i18n'

export function ProjectView(): ReactNode {
  const { t } = useI18n()
  const { jobs, parents, refreshParents, refreshJobs, pushToast } = useAppState()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  /**
   * 正在编辑的字段值。
   *
   * 不能直接用 `selected.details`：自动保存是防抖的，全局状态里的母项目
   * 要等落库 + 重新拉取之后才会变。若直接读它，用户敲进去的字会立刻消失。
   */
  const [details, setDetails] = useState<ProjectDetails>(emptyProjectDetails())
  const [nameDraft, setNameDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const timerRef = useRef<number | null>(null)
  // 已加载过的母项目 id，避免自动保存回写之后又被重新加载覆盖掉正在输入的内容
  const loadedFor = useRef<string | null>(null)

  const selected = useMemo(
    () => parents.find((project) => project.id === selectedId) ?? null,
    [parents, selectedId]
  )

  const projectOptions = useMemo<ComboOption<string>[]>(
    () => parents.map((project) => ({ value: project.id, label: project.name })),
    [parents]
  )

  useEffect(() => {
    if (selectedId === null && parents.length > 0) setSelectedId(parents[0]?.id ?? null)
  }, [parents, selectedId])

  useEffect(() => {
    if (selected === null) return
    if (loadedFor.current === selected.id) return
    loadedFor.current = selected.id
    setDetails(selected.details)
    setNameDraft(selected.name)
    setRenaming(false)
  }, [selected])

  const scheduleSave = useCallback(
    (next: ProjectDetails) => {
      if (selected === null) return
      // 先本地立刻生效，700ms 后再落库：边等拷贝边填信息，不该每次按键都写盘
      loadedFor.current = selected.id
      setDetails(next)
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        void (async () => {
          try {
            const saved = await unwrap(window.securereel.parents.update(selected.id, { details: next }))
            setSavedAt(saved.updatedAt)
            // 让全局列表跟上，否则切走再切回来会看到旧内容
            await refreshParents()
          } catch (error) {
            pushToast('error', error instanceof Error ? error.message : String(error))
          }
        })()
      }, 700)
    },
    [pushToast, refreshParents, selected]
  )

  const createParent = useCallback(async () => {
    const name = newName.trim()
    if (name === '') return
    try {
      const created = await unwrap(window.securereel.parents.create(name, emptyProjectDetails()))
      await refreshParents()
      setSelectedId(created.id)
      setNewName('')
      setNewOpen(false)
      pushToast('success', t('parent.created'))
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : String(error))
    }
  }, [newName, pushToast, refreshParents, t])

  const rename = useCallback(async () => {
    if (selected === null) return
    const name = nameDraft.trim()
    if (name === '' || name === selected.name) {
      setRenaming(false)
      setNameDraft(selected.name)
      return
    }
    try {
      await unwrap(window.securereel.parents.update(selected.id, { name }))
      await refreshParents()
      // 报告里存的是母项目名的快照，改名后要让它跟上（已生成的旧报告不受影响）
      await refreshJobs()
      setRenaming(false)
      pushToast('success', t('parent.updated'))
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : String(error))
    }
  }, [nameDraft, pushToast, refreshJobs, refreshParents, selected, t])

  const remove = useCallback(async () => {
    if (selected === null) return
    const affected = jobs.filter((job) => job.parentProjectId === selected.id).length
    const warning = t('parent.removeWarning', { count: affected })
    if (!window.confirm(`${t('parent.removeConfirm')}\n\n${warning}`)) return
    try {
      await unwrap(window.securereel.parents.remove(selected.id))
      loadedFor.current = null
      setSelectedId(null)
      await refreshParents()
      await refreshJobs()
      pushToast('success', t('parent.deleted'))
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : String(error))
    }
  }, [jobs, pushToast, refreshJobs, refreshParents, selected, t])

  const childJobs = useMemo(
    () => (selected === null ? [] : jobs.filter((job) => job.parentProjectId === selected.id)),
    [jobs, selected]
  )

  return (
    <div className="page">
      <header className="page-head">
        <h2>{t('parent.title')}</h2>
        <p>{t('parent.subtitle')}</p>
      </header>

      <Card
        title={t('parent.pick')}
        hint={parents.length === 0 ? t('parent.empty') : `${parents.length} / ${t('parent.jobsSuffix')}`}
        actions={
          <>
            {selected !== null && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setNameDraft(selected.name)
                  setRenaming((current) => !current)
                }}
              >
                {t('parent.rename')}
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={() => setNewOpen((current) => !current)}>
              + {t('parent.create')}
            </button>
            {selected !== null && (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()}>
                {t('parent.remove')}
              </button>
            )}
          </>
        }
      >
        {newOpen && (
          <div className="path-row">
            <input
              className="input"
              autoFocus
              value={newName}
              placeholder={t('copy.parentNamePlaceholder')}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void createParent()
                if (event.key === 'Escape') {
                  setNewOpen(false)
                  setNewName('')
                }
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={newName.trim() === ''}
              onClick={() => void createParent()}
            >
              {t('copy.parentCreateConfirm')}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setNewOpen(false)
                setNewName('')
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        )}

        {renaming && selected !== null ? (
          <div className="path-row" style={{ marginTop: newOpen ? 10 : 0 }}>
            <input
              className="input"
              autoFocus
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void rename()
                if (event.key === 'Escape') {
                  setRenaming(false)
                  setNameDraft(selected.name)
                }
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={nameDraft.trim() === ''}
              onClick={() => void rename()}
            >
              {t('common.save')}
            </button>
          </div>
        ) : parents.length === 0 ? (
          <div className="faint">{t('parent.empty')}</div>
        ) : (
          <SelectBox<string>
            value={selectedId ?? ''}
            ariaLabel={t('parent.pick')}
            style={{ marginTop: newOpen ? 10 : 0 }}
            options={projectOptions}
            onChange={(next) => setSelectedId(next === '' ? null : next)}
          />
        )}
      </Card>

      {selected === null ? (
        <Card title={t('parent.details')}>
          <Empty>{t('parent.noSelection')}</Empty>
        </Card>
      ) : (
        <>
          <Card
            title={t('parent.details')}
            hint={t('parent.detailsHint')}
            actions={
              <span className="hint faint">
                {savedAt === null ? t('project.autosave') : t('common.saved')}
              </span>
            }
          >
            <ProjectInfoFields
              value={details}
              sections={['basic', 'lenses', 'crew', 'notes']}
              onChange={(next) => scheduleSave(next)}
            />
            <Note>{t('parent.snapshotHint')}</Note>
          </Card>

          <Card title={t('parent.jobs')} hint={`${childJobs.length} ${t('parent.jobsSuffix')}`}>
            {childJobs.length === 0 ? (
              <div className="faint">{t('parent.noJobs')}</div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('copy.jobName')}</th>
                      <th>{t('common.status')}</th>
                      <th className="num">{t('common.files')}</th>
                      <th className="num">{t('common.bytes')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {childJobs.map((job) => (
                      <tr key={job.id}>
                        <td className="mono">{job.name}</td>
                        <td>
                          <JobStateBadge state={job.state} />
                        </td>
                        <td className="num">
                          {job.filesDone} / {job.totalFiles}
                        </td>
                        <td className="num">{humanBytes(job.bytesDone)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
