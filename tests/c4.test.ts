/**
 * ASC C4（SMPTE ST 2114:2017）正确性测试。
 *
 * 这里用的是**官方跨语言测试向量**：向量由 C4 的 Go 参考实现生成，
 * 并被 Python 参考实现 c4py 用作跨语言一致性基准。
 * 我们的 TypeScript 实现必须逐条与它们完全一致 ——
 * 这正是"本软件算出的 C4 值别人能验证"的全部依据。
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  C4_DIGEST_SIZE,
  C4_ID_LENGTH,
  decodeC4Id,
  encodeC4Digest,
  isNilC4Id,
  treeDigest
} from '../src/main/hashing/c4'
import { sha512 } from '../src/main/hashing'

interface SingleVector {
  input_repr: string
  input_bytes_hex: string
  c4id: string
  digest_hex: string
}

interface TreeVector {
  description: string
  inputs: string[]
  tree_id: string
}

const SINGLE_VECTORS: SingleVector[] = [
  {
    input_repr: 'empty string',
    input_bytes_hex: '',
    c4id: 'c459dsjfscH38cYeXXYogktxf4Cd9ibshE3BHUo6a58hBXmRQdZrAkZzsWcbWtDg5oQstpDuni4Hirj75GEmTc1sFT',
    digest_hex: 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e'
  },
  {
    input_repr: 'foo',
    input_bytes_hex: '666f6f',
    c4id: 'c45xZeXwMSpqXjpDumcHMA6mhoAmGHkUo7r9WmN2UgSEQzj9KjgseaQdkEJ11fGb5S1WEENcV3q8RFWwEeVpC7Fjk2',
    digest_hex: 'f7fbba6e0636f890e56fbbf3283e524c6fa3204ae298382d624741d0dc6638326e282c41be5e4254d8820772c5518a2c5a8c0c7f7eda19594a7eb539453e1ed7'
  },
  {
    input_repr: 'bar',
    input_bytes_hex: '626172',
    c4id: 'c45KgBYEvEE7Yfv16JAgnUT29bon2WsYAiBFZvnKNJiQR8kya2tRtEdfD6vi8bjvmmDDrepEGmkNvk88M8NWdeV9ig',
    digest_hex: 'd82c4eb5261cb9c8aa9855edd67d1bd10482f41529858d925094d173fa662aa91ff39bc5b188615273484021dfb16fd8284cf684ccf0fc795be3aa2fc1e6c181'
  },
  {
    input_repr: 'baz',
    input_bytes_hex: '62617a',
    c4id: 'c41hF4DAnW1q61imgv2q1kiuJ6DVsLXAHaBeCs2AG1XCuuPTQ5qWYgCAoD4eBcP2c1sz5x4oitFT7ERcmdXaoMmpFA',
    digest_hex: '22b41602570746d784cef124fa6713eec180f93af02a1bfee05528e94a1b053e4136b446015161d04e9900849575bd8f95f857773868a205dbed42413cd054f1'
  },
  {
    input_repr: 'hello world',
    input_bytes_hex: '68656c6c6f20776f726c64',
    c4id: 'c41yP4cqy7jmaRDzC2bmcGNZkuQb3VdftMk6YH7ynQ2Qw4zktKsyA9fk52xghNQNAdkpF9iFmFkKh2bNVG4kDWhsok',
    digest_hex: '309ecc489c12d6eb4cc40f50c902f2b4d0ed77ee511a7c7a9bcd3ca86d4cd86f989dd35bc5ff499670da34255b45b0cfd830e81f605dcf7dc5542e93ae9cd76f'
  },
  {
    input_repr: 'a',
    input_bytes_hex: '61',
    c4id: 'c41dF3bGD8iqVcrJJQpS6fEsVgg9iKeNHGCCEhK2C2cGYRm2dx8xeFU1wKbkBsCWdefaz82KeyfbBf8Pfkpm4C56cc',
    digest_hex: '1f40fc92da241694750979ee6cf582f2d5d7d28e18335de05abc54d0560e0f5302860c652bf08d560252aa5e74210546f369fbbbce8c12cfc7957b2652fe9a75'
  },
  {
    input_repr: 'b',
    input_bytes_hex: '62',
    c4id: 'c42eZGVoPnaooPQKkZQFrwnTKhsHwi8GZftxNyzKBfx3dZJm5Zzuy6JbTA2eZDLdL8PCPQ51f3SvLLBA7V3fjLZ8Nm',
    digest_hex: '5267768822ee624d48fce15ec5ca79cbd602cb7f4c2157a516556991f22ef8c7b5ef7b18d1ff41c59370efb0858651d44a936c11b7b144c48fe04df3c6a3e8da'
  },
  {
    input_repr: 'newline',
    input_bytes_hex: '0a',
    c4id: 'c44ooKUp8V54YNQ9R62vF14AAg83We1eYgddxZfs8bacNWnscbjZSYsEngoRCi7u7JBZJh7LA573FMMv8rBMYY9NLx',
    digest_hex: 'be688838ca8686e5c90689bf2ab585cef1137c999b48c70b92f67a5c34dc15697b5d11c982ed6d71be1e1e7f7b4e0733884aa97c3f7a339a8ed03577cf74be09'
  },
  {
    input_repr: 'null byte',
    input_bytes_hex: '00',
    c4id: 'c44gXrHw1dqafC4Vo2RTmHpRK3d3x8aYXLg81BtsMBWrWgQu9n45JWDMTM5yGhR1Ug1Reo4sFi4apJe9Zmoexx9Tc9',
    digest_hex: 'b8244d028981d693af7b456af8efa4cad63d282e19ff14942c246e50d9351d22704a802a71c3580b6370de4ceb293c324a8423342557d4e5c38438f0e36910ee'
  }
]

const TREE_VECTORS: TreeVector[] = [
  {
    description: 'tree of foo+bar',
    inputs: ['foo', 'bar'],
    tree_id: 'c458j3otjXhCWJGZxbxvbf2BuFaRknZkCBQwUWJAQRZFKxuU9zpUpVQxPqYwGHuK56e7aJZSYE1fNsHZ8WtNDfq3hK'
  },
  {
    description: 'tree of foo+bar+baz',
    inputs: ['foo', 'bar', 'baz'],
    tree_id: 'c42To6i5r7uwfJUt7p2JY9XKTUYqyCCGQCip3ujctUXzwYMMiSZmRKwm657ninwK41uZ5RRVCUjgHXcNzD3TAGqUey'
  },
  {
    description: 'tree of bar+foo (order independent)',
    inputs: ['bar', 'foo'],
    tree_id: 'c458j3otjXhCWJGZxbxvbf2BuFaRknZkCBQwUWJAQRZFKxuU9zpUpVQxPqYwGHuK56e7aJZSYE1fNsHZ8WtNDfq3hK'
  }
]

function digestOfHex(hex: string): Uint8Array {
  return new Uint8Array(createHash('sha512').update(Buffer.from(hex, 'hex')).digest())
}

function identify(text: string): string {
  return encodeC4Digest(new Uint8Array(createHash('sha512').update(Buffer.from(text, 'utf8')).digest()))
}

describe('ASC C4 单内容标识（官方跨语言向量）', () => {
  it.each(SINGLE_VECTORS)('$input_repr 的 C4 ID 与官方一致', (vector) => {
    const bytes =
      vector.input_bytes_hex === ''
        ? Buffer.alloc(0)
        : Buffer.from(vector.input_bytes_hex, 'hex')
    const digest = new Uint8Array(createHash('sha512').update(bytes).digest())

    expect(Buffer.from(digest).toString('hex')).toBe(vector.digest_hex)
    expect(encodeC4Digest(digest)).toBe(vector.c4id)
  })

  it.each(SINGLE_VECTORS)('$input_repr 的 ID 可以解析回原摘要', (vector) => {
    const decoded = decodeC4Id(vector.c4id)
    expect(decoded.length).toBe(C4_DIGEST_SIZE)
    expect(Buffer.from(decoded).toString('hex')).toBe(vector.digest_hex)
  })
})

describe('ASC C4 集合标识（Merkle 树）', () => {
  it.each(TREE_VECTORS)('$description', (vector) => {
    const digests = vector.inputs.map((input) => digestOfHex(Buffer.from(input, 'utf8').toString('hex')))
    const root = treeDigest(digests, sha512)
    expect(encodeC4Digest(root)).toBe(vector.tree_id)
  })

  it('输入顺序不影响集合标识', () => {
    const a = digestOfHex(Buffer.from('foo').toString('hex'))
    const b = digestOfHex(Buffer.from('bar').toString('hex'))
    expect(encodeC4Digest(treeDigest([a, b], sha512))).toBe(encodeC4Digest(treeDigest([b, a], sha512)))
  })

  it('重复元素会被去重', () => {
    const a = digestOfHex(Buffer.from('foo').toString('hex'))
    expect(encodeC4Digest(treeDigest([a, a], sha512))).toBe(encodeC4Digest(treeDigest([a], sha512)))
  })

  it('空集合返回全零标识', () => {
    const root = treeDigest([], sha512)
    expect(isNilC4Id(encodeC4Digest(root))).toBe(true)
  })
})

describe('C4 ID 格式约束', () => {
  it('长度恒为 90 字符且以 c4 开头', () => {
    const id = identify('foo')
    expect(id.length).toBe(C4_ID_LENGTH)
    expect(id.startsWith('c4')).toBe(true)
  })

  it('只使用 Base58 字母表（不含 0、O、I、l）', () => {
    const id = identify('foo')
    for (const char of id.slice(2)) {
      expect('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz').toContain(char)
    }
    expect(id.slice(2)).not.toMatch(/[0OIl]/)
  })

  it('拒绝长度不对的输入', () => {
    expect(() => decodeC4Id('c4short')).toThrow(/90 个字符/)
  })

  it('拒绝前缀不对的输入', () => {
    expect(() => decodeC4Id(`xx${'1'.repeat(88)}`)).toThrow(/必须以 "c4" 开头/)
  })

  it('拒绝非法 Base58 字符', () => {
    expect(() => decodeC4Id(`c4${'0'.repeat(88)}`)).toThrow(/非法 Base58 字符/)
  })

  it('拒绝超出 512 位范围的输入', () => {
    expect(() => decodeC4Id(`c4${'z'.repeat(88)}`)).toThrow(/超出 512 位/)
  })

  it('拒绝长度不对的摘要', () => {
    expect(() => encodeC4Digest(new Uint8Array(32))).toThrow(/必须是 64 字节/)
  })
})
