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
export const APP_VERSION = '1.2.5'
export const APP_NAME = 'SecureReel DIT'
