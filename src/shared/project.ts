/**
 * 项目信息与母项目的纯函数。
 *
 * 放在 shared 里，因为主进程（落库、报告、清单）和渲染进程（表单）都要用同一套规则。
 * 这里不碰 Node 也不碰 DOM —— 只做数据整形，因此可以单独测。
 */

import {
  MAX_COPY_NOTES_LENGTH,
  MAX_CREW_ROWS,
  MAX_LENS_ROWS,
  MAX_PROJECT_NOTES_LENGTH,
  type CrewEntry,
  type LensEntry,
  type ProjectDetails,
  type ProjectDraft,
  type ProjectInfo
} from './types'

export function emptyProjectDetails(): ProjectDetails {
  return {
    projectName: '',
    shootDay: '',
    camera: '',
    lenses: [],
    notes: '',
    crew: []
  }
}

export function emptyProjectInfo(cardLabel = ''): ProjectInfo {
  return {
    ...emptyProjectDetails(),
    cardLabel,
    copyNotes: '',
    parentProjectName: null,
    updatedAt: null
  }
}

export function emptyProjectDraft(): ProjectDraft {
  return { ...emptyProjectDetails(), cardLabel: '', copyNotes: '' }
}

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asTrimmedLimit(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value
}

/**
 * 把任意（可能是老版本写下的）数据整形成合法的 ProjectDetails。
 *
 * 为什么必须有这一步：`project_info` 里存的是整包 JSON，读的时候是直接
 * `JSON.parse`，没有任何校验。新增字段之后，**老记录里那些字段是 undefined** ——
 * 界面一旦去 `.map()` 就会崩，而且崩在跟真正原因毫无关系的行上
 * （"cannot read property of undefined"）。
 *
 * 所以所有读出口都先过这里：缺字段补默认值，脏元素丢掉，绝不抛错。
 */
export function normalizeProjectDetails(raw: unknown): ProjectDetails {
  const source = (raw ?? {}) as Record<string, unknown>

  const lenses = Array.isArray(source.lenses) ? source.lenses : []
  const crew = Array.isArray(source.crew) ? source.crew : []

  return {
    projectName: asTrimmedLimit(asText(source.projectName), 160),
    shootDay: asTrimmedLimit(asText(source.shootDay), 40),
    camera: asTrimmedLimit(asText(source.camera), 120),
    lenses: lenses
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .slice(0, MAX_LENS_ROWS)
      .map<LensEntry>((entry) => ({
        model: asTrimmedLimit(asText(entry.model), 120),
        detail: asTrimmedLimit(asText(entry.detail), 120)
      })),
    notes: asTrimmedLimit(asText(source.notes), MAX_PROJECT_NOTES_LENGTH),
    crew: crew
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .slice(0, MAX_CREW_ROWS)
      .map<CrewEntry>((entry) => ({
        role: asTrimmedLimit(asText(entry.role), 80),
        name: asTrimmedLimit(asText(entry.name), 80)
      }))
  }
}

export function normalizeProjectInfo(raw: unknown): ProjectInfo {
  const source = (raw ?? {}) as Record<string, unknown>
  return {
    ...normalizeProjectDetails(source),
    cardLabel: asTrimmedLimit(asText(source.cardLabel), 120),
    copyNotes: asTrimmedLimit(asText(source.copyNotes), MAX_COPY_NOTES_LENGTH),
    parentProjectName: typeof source.parentProjectName === 'string' ? source.parentProjectName : null,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null
  }
}

export function normalizeProjectDraft(raw: unknown): ProjectDraft {
  const source = (raw ?? {}) as Record<string, unknown>
  return {
    ...normalizeProjectDetails(source),
    cardLabel: asTrimmedLimit(asText(source.cardLabel), 120),
    copyNotes: asTrimmedLimit(asText(source.copyNotes), MAX_COPY_NOTES_LENGTH)
  }
}

/* ------------------------------------------------------------------ *
 * 展示
 * ------------------------------------------------------------------ */

/**
 * 把镜头列表压成一行文本，供报告与清单使用。
 *
 * 例：`Cooke S7/i 40mm、Cooke S7/i 65mm`
 */
export function describeLenses(details: ProjectDetails): string {
  return details.lenses
    .map((lens) => [lens.model.trim(), lens.detail.trim()].filter((part) => part !== '').join(' '))
    .filter((part) => part !== '')
    .join('、')
}

/**
 * 这条记录是否有值得沿用到下次填写的实质内容。
 *
 * **刻意不看 shootDay** —— 主进程创建任务时会把它自动填成当天日期，
 * 于是每一条记录看起来都"有内容"，沿用逻辑就永远挑不到真正空的那条。
 *
 * 也刻意不看 cardLabel / copyNotes：卡号和本次备注属于"这一张卡"，
 * 不是可以带到下一张卡的信息。
 */
export function hasSubstance(details: ProjectDetails): boolean {
  if (details.projectName.trim() !== '') return true
  if (details.camera.trim() !== '') return true
  if (details.notes.trim() !== '') return true
  if (details.lenses.some((lens) => lens.model.trim() !== '' || lens.detail.trim() !== '')) return true
  if (details.crew.some((entry) => entry.role.trim() !== '' || entry.name.trim() !== '')) return true
  return false
}

/* ------------------------------------------------------------------ *
 * 职务预置
 * ------------------------------------------------------------------ */

/**
 * 常用职务建议（渲染成下拉里的候选项）。
 *
 * 这只是**输入建议**，不是白名单：DIT 可以直接在输入框里敲任意职务。
 * 值本身是用户内容，会原样进入报告，所以不做翻译映射 ——
 * 中文界面下选「导演」，报告里就是「导演」。
 *
 * 顺序按现场出现频率排，而不是按字母或部门：下拉里排在前面本身就是一种提示，
 * 打开就能一眼看到最常用的那几个，不用滚。摄影组排在最前，因为 DIT 打交道最多。
 */
export const CREW_ROLE_PRESET_KEYS = [
  'crew.role.director',
  'crew.role.dp',
  'crew.role.cameraOperator',
  'crew.role.focusPuller',
  'crew.role.cameraAssistant',
  'crew.role.dit',
  'crew.role.dataManager',
  'crew.role.clapper',
  'crew.role.gaffer',
  'crew.role.electrician',
  'crew.role.sound',
  'crew.role.lineProducer',
  'crew.role.producer',
  'crew.role.editor'
] as const
