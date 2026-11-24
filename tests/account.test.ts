/**
 * 账号与同步的纯逻辑。
 *
 * 这里钉两件事：
 *   1. 同步白名单不能包含任何本机路径（否则换台机器就指向不存在的文件）；
 *   2. 逐键合并必须"谁新听谁的"，且旧数据不能覆盖新数据。
 */
import { describe, expect, it } from 'vitest'
import {
  isValidEmail,
  mergeSettings,
  normalizeEmail,
  SYNCABLE_SETTING_KEYS,
  type CloudSettings
} from '@shared/account'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'

describe('邮箱归一化与校验', () => {
  it('去空白并转小写', () => {
    expect(normalizeEmail('  Shanfly@Example.COM ')).toBe('shanfly@example.com')
  })

  it('接受常见写法', () => {
    expect(isValidEmail('a@b.co')).toBe(true)
    expect(isValidEmail('first.last+tag@sub.example.com')).toBe(true)
  })

  it('拒绝明显不是邮箱的输入', () => {
    expect(isValidEmail('')).toBe(false)
    expect(isValidEmail('a@b')).toBe(false)
    expect(isValidEmail('a b@c.com')).toBe(false)
    expect(isValidEmail('@example.com')).toBe(false)
    expect(isValidEmail('a@example.c')).toBe(false)
  })
})

describe('同步白名单', () => {
  it('不包含任何本机绝对路径', () => {
    for (const key of ['ffmpegDir', 'arrirawHdePath', 'frameRestoreLutPath', 'proxyLutPath', 'reportOutputDir']) {
      expect(SYNCABLE_SETTING_KEYS.includes(key as never)).toBe(false)
    }
  })

  it('不包含隐藏的统计开关', () => {
    expect(SYNCABLE_SETTING_KEYS.includes('usageStatsEnabled' as never)).toBe(false)
  })

  it('语言、主题与报告设置都在白名单里', () => {
    for (const key of ['language', 'themeId', 'themeMode', 'reportTheme', 'hashAlgorithm']) {
      expect(SYNCABLE_SETTING_KEYS.includes(key as never)).toBe(true)
    }
  })
})

describe('逐键合并', () => {
  const local: AppSettings = { ...DEFAULT_SETTINGS, language: 'en', themeId: 'steel' }

  it('云端更新时应用到本机', () => {
    const cloud: CloudSettings = {
      language: { value: 'zh-CN', updatedAt: 2000 },
      themeId: { value: 'steel', updatedAt: 1000 }
    }
    const { apply, push } = mergeSettings(local, { language: 1000, themeId: 1000 }, cloud)
    expect(apply).toEqual({ language: 'zh-CN' })
    expect(push).toEqual({})
  })

  it('本机更新时推到云端', () => {
    const cloud: CloudSettings = {
      language: { value: 'zh-CN', updatedAt: 1000 },
      themeId: { value: 'mono', updatedAt: 1000 }
    }
    const { apply, push } = mergeSettings(local, { language: 3000, themeId: 5000 }, cloud)
    expect(apply).toEqual({})
    expect(push).toEqual({
      language: { value: 'en', updatedAt: 3000 },
      themeId: { value: 'steel', updatedAt: 5000 }
    })
  })

  it('时间戳相等时两边都不动', () => {
    const cloud: CloudSettings = { language: { value: 'zh-CN', updatedAt: 1000 } }
    const { apply, push } = mergeSettings(local, { language: 1000 }, cloud)
    expect(apply).toEqual({})
    expect(push).toEqual({})
  })

  it('云端没有的键，本机改过就推上去', () => {
    const { push } = mergeSettings(local, { language: 1500 }, {})
    expect(push).toEqual({ language: { value: 'en', updatedAt: 1500 } })
  })

  it('云端没有、本机也没改过的键不推', () => {
    const { push } = mergeSettings(local, {}, {})
    expect(push).toEqual({})
  })

  it('云端多出来的键（不在白名单）被忽略', () => {
    const cloud: CloudSettings = { ffmpegDir: { value: '/usr/local/bin', updatedAt: 9999 } }
    const { apply, push } = mergeSettings(local, {}, cloud)
    expect(apply).toEqual({})
    expect(push).toEqual({})
  })

  it('不同键各走各的：A 机改主题、B 机改语言不会互相覆盖', () => {
    const cloud: CloudSettings = {
      language: { value: 'zh-CN', updatedAt: 1000 },
      themeId: { value: 'steel', updatedAt: 4000 }
    }
    const { apply, push } = mergeSettings(local, { language: 3000, themeId: 1000 }, cloud)
    expect(apply).toEqual({ themeId: 'steel' })
    expect(push).toEqual({ language: { value: 'en', updatedAt: 3000 } })
  })
})
