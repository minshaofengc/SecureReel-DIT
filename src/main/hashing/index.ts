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
 *   - xxhash64：默认，速度快，适合现场大批量素材
 *   - md5：兼容既有流程
 *   - asc-c4：SMPTE ST 2114:2017，归档用
 */
import { createHash } from 'node:crypto'
import { createXXHash64 } from 'hash-wasm'
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

class Md5Hasher implements StreamingHasher {
  readonly algorithm = 'md5' as const
  private readonly inner = createHash('md5')
  private bytes = 0
  private finalized = false

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
    return this.inner.digest('hex')
  }
}

class Sha512BasedHasher implements StreamingHasher {
  readonly algorithm: HashAlgorithm
  private readonly inner = createHash('sha512')
  private readonly encoder: (digest: Uint8Array) => string
  private bytes = 0
  private finalized = false

  constructor(algorithm: HashAlgorithm, encoder: (digest: Uint8Array) => string) {
    this.algorithm = algorithm
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

class XxHash64Hasher implements StreamingHasher {
  readonly algorithm = 'xxhash64' as const
  private bytes = 0
  private finalized = false
  private readonly hasher: { update(data: Uint8Array): void; digest(kind: 'hex'): string }

  constructor(hasher: { update(data: Uint8Array): void; digest(kind: 'hex'): string }) {
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
 * 对 xxHash64 而言这个 Promise 会等到 WASM 实例就绪；
 * 因此请在每个文件开始拷贝**之前**创建，不要在拷贝循环中间创建。
 */
export async function createStreamingHasher(algorithm: HashAlgorithm): Promise<StreamingHasher> {
  switch (algorithm) {
    case 'md5':
      return new Md5Hasher()
    case 'asc-c4':
      return new Sha512BasedHasher('asc-c4', (digest) => encodeC4Digest(digest))
    case 'xxhash64': {
      const wasm = await createXXHash64()
      wasm.init()
      return new XxHash64Hasher(wasm)
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
 *   · xxhash64 / md5 → 纯小写十六进制
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
