import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // exclude 会整体覆盖默认值，必须把 vitest 默认排除项一起写回来；
    // 再补 `**/._*`（macOS 在 exFAT 盘生成的 AppleDouble 伴随文件，如 `tests/._x.test.ts`）。
    exclude: [...configDefaults.exclude, '**/._*'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true
  }
})
