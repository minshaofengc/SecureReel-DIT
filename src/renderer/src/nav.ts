/**
 * 页面清单与三段导航。
 *
 * 2026-10-05 第五次改（方案 E）引入。此前是 **7 个平权页面（01–07）** ——
 * 那等于把"功能目录"当导航：用户得自己记住流程顺序，而软件不表达
 * "你现在该干什么"。
 *
 * DIT 的真实工作流是有先后、也有主次的：
 *
 *   建任务（产出素材与元数据）→ 监控（盯住运行中的活）→ 交付（把报告交出去）
 *
 * 设置与帮助不属于任何一段，降到右上角的工具图标。
 *
 * ⚠️ 01–07 的两位编号**已废弃**。它暗示了一个不存在的顺序，
 * 而且和"段"的概念打架（一个段里有好几个页，编号该给谁？）。
 *
 * 抽成独立模块而不是放在 App.tsx 里，是为了**避开循环依赖**：
 * App 要渲染各视图，各视图又要取自己的段与图标 —— 若定义在 App.tsx，
 * 就变成 App → View → App 的环。
 */

export type Page =
  | 'home'
  | 'copy'
  | 'hde'
  | 'project'
  | 'queue'
  | 'reports'
  | 'settings'
  | 'help'

/** 三段：产出 → 盯住 → 交出。 */
export type Segment = 'build' | 'monitor' | 'deliver'

export interface NavSegment {
  segment: Segment
  /** 该段下的页面；**第一个是点段名时落地的默认页**。 */
  pages: Page[]
}

export const SEGMENTS: NavSegment[] = [
  { segment: 'build', pages: ['home', 'copy', 'hde', 'project'] },
  { segment: 'monitor', pages: ['queue'] },
  { segment: 'deliver', pages: ['reports'] }
]

/** 右上角工具组：不属于任何一段。 */
export const TOOL_PAGES: Page[] = ['settings', 'help']

/** 页面 → NavIcon 的 case 名。 */
export const PAGE_ICON: Record<Page, string> = {
  home: 'home',
  copy: 'copy',
  hde: 'hde',
  project: 'project',
  queue: 'queue',
  reports: 'reports',
  settings: 'settings',
  help: 'help'
}

/** 页面 → 所属段。工具页返回 null。 */
export function segmentOf(page: Page): Segment | null {
  for (const item of SEGMENTS) {
    if (item.pages.includes(page)) return item.segment
  }
  return null
}

/** 打开软件第一眼落在哪一页。 */
export const DEFAULT_PAGE: Page = 'home'

/**
 * @deprecated 导航不再有 01–07 编号，这里**恒返回空串**。
 *
 * 保留它只为兼容**尚未清理**的几处视图（CopyView / QueueView / ReportsView /
 * HdeView / ProjectView / SettingsView / HelpView 还在传 `index={PAGE_INDEX.x}`）。
 * `PageHead` 收到空串就不渲染编号块，所以行为上已经等于"没有编号"。
 * 清完那几处就删掉这个导出。
 */
export const PAGE_INDEX = {
  home: '',
  copy: '',
  hde: '',
  project: '',
  queue: '',
  reports: '',
  settings: '',
  help: ''
} as Record<Page, string>
