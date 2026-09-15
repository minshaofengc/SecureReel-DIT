import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_NAME, APP_VERSION } from '../src/shared/version'

/**
 * 版本号一致性。
 *
 * 开发模式与打包模式的版本来源不同（见 src/shared/version.ts 的说明），
 * 用这条断言把两个来源钉在一起，避免界面上显示的版本号和实际发布版本对不上。
 */
describe('版本号一致性', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
    version: string
    productName: string
  }

  it('APP_VERSION 与 package.json 的 version 一致', () => {
    expect(APP_VERSION).toBe(pkg.version)
  })

  it('APP_NAME 与 package.json 的 productName 一致', () => {
    expect(APP_NAME).toBe(pkg.productName)
  })

  it('版本号符合 semver 形态', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
