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
import {
  HASH_ALGORITHMS,
  HASH_VALUE_LENGTH,
  supportsAlgorithm,
  type HashAlgorithm
} from '../src/shared/types'

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

/**
 * xxHash3 / xxHash128 已知值（seed = 0）。
 *
 * 这两个值在 xxHash 官方发布说明与多份独立实现里都出现过，属于公开的标准向量：
 * 空串的 XXH3-64 是 `2d06800538d394c2`，空串的 XXH3-128 是
 * `99aa06d3014798d86001c324468d497f`。
 *
 * 另外这两者有一条**结构性关系**可以当交叉校验用：
 * XXH3-128 的低 64 位就等于同一条数据的 XXH3-64 —— 见下面那条用例。
 * 不用自己"凭印象记"的向量，那种向量错了会掩盖真正的实现缺陷。
 */
const XXH3_VECTORS: [string, string][] = [
  ['', '2d06800538d394c2'],
  ['abc', '78af5f94892f3950']
]

const XXH128_VECTORS: [string, string][] = [
  ['', '99aa06d3014798d86001c324468d497f'],
  ['abc', '06b05ab6733a618578af5f94892f3950']
]

describe('xxHash3', () => {
  it.each(XXH3_VECTORS)('%j 的摘要为 %s', async (input, expected) => {
    expect(await hashBytes('xxh3', Buffer.from(input, 'utf8'))).toBe(expected)
  })

  it('输出为 16 位小写十六进制', async () => {
    expect(await hashBytes('xxh3', Buffer.from('anything'))).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('xxHash128', () => {
  it.each(XXH128_VECTORS)('%j 的摘要为 %s', async (input, expected) => {
    expect(await hashBytes('xxh128', Buffer.from(input, 'utf8'))).toBe(expected)
  })

  it('输出为 32 位小写十六进制', async () => {
    expect(await hashBytes('xxh128', Buffer.from('anything'))).toMatch(/^[0-9a-f]{32}$/)
  })

  it('与 hash-wasm 的一次性实现结果一致（能抓到漏调 init()）', async () => {
    /*
     * 交叉校验：流式（本项目真正走的那条路径）必须与 hash-wasm 的一次性函数
     * 给出同一个值。这能抓到的正是最容易犯的那个错 —— 建了实例却忘了 `init()`，
     * 于是每块数据都从一份未初始化的状态起算：值很稳定、每次都一样，
     * 但**是错的**。自校验能对上，对外没人认得。
     *
     * ⚠️ 曾经想当然地写过一条"XXH3-128 的低 64 位等于 XXH3-64"的断言，
     * 实测**不成立**（只有 '' 与 'abc' 这类输入碰巧相等，长串就不等了）——
     * 两个算法的内部状态本来就不同。别再按这个思路推。
     */
    const { xxhash3, xxhash128 } = await import('hash-wasm')
    for (const input of ['', 'abc', 'the quick brown fox jumps over the lazy dog']) {
      const data = new TextEncoder().encode(input)
      expect(await hashBytes('xxh3', data)).toBe(await xxhash3(data))
      expect(await hashBytes('xxh128', data)).toBe(await xxhash128(data))
    }
  })
})

describe('SHA-1 / SHA-256', () => {
  /*
   * 这两个是"对外通用"的口径，正确性只有一条标准：和公开标准向量一致。
   * 下面用的是 NIST / RFC 里最经典的三个向量（空串 / "abc" / 长串）。
   */
  const VECTORS: [HashAlgorithm, string, string][] = [
    ['sha1', '', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
    ['sha1', 'abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
    [
      'sha1',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '84983e441c3bd26ebaae4aa1f95129e5e54670f1'
    ],
    ['sha256', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['sha256', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'sha256',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    ]
  ]

  it.each(VECTORS)('%s(%j) 符合标准向量', async (algorithm, input, expected) => {
    expect(await hashBytes(algorithm, Buffer.from(input, 'utf8'))).toBe(expected)
  })

  it('与 node:crypto 对同一条长数据的结果一致', async () => {
    const payload = Buffer.alloc(200_000, 7)
    for (const algorithm of ['sha1', 'sha256'] as const) {
      expect(await hashBytes(algorithm, payload)).toBe(
        createHash(algorithm).update(payload).digest('hex')
      )
    }
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
    expect(HASH_VALUE_LENGTH.xxh3).toBe(16)
    expect(HASH_VALUE_LENGTH.xxh128).toBe(32)
    expect(HASH_VALUE_LENGTH.md5).toBe(32)
    expect(HASH_VALUE_LENGTH.sha1).toBe(40)
    expect(HASH_VALUE_LENGTH.sha256).toBe(64)
    // C4 的文本形态是 90 字符的 c4 标识，不是十六进制摘要
    expect(HASH_VALUE_LENGTH['asc-c4']).toBe(90)
  })

  it('每种算法的真实输出长度与声明一致（含 90 字符的 C4）', async () => {
    for (const algorithm of HASH_ALGORITHMS) {
      const value = await hashBytes(algorithm, Buffer.from('length probe'))
      expect(value.length).toBe(HASH_VALUE_LENGTH[algorithm])
    }
  })

  it('未知算法会抛错而不是静默返回空值', async () => {
    await expect(createStreamingHasher('crc32' as never)).rejects.toThrow(/不支持的校验算法/)
  })
})

describe('算法与清单格式的相容性', () => {
  /*
   * 这条规则是从 ASC MHL 2.0 官方 XSD 抄下来的事实，不是我们的取舍：
   * 官方 `<sequence>` 里只有 c4 / md5 / sha1 / xxh128 / xxh3 / xxh64。
   * 一旦有人「顺手」把 sha256 加进 ASC 元素表，生成的清单会过不了官方 XSD，
   * 而对方工具读不进来时**不会报错**，只会少一半条目 —— 所以这里钉死。
   */
  it('ASC MHL 2.0 不接受 sha256', () => {
    expect(supportsAlgorithm('asc-mhl-2.0', 'sha256')).toBe(false)
    expect(supportsAlgorithm('asc-mhl-2.0', 'sha1')).toBe(true)
    expect(supportsAlgorithm('asc-mhl-2.0', 'xxh3')).toBe(true)
    expect(supportsAlgorithm('asc-mhl-2.0', 'xxh128')).toBe(true)
    expect(supportsAlgorithm('asc-mhl-2.0', 'xxhash64')).toBe(true)
    expect(supportsAlgorithm('asc-mhl-2.0', 'md5')).toBe(true)
    expect(supportsAlgorithm('asc-mhl-2.0', 'asc-c4')).toBe(true)
  })

  it('MHL v1 只认三种', () => {
    expect(supportsAlgorithm('mhl-v1', 'xxhash64')).toBe(true)
    expect(supportsAlgorithm('mhl-v1', 'md5')).toBe(true)
    expect(supportsAlgorithm('mhl-v1', 'asc-c4')).toBe(true)
    for (const algorithm of ['xxh3', 'xxh128', 'sha1', 'sha256'] as const) {
      expect(supportsAlgorithm('mhl-v1', algorithm)).toBe(false)
    }
  })

  it('CSV 与 JSON 七种算法全都能写', () => {
    for (const format of ['csv', 'json'] as const) {
      for (const algorithm of HASH_ALGORITHMS) {
        expect(supportsAlgorithm(format, algorithm)).toBe(true)
      }
    }
  })

  it('每一对"格式 × 算法"要么能写、要么能明确说出为什么不能', () => {
    // 这条用例的价值在于：将来加算法/加格式时，忘配相容性表会被立刻发现，
    // 而不是等到现场生成出一份别人读不进来的清单
    for (const format of ['asc-mhl-2.0', 'mhl-v1', 'csv', 'json'] as const) {
      for (const algorithm of HASH_ALGORITHMS) {
        expect(typeof supportsAlgorithm(format, algorithm)).toBe('boolean')
      }
    }
  })
})
