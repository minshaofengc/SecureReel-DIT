/**
 * 外部命令调用的唯一出口。
 *
 * 全项目**所有**调用外部可执行文件的地方都必须经过这里，原因是安全约束
 * （项目硬性要求）只有集中在一个地方才守得住：
 *
 *   · 永远是 `shell: false` + 参数数组 —— 路径里出现空格、引号、`$(...)`、
 *     反引号都不会被 shell 解释，从根上杜绝命令注入
 *   · 可执行文件必须通过 `resolveExecutable()` 校验过，不接受任意字符串
 *   · 必定带超时，坏文件不会把整个任务挂死
 *   · 输出有上限，防止异常程序刷爆内存
 */
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { isExecutableFile } from './fs-utils'

export interface RunOptions {
  timeoutMs?: number
  cwd?: string
  /** stdout 上限（字节） */
  maxStdoutBytes?: number
  maxStderrBytes?: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  /** Complete stdout lines, including a trailing unterminated line. */
  onStdoutLine?: (line: string) => void
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** 进程启动本身失败（文件不存在、无执行权限） */
  spawnError: string | null
}

const DEFAULT_TIMEOUT = 30_000
const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024

/**
 * 校验一个路径确实指向可执行文件。
 *
 * 这是"参数化调用"的前提：只有确认过是真实可执行文件，才会把它交给 spawn。
 */
export async function resolveExecutable(
  candidate: string | null | undefined
): Promise<string | null> {
  if (candidate === null || candidate === undefined || candidate.trim() === '') return null
  if (candidate.includes('\0')) return null
  return (await isExecutableFile(candidate)) ? candidate : null
}

/**
 * 运行一个外部命令。
 *
 * 调用方必须先自行解析出绝对可执行路径；这里不再接受 PATH 查找，
 * 以保证"运行的是哪个二进制"完全可控、可审计。
 */
export function runCommand(
  executable: string,
  args: readonly string[],
  options: RunOptions = {}
): Promise<RunResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: null
    })
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_OUTPUT
  const maxStderr = options.maxStderrBytes ?? DEFAULT_MAX_OUTPUT

  return new Promise<RunResult>((resolve) => {
    let settled = false
    let timedOut = false
    let stdout = ''
    let stderr = ''
    let pendingLine = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const lineDecoder = new StringDecoder('utf8')

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(executable, [...args], {
        shell: false,
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: error instanceof Error ? error.message : String(error)
      })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()

    const finish = (code: number | null, spawnError: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (pendingLine) options.onStdoutLine?.(pendingLine)
      resolve({ code, stdout, stderr, timedOut, spawnError })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, maxStdout - stdoutBytes)
      stdout += stdoutDecoder.write(chunk.subarray(0, remaining))
      stdoutBytes += Math.min(remaining, chunk.length)
      if (options.onStdoutLine) {
        pendingLine += lineDecoder.write(chunk)
        const lines = pendingLine.split(/\r?\n/)
        pendingLine = lines.pop() ?? ''
        for (const line of lines) options.onStdoutLine(line)
        // Bound a broken tool's unterminated progress line.
        if (pendingLine.length > 65536) pendingLine = pendingLine.slice(-65536)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, maxStderr - stderrBytes)
      stderr += stderrDecoder.write(chunk.subarray(0, remaining))
      stderrBytes += Math.min(remaining, chunk.length)
    })
    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code, null))
  })
}
