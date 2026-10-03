/**
 * 1.x → 2.0 的一次性数据迁移。
 *
 * 2.0 把应用名改成 `SecureReel DIT 2`（见 `@shared/version`），于是 macOS 的
 * userData 目录也跟着变成 `~/Library/Application Support/SecureReel DIT 2/`。
 * 好处是 1.x 的数据**原封不动留在原处**，坏处是新版本一启动会看到一片空白 ——
 * 这个模块负责把旧目录里的任务历史与报告搬过来。
 *
 * 三条设计原则：
 *  1. **绝不覆盖**：目标已有同名条目就跳过，不做任何合并或改写。
 *  2. **绝不删除旧数据**：整个迁移只读旧目录，搬完旧目录保持原样。
 *  3. **绝不阻断启动**：任何一步失败都只返回 `failed` 让人记日志，
 *     2.0 照样用空库正常起来（丢的是历史记录，不是素材）。
 *
 * 幂等性不靠标记文件，而靠"目标数据库是否已存在"这个天然判据 ——
 * 迁移成功一次之后，第二次启动必然走进 `skipped`。
 */
import { cp, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathExists } from '../fs-utils'

/** 1.x 的 userData 目录名（`app.setName('SecureReel DIT')` 的产物）。 */
export const LEGACY_USER_DATA_DIR = 'SecureReel DIT'

/** 数据库文件名，与 `paths.ts` 的 `buildAppPaths()` 保持一致。 */
export const DB_FILE = 'securereel.sqlite'

/**
 * 必须跟数据库一起搬的同名附属文件。
 *
 * 数据库跑在 WAL 模式下，最近提交的事务可能还留在 `-wal` 里没写回主库 ——
 * 只搬 `.sqlite` 会丢掉最后一次任务的结果。
 */
const DB_SIDECARS = ['-wal', '-shm'] as const

export interface MigrationResult {
  status: 'skipped' | 'migrated' | 'failed'
  /** 人话说明，可直接进日志与界面提示 */
  reason: string
  /** 实际搬过来的条目名（成功时用于日志） */
  copied: string[]
}

/**
 * 由当前 userData 目录推导出 1.x 的目录。
 *
 * 两者永远同级（都是 `~/Library/Application Support/` 下的目录），
 * 所以取父目录再拼常量即可，不需要写死绝对路径。
 */
export function legacyUserDataDirOf(currentUserDataDir: string): string {
  return join(dirname(currentUserDataDir), LEGACY_USER_DATA_DIR)
}

/**
 * 把 1.x 的数据搬进 2.0 的目录。**调用点必须在 `Store.open()` 之前**，
 * 否则数据库已被打开，复制到的就是一半旧一半新的状态。
 */
export async function migrateLegacyUserData(
  currentUserDataDir: string,
  legacyUserDataDir: string
): Promise<MigrationResult> {
  if (currentUserDataDir === legacyUserDataDir) {
    return { status: 'skipped', reason: '新旧数据目录相同，无需迁移', copied: [] }
  }

  if (await pathExists(join(currentUserDataDir, DB_FILE))) {
    // 已经是第二次以后启动了（或者用户自己在 2.0 里跑过任务）—— 不重复迁移
    return { status: 'skipped', reason: '2.0 的数据库已存在，不重复迁移', copied: [] }
  }

  if (!(await pathExists(join(legacyUserDataDir, DB_FILE)))) {
    return { status: 'skipped', reason: '没有找到 1.x 的数据，按全新安装处理', copied: [] }
  }

  const copied: string[] = []
  try {
    // 数据库三件套一起搬
    for (const suffix of ['', ...DB_SIDECARS]) {
      const name = `${DB_FILE}${suffix}`
      const from = join(legacyUserDataDir, name)
      if (await pathExists(from)) {
        await copyFile(from, join(currentUserDataDir, name))
        copied.push(name)
      }
    }

    // 报告档案整体搬（含 R001/R002 各修订目录、首尾帧、清单副本）。
    // force:false + errorOnExist:false = 遇到已存在的条目跳过，绝不覆盖。
    const legacyReports = join(legacyUserDataDir, 'reports')
    if (await pathExists(legacyReports)) {
      await cp(legacyReports, join(currentUserDataDir, 'reports'), {
        recursive: true,
        force: false,
        errorOnExist: false
      })
      copied.push('reports/')
    }

    return {
      status: 'migrated',
      reason: `已从 1.x 数据目录迁移：${copied.join('、')}`,
      copied
    }
  } catch (error) {
    // 迁移失败不能让 2.0 起不来：把已经搬了一半的情况说清楚，然后放行
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      copied
    }
  }
}
