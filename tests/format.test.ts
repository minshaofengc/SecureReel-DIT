/**
 * 跨进程格式化工具的纯函数契约。
 *
 * 重点盯 `countExtension` —— 它决定拷贝页那条「这批来源里有 .CRM」的提示
 * 触不触发。判定本身只有一行，但大小写/点号的边界最容易悄悄写错，
 * 而写错的后果是"该提示时不提示"（用户会以为软件坏了），所以用测试钉死。
 */
import { describe, expect, it } from 'vitest'
import { countExtension } from '../src/shared/format'

describe('countExtension', () => {
  const extensions = [
    { ext: 'crm', count: 12 },
    { ext: 'mov', count: 3 },
    { ext: 'txt', count: 1 }
  ]

  it('数到指定扩展名的文件数', () => {
    expect(countExtension(extensions, 'crm')).toBe(12)
    expect(countExtension(extensions, 'mov')).toBe(3)
  })

  it('查不到时返回 0（而不是抛错或 undefined）', () => {
    expect(countExtension(extensions, 'r3d')).toBe(0)
  })

  it('扩展名大小写不敏感', () => {
    expect(countExtension(extensions, 'CRM')).toBe(12)
    expect(countExtension(extensions, 'Crm')).toBe(12)
  })

  it('允许传带点号的扩展名（.crm 与 crm 等价）', () => {
    expect(countExtension(extensions, '.crm')).toBe(12)
  })

  it('直方图里的扩展名若带大写也能匹配（两边都归一）', () => {
    expect(countExtension([{ ext: 'CRM', count: 5 }], 'crm')).toBe(5)
  })

  it('空直方图返回 0', () => {
    expect(countExtension([], 'crm')).toBe(0)
  })
})
