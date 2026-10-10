/**
 * 配色令牌的守卫。
 *
 * 2026-10-05 新增。背景：那天把配色从"一套荧光绿"扩成"四套降噪配色"，
 * 每套两模式 —— 一共 8 组色板。这种规模下有两类错误**完全不报错**，
 * 只会在界面上表现成"看着不对劲"，靠人眼复查四遍并不现实：
 *
 *   ① 某套皮肤漏配了令牌 → 那一项沿用默认皮肤的值。
 *      症状是"这套皮肤好像没生效"，而且只在那一处，极难发现。
 *   ② 强调色与压在它上面的字配错了 → 白底白字、看不见。
 *      改配色时最容易犯，因为它只在特定肤色下才错。
 *
 * 这里把两类都钉住：令牌集合必须完整，对比度必须达标。
 * 它读的是**真实的 tokens.css**，不是复制一份色板 —— 复制出来的那份
 * 迟早会和真源走散，那这个测试就只剩心理安慰。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync('src/renderer/src/styles/tokens.css', 'utf8')

/** 从 CSS 里抠出「选择器 → 自定义属性表」。tokens.css 没有嵌套规则，正则够用。 */
function parseBlocks(css: string): Map<string, Map<string, string>> {
  /*
   * ⚠️ 必须先剥掉注释。
   * 注释里没有大括号，于是 `([^{}]+)\{` 会把**整段注释**吃进"选择器"里 ——
   * 第一个块的选择器变成 "/** …一大段说明… :root"，`startsWith(':root')` 直接判否，
   * 所有块全被跳过。第一次写这个解析器就栽在这上面（表现为"选择器不存在"，
   * 而文件里明明有）。
   */
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks = new Map<string, Map<string, string>>()
  const rule = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = rule.exec(stripped)) !== null) {
    const selector = (match[1] ?? '').trim()
    if (!selector.startsWith(':root') && !selector.startsWith('html[')) continue
    const decls = new Map<string, string>()
    const decl = /--([\w-]+)\s*:\s*([^;]+);/g
    let item: RegExpExecArray | null
    while ((item = decl.exec(match[2] ?? '')) !== null) {
      decls.set(item[1] as string, (item[2] as string).trim())
    }
    blocks.set(selector, decls)
  }
  return blocks
}

const BLOCKS = parseBlocks(CSS)

/** 按 CSS 层叠顺序取某个「皮肤 × 明暗」组合下的最终值。 */
function resolve(skin: string, mode: 'light' | 'dark'): Map<string, string> {
  const merged = new Map<string, string>()
  const layers = [
    ':root',
    `html[data-mode='${mode}']`,
    // 默认皮肤没有覆盖块，这一层自然落空
    `html[data-skin='${skin}'][data-mode='${mode}']`
  ]
  for (const selector of layers) {
    for (const [name, value] of BLOCKS.get(selector) ?? []) merged.set(name, value)
  }
  return merged
}

const SKINS = ['mono', 'steel', 'sand'] as const
const MODES = ['light', 'dark'] as const

/*
 * 必须被**每一套皮肤**覆盖的令牌。
 *
 * 不在这个名单里的（--radius-*、--sp-*、--fs-*、--lead-* 等）要么与配色无关，
 * 要么本身写成 var() 引用、会跟着走，不需要每套重写。
 * 加新皮肤时：tokens.css 里那两块必须把这 42 个全写上。
 */
const REQUIRED_PER_SKIN = [
  'bg',
  'bg-elevated',
  'surface',
  'surface-2',
  'surface-3',
  'border',
  'border-strong',
  'line-soft',
  'hard-line',
  'text',
  'text-muted',
  'text-faint',
  'band',
  'band-ink',
  'band-ink-dim',
  'band-danger',
  'accent',
  'accent-hover',
  'accent-soft',
  'accent-ink',
  'accent-ink-dim',
  'accent-text',
  'accent-contrast',
  'ok',
  'ok-soft',
  'warn',
  'warn-soft',
  'danger',
  'danger-soft',
  'info',
  'info-soft',
  'rail',
  'rail-text',
  'rail-text-dim',
  'rail-hover',
  'rail-line',
  'on-dark-bg',
  'on-dark-border',
  'on-dark-text',
  'nav-current-bg',
  'nav-current-text',
  'shadow-md'
]

/* ---------------- 对比度 ---------------- */

const channel = (v: number): number => {
  const s = v / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null
  const n = parseInt(hex.slice(1), 16)
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  )
}

/** WCAG 2.1 对比度。任一色值不是 6 位 hex（比如 rgba 半透明）就返回 null，跳过。 */
function contrast(a: string | undefined, b: string | undefined): number | null {
  if (a === undefined || b === undefined) return null
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return null
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

describe('配色令牌', () => {
  it('tokens.css 能被解析出默认皮肤的两个明暗块', () => {
    expect(BLOCKS.has("html[data-mode='light']")).toBe(true)
    expect(BLOCKS.has("html[data-mode='dark']")).toBe(true)
  })

  /*
   * 这条挡的是"漏配 → 静默回退成 unset"。
   * 默认皮肤两块必须一一对应，多一个少一个都会让某个声明整条失效。
   */
  it('默认皮肤的明暗两块令牌一一对应（漏配会静默失效）', () => {
    const light = [...(BLOCKS.get("html[data-mode='light']") ?? new Map()).keys()].sort()
    const dark = [...(BLOCKS.get("html[data-mode='dark']") ?? new Map()).keys()].sort()
    expect(dark).toEqual(light)
  })

  for (const skin of SKINS) {
    for (const mode of MODES) {
      const where = `${skin} / ${mode}`

      it(`${where}：42 个色彩令牌全部配齐（漏配会沿用默认皮肤，看起来像没生效）`, () => {
        const selector = `html[data-skin='${skin}'][data-mode='${mode}']`
        // 默认皮肤（mono）走的就是 [data-mode] 那两块，没有覆盖块
        if (skin === 'mono') {
          expect(BLOCKS.has(selector)).toBe(false)
          return
        }
        const declared = BLOCKS.get(selector)
        expect(declared, `${selector} 不存在`).toBeDefined()
        const missing = REQUIRED_PER_SKIN.filter((name) => !(declared as Map<string, string>).has(name))
        expect(missing, `${where} 缺这些令牌`).toEqual([])
      })

      it(`${where}：对比度达标`, () => {
        const t = resolve(skin, mode)
        const get = (name: string): string => t.get(name) ?? ''

        /*
         * 主按钮 / 主区块标题带：--accent 当底，--accent-ink 当字。
         * 这是全项目最显眼的一处配对，4.5:1 是硬线。
         */
        expect(contrast(get('accent-ink'), get('accent')), '主按钮').toBeGreaterThanOrEqual(4.5)

        /*
         * 强调色当**文字**用（下拉的动作项、聚焦箭头、徽标）。
         * 它落在纸面上，所以对着 --surface 量，不是对着 --bg。
         */
        expect(contrast(get('accent-text'), get('surface')), '强调色文字').toBeGreaterThanOrEqual(4.5)

        /* 深色标题带 / 吸底操作条上的字 */
        expect(contrast(get('band-ink'), get('band')), '标题带').toBeGreaterThanOrEqual(4.5)

        /* 侧栏 */
        expect(contrast(get('rail-text'), get('rail')), '侧栏').toBeGreaterThanOrEqual(4.5)

        /* 正文。这一条要求 7:1（AAA），因为它是长时间阅读的主色 */
        expect(contrast(get('text'), get('bg')), '正文').toBeGreaterThanOrEqual(7)

        /* 卡片正文：卡片底是 --surface，不是 --bg */
        expect(contrast(get('text-muted'), get('surface')), '次要文字').toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})
