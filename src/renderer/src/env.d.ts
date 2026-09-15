/// <reference types="vite/client" />

import type { SecureReelApi } from '@shared/ipc'

declare global {
  interface Window {
    /** 由预加载脚本通过 contextBridge 注入；渲染进程唯一的系统访问入口 */
    securereel: SecureReelApi
  }
}

export {}
