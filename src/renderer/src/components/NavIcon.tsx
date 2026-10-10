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
    /*
     * 设置。**闭合轮廓的齿轮**，不是「中心圆 + 一圈射线」。
     *
     * 2026-10-11 改。上一版画的是 `<circle r=2.2>` 加 8 条等长细射线 ——
     * 那正是 ☀ 的标准字形，用户直接反馈「不像设置按钮，像亮度调节器」。
     * 区别在两点：**齿是轮廓上的方块凸起**（与本体连成一体，宽度明显大于描边），
     * 以及**中心有孔**。太阳是彼此分离的细线、且没有孔。
     *
     * 用 6 齿而不是 8 齿：16px 下 6 齿的齿宽才够，8 齿会糊成一圈。
     */
    case 'settings':
      return (
        <svg {...base}>
          <path d="M6.38 3.91L6.29 1.62L9.71 1.62L9.62 3.91A4.4 4.4 0 0 1 10.73 4.55L12.67 3.33L14.38 6.29L12.35 7.36A4.4 4.4 0 0 1 12.35 8.64L14.38 9.71L12.67 12.67L10.73 11.45A4.4 4.4 0 0 1 9.62 12.09L9.71 14.38L6.29 14.38L6.38 12.09A4.4 4.4 0 0 1 5.27 11.45L3.33 12.67L1.62 9.71L3.65 8.64A4.4 4.4 0 0 1 3.65 7.36L1.62 6.29L3.33 3.33L5.27 4.55Z" />
          <circle cx="8" cy="8" r="1.6" />
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
