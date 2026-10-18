import { preflightConfirmationSchema } from '../../shared/schemas'
import { checkPreflightConfirmation } from '../core/storage-preflight'
import { hostname } from 'node:os'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, rename, realpath, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { basename, join } from 'node:path'
import { isIP } from 'node:net'
import { z } from 'zod'
import {
  HASH_ALGORITHMS,
  MANIFEST_FORMATS,
  MAX_CREW_ROWS,
  MAX_LENS_ROWS,
  MAX_PARENT_NAME_LENGTH,
  supportsAlgorithm
} from '../../shared/types'
import type { ApprovedRoot, CompanionAdapter, CompanionCreate } from './adapter'
import { loadIdentity } from './identity'
import {
  parentProjectIdSchema,
  projectDetailsSchema,
  projectDraftSchema,
  crewEntrySchema,
  lensEntrySchema
} from '../../shared/schemas'
const detailPatchSchema = projectDetailsSchema
  .partial()
  .extend({
    crew: z.array(crewEntrySchema.strict()).max(MAX_CREW_ROWS).optional(),
    lenses: z.array(lensEntrySchema.strict()).max(MAX_LENS_ROWS).optional()
  })
  .strict()
const draftPatchSchema = projectDraftSchema
  .partial()
  .extend({
    crew: detailPatchSchema.shape.crew,
    lenses: detailPatchSchema.shape.lenses
  })
  .strict()
const parentMutationSchema = z
  .object({
    requestId: z.string().regex(/^[a-zA-Z0-9_-]{6,100}$/),
    id: parentProjectIdSchema.optional(),
    name: z.string().trim().min(1).max(MAX_PARENT_NAME_LENGTH).optional(),
    details: detailPatchSchema.optional()
  })
  .strict()
  .refine((value) => value.id !== undefined || value.name !== undefined)

const id = z.string().regex(/^[a-zA-Z0-9_-]{6,100}$/)
const createSchema = z
  .object({
    requestId: id,
    preflightConfirmation: preflightConfirmationSchema.optional(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((v) => [...v].every((c) => c.charCodeAt(0) >= 32))
      .optional(),
    sourceRootId: id,
    targetRootIds: z.array(id).min(1).max(2),
    mode: z.enum(['copy', 'verify']),
    hashAlgorithm: z.enum(HASH_ALGORITHMS),
    manifestFormat: z.enum(MANIFEST_FORMATS),
    parentProjectId: parentProjectIdSchema.nullable().optional(),
    project: projectDraftSchema
      .extend({
        crew: z.array(crewEntrySchema.strict()).max(MAX_CREW_ROWS),
        lenses: z.array(lensEntrySchema.strict()).max(MAX_LENS_ROWS)
      })
      .strict()
      .optional(),
    projectName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine(
        (v) =>
          !v.includes('/') &&
          !v.includes(String.fromCharCode(92)) &&
          [...v].every((c) => c.charCodeAt(0) >= 32)
      )
  })
  .strict()
const stateSchema = z.object({
  version: z.literal(1),
  clients: z
    .array(
      z.object({
        id,
        deviceName: z.string().max(80),
        tokenHash: z.string().regex(/^[0-9a-f]{64}$/)
      })
    )
    .max(32),
  roots: z
    .array(
      z.object({
        id,
        label: z.string(),
        role: z.enum(['source', 'target']),
        path: z.string(),
        dev: z.string(),
        ino: z.string()
      })
    )
    .max(32),
  requests: z.record(
    z.string(),
    z.object({ hash: z.string(), data: z.unknown().optional(), pending: z.boolean() })
  )
})
type State = z.infer<typeof stateSchema>
const desktopName =
  [...hostname()]
    .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    .join('')
    .slice(0, 80) || 'SecureReel Desktop'
export interface CompanionSetup {
  desktopName: string
  version: 1
  url: string
  fingerprint: string
  pairingCode: string
  expiresAt: number
}
export interface CompanionStatus {
  desktopName: string
  running: boolean
  port: number | null
  fingerprint: string
  clients: { id: string; deviceName: string; lastSeenAt: string | null }[]
  roots: { id: string; label: string; role: 'source' | 'target' }[]
}
class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
function lanAddress(address: string): boolean {
  const ip = address.replace(/^::ffff:/, '')
  return (
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^(fc|fd|fe[89ab])/i.test(ip)
  )
}
function json(response: ServerResponse, status: number, data: unknown, ok = true): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  response.end(
    JSON.stringify(
      ok ? { version: 1, ok: true, data } : { version: 1, ok: false, error: { code: data } }
    )
  )
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type'] !== 'application/json')
    throw new ApiError(400, 'invalid_input')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 16384) throw new ApiError(413, 'too_large')
    chunks.push(Buffer.from(chunk))
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new ApiError(400, 'invalid_input')
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new ApiError(400, 'invalid_input')
  return result.data
}

/** Off by default. Callers can only select opaque desktop-approved folders. */
export class MobileCompanion {
  private readonly lastSeen = new Map<string, string>()
  private server: Server | null = null
  private port: number | null = null
  private pairing: { hash: string; expiresAt: number } | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private attempts = 0
  private attemptWindow = 0
  private activeRequests = 0
  private constructor(
    private readonly options: { directory: string; adapter: CompanionAdapter },
    private readonly identity: { key: string; cert: string; fingerprint: string },
    private state: State
  ) {}
  static async open(options: {
    directory: string
    adapter: CompanionAdapter
  }): Promise<MobileCompanion> {
    const identity = await loadIdentity(options.directory)
    let state: State = { version: 1, clients: [], roots: [], requests: {} }
    try {
      state = stateSchema.parse(
        JSON.parse(await readFile(join(options.directory, 'state.json'), 'utf8'))
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return new MobileCompanion(options, identity, state)
  }
  private async save(): Promise<void> {
    const file = join(this.options.directory, 'state.json')
    const temp = `${file}.tmp`
    await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 })
    await rename(temp, file)
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }
  status(): CompanionStatus {
    return {
      desktopName,
      running: this.server !== null,
      port: this.port,
      fingerprint: this.identity.fingerprint,
      clients: this.state.clients.map(({ id, deviceName }) => ({
        id,
        deviceName,
        lastSeenAt: this.lastSeen.get(id) ?? null
      })),
      roots: this.state.roots.map(({ id, label, role }) => ({ id, label, role }))
    }
  }
  async approveRoot(path: string, role: 'source' | 'target'): Promise<CompanionStatus> {
    return this.exclusive(async () => {
      parse(z.enum(['source', 'target']), role)
      parse(z.string().min(1).max(4096), path)
      const actual = await realpath(path)
      const info = await stat(actual, { bigint: true })
      if (!info.isDirectory()) throw new Error('Select a folder')
      if (this.state.roots.length >= 32) throw new Error('Root limit reached')
      if (!this.state.roots.some((r) => r.path === actual && r.role === role))
        this.state.roots.push({
          id: `root_${randomBytes(12).toString('hex')}`,
          label: basename(actual),
          role,
          path: actual,
          dev: String(info.dev),
          ino: String(info.ino)
        })
      await this.save()
      return this.status()
    })
  }
  async revokeClient(clientId: string): Promise<CompanionStatus> {
    return this.exclusive(async () => {
      this.state.clients = this.state.clients.filter((client) => client.id !== clientId)
      this.lastSeen.delete(clientId)
      await this.save()
      return this.status()
    })
  }
  async removeRoot(rootId: string): Promise<CompanionStatus> {
    return this.exclusive(async () => {
      this.state.roots = this.state.roots.filter((root) => root.id !== rootId)
      await this.save()
      return this.status()
    })
  }

  async clearRoots(): Promise<CompanionStatus> {
    return this.exclusive(async () => {
      this.state.roots = []
      await this.save()
      return this.status()
    })
  }
  async revokeClients(): Promise<CompanionStatus> {
    return this.exclusive(async () => {
      this.state.clients = []
      this.pairing = null
      await this.save()
      return this.status()
    })
  }
  async start(host = '0.0.0.0', port = 0): Promise<CompanionStatus> {
    if (this.server) return this.status()
    const server = createServer(
      { ...this.identity, minVersion: 'TLSv1.2', maxHeaderSize: 8192 },
      (req, res) => {
        if (this.activeRequests >= 32) {
          json(res, 503, 'busy', false)
          req.resume()
          return
        }
        this.activeRequests++
        void this.handle(req, res)
          .catch((error) => {
            if (!res.headersSent)
              json(
                res,
                error instanceof ApiError ? error.status : 400,
                error instanceof ApiError ? error.code : 'operation_failed',
                false
              )
            else res.destroy()
          })
          .finally(() => {
            this.activeRequests--
          })
      }
    )
    server.requestTimeout = 15000
    server.headersTimeout = 10000
    server.keepAliveTimeout = 2000
    server.maxConnections = 64
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.server = server
    this.port = (server.address() as { port: number }).port
    return this.status()
  }
  async stop(): Promise<void> {
    this.pairing = null
    const server = this.server
    this.server = null
    this.port = null
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
    await this.queue
  }
  createPairing(host: string, ttl = 120000): CompanionSetup {
    if (!this.server || this.port === null) throw new Error('Companion is off')
    if (!isIP(host) || !lanAddress(host)) throw new Error('Use a local network address')
    const code = randomBytes(24).toString('base64url')
    const expiresAt = Date.now() + Math.min(ttl, 120000)
    this.pairing = { hash: hash(code), expiresAt }
    return {
      version: 1,
      desktopName,
      url: `https://${isIP(host) === 6 ? `[${host}]` : host}:${this.port}`,
      fingerprint: this.identity.fingerprint,
      pairingCode: code,
      expiresAt
    }
  }
  private authenticate(req: IncomingMessage): string {
    const header = req.headers.authorization
    if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header))
      throw new ApiError(401, 'unauthorized')
    const candidate = Buffer.from(hash(header.slice(7)), 'hex')
    const client = this.state.clients.find((c) =>
      timingSafeEqual(Buffer.from(c.tokenHash, 'hex'), candidate)
    )
    if (!client) throw new ApiError(401, 'unauthorized')
    this.lastSeen.set(client.id, new Date().toISOString())
    return client.id
  }
  private async validRoots(): Promise<ApprovedRoot[]> {
    const valid: ApprovedRoot[] = []
    for (const root of this.state.roots) {
      try {
        const actual = await realpath(root.path)
        const info = await stat(actual, { bigint: true })
        if (
          actual === root.path &&
          info.isDirectory() &&
          String(info.dev) === root.dev &&
          String(info.ino) === root.ino
        )
          valid.push(root)
      } catch {
        /* Removed volumes cannot authorize access. */
      }
    }
    return valid
  }
  private async idempotent(
    client: string,
    path: string,
    input: { requestId: string },
    operation: () => Promise<unknown>
  ): Promise<unknown> {
    const key = `${client}:${input.requestId}`
    const digest = hash(JSON.stringify({ path, input }))
    const previous = this.state.requests[key]
    if (previous) {
      if (previous.hash !== digest) throw new ApiError(409, 'request_conflict')
      if (previous.pending) throw new ApiError(409, 'request_uncertain')
      return previous.data
    }
    if (Object.keys(this.state.requests).length >= 4096) throw new ApiError(503, 'request_limit')
    // Reserve durably before touching the engine. An interrupted request is never replayed.
    this.state.requests[key] = { hash: digest, pending: true }
    await this.save()
    try {
      const data = await operation()
      this.state.requests[key] = { hash: digest, pending: false, data }
      await this.save()
      return data
    } catch {
      // The operation or its result save may fail after creating/starting a job.
      // Keep memory aligned with the durable pending reservation for retries.
      this.state.requests[key] = { hash: digest, pending: true }
      throw new ApiError(409, 'request_uncertain')
    }
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!lanAddress(req.socket.remoteAddress ?? '') || req.headers.origin)
      throw new ApiError(403, 'forbidden')
    const path = req.url ?? ''
    if (!/^\/api\/v1\/[A-Za-z0-9_/-]+$/.test(path)) throw new ApiError(404, 'not_found')
    if (path === '/api/v1/pair' && req.method === 'POST') {
      if (Date.now() - this.attemptWindow > 60000) {
        this.attempts = 0
        this.attemptWindow = Date.now()
      }
      if (++this.attempts > 10) throw new ApiError(429, 'rate_limited')
      const input = parse(
        z
          .object({
            pairingCode: z.string().max(100),
            deviceName: z.string().trim().min(1).max(80)
          })
          .strict(),
        await body(req)
      )
      const data = await this.exclusive(async () => {
        const pairing = this.pairing
        if (
          !pairing ||
          pairing.expiresAt <= Date.now() ||
          !timingSafeEqual(
            Buffer.from(hash(input.pairingCode), 'hex'),
            Buffer.from(pairing.hash, 'hex')
          )
        )
          throw new ApiError(403, 'pairing_invalid')
        if (this.state.clients.length >= 32) throw new ApiError(409, 'client_limit')
        this.pairing = null
        const token = randomBytes(32).toString('base64url')
        const clientId = `client_${randomBytes(12).toString('hex')}`
        this.state.clients.push({
          id: clientId,
          deviceName: input.deviceName,
          tokenHash: hash(token)
        })
        await this.save()
        return { clientId, token }
      })
      json(res, 200, data)
      return
    }
    const client = this.authenticate(req)
    const roots = await this.validRoots()
    if (path === '/api/v1/projects' && req.method === 'GET' && this.options.adapter.projects) {
      json(res, 200, this.options.adapter.projects())
      return
    }
    if (path === '/api/v1/projects' && req.method === 'POST' && this.options.adapter.saveParent) {
      const input = parse(parentMutationSchema, await body(req))
      const data = await this.exclusive(async () => {
        this.authenticate(req)
        return this.idempotent(client, path, input, () => this.options.adapter.saveParent!(input))
      })
      json(res, 200, data)
      return
    }
    const projectRoute = /^\/api\/v1\/jobs\/(job_[A-Za-z0-9_-]+)\/project$/.exec(path)
    if (projectRoute && req.method === 'GET' && this.options.adapter.jobProject) {
      if (!this.options.adapter.snapshot(roots).jobs.some((j) => j.id === projectRoute[1]))
        throw new ApiError(403, 'job_forbidden')
      json(res, 200, this.options.adapter.jobProject(projectRoute[1]!, roots))
      return
    }
    if (projectRoute && req.method === 'POST' && this.options.adapter.saveJobProject) {
      const input = parse(
        z.object({ requestId: id, project: draftPatchSchema }).strict(),
        await body(req)
      )
      const data = await this.exclusive(async () => {
        this.authenticate(req)
        const currentRoots = await this.validRoots()
        if (!this.options.adapter.snapshot(currentRoots).jobs.some((j) => j.id === projectRoute[1]))
          throw new ApiError(403, 'job_forbidden')
        return this.idempotent(client, path, input, () =>
          this.options.adapter.saveJobProject!(projectRoute[1]!, input.project, currentRoots)
        )
      })
      json(res, 200, data)
      return
    }

    if (path === '/api/v1/roots' && req.method === 'GET') {
      json(
        res,
        200,
        roots.map(({ id, label, role }) => ({ id, label, role }))
      )
      return
    }
    if (path === '/api/v1/snapshot' && req.method === 'GET') {
      json(res, 200, { ...this.options.adapter.snapshot(roots), desktopName })
      return
    }
    if (path === '/api/v1/preflight' && req.method === 'POST') {
      const input = parse(
        z
          .object({
            sourceRootId: id,
            targetRootIds: z.array(id).min(1).max(8),
            mode: z.enum(['copy', 'verify']),
            jobId: z.string().optional(),
            hashAlgorithm: z.enum(HASH_ALGORITHMS).optional(),
            manifestFormat: z.enum(MANIFEST_FORMATS).optional()
          })
          .strict(),
        await body(req)
      )
      const result = await this.exclusive(async () => {
        this.authenticate(req)
        const approved = await this.validRoots()
        if (
          !approved.some((root) => root.id === input.sourceRootId && root.role === 'source') ||
          input.targetRootIds.some(
            (target) => !approved.some((root) => root.id === target && root.role === 'target')
          )
        )
          throw new ApiError(403, 'root_forbidden')
        if (!this.options.adapter.preflight) throw new ApiError(503, 'preflight_unavailable')
        const evidence = await this.options.adapter.preflight(input, approved)
        const rootId = (value: string): string =>
          approved.find((root) => root.path === value)?.id ?? 'unknown'
        const opaque = (identity: typeof evidence.source) => ({
          ...identity,
          path: rootId(identity.path),
          label: approved.find((root) => root.path === identity.path)?.label ?? 'Directory',
          filesystemId: identity.filesystemId === null ? null : hash(identity.filesystemId),
          capacityPoolId: identity.capacityPoolId === null ? null : hash(identity.capacityPoolId),
          physicalDeviceIds: identity.physicalDeviceIds.map(hash)
        })
        return {
          ...evidence,
          source: opaque(evidence.source),
          targets: evidence.targets.map(opaque),
          groups: evidence.groups.map((group) => ({
            ...group,
            id: hash(group.id),
            paths: group.paths.map(rootId)
          })),
          risks: evidence.risks.map((risk) => ({ ...risk, paths: risk.paths.map(rootId) })),
          blockingReasons: evidence.blockingReasons.length
            ? ['Storage preflight blocked; refresh approved folders and capacity.']
            : []
        }
      })
      json(res, 200, result)
      return
    }
    if (path === '/api/v1/jobs' && req.method === 'POST') {
      const input = parse(createSchema, await body(req)) as CompanionCreate
      const data = await this.exclusive(async () => {
        this.authenticate(req)
        const currentRoots = await this.validRoots()
        if (
          !currentRoots.some((r) => r.id === input.sourceRootId && r.role === 'source') ||
          input.targetRootIds.some(
            (id) => !currentRoots.some((r) => r.id === id && r.role === 'target')
          )
        )
          throw new ApiError(403, 'root_forbidden')
        if (
          new Set(input.targetRootIds).size !== input.targetRootIds.length ||
          !supportsAlgorithm(input.manifestFormat, input.hashAlgorithm)
        )
          throw new ApiError(400, 'invalid_input')
        if (
          this.options.adapter.preflight &&
          !this.state.requests[`${client}:${input.requestId}`]
        ) {
          const evidence = await this.options.adapter.preflight(input, currentRoots)
          try {
            checkPreflightConfirmation(evidence, input.preflightConfirmation)
          } catch {
            throw new ApiError(400, 'preflight_required')
          }
        }
        return this.idempotent(client, path, input, () =>
          this.options.adapter.create(input, currentRoots)
        )
      })
      json(res, 200, data)
      return
    }
    const jobRoute = /^\/api\/v1\/jobs\/(job_[A-Za-z0-9_-]+)$/.exec(path)
    if (jobRoute && req.method === 'GET') {
      const job = this.options.adapter.snapshot(roots).jobs.find((j) => j.id === jobRoute[1])
      if (!job) throw new ApiError(403, 'job_forbidden')
      json(res, 200, job)
      return
    }
    const control = /^\/api\/v1\/jobs\/(job_[A-Za-z0-9_-]+)\/(start|pause|resume|cancel)$/.exec(
      path
    )
    if (control && req.method === 'POST') {
      const input = parse(
        z
          .object({ requestId: id, preflightConfirmation: preflightConfirmationSchema.optional() })
          .strict(),
        await body(req)
      )
      const data = await this.exclusive(async () => {
        this.authenticate(req)
        const currentRoots = await this.validRoots()
        if (!this.options.adapter.snapshot(currentRoots).jobs.some((j) => j.id === control[1]))
          throw new ApiError(403, 'job_forbidden')
        const requestedAction = control[2] as 'start' | 'pause' | 'resume' | 'cancel'
        if (
          (requestedAction === 'start' || requestedAction === 'resume') &&
          this.options.adapter.preflight &&
          !this.state.requests[`${client}:${input.requestId}`]
        ) {
          const selected = this.options.adapter
            .snapshot(currentRoots)
            .jobs.find((job) => job.id === control[1])!
          const evidence = await this.options.adapter.preflight(
            {
              jobId: selected.id,
              sourceRootId: selected.sourceRootId,
              targetRootIds: selected.targetRootIds,
              mode: selected.mode
            },
            currentRoots
          )
          try {
            checkPreflightConfirmation(evidence, input.preflightConfirmation)
          } catch {
            throw new ApiError(400, 'preflight_required')
          }
        }
        return this.idempotent(client, path, input, async () => {
          const job = this.options.adapter
            .snapshot(currentRoots)
            .jobs.find((j) => j.id === control[1])!
          const allowed = {
            start: ['draft'],
            pause: ['queued', 'running'],
            resume: ['paused'],
            cancel: ['draft', 'queued', 'running', 'paused']
          }
          const action = control[2] as 'start' | 'pause' | 'resume' | 'cancel'
          if (!allowed[action].includes(job.state)) throw new ApiError(409, 'invalid_state')
          return this.options.adapter.control(
            control[1]!,
            action,
            currentRoots,
            input.preflightConfirmation
          )
        })
      })
      json(res, 200, data)
      return
    }
    const report =
      /^\/api\/v1\/reports\/(job_[A-Za-z0-9_-]+)(?:\/(R\d{3,})\/(json|html|pdf))?$/.exec(path)
    if (report && req.method === 'GET') {
      const job = this.options.adapter.snapshot(roots).jobs.find((j) => j.id === report[1])
      if (!job) throw new ApiError(403, 'job_forbidden')
      if (!['completed', 'completed-with-errors', 'failed', 'cancelled'].includes(job.state))
        throw new ApiError(409, 'report_not_terminal')
      if (!report[2]) {
        json(res, 200, this.options.adapter.reports(report[1]!, roots))
        return
      }
      const file = await this.options.adapter.reportFile(report[1]!, report[2], report[3]!, roots)
      if (!file) throw new ApiError(404, 'not_found')
      res.writeHead(200, {
        'content-type':
          report[3] === 'pdf'
            ? 'application/pdf'
            : report[3] === 'html'
              ? 'text/html; charset=utf-8'
              : 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
      })
      const stream = createReadStream(file)
      stream.on('error', () => res.destroy())
      res.on('close', () => stream.destroy())
      stream.pipe(res)
      return
    }
    throw new ApiError(404, 'not_found')
  }
}
