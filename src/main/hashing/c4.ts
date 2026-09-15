/**
 * ASC C4 内容标识（SMPTE ST 2114:2017）。
 *
 * 算法：
 *   1. 计算内容的 SHA-512 摘要（64 字节）
 *   2. 把摘要当作大端无符号整数
 *   3. 用 Base58（比特币字母表）编码，右对齐补 '1' 到 88 字符
 *   4. 前置 "c4"，得到 90 字符的 ID
 *
 * 集合标识（tree id）：
 *   1. 把各 ID 的 64 字节摘要排序去重
 *   2. 自底向上构造 Merkle 树，每层两两配对
 *   3. 配对前先对两个摘要排序，保证与原顺序无关
 *   4. 哈希方式为 SHA-512(较小的摘要 ‖ 较大的摘要)
 *   5. 落单的摘要原样晋级
 *
 * 正确性由 tests/c4.test.ts 中的官方跨语言测试向量保证。
 */

export const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export const C4_PREFIX = 'c4'
export const C4_ID_LENGTH = 90 // 2 位前缀 + 88 位编码
export const C4_DIGEST_SIZE = 64 // SHA-512 = 512 bit = 64 字节

const BASE58_MAP: ReadonlyMap<string, number> = new Map(
  [...BASE58_ALPHABET].map((char, index) => [char, index])
)

const ZERO_DIGEST = new Uint8Array(C4_DIGEST_SIZE)

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte)
  }
  return value
}

function bigIntToBytes(value: bigint, size: number): Uint8Array {
  const out = new Uint8Array(size)
  let remaining = value
  for (let i = size - 1; i >= 0; i--) {
    out[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  if (remaining !== 0n) {
    throw new Error(`数值超出 ${size} 字节可表示的范围`)
  }
  return out
}

/** 把 64 字节摘要编码成 90 字符的 C4 ID。 */
export function encodeC4Digest(digest: Uint8Array): string {
  if (digest.length !== C4_DIGEST_SIZE) {
    throw new Error(`C4 摘要必须是 ${C4_DIGEST_SIZE} 字节，实际 ${digest.length} 字节`)
  }

  let value = bytesToBigInt(digest)

  // '1' 是 Base58 中的零，用于右对齐填充
  const chars: string[] = new Array<string>(C4_ID_LENGTH).fill('1')
  chars[0] = 'c'
  chars[1] = '4'

  let cursor = C4_ID_LENGTH - 1
  while (cursor > 1 && value > 0n) {
    const remainder = Number(value % 58n)
    value /= 58n
    chars[cursor] = BASE58_ALPHABET[remainder] as string
    cursor--
  }

  return chars.join('')
}

/** 把 90 字符的 C4 ID 解析回 64 字节摘要。任何非法输入都会抛错。 */
export function decodeC4Id(id: string): Uint8Array {
  if (id.length !== C4_ID_LENGTH) {
    throw new Error(`C4 ID 必须是 ${C4_ID_LENGTH} 个字符，实际 ${id.length} 个`)
  }
  if (!id.startsWith(C4_PREFIX)) {
    throw new Error(`C4 ID 必须以 "${C4_PREFIX}" 开头，实际为 "${id.slice(0, 2)}"`)
  }

  let value = 0n
  for (let i = 2; i < C4_ID_LENGTH; i++) {
    const char = id[i] as string
    const digit = BASE58_MAP.get(char)
    if (digit === undefined) {
      throw new Error(`第 ${i} 位出现非法 Base58 字符 "${char}"`)
    }
    value = value * 58n + BigInt(digit)
  }

  if (value >> 512n !== 0n) {
    throw new Error('C4 ID 数值超出 512 位范围')
  }

  return bigIntToBytes(value, C4_DIGEST_SIZE)
}

/** C4 ID 是否为全零（空集合的标识）。 */
export function isNilC4Id(id: string): boolean {
  return id === encodeC4Digest(ZERO_DIGEST)
}

/** 比较两个摘要的大小，等价于按大端字节序做字典序比较。 */
function compareDigests(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const left = a[i] as number
    const right = b[i] as number
    if (left !== right) return left - right
  }
  return a.length - b.length
}

/**
 * 计算一组摘要的集合标识（顺序无关）。
 *
 * 输入为空集合时返回全零摘要对应的 ID。
 * 单元素集合直接返回该元素。
 */
export function treeDigest(
  digests: Uint8Array[],
  sha512: (data: Uint8Array) => Uint8Array
): Uint8Array {
  if (digests.length === 0) {
    return new Uint8Array(ZERO_DIGEST)
  }

  // 去重 + 排序，保证顺序无关
  const unique = [...digests].sort(compareDigests)
  const deduped: Uint8Array[] = []
  for (const digest of unique) {
    const last = deduped[deduped.length - 1]
    if (last === undefined || compareDigests(last, digest) !== 0) {
      deduped.push(digest)
    }
  }

  if (deduped.length === 1) {
    return deduped[0] as Uint8Array
  }

  let level: Uint8Array[] = deduped
  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i] as Uint8Array
      const b = level[i + 1]
      if (b === undefined) {
        next.push(a) // 落单原样晋级
        continue
      }
      const [first, second] = compareDigests(a, b) <= 0 ? [a, b] : [b, a]
      next.push(sha512(concatBytes(first, second)))
    }
    level = next
  }

  return level[0] as Uint8Array
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('十六进制字符串长度必须为偶数')
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) {
      throw new Error('十六进制字符串包含非法字符')
    }
    out[i] = byte
  }
  return out
}
