import type { TargetPreflightResult, PreflightConfirmation } from '../../shared/storage-safety'
import type { JobManager } from '../core/job-manager'
import type { Store } from '../db/store'
import type {
  CopyJob,
  JobState,
  HashAlgorithm,
  ManifestFormat,
  ParentProject,
  ProjectDetails,
  ProjectDraft,
  ProjectInfo
} from '../../shared/types'
import { randomBytes } from 'node:crypto'
import { emptyProjectDraft, emptyProjectDetails, emptyProjectInfo } from '../../shared/project'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

export interface ApprovedRoot {
  id: string
  label: string
  role: 'source' | 'target'
  path: string
}
export interface CompanionJob {
  id: string
  name: string
  mode: 'copy' | 'verify'
  state: JobState
  totalFiles: number
  totalBytes: number
  filesDone: number
  filesFailed: number
  bytesDone: number
  sourceRootId: string
  targetRootIds: string[]
  origin?: 'desktop'
  parentProjectId?: string | null
  parentProjectName?: string | null
  project?: ProjectInfo
}
export interface CompanionCreate {
  preflightConfirmation?: PreflightConfirmation
  requestId: string
  name?: string
  sourceRootId: string
  targetRootIds: string[]
  mode: 'copy' | 'verify'
  hashAlgorithm: HashAlgorithm
  manifestFormat: ManifestFormat
  projectName: string
  parentProjectId?: string | null
  project?: ProjectDraft
}
export type CompanionAction = 'start' | 'pause' | 'resume' | 'cancel'
export interface CompanionSnapshot {
  jobs: CompanionJob[]
  projects: ParentProject[]
}
export interface CompanionReport {
  revision: string
  createdAt: string
  formats: string[]
}
export interface ParentMutation {
  requestId: string
  id?: string
  name?: string
  details?: Partial<ProjectDetails>
}
export interface CompanionAdapter {
  preflight?(
    input: {
      sourceRootId: string
      targetRootIds: string[]
      mode: 'copy' | 'verify'
      jobId?: string
    },
    roots: ApprovedRoot[]
  ): Promise<TargetPreflightResult>
  projects?(): ParentProject[]
  saveParent?(input: ParentMutation): Promise<ParentProject>
  jobProject?(id: string, roots: ApprovedRoot[]): ProjectInfo
  saveJobProject?(
    id: string,
    project: Partial<ProjectDraft>,
    roots: ApprovedRoot[]
  ): Promise<ProjectInfo>
  snapshot(roots: ApprovedRoot[]): CompanionSnapshot
  create(input: CompanionCreate, roots: ApprovedRoot[]): Promise<CompanionJob>
  control(
    id: string,
    action: CompanionAction,
    roots: ApprovedRoot[],
    confirmation?: PreflightConfirmation
  ): Promise<CompanionJob>
  reports(id: string, roots: ApprovedRoot[]): CompanionReport[]
  reportFile(
    id: string,
    revision: string,
    kind: string,
    roots: ApprovedRoot[]
  ): Promise<string | null>
}
export function scopedJob(job: CopyJob, roots: ApprovedRoot[]): CompanionJob | null {
  const source = roots.find((r) => r.role === 'source' && r.path === job.sourcePath)
  const targets = job.targets.map((t) =>
    roots.find((r) => r.role === 'target' && r.path === t.path)
  )
  if (!source || targets.some((t) => !t)) return null
  return {
    id: job.id,
    name: job.name,
    mode: job.mode,
    state: job.state,
    totalFiles: job.totalFiles,
    totalBytes: job.totalBytes,
    filesDone: job.filesDone,
    filesFailed: job.filesFailed,
    bytesDone: job.bytesDone,
    sourceRootId: source.id,
    targetRootIds: targets.map((t) => t!.id)
  }
}
/** All copy operations remain owned by the existing desktop engine. */
export function desktopAdapter(
  manager: JobManager,
  store: Store,
  reportsDir: string
): CompanionAdapter {
  function requireJob(id: string, roots: ApprovedRoot[]): CompanionJob {
    const job = store.getJob(id)
    const scoped = job && scopedJob(job, roots)
    if (!scoped) throw new Error('Job unavailable')
    const project = store.getProjectInfo(id) ?? emptyProjectInfo()
    return {
      ...scoped,
      origin: 'desktop',
      parentProjectId: job!.parentProjectId,
      parentProjectName: project.parentProjectName,
      project
    }
  }
  return {
    preflight: async (input, roots) => {
      if (input.jobId) {
        requireJob(input.jobId, roots)
        const job = store.getJob(input.jobId)!
        return manager.preflight({
          sourcePath: job.sourcePath,
          targets: job.targets.map((t) => ({ path: t.path })),
          mode: job.mode,
          proxyEnabled: job.proxyEnabled
        })
      }
      const source = roots.find((r) => r.id === input.sourceRootId && r.role === 'source')
      const targets = input.targetRootIds.map((id) =>
        roots.find((r) => r.id === id && r.role === 'target')
      )
      if (!source || targets.some((target) => !target))
        throw new Error('Directory authority unavailable')
      return manager.preflight({
        sourcePath: source.path,
        targets: targets.map((target) => ({ path: target!.path })),
        mode: input.mode,
        proxyEnabled: false
      })
    },
    projects: () => store.listParentProjects(),
    saveParent: async (input) => {
      if (input.id) {
        const current = store.getParentProject(input.id)
        if (!current) throw new Error('Project unavailable')
        return store.updateParentProject(input.id, {
          name: input.name,
          details: { ...current.details, ...input.details },
          updatedAt: new Date().toISOString()
        })!
      }
      const project = {
        id: `prj_${randomBytes(12).toString('hex')}`,
        name: input.name!,
        details: { ...emptyProjectDetails(), ...input.details },
        createdAt: new Date().toISOString(),
        updatedAt: null
      }
      store.createParentProject(project)
      return project
    },
    jobProject: (id, roots) => {
      requireJob(id, roots)
      return store.getProjectInfo(id) ?? emptyProjectInfo()
    },
    saveJobProject: async (id, project, roots) => {
      requireJob(id, roots)
      const saved = {
        ...(store.getProjectInfo(id) ?? emptyProjectInfo()),
        ...project,
        updatedAt: new Date().toISOString()
      }
      store.saveProjectInfo(id, saved)
      return saved
    },
    snapshot: (roots) => ({
      jobs: store
        .listJobs()
        .map((j) => scopedJob(j, roots))
        .filter((j): j is CompanionJob => j !== null)
        .map((j) => requireJob(j.id, roots)),
      projects: store.listParentProjects()
    }),
    create: async (input, roots) => {
      const source = roots.find((r) => r.id === input.sourceRootId && r.role === 'source')!
      if (input.parentProjectId && !store.getParentProject(input.parentProjectId))
        throw new Error('Project unavailable')
      const result = await manager.createJob({
        preflightConfirmation: input.preflightConfirmation,
        name: input.name ?? input.projectName,
        sourcePath: source.path,
        targets: input.targetRootIds.map((id) => ({
          path: roots.find((r) => r.id === id && r.role === 'target')!.path
        })),
        mode: input.mode,
        hashAlgorithm: input.hashAlgorithm,
        manifestFormat: input.manifestFormat,
        verifyAfterWrite: true,
        proxyEnabled: false,
        proxyLutPath: null,
        parentProjectId: input.parentProjectId,
        project: input.project ?? { ...emptyProjectDraft(), projectName: input.projectName }
      })
      return requireJob(result.job.id, roots)
    },
    control: async (id, action, roots, confirmation) => {
      requireJob(id, roots)
      if (action === 'start') await manager.start(id, false, confirmation)
      else if (action === 'resume') await manager.resume(id, confirmation)
      else await manager[action](id)
      return requireJob(id, roots)
    },
    reports: (id, roots) => {
      requireJob(id, roots)
      if (manager.isRunning(id)) throw new Error('Report unavailable')
      return store.listReports(id).map((r) => ({
        revision: r.revision,
        createdAt: r.createdAt,
        formats: Object.keys(r.files).filter((k) => ['json', 'html', 'pdf'].includes(k))
      }))
    },
    reportFile: async (id, revision, kind, roots) => {
      requireJob(id, roots)
      if (manager.isRunning(id)) throw new Error('Report unavailable')
      const report = store.listReports(id).find((r) => r.revision === revision)
      const file = report?.files[kind as 'json' | 'html' | 'pdf']
      if (!file) return null
      const root = await realpath(reportsDir)
      const actual = await realpath(file)
      const rel = relative(root, actual)
      if (
        isAbsolute(rel) ||
        rel === '..' ||
        rel.startsWith(`..${sep}`) ||
        !(await stat(actual)).isFile()
      )
        return null
      return actual
    }
  }
}
