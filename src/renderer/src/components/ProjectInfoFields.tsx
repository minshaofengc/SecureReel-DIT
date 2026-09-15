/**
 * 项目级信息的表单字段（母项目页与拷贝页共用）。
 *
 * 抽成一个受控组件而不是两处各写一遍：字段只写一次，两处永远一致。
 * 之前「项目信息」页与「拷贝」页是两套几乎相同的 JSX，加一个字段要改两个地方，
 * 迟早会漏掉一处。
 *
 * 组件只管 `ProjectDetails`（机型、镜头、人员、项目备注）。
 * 「卡号 / 卷号」与「本次拷贝备注」不属于项目级信息，由调用方在卡片里单独排。
 */
import { useCallback, useMemo, useRef, type ReactNode } from 'react'
import {
  CREW_ROLE_PRESET_KEYS,
  emptyProjectDetails
} from '@shared/project'
import {
  MAX_CREW_ROWS,
  MAX_LENS_ROWS,
  MAX_PROJECT_NOTES_LENGTH,
  type CrewEntry,
  type LensEntry,
  type ProjectDetails
} from '@shared/types'
import { ComboBox } from './ComboBox'
import { Note } from './ui'
import { useI18n } from '../i18n'
import type { MessageKey } from '../i18n/messages'

export type ProjectInfoSection = 'basic' | 'lenses' | 'crew' | 'notes'

interface Props {
  value: ProjectDetails
  onChange: (next: ProjectDetails) => void
  disabled?: boolean
  /** 只渲染需要的区块；缺省全部渲染 */
  sections?: ProjectInfoSection[]
}

/**
 * 给每一行配一个稳定的 key。
 *
 * 为什么不用数组下标：删掉中间一行之后，后面所有行的下标都会往前挪，
 * React 会把「下一行的 DOM」当成「这一行」复用 —— 输入框里的光标会跳到别处，
 * 正在打字的人会以为程序疯了。用 index 当 key 的现有实现在删中间行时就是这个症状。
 *
 * 用 ref 而不是 state：key 只在渲染时有意义，不需要它自己触发重渲染。
 * 长度被外部改动时（比如从母项目整包带入）在这里补齐或截断，
 * 与「本次操作」增删的路径收敛到同一段逻辑上。
 */
function useRowKeys(length: number): {
  keys: string[]
  add: () => void
  removeAt: (index: number) => void
} {
  const keys = useRef<string[]>(Array.from({ length }, () => crypto.randomUUID()))

  if (keys.current.length !== length) {
    keys.current =
      keys.current.length < length
        ? [
            ...keys.current,
            ...Array.from({ length: length - keys.current.length }, () => crypto.randomUUID())
          ]
        : keys.current.slice(0, length)
  }

  const add = useCallback(() => {
    keys.current = [...keys.current, crypto.randomUUID()]
  }, [])

  const removeAt = useCallback((index: number) => {
    keys.current = keys.current.filter((_, i) => i !== index)
  }, [])

  return { keys: keys.current, add, removeAt }
}

export function ProjectInfoFields({ value, onChange, disabled, sections }: Props): ReactNode {
  const { t } = useI18n()
  const show = (section: ProjectInfoSection): boolean =>
    sections === undefined || sections.includes(section)

  const lensKeys = useRowKeys(value.lenses.length)
  const crewKeys = useRowKeys(value.crew.length)

  const patch = (part: Partial<ProjectDetails>): void => onChange({ ...value, ...part })

  const setLens = (index: number, part: Partial<LensEntry>): void =>
    patch({ lenses: value.lenses.map((entry, i) => (i === index ? { ...entry, ...part } : entry)) })

  const addLens = (): void => {
    lensKeys.add()
    patch({ lenses: [...value.lenses, { model: '', detail: '' }] })
  }

  const removeLens = (index: number): void => {
    lensKeys.removeAt(index)
    patch({ lenses: value.lenses.filter((_, i) => i !== index) })
  }

  const setCrew = (index: number, part: Partial<CrewEntry>): void =>
    patch({ crew: value.crew.map((entry, i) => (i === index ? { ...entry, ...part } : entry)) })

  const addCrew = (): void => {
    crewKeys.add()
    patch({ crew: [...value.crew, { role: '', name: '' }] })
  }

  const removeCrew = (index: number): void => {
    crewKeys.removeAt(index)
    patch({ crew: value.crew.filter((_, i) => i !== index) })
  }

  const notesLength = value.notes.length
  const lensFull = value.lenses.length >= MAX_LENS_ROWS
  const crewFull = value.crew.length >= MAX_CREW_ROWS

  /*
   * 职务的建议列表。
   *
   * value 和 label 都是同一份本地化文案 —— 职务是**用户内容**，
   * 会原样写进报告和清单，所以不做「键名 → 文案」的翻译映射。
   * 中文界面下选「导演」，报告里就是「导演」；英文界面下选 Director，
   * 报告里就是 Director。这也是它不能用普通下拉（只能选）的原因：
   * 预设之外还有大量职务，必须能自由输入。
   */
  const roleOptions = useMemo(
    () => CREW_ROLE_PRESET_KEYS.map((key) => ({ value: t(key as MessageKey), label: t(key as MessageKey) })),
    [t]
  )

  return (
    <>
      {show('basic') && (
        <div className="grid-2">
          <label className="field">
            <span className="field-label">{t('project.projectName')}</span>
            <input
              className="input"
              value={value.projectName}
              disabled={disabled}
              onChange={(event) => patch({ projectName: event.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('project.shootDay')}</span>
            <input
              className="input"
              value={value.shootDay}
              placeholder="2026-09-15"
              disabled={disabled}
              onChange={(event) => patch({ shootDay: event.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('project.camera')}</span>
            <input
              className="input"
              value={value.camera}
              /*
               * 提示里刻意不写任何品牌或型号：机型是用户现场填的内容。
               * 软件替他写一个具体机型，既没有意义，也容易被读成"官方推荐 / 背书"。
               */
              placeholder={t('project.cameraPlaceholder')}
              disabled={disabled}
              onChange={(event) => patch({ camera: event.target.value })}
            />
          </label>
        </div>
      )}

      {show('lenses') && (
        <div className="sub-block">
          <div className="sub-head">
            <span className="field-label">
              {t('project.lenses')} {value.lenses.length} / {MAX_LENS_ROWS}
            </span>
            <button type="button" className="btn btn-sm" disabled={disabled || lensFull} onClick={addLens}>
              + {t('project.addLens')}
            </button>
          </div>
          {value.lenses.length === 0 ? (
            <div className="faint" style={{ fontSize: 12 }}>
              {t('project.noLens')}
            </div>
          ) : (
            value.lenses.map((lens, index) => (
              <div className="crew-row" key={lensKeys.keys[index] ?? `lens-${index}`}>
                <input
                  className="input"
                  placeholder={t('project.lensModel')}
                  value={lens.model}
                  disabled={disabled}
                  onChange={(event) => setLens(index, { model: event.target.value })}
                />
                <input
                  className="input"
                  placeholder={t('project.lensDetail')}
                  value={lens.detail}
                  disabled={disabled}
                  onChange={(event) => setLens(index, { detail: event.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={disabled}
                  onClick={() => removeLens(index)}
                >
                  {t('common.remove')}
                </button>
              </div>
            ))
          )}
          {lensFull && <Note tone="warn">{t('copy.lensFull')}</Note>}
        </div>
      )}

      {show('crew') && (
        <div className="sub-block">
          <div className="sub-head">
            <span className="field-label">
              {t('project.crew')} {value.crew.length} / {MAX_CREW_ROWS} · {t('project.roleHint')}
            </span>
            <button type="button" className="btn btn-sm" disabled={disabled || crewFull} onClick={addCrew}>
              + {t('project.addRow')}
            </button>
          </div>
          {/*
            职务用 ComboBox（可自由输入 + 建议列表）而不是普通下拉：
            预设只是路牌，不是白名单 —— 敲什么就存什么。
            以前这里用的是原生 <datalist>，那个候选列表由系统绘制、
            CSS 完全够不着，换主题时永远跟不上，所以换成了自研的。
          */}
          {value.crew.length === 0 ? (
            <div className="faint" style={{ fontSize: 12 }}>
              {t('common.none')}
            </div>
          ) : (
            value.crew.map((entry, index) => (
              <div className="crew-row" key={crewKeys.keys[index] ?? `crew-${index}`}>
                <ComboBox
                  value={entry.role}
                  disabled={disabled}
                  ariaLabel={t('project.role')}
                  listLabel={t('project.roleSuggestions')}
                  placeholder={t('project.role')}
                  options={roleOptions}
                  onChange={(next) => setCrew(index, { role: next })}
                />
                <input
                  className="input"
                  placeholder={t('project.person')}
                  value={entry.name}
                  disabled={disabled}
                  onChange={(event) => setCrew(index, { name: event.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={disabled}
                  onClick={() => removeCrew(index)}
                >
                  {t('common.remove')}
                </button>
              </div>
            ))
          )}
          {crewFull && <Note tone="warn">{t('copy.crewFull')}</Note>}
        </div>
      )}

      {show('notes') && (
        <label className="field">
          <span className="field-label">{t('project.notes')}</span>
          <textarea
            className="textarea"
            value={value.notes}
            maxLength={MAX_PROJECT_NOTES_LENGTH}
            disabled={disabled}
            onChange={(event) => patch({ notes: event.target.value })}
          />
          <div className={`counter${notesLength > MAX_PROJECT_NOTES_LENGTH ? ' over' : ''}`}>
            {notesLength} / {MAX_PROJECT_NOTES_LENGTH}
          </div>
        </label>
      )}
    </>
  )
}

export { emptyProjectDetails }
