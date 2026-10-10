/**
 * 所有来自渲染进程的输入都在这里做 Zod 校验。
 *
 * 主进程的 IPC 处理器一律先 `safeParse` 再使用，绝不信任界面传来的任何字符串。
 * 这既是项目的硬性要求，也是防止路径穿越与命令注入的第一道闸门。
 */
import { z } from 'zod'
import {
  HASH_ALGORITHMS,
  JOB_MODES,
  LANGUAGES,
  MANIFEST_FORMATS,
  MAX_COPY_NOTES_LENGTH,
  MAX_CREW_ROWS,
  MAX_LENS_ROWS,
  MAX_PARENT_NAME_LENGTH,
  MAX_PROJECT_NOTES_LENGTH,
  THEME_MODES,
  THEMES
} from './types'

/**
 * 绝对路径校验。
 *
 * - 必须是绝对路径（POSIX 以 / 开头，或 Windows 盘符）
 * - 禁止包含 NUL 字符
 * - 不接受空串
 */
export const absolutePathSchema = z
  .string()
  .min(1, '路径不能为空')
  .max(4096, '路径过长')
  .refine((v) => !v.includes('\0'), '路径包含非法字符')
  .refine(
    (v) => v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\'),
    '必须使用绝对路径'
  )

export const jobIdSchema = z.string().regex(/^job_[A-Za-z0-9_-]{6,40}$/, '非法的任务 ID')

/**
 * 标题栏叠加层的颜色。
 *
 * 这两个值会被交给 Electron 的原生窗口 API，所以只放行**颜色字面量**，
 * 不接受任意字符串 —— 界面传什么都不该让主进程拿到非颜色内容。
 * 允许 `#rgb` / `#rrggbb` / `#rrggbbaa` 与 `rgb()` / `rgba()`。
 */
const cssColorSchema = z
  .string()
  .max(64, '颜色值过长')
  .regex(/^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%/]+\))$/, '颜色格式不合法')

export const titleBarOverlaySchema = z.object({
  color: cssColorSchema,
  symbolColor: cssColorSchema
})

export const parentProjectIdSchema = z
  .string()
  .regex(/^prj_[A-Za-z0-9_-]{6,40}$/, '非法的母项目 ID')

export const crewEntrySchema = z.object({
  role: z.string().max(80, '职务过长'),
  name: z.string().max(80, '姓名过长')
})

export const lensEntrySchema = z.object({
  model: z.string().max(120, '镜头型号过长'),
  detail: z.string().max(120, '镜头信息过长')
})

/**
 * 项目级共享信息。母项目与每次拷贝共用同一份校验。
 *
 * `lenses` / `crew` 上的 `.default([])` 是刻意的：老记录里没有这些字段，
 * 若设成必填，读出来再保存一次就会被拦下 —— 用户什么都没改却存不上。
 */
export const projectDetailsSchema = z.object({
  projectName: z.string().max(160, '项目名过长'),
  shootDay: z.string().max(40, '拍摄日过长'),
  camera: z.string().max(120, '机型过长'),
  lenses: z
    .array(lensEntrySchema)
    .max(MAX_LENS_ROWS, `镜头行数不能超过 ${MAX_LENS_ROWS} 行`)
    .default([]),
  notes: z.string().max(MAX_PROJECT_NOTES_LENGTH, `备注不能超过 ${MAX_PROJECT_NOTES_LENGTH} 字`),
  crew: z
    .array(crewEntrySchema)
    .max(MAX_CREW_ROWS, `职务行数不能超过 ${MAX_CREW_ROWS} 行`)
    .default([])
})

export const projectDraftSchema = projectDetailsSchema.extend({
  cardLabel: z.string().max(120, '卡号过长'),
  copyNotes: z.string().max(MAX_COPY_NOTES_LENGTH, `备注不能超过 ${MAX_COPY_NOTES_LENGTH} 字`)
})

export const projectInfoSchema = projectDraftSchema.extend({
  parentProjectName: z.string().nullable(),
  updatedAt: z.string().nullable()
})

/**
 * 创建任务。
 *
 * 项目信息随创建一次带全（而不是创建成功后再调一次保存）：
 * 少一次 IPC，且不存在"整包覆盖"把主进程按来源盘推出的卡号冲掉的坑。
 */
export const createJobSchema = z.object({
  name: z.string().min(1, '请填写任务名称').max(120, '任务名称过长'),
  sourcePath: absolutePathSchema,
  targets: z
    .array(z.object({ path: absolutePathSchema }))
    .min(1, '至少需要一个目标')
    .max(8, '最多 8 个目标'),
  /** 任务模式；缺省 = copy（拷贝 + 校验） */
  mode: z.enum(JOB_MODES).optional(),
  hashAlgorithm: z.enum(HASH_ALGORITHMS).optional(),
  manifestFormat: z.enum(MANIFEST_FORMATS).optional(),
  verifyAfterWrite: z.boolean().optional(),
  /** 归属的母项目；null 或缺省 = 未分组 */
  parentProjectId: z.union([parentProjectIdSchema, z.null()]).optional(),
  /** 本次拷贝的项目信息；缺省 = 全空 */
  project: projectDraftSchema.optional()
})

export const createParentProjectSchema = z.object({
  name: z.string().min(1, '请填写母项目名称').max(MAX_PARENT_NAME_LENGTH, '母项目名称过长'),
  details: projectDetailsSchema.default({
    projectName: '',
    shootDay: '',
    camera: '',
    lenses: [],
    notes: '',
    crew: []
  })
})

export const parentProjectIdOnlySchema = z.object({
  parentProjectId: parentProjectIdSchema
})

export const renameParentProjectSchema = z.object({
  parentProjectId: parentProjectIdSchema,
  name: z.string().min(1, '请填写母项目名称').max(MAX_PARENT_NAME_LENGTH, '母项目名称过长')
})

export const updateParentProjectSchema = z.object({
  parentProjectId: parentProjectIdSchema,
  name: z.string().min(1).max(MAX_PARENT_NAME_LENGTH, '母项目名称过长').optional(),
  details: projectDetailsSchema.optional()
})

export const setJobParentSchema = z.object({
  jobId: jobIdSchema,
  parentProjectId: z.union([parentProjectIdSchema, z.null()])
})

export const settingsPatchSchema = z
  .object({
    language: z.enum(LANGUAGES),
    themeId: z.enum(THEMES),
    themeMode: z.enum(THEME_MODES),
    hashAlgorithm: z.enum(HASH_ALGORITHMS),
    manifestFormat: z.enum(MANIFEST_FORMATS),
    verifyAfterWrite: z.boolean(),
    maxParallelTargets: z.number().int().min(1).max(8),
    resumePartialFiles: z.boolean(),
    ejectAfterCopy: z.boolean(),
    ffmpegDir: z.union([absolutePathSchema, z.null()]),
    arrirawHdePath: z.union([absolutePathSchema, z.null()]),
    acceptHdeDowngrade: z.boolean(),
    extractFrames: z.boolean(),
    /** 0 表示不限制；上限 100000 只是防止界面填入荒谬值 */
    maxFrameExtractions: z.number().int().min(0).max(100_000),
    frameConcurrency: z.number().int().min(1).max(8),
    soundEnabled: z.boolean(),
    soundVolume: z.number().min(0).max(1)
  })
  .partial()

export const pathPickSchema = z.object({
  kind: z.enum(['directory', 'file']),
  title: z.string().max(200).optional()
})

export const reportPathSchema = z.object({
  path: absolutePathSchema
})

export const tailSchema = z.object({
  lines: z.number().int().min(1).max(2000).optional()
})

/**
 * 通用键值读写（`settings_kv` 里**不属于 AppSettings** 的那些零散状态）。
 *
 * 存在的理由和主进程里`getKv` / `setKv` 的注释一样：
 * 有些状态既不是用户偏好（不该跟着设置被重置），
 * 也不该为此给 AppSettings 加一个字段。
 *
 * 键名限死成一段安全字符：这条通道直通SQLite 的键，
 * 而渲染层拿得到用户输入，写进不认识的键只会把库里搅脏。
 * 值限 200 字符 —— 已够放一个标记位，不必给它开口子。
 */
export const kvGetSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/)
})

export const kvSetSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  value: z.string().max(200)
})
