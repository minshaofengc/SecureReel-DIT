/**
 * 哈希层 —— 统一的流式校验接口。
 *
 * 拷贝引擎在「读源」和「目标重读」两处都使用同一个 `StreamingHasher`，
 * 因此两侧算出的值口径必然一致，不存在两套实现漂移的可能。
 *
 * 关键设计：哈希器必须先用 `createStreamingHasher()` 异步创建（WASM 初始化），
 * 创建完成后 `update()` 才是同步、零缓冲的真流式写入。
 * 绝不能把分片暂存到内存里 —— 单条素材动辄上百 GB。
 *
 * 算法：
 *   - xxhash64 / xxh3 / xxh128：速度快，适合现场大批量素材（xxh3 在现代 CPU 上最快）
 *   - md5 / sha1 / sha256：通用与归档口径，对接外部流程（走 Node 内置 crypto）
 *   - asc-c4：SMPTE ST 2114:2017，归档用，也是 ASC MHL 的原生口径
 */
import { createHash } from 'node:crypto'
import { createXXHash128, createXXHash3, createXXHash64 } from 'hash-wasm'
import type { HashAlgorithm } from '@shared/types'
import { HASH_VALUE_LENGTH } from '@shared/types'
import { bytesToHex, decodeC4Id, encodeC4Digest } from './c4'

export interface StreamingHasher {
  readonly algorithm: HashAlgorithm
  /** 已喂入的字节数 */
  readonly bytesHashed: number
  /** 同步写入一片数据。创建完成后可无限次调用，不缓存任何内容。 */
  update(chunk: Uint8Array): void
  /** 结束并返回小写十六进制字符串。每个实例只能调用一次。 */
  digest(): string
}

/**
 * 走 Node 内置 crypto 的哈希器（md5 / sha1 / sha256）。
 *
 * 这三种是"外部流程认"的口径，速度不是重点，稳定性与标准一致性才是 ——
 * 所以不用 WASM 实现，直接用 Node 自带的那份（FIPS 实现在系统里）。
 */
class NodeCryptoHasher implements StreamingHasher {
  readonly algorithm: HashAlgorithm
  private readonly inner: ReturnType<typeof createHash>
  private readonly encoder: (digest: Uint8Array) => string
  private bytes = 0
  private finalized = false

  constructor(algorithm: HashAlgorithm, name: string, encoder: (digest: Uint8Array) => string) {
    this.algorithm = algorithm
    this.inner = createHash(name)
    this.encoder = encoder
  }

  get bytesHashed(): number {
    return this.bytes
  }

  update(chunk: Uint8Array): void {
    if (this.finalized) throw new Error('哈希实例已结束，不能继续写入')
    this.inner.update(chunk)
    this.bytes += chunk.length
  }

  digest(): string {
    if (this.finalized) throw new Error('哈希实例已结束，不能重复取值')
    this.finalized = true
    return this.encoder(new Uint8Array(this.inner.digest()))
  }
}

/** SHA-512 → C4 标识（SMPTE ST 2114 规定底层用 SHA-512）。 */
class Sha512BasedHasher extends NodeCryptoHasher {
  constructor(algorithm: HashAlgorithm, encoder: (digest: Uint8Array) => string) {
    super(algorithm, 'sha512', encoder)
  }
}

/** hash-wasm 的流式哈希器（xxhash64 / xxh3 / xxh128 共用同一套接口）。 */
class WasmXxHasher implements StreamingHasher {
  readonly algorithm: HashAlgorithm
  private bytes = 0
  private finalized = false
  private readonly hasher: { update(data: Uint8Array): void; digest(kind: 'hex'): string }

  constructor(
    algorithm: HashAlgorithm,
    hasher: { update(data: Uint8Array): void; digest(kind: 'hex'): string }
  ) {
    this.algorithm = algorithm
    this.hasher = hasher
  }

  get bytesHashed(): number {
    return this.bytes
  }

  update(chunk: Uint8Array): void {
    if (this.finalized) throw new Error('哈希实例已结束，不能继续写入')
    this.hasher.update(chunk)
    this.bytes += chunk.length
  }

  digest(): string {
    if (this.finalized) throw new Error('哈希实例已结束，不能重复取值')
    this.finalized = true
    return this.hasher.digest('hex')
  }
}

/**
 * 创建流式哈希器。
 *
 * 对 xxHash 三兄弟而言这个 Promise 会等到 WASM 实例就绪；
 * 因此请在每个文件开始拷贝**之前**创建，不要在拷贝循环中间创建。
 *
 * ⚠️ xxHash3 / xxHash128 的 `init()` 是必须调的，和唯一区别只在内部状态长度 ——
 * 漏掉它不会报错，但会把第一个分片当种子用，结果是**每个文件都算出一个
 * 稳定但错误的值**（自校验能对上，对外却不认得），属于最难发现的一类错。
 */
export async function createStreamingHasher(algorithm: HashAlgorithm): Promise<StreamingHasher> {
  switch (algorithm) {
    case 'md5':
      return new NodeCryptoHasher('md5', 'md5', bytesToHex)
    case 'sha1':
      return new NodeCryptoHasher('sha1', 'sha1', bytesToHex)
    case 'sha256':
      return new NodeCryptoHasher('sha256', 'sha256', bytesToHex)
    case 'asc-c4':
      return new Sha512BasedHasher('asc-c4', (digest) => encodeC4Digest(digest))
    case 'xxhash64':
    case 'xxh3':
    case 'xxh128': {
      const wasm =
        algorithm === 'xxhash64'
          ? await createXXHash64()
          : algorithm === 'xxh3'
            ? await createXXHash3()
            : await createXXHash128()
      wasm.init()
      return new WasmXxHasher(algorithm, wasm)
    }
    default: {
      const never: never = algorithm
      throw new Error(`不支持的校验算法：${String(never)}`)
    }
  }
}

/**
 * 校验值形态自检。
 *
 * 每种算法的文本形态不同，必须分开判断：
 *   · xxhash64 / xxh3 / xxh128 / md5 / sha1 / sha256 → 纯小写十六进制
 *   · ASC C4 → 90 字符、`c4` 开头、其余为 Base58（含大小写字母，不是十六进制）
 */
export function hashLooksValid(algorithm: HashAlgorithm, value: string): boolean {
  if (value.length !== HASH_VALUE_LENGTH[algorithm]) return false
  if (algorithm === 'asc-c4') {
    try {
      decodeC4Id(value)
      return true
    } catch {
      return false
    }
  }
  return /^[0-9a-f]+$/.test(value)
}

/** 计算一段内存数据的校验值（测试与小文件用）。 */
export async function hashBytes(algorithm: HashAlgorithm, data: Uint8Array): Promise<string> {
  const hasher = await createStreamingHasher(algorithm)
  hasher.update(data)
  return hasher.digest()
}

/** 摘要工具：供 C4 集合标识使用。 */
export function sha512(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha512').update(data).digest())
}

export { bytesToHex, encodeC4Digest }
export * from './c4'
