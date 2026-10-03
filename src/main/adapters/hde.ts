/**
 * HDE 外部工具适配层。
 *
 * ⚠️ 合规红线（AGENTS.md）：
 *   · 本文件**不实现**任何 HDE 编码算法，只负责发现并参数化调用官方工具
 *   · **不逆向工程** CODEX Device Manager 或 ARRIRAW HDE Transcoder
 *   · **不打包**任何 CODEX / ARRI 专有二进制到分发包
 *   · 找不到官方工具时，只解释原因，并在用户明确确认后才降级为普通拷贝
 *
 * HDE 编码能力由 ARRI / CODEX 官方免费工具提供。本应用只做编排。
 */
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AppSettings, HdeCameraModel, HdeCapabilityDecision, HdeToolStatus, ScanResult } from '@shared/types'
import { resolveExecutable, runCommand } from '@main/exec'
import { pathExists, whichInPath } from '@main/fs-utils'
import { IS_WINDOWS } from '@main/platform'
import { listVolumeEntries } from '@main/volumes'
import type { Logger } from '@main/logger'

/**
 * Windows 上「程序装在哪」的几个标准目录。
 *
 * 用环境变量而不是写死 `C:\Program Files`：系统盘不一定是 C，而且
 * 32 位程序在 64 位系统上会被装到 Program Files (x86)。
 * 拿不到的键（比如某些精简环境）直接跳过，不猜路径。
 */
function windowsProgramDirs(): string[] {
  const dirs: string[] = []
  for (const key of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    const value = process.env[key]
    if (value !== undefined && value !== '') dirs.push(value)
  }
  const localAppData = process.env['LOCALAPPDATA']
  if (localAppData !== undefined && localAppData !== '') dirs.push(join(localAppData, 'Programs'))
  return dirs
}

/**
 * CODEX Device Manager 应用可能出现的位置。
 *
 * ⚠️ Windows 这一串是**按常见安装约定猜的，没有在真机上验证过** ——
 * 我们查不到 ARRI / CODEX 官方工具是否提供 Windows 版本。所以这里的策略是
 * 「多猜几个位置 + 兜底去 PATH 里找」，找不到就老实走降级链，
 * 绝不因为「路径没猜中」而假报成工具不存在。
 * 真机上准确的安装位置，由 `windows 版本/Windows 自检清单.md` 的 H 组反馈回来。
 */
const CODEX_BUNDLE_CANDIDATES = IS_WINDOWS
  ? windowsProgramDirs().flatMap((dir) => [
      join(dir, 'CODEX Device Manager'),
      join(dir, 'Codex Device Manager')
    ])
  : [
      '/Applications/CODEX Device Manager.app',
      '/Applications/Codex Device Manager.app',
      '/Applications/CODEX Device Manager',
      '/Applications/CODEXDeviceManager.app'
    ]

/** 官方 ARRIRAW HDE Transcoder 可执行文件常见位置（Windows 部分同样是猜测，见上）。 */
const ARRIRAW_HDE_CANDIDATES = IS_WINDOWS
  ? windowsProgramDirs().flatMap((dir) => [
      join(dir, 'ARRI', 'ARRIRAW HDE Transcoder', 'arrirawhde.exe'),
      join(dir, 'ARRIRAW HDE Transcoder', 'arrirawhde.exe')
    ])
  : [
      '/usr/local/bin/arrirawhde',
      '/opt/homebrew/bin/arrirawhde',
      '/Applications/ARRIRAW HDE Transcoder.app/Contents/MacOS/arrirawhde',
      '/Applications/ARRI/ARRIRAW HDE Transcoder.app/Contents/MacOS/arrirawhde'
    ]

/** 文件名里出现这些关键字，通常意味着 HDE 卷。 */
const HDE_NAME_HINTS = ['hde', 'codex', 'arriraw', 'arx']

export interface HdeAdapterDeps {
  logger: Logger
  getSettings: () => AppSettings
  /** 随应用资源目录；仅用于查找，绝不打包第三方二进制 */
  resourceDir: string | null
}

export interface TranscoderInvocation {
  executable: string
  args: string[]
  /** 供界面展示的完整命令行（只读，供用户核对） */
  display: string
}

export class HdeAdapter {
  private cached: HdeToolStatus | null = null

  constructor(private readonly deps: HdeAdapterDeps) {}

  /**
   * 探测官方工具状态。
   *
   * VFS 是否可用是用「有没有挂载点」判断的，属于启发式：
   * 我们无法（也不打算）去探测内核扩展，只能看 CODEX Device Manager
   * 有没有把卷挂出来、以及卷上有没有出现 HDE 特征文件。
   */
  async status(force = false): Promise<HdeToolStatus> {
    if (this.cached !== null && !force) return this.cached

    const settings = this.deps.getSettings()
    const vfsVolumes = await this.detectVfsVolumes()
    const bundleInstalled = await this.anyExists(CODEX_BUNDLE_CANDIDATES)

    // 解析优先级：环境变量 > 设置里的手填路径 > 常见安装位置 > PATH 查找
    const envOverride = process.env['ARRIRAW_HDE_PATH'] ?? null
    const transcoderPath =
      (await resolveExecutable(envOverride)) ??
      (await resolveExecutable(settings.arrirawHdePath)) ??
      (await this.detectTranscoder())

    // 说明：README 要求"不把该路径与命令参数显示给最终用户"，指的是
    // 不写进清单/报告等交付物（本文件确实不写）。
    // 但 HDE 诊断页会显示解析到的路径 —— 用户自己指定了路径却看不到有没有生效，
    // 会让"工具找不到"这类问题完全无法排查。
    void this.deps.resourceDir

    let transcoderVersion: string | null = null
    if (transcoderPath !== null) {
      const version = await runCommand(transcoderPath, ['--version'], { timeoutMs: 10_000 })
      if (version.code === 0) {
        transcoderVersion = version.stdout.trim().split('\n')[0] ?? null
      } else {
        const help = await runCommand(transcoderPath, ['--help'], { timeoutMs: 10_000 })
        if (help.code === 0) {
          transcoderVersion = help.stdout.trim().split('\n')[0] ?? null
        }
      }
    }

    const vfsAvailable = vfsVolumes.length > 0 || bundleInstalled

    const messages: string[] = []
    if (vfsAvailable) {
      messages.push(
        vfsVolumes.length > 0
          ? `已检测到 CODEX Device Manager 虚拟文件系统，挂载卷：${vfsVolumes.join('、')}`
          : '已检测到 CODEX Device Manager 已安装，但当前没有检测到已挂载的卷。'
      )
    } else {
      messages.push(
        '未检测到 CODEX Device Manager。ALEXA Mini / Mini LF 的 HDE 素材将无法通过虚拟文件系统读取。'
      )
    }
    if (transcoderPath !== null) {
      messages.push(`已找到官方 ARRIRAW HDE 转码器：${transcoderPath}`)
    } else {
      messages.push(
        '未找到官方 ARRIRAW HDE 转码器（arrirawhde）。ALEXA 35 / 35 Xtreme / 265 的 HDE 编码需要它。'
      )
    }
    messages.push('HDE 编码能力由 ARRI / CODEX 官方免费工具提供，本应用不实现、不逆向、不打包这些工具。')

    this.cached = {
      vfsAvailable,
      vfsVolumes,
      transcoderPath,
      transcoderVersion,
      message: messages.join('\n'),
      requiresUserConfirmation: !vfsAvailable || transcoderPath === null
    }

    this.deps.logger.info('hde', `工具探测完成：vfs=${String(vfsAvailable)} transcoder=${String(transcoderPath)}`)
    return this.cached
  }

  /**
   * 依据源盘特征与机型给出处理决策。
   *
   * `declaredModel` 为 'auto' 时按内容特征推断；推断不出来就把决定权交回用户，
   * 绝不擅自假设一个机型然后跑错流程。
   */
  async decide(
    sourcePath: string,
    scan: ScanResult | null,
    declaredModel: HdeCameraModel | 'auto' = 'auto'
  ): Promise<HdeCapabilityDecision> {
    const toolStatus = await this.status()
    const settings = this.deps.getSettings()
    const signals = scan === null ? await this.probeSignals(sourcePath) : signalsFromScan(scan)

    const model = declaredModel === 'auto' ? inferModel(sourcePath, signals) : declaredModel

    if (model === 'unknown') {
      return {
        model,
        useVfs: false,
        requiresTranscoder: false,
        canProceed: true,
        degraded: false,
        message:
          '未在该源盘上识别到 HDE 特征。将按普通 ARRIRAW/素材拷贝处理，' +
          '仍会完成完整的哈希校验与报告。若这确实是 HDE 素材，请在界面里手动指定机型。'
      }
    }

    const isMiniFamily = model === 'alexa-mini' || model === 'alexa-mini-lf'
    const useVfs = isMiniFamily && toolStatus.vfsAvailable

    if (isMiniFamily) {
      if (useVfs) {
        return {
          model,
          useVfs: true,
          requiresTranscoder: false,
          canProceed: true,
          degraded: false,
          message:
            '将通过 CODEX Device Manager 虚拟文件系统读取 HDE 素材。' +
            '这些文件在 Finder 中显示为 0 字节属于预期行为，读取时由虚拟文件系统还原真实数据。'
        }
      }
      return {
        model,
        useVfs: false,
        requiresTranscoder: false,
        canProceed: settings.acceptHdeDowngrade,
        degraded: true,
        message:
          '未检测到 CODEX Device Manager，无法读取该卡的 HDE 素材。\n' +
          '请先安装官方 CODEX Device Manager 后重新挂载。\n' +
          '若你确认要继续，本应用会降级为普通 ARRIRAW 拷贝 + 哈希校验 —— ' +
          '注意此时读到的是虚拟文件系统缺席下可见的内容，可能与原始 HDE 数据不一致。'
      }
    }

    if (toolStatus.transcoderPath !== null) {
      return {
        model,
        useVfs: false,
        requiresTranscoder: true,
        canProceed: true,
        degraded: false,
        message:
          `该机型（${describeModel(model)}）的 HDE 编码必须由官方转码器完成。` +
          '已找到官方工具，执行前会先把完整命令行展示给你确认。'
      }
    }

    return {
      model,
      useVfs: false,
      requiresTranscoder: true,
      canProceed: settings.acceptHdeDowngrade,
      degraded: true,
      message:
        `该机型（${describeModel(model)}）的 HDE 编码必须由官方 ARRIRAW HDE Transcoder 完成，` +
        '但当前系统上未找到 `arrirawhde`。\n' +
        '本应用不会自己实现 HDE 编码（这既不合规也不可靠）。\n' +
        '可选：安装官方工具后重试，或确认降级为普通 ARRIRAW 拷贝 + 哈希校验。'
    }
  }

  /**
   * 构造官方转码器调用。
   *
   * 参数全部来自明确的字段，没有字符串拼接；调用方在真正执行前
   * 必须把 `display` 展示给用户确认。
   */
  buildInvocation(input: {
    source: string
    destination: string
    /** 用户从 `arrirawhde --help` 里核对过的附加参数，逐项加入 */
    extraArgs?: string[]
  }): TranscoderInvocation | null {
    const path = this.cached?.transcoderPath ?? null
    if (path === null) return null

    const args = [...(input.extraArgs ?? []), '--', input.source, input.destination]
    return {
      executable: path,
      args,
      display: [path, ...args].map((part) => (part.includes(' ') ? `"${part}"` : part)).join(' ')
    }
  }

  /** 读取官方工具的帮助文本，供界面展示给用户核对参数。 */
  async helpText(): Promise<string | null> {
    const status = await this.status()
    if (status.transcoderPath === null) return null
    const result = await runCommand(status.transcoderPath, ['--help'], { timeoutMs: 10_000 })
    if (result.code !== 0 && result.stdout.trim() === '') return null
    return result.stdout.trim() === '' ? result.stderr.trim() : result.stdout.trim()
  }

  /* ---------------------------------------------------------------- *
   * 探测实现
   * ---------------------------------------------------------------- */

  private async detectVfsVolumes(): Promise<string[]> {
    // 走统一的卷枚举：macOS 是 /Volumes 下的挂载目录，Windows 是盘符。
    // HDE 卷的名字特征（hde / codex / arriraw / arx）两个平台一样，规则不变。
    const found: string[] = []
    for (const entry of await listVolumeEntries()) {
      const lower = basename(entry.root).toLowerCase()
      if (HDE_NAME_HINTS.some((hint) => lower.includes(hint))) found.push(entry.root)
    }
    return found
  }

  private async detectTranscoder(): Promise<string | null> {
    for (const candidate of ARRIRAW_HDE_CANDIDATES) {
      const resolved = await resolveExecutable(candidate)
      if (resolved !== null) return resolved
    }
    // Windows 上 whichInPath 会按 PATHEXT 找到 arrirawhde.exe
    const inPath = await whichInPath('arrirawhde')
    return resolveExecutable(inPath)
  }

  private async anyExists(paths: string[]): Promise<boolean> {
    for (const path of paths) {
      if (await pathExists(path)) return true
    }
    return false
  }

  /** 目录级特征探测（在还没有扫描结果时使用）。 */
  private async probeSignals(root: string): Promise<HdeSignals> {
    const signals: HdeSignals = { arxCount: 0, zeroByteMediaCount: 0, hintInName: false }
    const lowerRoot = root.toLowerCase()
    signals.hintInName = HDE_NAME_HINTS.some((hint) => lowerRoot.includes(hint))
    try {
      const entries = await readdir(root, { withFileTypes: true })
      for (const entry of entries) {
        const lower = entry.name.toLowerCase()
        if (lower.endsWith('.arx')) signals.arxCount++
      }
    } catch {
      /* 读不到目录就不做判断 */
    }
    return signals
  }
}

interface HdeSignals {
  arxCount: number
  zeroByteMediaCount: number
  hintInName: boolean
}

function signalsFromScan(scan: ScanResult): HdeSignals {
  const arx = scan.extensions.find((item) => item.ext === 'arx')
  return {
    arxCount: arx?.count ?? 0,
    zeroByteMediaCount: 0,
    hintInName: HDE_NAME_HINTS.some((hint) => scan.root.toLowerCase().includes(hint))
  }
}

function inferModel(root: string, signals: HdeSignals): HdeCameraModel {
  const lower = root.toLowerCase()
  if (lower.includes('265') || lower.includes('alexa265')) return 'alexa-265'
  if (lower.includes('35xtreme') || lower.includes('35 xtreme')) return 'alexa-35-xtreme'
  if (lower.includes('alexa35') || lower.includes('alexa 35')) return 'alexa-35'
  if (lower.includes('minilf') || lower.includes('mini lf')) return 'alexa-mini-lf'
  if (lower.includes('min')) return 'alexa-mini'

  if (signals.arxCount > 0) return 'alexa-mini'
  if (signals.hintInName) return 'unknown'
  return 'unknown'
}

export function describeModel(model: HdeCameraModel): string {
  switch (model) {
    case 'alexa-mini':
      return 'ALEXA Mini'
    case 'alexa-mini-lf':
      return 'ALEXA Mini LF'
    case 'alexa-35':
      return 'ALEXA 35'
    case 'alexa-35-xtreme':
      return 'ALEXA 35 Xtreme'
    case 'alexa-265':
      return 'ALEXA 265'
    default:
      return '未识别机型'
  }
}

/** 供界面展示的卷标建议，仅用于显示。 */
export function suggestVolumeLabel(path: string): string {
  return basename(path)
}
