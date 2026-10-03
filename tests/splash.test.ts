/**
 * 开屏页面模板的测试。
 *
 * 为什么值得单独测：这个窗口**不接 IPC、不读数据库、也不在冒烟流程里**
 * （默认就不建它），所以它坏掉的时候不会有任何报错 —— 表现只是"启动时
 * 那块牌子有点不对"，而那块牌子很多人根本不会盯着看。属于最容易烂掉、
 * 又最难被发现的界面。
 *
 * 下面钉三件事：署名与版本在不在、动画元素在不在、以及**不许有任何外部资源**。
 * 最后一条是安全底线：这个页面用 `data:` 协议加载，一旦有外链
 * （字体、图片、脚本），等于给了它一个不受 Content-Security-Policy 之外约束的出口。
 */
import { describe, expect, it } from 'vitest'
import { SPLASH_PALETTE, splashHtml } from '../src/main/splash-html'
import { APP_NAME, APP_VERSION } from '../src/shared/version'

const html = splashHtml(SPLASH_PALETTE.dark)

describe('开屏页面模板', () => {
  it('带上软件名与版本号', () => {
    expect(html).toContain(APP_NAME)
    expect(html).toContain(`v${APP_VERSION}`)
  })

  it('带上开发者与鸣谢署名', () => {
    expect(html).toContain('Shanfly 鱼鱼子')
    expect(html).toContain('吉林动画学院电影学院影制系')
    expect(html).toContain('开发者')
    expect(html).toContain('鸣谢')
  })

  it('胶片与时码的元素都在（动画不是靠注释写的）', () => {
    expect(html).toContain('class="strip"')
    expect(html).toContain('class="scan"')
    expect(html).toContain('id="tc"')
    // 时码按 24 fps 往上跳，得真有那个定时器
    expect(html).toContain('setInterval')
    expect(html).toContain('24')
  })

  it('暴露了主进程要用的两个钩子', () => {
    expect(html).toContain('__splashSetStatus')
    expect(html).toContain('__splashFadeOut')
  })

  it('系统开了减弱动态效果时有降级（不滚动、不扫光）', () => {
    expect(html).toContain('prefers-reduced-motion')
  })

  it('一个外部资源都不引用', () => {
    // 这是安全底线：页面走 data: 协议加载，任何外链都是额外攻击面
    expect(html).not.toMatch(/<img\b/i)
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i)
    expect(html).not.toMatch(/@import/i)
    expect(html).not.toMatch(/url\(\s*["']?https?:/i)
  })

  it('带上了限制性 CSP', () => {
    expect(html).toContain("default-src 'none'")
  })

  it('两种明暗给的是不同的色值', () => {
    const light = splashHtml(SPLASH_PALETTE.light)
    expect(light).not.toBe(html)
    // 浅色底必须比深色底亮，否则就是两套配色接反了
    const lightness = (hex: string): number => parseInt(hex.slice(1, 3), 16)
    expect(lightness(SPLASH_PALETTE.light.card)).toBeGreaterThan(
      lightness(SPLASH_PALETTE.dark.card)
    )
    expect(lightness(SPLASH_PALETTE.light.text)).toBeLessThan(
      lightness(SPLASH_PALETTE.dark.text)
    )
  })

  it('配色是合法十六进制（拼错了 CSS 会静默失效，看不出来）', () => {
    for (const palette of [SPLASH_PALETTE.light, SPLASH_PALETTE.dark]) {
      for (const value of Object.values(palette)) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })
})
