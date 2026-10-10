import type { ReactNode } from 'react'

/**
 * 侧栏导航图标（内联 SVG，16px，线性风格）。
 *
 * ## 为什么自己画而不用字符
 *
 * 此前用的是 Unicode 字符（⤓ ☰ ▤ ◈ ✎ ⚙ ?），boss 反馈"菜单里的也改掉"。
 * 字符的问题：
 *   1. 每个字符来自不同字体的符号区，笔画粗细、视觉重心、线条风格完全不统一
 *      —— "报告"的 ▤ 是实心块，"拷贝"的 ⤓ 是细线，摆在一列里像拼凑的
 *   2. Unicode 符号在不同系统/字体下会退化（Windows 上 ⤓ 可能显示成方框）
 *   3. 没法用 currentColor 精确控制粗细
 *
 * 16px / stroke 1.6 / round cap —— 与界面里的 1.5px 描边是同一套语言。
 * 用 currentColor，颜色完全由父级（.nav-item）决定。
 *
 * 图标语义（剧组视角）：
 *   copy   下箭头入盘 —— 拷贝
 *   queue  三行列表   —— 任务队列
 *   report 文件纸     —— 报告
 *   hde    菱形标记   —— HDE 工作流（保持原字符的意象）
 *   project 铅笔      —— 母项目
 *   settings 齿轮     —— 设置
 *   help   问号       —— 帮助
 *   collapse/expand  竖板 + 箭头 —— 侧栏收放
 *   view-*           同内容三种排法 —— 视图模式
 */

const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
}

export function NavIcon({ name }: { name: string }): ReactNode {
  switch (name) {
    case 'copy':
      return (
        <svg {...base}>
          <path d="M8 2.5v8" />
          <path d="M4.8 7.5 8 10.7l3.2-3.2" />
          <path d="M2.5 13.5h11" />
        </svg>
      )
    case 'queue':
      return (
        <svg {...base}>
          <path d="M2.5 4h11" />
          <path d="M2.5 8h11" />
          <path d="M2.5 12h7.5" />
        </svg>
      )
    case 'reports':
      return (
        <svg {...base}>
          <path d="M4 1.8h5.2L12.5 5v9.2H4z" />
          <path d="M9 2v3.2h3.4" />
        </svg>
      )
    case 'hde':
      return (
        <svg {...base}>
          <rect x="4.6" y="4.6" width="6.8" height="6.8" transform="rotate(45 8 8)" />
        </svg>
      )
    case 'project':
      return (
        <svg {...base}>
          <path d="M10.3 2.6 13.4 5.7 6 13.1l-3.6.5.5-3.6z" />
        </svg>
      )
    /*
     * 工作台。四格窗 —— 一眼看出"这是一个总览页"，而不是又一页清单。
     * 与 view-cards 的区别：那个讲"同一批内容的三种排法"，这个讲"整件事的全景"。
     */
    case 'home':
      return (
        <svg {...base}>
          <rect x="2.2" y="2.2" width="5" height="5" rx="1" />
          <rect x="8.8" y="2.2" width="5" height="5" rx="1" />
          <rect x="2.2" y="8.8" width="5" height="5" rx="1" />
          <rect x="8.8" y="8.8" width="5" height="5" rx="1" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...base}>
          <circle cx="8" cy="8" r="2.2" />
          {/* 齿轮外圈：8 个短齿 */}
          <path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" />
        </svg>
      )
    case 'help':
      return (
        <svg {...base}>
          <path d="M5.8 6a2.2 2.2 0 1 1 3.2 2c-.7.4-1 .9-1 1.7" />
          <path d="M8 12.2v.2" />
        </svg>
      )
    /*
     * 侧栏收放。两个方向各画一个，而不是画一个再旋转 ——
     * 旋转会把 16px 的圆头笔画在非整数像素上，边角发虚。
     *
     * 画的是"一块竖板 + 指向它的箭头"：左边那条竖线代表侧栏本身，
     * 箭头指向它 = 收进去，背离它 = 展开。单看一个三角形容易被当成
     * "上/下一页"，加上那块板子就没有歧义了。
     */
    case 'collapse':
      return (
        <svg {...base}>
          <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1" />
          <path d="M6 2.8v10.4" />
          <path d="M12.2 5.8 9.6 8l2.6 2.2" />
        </svg>
      )
    case 'expand':
      return (
        <svg {...base}>
          <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1" />
          <path d="M6 2.8v10.4" />
          <path d="M9.6 5.8 12.2 8l-2.6 2.2" />
        </svg>
      )
    /*
     * 视图模式三档。三个图形刻意画成"同一块内容的不同排法"，
     * 而不是三个无关的符号 —— 用户看的是"我的东西会变成什么样"：
     *   cards   两列方块 + 一条通栏  —— 卡片式，分区最清楚
     *   compact 四行密排            —— 紧凑式，一屏看得最多
     *   focus   一条居中的窄栏      —— 专注式，一次只做一件事
     */
    case 'view-cards':
      return (
        <svg {...base}>
          <rect x="2" y="2.6" width="5.4" height="4.4" />
          <rect x="8.6" y="2.6" width="5.4" height="4.4" />
          <rect x="2" y="8.6" width="12" height="4.8" />
        </svg>
      )
    case 'view-compact':
      return (
        <svg {...base}>
          <path d="M2.5 3.4h11" />
          <path d="M2.5 6.5h11" />
          <path d="M2.5 9.6h11" />
          <path d="M2.5 12.7h7.5" />
        </svg>
      )
    case 'view-focus':
      return (
        <svg {...base}>
          <rect x="4.4" y="2.6" width="7.2" height="10.8" />
          <path d="M6.4 5.6h3.2" />
        </svg>
      )
    default:
      return null
  }
}
