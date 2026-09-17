/**
 * 消息表与占位符替换。
 *
 * 两张表（主进程的 `@shared/messages` 与渲染层的 `i18n/messages.ts`）都是
 * 中英成对的，类型上已经强制两边键位一致。这里补的是**类型管不到的部分**：
 * 空字符串、以及占位符替换真的会把 `{name}` 换掉。
 *
 * 为什么值得单独测：占位符写错不会报错、不会崩，界面上只是原样显示
 * 一个 `{count}`，或者干脆少了一截话 —— 属于"看着像没写完"的那种缺陷。
 */
import { describe, expect, it } from 'vitest'
import { fillTemplate, msg } from '../src/shared/messages'

describe('占位符替换', () => {
  it('把 {name} 换成对应的值', () => {
    expect(fillTemplate('共 {count} 个文件', { count: 3 })).toBe('共 3 个文件')
    expect(fillTemplate('备份到 {backup}', { backup: '/tmp/x.sqlite' })).toBe('备份到 /tmp/x.sqlite')
  })

  it('同一个占位符出现多次会全部替换', () => {
    expect(fillTemplate('{n} 与 {n}', { n: 7 })).toBe('7 与 7')
  })

  it('漏传参数时占位符原样保留（界面上很扎眼，比悄悄变成空串好）', () => {
    expect(fillTemplate('共 {count} 个文件', {})).toBe('共 {count} 个文件')
    expect(fillTemplate('共 {count} 个文件', { other: 1 })).toBe('共 {count} 个文件')
  })

  it('没有占位符的文本不受影响', () => {
    expect(fillTemplate('纯文本', { count: 1 })).toBe('纯文本')
  })
})

describe('主进程消息表', () => {
  it('取得到中英文两种文案', () => {
    expect(msg('zh-CN', 'job.notFound')).toBe('任务不存在。')
    expect(msg('en', 'job.notFound')).toBe('Job not found.')
  })

  it('带占位符的文案会被替换', () => {
    expect(msg('zh-CN', 'ipc.diagnosticsZipFailed', { code: 9, reason: '磁盘已满' })).toContain(
      '9'
    )
    expect(msg('en', 'ipc.diagnosticsZipFailed', { code: 9, reason: 'disk full' })).toContain(
      'disk full'
    )
  })

  it('运行中生成报告这条提示明确说了后果，而不只是"不允许"', () => {
    const zh = msg('zh-CN', 'job.reportWhileRunning')
    const en = msg('en', 'job.reportWhileRunning')
    expect(zh).toContain('重做')
    expect(en.toLowerCase()).toContain('redo')
  })

  it('未知键直接抛错，不静默返回空串', () => {
    expect(() => msg('zh-CN', 'no.suchKey' as never)).toThrow(/未知消息键/)
  })
})
