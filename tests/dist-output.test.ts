import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const repository = dirname(dirname(fileURLToPath(import.meta.url)))
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture(platform: 'mac' | 'win', linked = false) {
  const workspace = await mkdtemp(join(tmpdir(), 'securereel-dist-'))
  temporary.push(workspace)
  const root = join(workspace, '01-源码', 'SecureReel-DIT')
  const marker = join(workspace, 'builder-invoked')
  await mkdir(join(root, 'scripts'), { recursive: true })
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
  await copyFile(
    join(repository, 'scripts', `dist-${platform}.sh`),
    join(root, 'scripts', `dist-${platform}.sh`)
  )
  await writeFile(join(root, 'scripts', 'check-win-assets.sh'), '#!/bin/sh\nexit 0\n')
  if (linked) await writeFile(join(root, '.git'), 'gitdir: /fixture/worktrees/staging\n')
  else await mkdir(join(root, '.git'))
  const builder = join(root, 'node_modules', '.bin', 'electron-builder')
  await writeFile(
    builder,
    `#!/bin/sh
set -eu
printf invoked > "$SECUREREEL_TEST_BUILDER_MARKER"
output=''
for argument in "$@"; do
  case "$argument" in -c.directories.output=*) output="\${argument#-c.directories.output=}";; esac
done
[ -n "$output" ] || exit 9
/bin/mkdir -p "$output/mac-universal/SecureReel DIT 2.app/Contents"
printf fresh > "$output/mac-universal/SecureReel DIT 2.app/Contents/new.txt"
printf package > "$output/fresh-package.zip"
`
  )
  await chmod(builder, 0o755)
  const script = join(root, 'scripts', `dist-${platform}.sh`)
  const invoke = (override?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, SECUREREEL_TEST_BUILDER_MARKER: marker }
    delete env.SECUREREEL_OUTPUT_DIR
    if (override !== undefined) env.SECUREREEL_OUTPUT_DIR = override
    return run('/bin/sh', [script], { cwd: root, env })
  }
  return { root, workspace, marker, invoke }
}

describe.skipIf(process.platform === 'win32').each(['mac', 'win'] as const)(
  '%s packaging output guard',
  (platform) => {
    it('rejects relative output before invoking the builder', async () => {
      const f = await fixture(platform)
      await expect(f.invoke('../unsafe')).rejects.toThrow()
      await expect(readFile(f.marker)).rejects.toThrow()
    })
    it('rejects empty or traversal-containing overrides before invoking the builder', async () => {
      const f = await fixture(platform)
      for (const output of [
        '',
        f.workspace + '/candidate/../other',
        f.workspace + '/./candidate'
      ]) {
        await expect(f.invoke(output)).rejects.toThrow()
      }
      await expect(readFile(f.marker)).rejects.toThrow()
    })
    it('uses an absolute destination whose parent directories do not exist yet', async () => {
      const f = await fixture(platform, true)
      const output = join(f.workspace, 'new-parent', 'new-child')
      await f.invoke(output)
      expect(await readFile(join(output, 'fresh-package.zip'), 'utf8')).toBe('package')
    })
    it('requires an explicit output when the repository uses a linked worktree', async () => {
      const f = await fixture(platform, true)
      await expect(f.invoke()).rejects.toThrow()
      await expect(readFile(f.marker)).rejects.toThrow()
    })
    it('keeps the default platform destination in a normal checkout', async () => {
      const f = await fixture(platform)
      await f.invoke()
      const output = join(f.workspace, platform === 'mac' ? '02-Mac 版' : '03-Windows 版')
      expect(await readFile(join(output, 'fresh-package.zip'), 'utf8')).toBe('package')
    })
    it('uses an absolute staging path and retains previous packages', async () => {
      const f = await fixture(platform, true)
      const output = join(f.workspace, '候选产物 with spaces')
      await mkdir(output)
      await writeFile(join(output, 'previous-package.zip'), 'previous')
      await f.invoke(output)
      expect(await readFile(join(output, 'fresh-package.zip'), 'utf8')).toBe('package')
      expect(await readFile(join(output, 'previous-package.zip'), 'utf8')).toBe('previous')
    })
    it('rejects root, source, source descendants, source ancestors, and file paths', async () => {
      const f = await fixture(platform)
      const file = join(f.workspace, 'file')
      await writeFile(file, 'keep')
      for (const output of ['/', f.root, join(f.root, 'release'), f.workspace, file]) {
        await expect(f.invoke(output)).rejects.toThrow()
      }
      await expect(readFile(f.marker)).rejects.toThrow()
      expect(await readFile(file, 'utf8')).toBe('keep')
    })
    it('rejects a symlink output that resolves inside the source directory', async () => {
      const f = await fixture(platform)
      const { symlink } = await import('node:fs/promises')
      const alias = join(f.workspace, 'source-alias')
      await symlink(f.root, alias, 'dir')
      await expect(f.invoke(alias)).rejects.toThrow()
      await expect(readFile(f.marker)).rejects.toThrow()
    })
  }
)

describe.skipIf(process.platform === 'win32')('macOS application publication', () => {
  it('copies fresh app files while retaining existing destination files and builder output', async () => {
    const f = await fixture('mac', true)
    const output = join(f.workspace, 'candidate')
    const app = join(output, 'SecureReel DIT 2.app', 'Contents')
    await mkdir(app, { recursive: true })
    await writeFile(join(app, 'keep-existing.txt'), 'existing')
    await f.invoke(output)
    expect(await readFile(join(app, 'keep-existing.txt'), 'utf8')).toBe('existing')
    expect(await readFile(join(app, 'new.txt'), 'utf8')).toBe('fresh')
    expect(
      await readFile(
        join(output, 'mac-universal', 'SecureReel DIT 2.app', 'Contents', 'new.txt'),
        'utf8'
      )
    ).toBe('fresh')
  })
})
