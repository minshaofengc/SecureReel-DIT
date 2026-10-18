import { generateKeyPair, randomBytes, sign, X509Certificate, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

function der(tag: number, bytes: Buffer): Buffer {
  const length = bytes.length
  const size =
    length < 128
      ? Buffer.from([length])
      : (() => {
          const hex = length
            .toString(16)
            .padStart(Math.ceil(length.toString(16).length / 2) * 2, '0')
          const value = Buffer.from(hex, 'hex')
          return Buffer.concat([Buffer.from([0x80 | value.length]), value])
        })()
  return Buffer.concat([Buffer.from([tag]), size, bytes])
}
const seq = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts))
const oid = (hex: string): Buffer => der(6, Buffer.from(hex, 'hex'))
function pem(label: string, value: Buffer): string {
  return `-----BEGIN ${label}-----\n${value
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END ${label}-----\n`
}
/** Creates a pinned self-signed certificate without an external executable. */
async function generateIdentity(): Promise<{ key: string; cert: string }> {
  const { privateKey, publicKey } = await promisify(generateKeyPair)('rsa', { modulusLength: 2048 })
  const algorithm = seq(oid('2a864886f70d01010b'), der(5, Buffer.alloc(0)))
  const name = seq(
    der(0x31, seq(oid('550403'), der(0x0c, Buffer.from('SecureReel LAN Companion'))))
  )
  const time = (date: Date): Buffer =>
    der(
      0x18,
      Buffer.from(
        date
          .toISOString()
          .replace(/[-:T]/g, '')
          .replace(/\.\d+Z$/, 'Z')
      )
    )
  const now = Date.now()
  const serial = randomBytes(16)
  serial[0] = serial[0]! & 0x7f || 1
  const tbs = seq(
    der(0xa0, der(2, Buffer.from([2]))),
    der(2, serial),
    algorithm,
    name,
    seq(time(new Date(now - 86400000)), time(new Date(now + 10 * 365 * 86400000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' })
  )
  const signature = sign('RSA-SHA256', tbs, privateKey)
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: pem(
      'CERTIFICATE',
      seq(tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), signature])))
    )
  }
}
export async function loadIdentity(
  directory: string
): Promise<{ key: string; cert: string; fingerprint: string }> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let identity: { key: string; cert: string }
  try {
    identity = JSON.parse(
      await readFile(join(directory, 'identity.json'), 'utf8')
    ) as typeof identity
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    identity = await generateIdentity()
    await writeFile(join(directory, 'identity.json'), JSON.stringify(identity), {
      mode: 0o600,
      flag: 'wx'
    })
  }
  const cert = new X509Certificate(identity.cert)
  if (!cert.checkPrivateKey((await import('node:crypto')).createPrivateKey(identity.key)))
    throw new Error('Invalid companion identity')
  return { ...identity, fingerprint: createHash('sha256').update(cert.raw).digest('hex') }
}
