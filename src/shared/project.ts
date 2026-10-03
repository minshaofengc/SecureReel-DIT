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

/* ------------------------------------------------------------------ *
 * 空值构造
 * ------------------------------------------------------------------ */

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
  if (hasLenses(details.lenses)) return true
  if (hasCrew(details.crew)) return true
  return false
}

/**
 * 镜头列表里有没有真正填过的行。
 *
 * 只能选一个字段的也算 —— 现场常有人只写"雅典娜"不写焦段。
 * 界面上点"+ 添加镜头"留下的空行不算。
 */
export function hasLenses(lenses: LensEntry[]): boolean {
  return lenses.some((lens) => lens.model.trim() !== '' || lens.detail.trim() !== '')
}

/**
 * 人员列表里有没有真正填过的行。
 *
 * 同理，只填了职务没填名字（或反过来）也算 —— 那多半是还没填完，
 * 不该被当成"没有内容"而丢掉。界面上留下的空行不算。
 */
export function hasCrew(crew: CrewEntry[]): boolean {
  return crew.some((entry) => entry.role.trim() !== '' || entry.name.trim() !== '')
}

/** 丢掉界面上点"添加一行"留下、但一个字都没填的空行。 */
export function dropEmptyCrew(crew: CrewEntry[]): CrewEntry[] {
  return crew.filter((entry) => entry.role.trim() !== '' || entry.name.trim() !== '')
}

export function dropEmptyLenses(lenses: LensEntry[]): LensEntry[] {
  return lenses.filter((lens) => lens.model.trim() !== '' || lens.detail.trim() !== '')
}

/**
 * 把 fallback 里"base 没填"的字段补进 base —— 用于从历史拷贝记录里回捞母项目信息。
 *
 * 为什么是"补空"而不是"覆盖"：母项目是**用户自己维护**的档案，
 * 一个字段一旦填了就是他的意思，历史记录再新也不该把它顶掉。
 * 反过来，空着的字段说明他从没在这部戏的档案里写过，用历史记录填上只是把
 * 他早就填过、却被旧版本漏存的内容还给他。
 *
 * **故意不合并 shootDay**：拍摄日是"这一次拷贝拍的是哪天"，
 * 不属于整部戏不变的属性；从历史里翻出一个几个月前的日期填进去只会误导。
 */
export function fillMissingDetails(base: ProjectDetails, fallback: ProjectDetails | null): ProjectDetails {
  if (fallback === null) return base
  return {
    // 拍摄日保持 base 的，理由见上
    shootDay: base.shootDay,
    projectName: base.projectName.trim() === '' ? fallback.projectName : base.projectName,
    camera: base.camera.trim() === '' ? fallback.camera : base.camera,
    notes: base.notes.trim() === '' ? fallback.notes : base.notes,
    lenses: hasLenses(base.lenses) ? base.lenses : fallback.lenses,
    crew: hasCrew(base.crew) ? base.crew : fallback.crew
  }
}

/**
 * 把本次拷贝填的职员与镜头"沉淀"回母项目档案。
 *
 * 与 `fillMissingDetails` 的方向正好相反：这次是**用户刚在拷贝页填的**，
 * 以它为准，覆盖母项目里对应的那两项。
 *
 * 两条保护，都是"宁可不更新，也不能把档案清空"：
 *   · 本次**没填**（一个有效行都没有）→ 保持档案原样，绝不写入空数组。
 *     否则"这张卡懒得填"就会把辛苦攒了几部戏的人员表抹掉。
 *   · 只动 lenses / crew 两项。机型、项目名、备注、拍摄日各自有归属，
 *     不在拷贝页的顺手改动范围里。
 */
export function mergeTalentIntoParent(
  parent: ProjectDetails,
  filled: Pick<ProjectDetails, 'lenses' | 'crew'>
): { details: ProjectDetails; changed: boolean } {
  const nextLenses = hasLenses(filled.lenses) ? dropEmptyLenses(filled.lenses) : parent.lenses
  const nextCrew = hasCrew(filled.crew) ? dropEmptyCrew(filled.crew) : parent.crew

  const changed = !sameLenses(nextLenses, parent.lenses) || !sameCrew(nextCrew, parent.crew)
  return {
    details: changed ? { ...parent, lenses: nextLenses, crew: nextCrew } : parent,
    changed
  }
}

function sameLenses(a: LensEntry[], b: LensEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((lens, index) => lens.model === b[index]?.model && lens.detail === b[index]?.detail)
  )
}

function sameCrew(a: CrewEntry[], b: CrewEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => entry.role === b[index]?.role && entry.name === b[index]?.name)
  )
}

/* ------------------------------------------------------------------ *
 * 拍摄日的自动推进
 * ------------------------------------------------------------------ */

/**
 * 跨过午夜时，要不要把「拍摄日」自动推进到新的一天。
 *
 * 返回值 = 该写进表单的日期；`null` = 别动。
 *
 * 三种"别动"的情况，每一种都对应一次真实误伤：
 *   · `lastAuto` 为空 —— 不知道框里这个值是程序填的还是人填的，宁可不动
 *   · 电脑的日期没变 —— 没事找事
 *   · 框里的值已经被人改过 —— **补拷昨天卡的人会故意填旧日期**，绝不能被覆盖
 *
 * 抽成纯函数是为了能单独测：这段一旦写错，后果是"拍摄日默默错一天"，
 * 而且格式完全合法、不报任何错，只能靠人肉发现。
 */
export function nextAutoShootDay(
  currentValue: string | null,
  lastAuto: string | null,
  today: string
): string | null {
  if (lastAuto === null) return null
  if (today === lastAuto) return null
  if (currentValue !== lastAuto) return null
  return today
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
