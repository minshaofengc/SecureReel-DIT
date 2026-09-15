/**
 * 哈希层测试。
 *
 * 重点验证三件事：
 *   1. xxHash64 与官方标准测试向量一致（字节序、十六进制大小写都必须对）
 *   2. 分片流式写入与一次性写入结果相同（拷贝引擎依赖这一点）
 *   3. 各算法输出长度符合清单与报告里的约定
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createStreamingHasher, hashBytes, hashLooksValid, sha512 } from '../src/main/hashing'
import { HASH_ALGORITHMS, HASH_VALUE_LENGTH } from '../src/shared/types'

/**
 * xxHash64 已知值（seed = 0）。
 *
 * 来源：xxHash 官方测试套件的三个基础向量（空串 / "a" / "abc"），
 * 其余值由 Python `xxhash` 4.0.1 独立实现算得并逐条核对过 ——
 * 不采用"凭印象写下"的向量，那种向量错了会掩盖真正的实现缺陷。
 */
const XXH64_VECTORS: [string, string][] = [
  ['', 'ef46db3751d8e999'],
  ['a', 'd24ec4f1a98c6e5b'],
  ['abc', '44bc2cf5ad770999'],
  ['message digest', '066ed728fceeb3be'],
  ['abcdefghijklmnopqrstuvwxyz', 'cfe1f278fa89835c'],
  ['hello world', '45ab6734b21e6968'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'aaa46907d3047814']
]

describe('xxHash64', () => {
  it.each(XXH64_VECTORS)('%j 的摘要为 %s', async (input, expected) => {
    expect(await hashBytes('xxhash64', Buffer.from(input, 'utf8'))).toBe(expected)
  })

  it('输出为 16 位小写十六进制', async () => {
    const value = await hashBytes('xxhash64', Buffer.from('anything'))
    expect(value).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('MD5', () => {
  it('与 node:crypto 的实现一致', async () => {
    const input = Buffer.from('hello world', 'utf8')
    const expected = createHash('md5').update(input).digest('hex')
    expect(await hashBytes('md5', input)).toBe(expected)
  })

  it('空内容为 d41d8cd98f00b204e9800998ecf8427e', async () => {
    expect(await hashBytes('md5', Buffer.alloc(0))).toBe('d41d8cd98f00b204e9800998ecf8427e')
  })
})

describe('ASC C4 流式实现', () => {
  it('与直接编码 SHA-512 的结果一致', async () => {
    const input = Buffer.from('the quick brown fox', 'utf8')
    const direct = createHash('sha512').update(input).digest('hex')
    const viaHasher = await hashBytes('asc-c4', input)
    expect(viaHasher.startsWith('c4')).toBe(true)

    const { encodeC4Digest } = await import('../src/main/hashing/c4')
    expect(viaHasher).toBe(encodeC4Digest(new Uint8Array(Buffer.from(direct, 'hex'))))
  })
})

describe('流式写入与一次性写入等价', () => {
  const payload = Buffer.alloc(3 * 1024 * 1024 + 12345)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) % 256

  it.each(HASH_ALGORITHMS)('%s 在任意分片下结果相同', async (algorithm) => {
    const oneShot = await hashBytes(algorithm, payload)

    const hasher = await createStreamingHasher(algorithm)
    const chunkSizes = [1, 4096, 65536, 1_000_003]
    let offset = 0
    let index = 0
    while (offset < payload.length) {
      const size = chunkSizes[index % chunkSizes.length] as number
      const end = Math.min(offset + size, payload.length)
      hasher.update(payload.subarray(offset, end))
      offset = end
      index++
    }
    expect(hasher.digest()).toBe(oneShot)
    expect(hasher.bytesHashed).toBe(payload.length)
  })

  it('空文件也能正常取值', async () => {
    for (const algorithm of HASH_ALGORITHMS) {
      const hasher = await createStreamingHasher(algorithm)
      const value = hasher.digest()
      expect(value.length).toBe(HASH_VALUE_LENGTH[algorithm])
    }
  })
})

describe('结果自检', () => {
  it('hashLooksValid 能识别正确与错误的长度', async () => {
    for (const algorithm of HASH_ALGORITHMS) {
      const value = await hashBytes(algorithm, Buffer.from('x'))
      expect(hashLooksValid(algorithm, value)).toBe(true)
      expect(hashLooksValid(algorithm, `${value}ff`)).toBe(false)
    }
    // 十六进制算法的大小写形态不合法；C4 是 Base58，本来就含大写
    expect(hashLooksValid('md5', (await hashBytes('md5', Buffer.from('x'))).toUpperCase())).toBe(false)
    expect(hashLooksValid('asc-c4', await hashBytes('asc-c4', Buffer.from('x')))).toBe(true)
    expect(hashLooksValid('asc-c4', 'c4notavalidid')).toBe(false)
  })

  it('sha512 工具函数与 node:crypto 一致', () => {
    const input = Buffer.from('abc')
    expect(Buffer.from(sha512(input)).toString('hex')).toBe(
      createHash('sha512').update(input).digest('hex')
    )
  })
})

describe('算法定义完整性', () => {
  it('每个算法都有明确的字符串长度', () => {
    for (const algorithm of HASH_ALGORITHMS) {
      expect(HASH_VALUE_LENGTH[algorithm]).toBeGreaterThan(0)
    }
    expect(HASH_VALUE_LENGTH.xxhash64).toBe(16)
    expect(HASH_VALUE_LENGTH.md5).toBe(32)
    // C4 的文本形态是 90 字符的 c4 标识，不是十六进制摘要
    expect(HASH_VALUE_LENGTH['asc-c4']).toBe(90)
  })

  it('未知算法会抛错而不是静默返回空值', async () => {
    await expect(createStreamingHasher('sha256' as never)).rejects.toThrow(/不支持的校验算法/)
  })
})
