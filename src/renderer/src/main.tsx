import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/tokens.css'
import './styles/app.css'
/*
 * 2026-10-05 第五次改（方案 E）新增的两份。
 *
 * ⚠️ **顺序有意义**：它们在 app.css 之后，同权重规则以它们为准 ——
 * 外壳从"左侧栏"换成"顶部三段导航"、工作台与监控页改用行式分区，
 * 都是靠这个顺序覆盖掉 app.css 里的旧规则。
 * 排到 app.css 前面会静默失效（表现为"新样式没生效"）。
 */
import './styles/shell.css'
import './styles/workbench.css'
import './styles/monitor.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('找不到 #root 挂载点')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
