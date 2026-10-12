import { describe, expect, it } from 'vitest'
import { buildProxyArgs, proxyRelPathFor } from '../src/main/media/proxy'

describe('代理安全输出', () => {
  it('保留来源目录与完整原文件名，区分同名不同扩展名', () => {
    expect(proxyRelPathFor('CARD_A/C001.mov', 'prores')).toBe('Proxies/CARD_A/C001.mov.mov')
    expect(proxyRelPathFor('CARD_A/C001.mxf', 'prores')).not.toBe(
      proxyRelPathFor('CARD_A/C001.mov', 'prores')
    )
  })
  it('编码命令不覆盖已存在输出', () => {
    const args = buildProxyArgs('/input.mov', '/output.mov', {
      codec: 'prores',
      profile: '422-proxy',
      resolution: '1080p'
    })
    expect(args).not.toContain('-y')
    expect(args).toContain('-n')
  })
})
