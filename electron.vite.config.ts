import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * 按环境收紧内容安全策略。
 *
 * 开发模式下 Vite 与 React 快速刷新需要内联脚本，生产构建则不应该需要。
 * 与其为了保证 dev 能跑而在生产里也放开 'unsafe-inline'，
 * 不如在这里按环境分别下料。
 */
function cspPlugin(): Plugin {
  return {
    name: 'securereel-csp',
    transformIndexHtml(html, context) {
      const isDev = context.server !== undefined
      const scriptSrc = isDev ? "'self' 'unsafe-inline'" : "'self'"
      return html.replace('__CSP_SCRIPT_SRC__', scriptSrc)
    }
  }
}

/**
 * 三进程分层构建：
 *  - main    → 文件、哈希、数据库、报告、外部工具（Node 环境）
 *  - preload → 唯一的 IPC 桥，带参数校验的类型化 API
 *  - renderer→ React 界面，sandbox + contextIsolation，无 Node 集成
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // 端到端验证入口只在显式开启时参与构建，不会进正式产物
          ...(process.env.SECUREREEL_VERIFY === '1'
            ? { verify: resolve(__dirname, 'src/main/verify-pipeline.ts') }
            : {})
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), cspPlugin()],
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
