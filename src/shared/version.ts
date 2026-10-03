/**
 * 应用版本号。
 *
 * 这里必须是一份独立的常量，而不是在运行时读 package.json：
 *   · 开发模式下 Electron 通过 `electron out/main/index.js` 启动，
 *     没有应用包上下文，`app.getVersion()` 会返回 **Electron 自己的版本号**
 *     （表现为界面上写着 v43.7.0，实际应用是 1.0.0）
 *   · 打包后 `app.getVersion()` 才正确，于是开发与生产的显示会不一致
 *
 * 代价是这里要手工同步。为此 tests/version.test.ts 会断言它与
 * package.json 的 version 一致 —— 忘了改就会红。
 */
export const APP_VERSION = '2.0.1'
/**
 * 应用名 = macOS userData 目录名。
 *
 * 2.0 起刻意带上 "2"：这样它既是界面上能一眼分辨的品牌名，
 * 又让 userData 落到 `~/Library/Application Support/SecureReel DIT 2/`，
 * 与 1.x 的目录**互不干扰** —— 老版本的任务历史与报告原样留在原处，
 * 由首次启动时的一次性迁移搬过来（见 `core/data-migration.ts`）。
 * 改这个名字等于改数据目录，动它之前先看迁移逻辑。
 */
export const APP_NAME = 'SecureReel DIT 2'
