/**
 * 文件系统工具测试。
 *
 * 重点在**路径安全**：这一层是防止"把文件写到目标盘之外"的唯一闸门，
 * 一旦 normalizeRelPath 出问题，界面上的任何路径输入都可能变成越权写入。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PARTIAL_MARKER,
  commitPartial,
  describeVolume,
  isNestedPath,
  isSameVolume,
  normalizeRelPath,
  partialPathFor,
  pathExists,
  removeQuietly,
  resolveInside,
  safeFolderName,
  safeSourceRootName,
  stripTrailingSeparators,
  targetRelativePath,
  toPosix,
  volumeUsage,
  walkFiles,
  whichInPath
} from '../src/main/fs-utils'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'securereel-fs-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('相对路径规范化', () => {
  it('去掉开头的 ./ 与多余斜杠', () => {
    expect(normalizeRelPath('./Clips/a.mov')).toBe('Clips/a.mov')
    expect(normalizeRelPath('Clips//a.mov')).toBe('Clips/a.mov')
    expect(normalizeRelPath('Clips/a.mov')).toBe('Clips/a.mov')
  })

  it('反斜杠是 macOS 上的合法文件名字符，不会被当成路径分隔符改写', () => {
    // 关键：如果这里把 \ 换成 /，清单里就会写出一个不存在的路径。
    // 这比"格式不统一"严重得多，所以要显式锁住这个行为。
    expect(toPosix('Clips/sub/a.mov')).toBe('Clips/sub/a.mov')
    expect(toPosix('odd\\name.mov')).toBe('odd\\name.mov')
    expect(toPosix('Clips/sub/a.mov')).not.toContain('\\')
  })

  it('带反斜杠的真实文件名能被完整拷贝路径逻辑接受', () => {
    expect(normalizeRelPath('Clips/odd\\name.mov')).toBe('Clips/odd\\name.mov')
  })

  it.each(['../escape', 'a/../../escape', 'a/b/../../../escape', './../x'])(
    '拒绝跳出根目录的路径 %s',
    (input) => {
      expect(() => normalizeRelPath(input)).toThrow(/跳出根目录/)
    }
  )

  it('拒绝包含 NUL 的路径', () => {
    expect(() => normalizeRelPath('a\0b')).toThrow(/非法字符/)
  })

  it('拒绝空路径', () => {
    expect(() => normalizeRelPath('')).toThrow(/为空/)
    expect(() => normalizeRelPath('./')).toThrow(/为空/)
  })

  it('resolveInside 拼出的绝对路径始终在根之内', () => {
    expect(resolveInside('/tmp/base', 'a/b.mov')).toBe('/tmp/base/a/b.mov')
    // 前缀相似的兄弟目录不能被误判为在根之内
    expect(() => resolveInside('/tmp/base', '../base-evil/x')).toThrow()
  })
})

describe('中转文件与原子改名', () => {
  it('分片文件名带隐藏前缀与标记，且与最终文件同目录', async () => {
    const final = join(root, 'sub', 'clip.mov')
    const partial = partialPathFor(final)
    expect(partial).toBe(join(root, 'sub', `.clip.mov${PARTIAL_MARKER}`))
    expect(partial.includes(PARTIAL_MARKER)).toBe(true)
  })

  it('commitPartial 之后最终文件存在、分片消失', async () => {
    const final = join(root, 'clip.mov')
    const partial = partialPathFor(final)
    await writeFile(partial, 'payload')
    expect(await pathExists(final)).toBe(false)

    await commitPartial(partial, final)

    expect(await readFile(final, 'utf8')).toBe('payload')
    expect(await pathExists(partial)).toBe(false)
  })

  it('removeQuietly 对不存在的文件不报错', async () => {
    await expect(removeQuietly(join(root, 'nope'))).resolves.toBeUndefined()
  })
})

describe('目录遍历', () => {
  it('递归收集文件并汇总体积', async () => {
    await mkdir(join(root, 'src/Clips'), { recursive: true })
    await writeFile(join(root, 'src/Clips/a.mov'), 'aaaa')
    await writeFile(join(root, 'src/Clips/b.mov'), 'bb')
    await writeFile(join(root, 'src/Sidecar.txt'), 'ccc')

    const result = await walkFiles(join(root, 'src'))
    expect(result.files.length).toBe(3)
    expect(result.files.map((file) => file.relPath).sort()).toEqual([
      'Clips/a.mov',
      'Clips/b.mov',
      'Sidecar.txt'
    ])
    expect(result.totalBytes).toBe(9)
  })

  it('默认跳过 macOS 系统垃圾文件', async () => {
    await writeFile(join(root, '.DS_Store'), 'junk')
    await writeFile(join(root, 'real.mov'), 'x')
    const result = await walkFiles(root)
    expect(result.files.map((file) => file.relPath)).toEqual(['real.mov'])
  })

  it('跳过本软件自己的分片文件', async () => {
    await writeFile(join(root, `x.mov${PARTIAL_MARKER}`), 'partial')
    await writeFile(join(root, 'x.mov'), 'real')
    const result = await walkFiles(root)
    expect(result.files.map((file) => file.relPath)).toEqual(['x.mov'])
  })

  it('不跟随符号链接（避免把源盘再拷一遍）', async () => {
    await mkdir(join(root, 'target'), { recursive: true })
    await writeFile(join(root, 'target/real.mov'), 'x')
    await symlink(join(root, 'target'), join(root, 'link'))

    const result = await walkFiles(root)
    expect(result.files.map((file) => file.relPath)).toEqual(['target/real.mov'])
  })

  it('超过文件上限时截断并给出告警', async () => {
    for (let i = 0; i < 5; i++) await writeFile(join(root, `f${i}.bin`), 'x')
    const result = await walkFiles(root, { maxFiles: 3 })
    expect(result.files.length).toBe(3)
    expect(result.warnings.join('\n')).toMatch(/上限/)
  })
})

/**
 * 尾斜杠是一类真实的事故来源：界面上的路径是可手输的文本框，
 * 从访达「拷贝路径」或终端粘贴时经常带一个尾斜杠。
 * 曾经的实现用 `absPath.slice(root.length + 1)` 算相对路径，
 * 带尾斜杠时会多切一个字符 —— 每条相对路径都丢掉首字母，
 * 扫描阶段完全正常，一开跑每个文件都拼不出真实路径而失败。
 */
describe('路径尾斜杠', () => {
  it('stripTrailingSeparators 削掉多余的尾斜杠，但保留根目录', () => {
    expect(stripTrailingSeparators('/Volumes/CARD/')).toBe('/Volumes/CARD')
    expect(stripTrailingSeparators('/Volumes/CARD///')).toBe('/Volumes/CARD')
    expect(stripTrailingSeparators('/Volumes/CARD')).toBe('/Volumes/CARD')
    expect(stripTrailingSeparators('/')).toBe('/')
    expect(stripTrailingSeparators('///')).toBe('/')
  })

  it('带尾斜杠调用 walkFiles 得到的相对路径与不带时完全一致', async () => {
    await mkdir(join(root, 'DCIM/100'), { recursive: true })
    await writeFile(join(root, 'DCIM/100/A001.MP4'), 'aaaa')
    await writeFile(join(root, 'Sidecar.txt'), 'bb')

    const plain = await walkFiles(root)
    const slashed = await walkFiles(`${root}/`)

    expect(plain.files.map((file) => file.relPath).sort()).toEqual([
      'DCIM/100/A001.MP4',
      'Sidecar.txt'
    ])
    expect(slashed.files.map((file) => file.relPath).sort()).toEqual(
      plain.files.map((file) => file.relPath).sort()
    )
    expect(slashed.totalBytes).toBe(plain.totalBytes)
  })

  it('resolveInside 对带尾斜杠的根给出同样的绝对路径', () => {
    expect(resolveInside('/tmp/base/', 'a/b.mov')).toBe('/tmp/base/a/b.mov')
    expect(resolveInside('/tmp/base', 'a/b.mov')).toBe('/tmp/base/a/b.mov')
    expect(() => resolveInside('/tmp/base/', '../escape')).toThrow()
  })
})

describe('卷与嵌套判断', () => {
  it('同一卷上的两个目录被识别为同卷', async () => {
    await mkdir(join(root, 'a'), { recursive: true })
    await mkdir(join(root, 'b'), { recursive: true })
    expect(await isSameVolume(join(root, 'a'), join(root, 'b'))).toBe(true)
  })

  it('父子目录会被识别为嵌套', async () => {
    await mkdir(join(root, 'parent/child'), { recursive: true })
    expect(await isNestedPath(join(root, 'parent/child'), join(root, 'parent'))).toBe(true)
    expect(await isNestedPath(join(root, 'parent'), join(root, 'parent/child'))).toBe(true)
  })

  it('互不相干的目录不算嵌套', async () => {
    await mkdir(join(root, 'x'), { recursive: true })
    await mkdir(join(root, 'y'), { recursive: true })
    expect(await isNestedPath(join(root, 'x'), join(root, 'y'))).toBe(false)
  })

  it('能读出卷的容量信息', async () => {
    const usage = await volumeUsage(root)
    expect(usage).not.toBeNull()
    expect(usage?.totalBytes).toBeGreaterThan(0)
    expect(usage?.availableBytes).toBeGreaterThanOrEqual(0)
  })

  it('能推断出卷的展示名', async () => {
    const description = await describeVolume(root)
    expect(description).not.toBeNull()
    expect(description?.label.length).toBeGreaterThan(0)
    expect(description?.mountPoint.startsWith('/')).toBe(true)
  })
})

describe('可执行文件查找', () => {
  it('能在 PATH 中找到系统自带命令', async () => {
    const found = await whichInPath('ls', { PATH: '/bin:/usr/bin' })
    expect(found).not.toBeNull()
  })

  it('找不到时返回 null 而不是抛错', async () => {
    expect(await whichInPath('definitely-not-a-real-binary-xyz', { PATH: '/bin' })).toBeNull()
  })
})

/**
 * 目标盘的落盘层级。
 *
 * 这两个函数是**一处实现、两处调用**（拷贝引擎拼写入路径、
 * 报告层拼清单路径），两边必须永远一致 —— 各算各的就会出现
 * "清单里列了它、盘上却找不到"这种最难查的问题。
 */
describe('来源目录名与目标盘路径', () => {
  it('取出路径最后一段作为来源目录名', () => {
    expect(safeSourceRootName('/Volumes/A002R2EC')).toBe('A002R2EC')
    expect(safeSourceRootName('/Volumes/A002R2EC/')).toBe('A002R2EC')
    expect(safeSourceRootName('/Volumes/CARD/DCIM/100')).toBe('100')
    expect(safeSourceRootName('relative-folder')).toBe('relative-folder')
  })

  it('取不到像样的名字时返回空串，绝不把危险段拼进目标路径', () => {
    // 根目录的末段是空串；`.` 与 `..` 拼进路径会让文件落到盘外
    expect(safeSourceRootName('/')).toBe('')
    expect(safeSourceRootName('/Volumes/CARD/..')).toBe('')
    expect(safeSourceRootName('/Volumes/CARD/.')).toBe('')
  })

  it('拼出 <来源目录名>/<源内相对路径>', () => {
    expect(targetRelativePath('A001', 'DCIM/100/A001_C001.mov')).toBe('A001/DCIM/100/A001_C001.mov')
    expect(targetRelativePath('A001', 'clip.mov')).toBe('A001/clip.mov')
  })

  it('来源目录名为空串时原样返回 —— 1.x 的存量任务行为不变', () => {
    expect(targetRelativePath('', 'DCIM/100/A001_C001.mov')).toBe('DCIM/100/A001_C001.mov')
  })

  it('任务名安全化：保留中文，只清掉会破坏路径结构的字符', () => {
    // 中文必须留着 —— 这个目录是给人看的，不是给校验工具看的
    expect(safeFolderName('D02 A机 主卡')).toBe('D02 A机 主卡')
    // 斜杠会拆成两级；冒号在访达里被显示成斜杠，同样会让人误判
    expect(safeFolderName('D02/A机')).toBe('D02_A机')
    expect(safeFolderName('D02:A机')).toBe('D02_A机')
    // 前导点会变成隐藏目录（在访达里"看不见"）；尾随点会被文件系统静默吞掉
    expect(safeFolderName('.hidden')).toBe('hidden')
    expect(safeFolderName('trailing...')).toBe('trailing')
    // 连续空白折叠成一个空格
    expect(safeFolderName('  多余   空白  ')).toBe('多余 空白')
  })

  it('任务名没有可用内容时返回空串，让调用方自行回退', () => {
    expect(safeFolderName('')).toBe('')
    expect(safeFolderName('   ')).toBe('')
    expect(safeFolderName('...')).toBe('')
  })
})
