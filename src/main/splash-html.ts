/**
 * 开屏页面的模板。
 *
 * ## 为什么单独一个文件、且**不 import electron**
 *
 * 这段 HTML 决定"开屏长什么样"，而它恰恰是最容易**悄悄坏掉**的东西：
 * 它不接 IPC、不读数据库，出问题不会有任何报错，只是启动时多一块白板。
 * 所以要能写单元测试钉住它 —— 而测试跑在纯 Node 里，一 import `electron`
 * 就炸（那个包在 Node 下导出的是一个路径字符串，不是真正的模块）。
 *
 * 于是这里只留"模板 + 配色常量"这点纯东西，窗口怎么建、什么时候关，
 * 全在 splash.ts。明暗由调用方按系统外观选好传进来。
 */
import { APP_NAME, APP_VERSION } from '@shared/version'

/** 开屏窗尺寸（逻辑像素）。宽高比接近一张横构图的取景框。 */
export const SPLASH_WIDTH = 560
export const SPLASH_HEIGHT = 380

/** 淡出时长，必须与模板里 CSS 的 transition 保持一致。 */
export const SPLASH_FADE_MS = 240

export interface SplashPalette {
  card: string
  /** 粗描边（1.5px）—— 方案 A 的签名，卡片靠它立起来而不是靠阴影 */
  edge: string
  /** 齿孔、表格线等"刻意的深色小元素" */
  faint: string
  text: string
  muted: string
  accent: string
  /** 电光绿底上的文字色（近黑） */
  accentInk: string
  track: string
}

/**
 * 两份配色，与 tokens.css 的**默认皮肤（暗房 / Darkroom）**对齐。
 *
 * ⚠️ 这里的内联色值是一个**刻意的例外**。全项目的颜色都走
 * `styles/tokens.css` 的 CSS 变量，但这个窗口出现在主题系统就绪**之前**
 * （连设置都还没读出来），拿不到那套变量。
 * 代价：两份色板要手动与 tokens.css 保持一致 ——
 * 改默认皮肤时记得回来改这里，否则开屏那两秒会换个颜色。
 * 换来的是"启动立刻有画面"。
 *
 * ⚠️ 它只跟随**默认皮肤**。用户在设置里换成暖砂/靛青之后，开屏仍是暗房 ——
 * 这是有意接受的：开屏要能在读设置之前就画出来，
 * 而"为了两秒的开屏先去读 kv"会把它变成"启动先白屏一下"。
 */
export const SPLASH_PALETTE: { light: SplashPalette; dark: SplashPalette } = {
  light: {
    card: '#ffffff',
    edge: 'rgba(20, 24, 30, 0.22)',
    faint: 'rgba(20, 24, 30, 0.12)',
    text: '#1a1d22',
    muted: '#565b63',
    accent: '#2f6fb5',
    accentInk: '#ffffff',
    track: '#f4f5f7'
  },
  dark: {
    card: '#26262b',
    edge: 'rgba(255, 255, 255, 0.22)',
    faint: 'rgba(255, 255, 255, 0.12)',
    text: '#e8e8ea',
    muted: '#a0a0a8',
    accent: '#4a8fe7',
    accentInk: '#08121e',
    track: '#2e2e34'
  }
}

/**
 * 开屏页面的完整 HTML。
 *
 * 画面是**胶片 + 时码**：齿孔一排排走动、时码按 24 fps 往上跳。
 * 这套元素一个都没删 —— 它们组里人一眼就熟，也正好对应软件本身在做的事。
 * 2026-10-04 视觉重设计只换了呈现方式：
 *
 *   · 标题从 19px 常规字重 → **超大紧缩粗体**（方案 A 的排版胆量）
 *   · 卡片从 1px 细边+ 圆角 → **1.5px 粗描边**（米白底上阴影会发灰，靠描边分区）
 *   · 时码从主色 → **电光绿大色块**（近黑字压在上面），当画面里唯一的重点
 *   · 胶片格从 8 个 → 5 个，给标题让出垂直空间
 *   · 进度条改成 6px、方头 —— 与 App 内进度条同一种语言
 */
export function splashHtml(palette: SplashPalette): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<title>启动中</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
    -webkit-user-select: none; user-select: none;
    overflow: hidden;
  }
  body { opacity: 1; transition: opacity ${SPLASH_FADE_MS}ms ease; }
  body.fading { opacity: 0; }

  .card {
    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    border-radius: 18px;
    /* 1.5px 粗描边 —— 与 App 内所有卡片同一套语言 */
    border: 1.5px solid ${palette.edge};
    background: ${palette.card};
    color: ${palette.text};
    overflow: hidden;
  }

  /* ---- 胶片：上下各一排齿孔，中间一格格画面在走 ---- */
  .film {
    position: relative;
    height: 88px;
    background: ${palette.track};
    border-bottom: 1.5px solid ${palette.edge};
    overflow: hidden;
  }
  .strip {
    position: absolute; top: 0; left: 0;
    display: flex; width: 200%;
    height: 100%;
    animation: roll 6.5s linear infinite;
  }
  /* 内容复制一份首尾相接：滚到 50% 时正好接上，接缝看不出来 */
  @keyframes roll { from { transform: translateX(0); } to { transform: translateX(-50%); } }

  .frame {
    position: relative;
    flex: 0 0 20%;
    height: 100%;
    padding: 18px 5px;
    display: flex; gap: 5px;
  }
  .cell {
    flex: 1;
    border-radius: 4px;
    border: 1px solid ${palette.edge};
    background: ${palette.card};
  }
  /* 齿孔：每格上下各一排，用重复的线性渐变画出来，省掉一堆 DOM */
  .frame::before, .frame::after {
    content: '';
    position: absolute; left: 0; right: 0; height: 8px;
    background-image: repeating-linear-gradient(
      to right,
      transparent 0 5px,
      ${palette.faint} 5px 13px,
      transparent 13px 26px
    );
  }
  .frame::before { top: 4px; }
  .frame::after { bottom: 4px; }

  /*
   * 扫描光：横着扫过胶片，暗示"正在读"。
   *
   * 必须限制在胶片内（overflow:hidden 在 .film 上，但 .scan 是它的兄弟节点
   * .strip 的同级 —— 一旦位移超过胶片宽度就会溢到卡片外面，
   * 表现为左上角一道绿光斑，看起来像渲染瑕疵而不是效果）。
   * 起点给 -84px，终点给胶片宽度减去自身宽度，两者都收在框内。
   */
  .scan {
    position: absolute; top: 0; bottom: 0; width: 84px;
    background: linear-gradient(90deg, transparent, ${palette.accent}40, transparent);
    animation: sweep 2.2s ease-in-out infinite;
  }
  @keyframes sweep {
    0% { transform: translateX(-84px); }
    100% { transform: translateX(${SPLASH_WIDTH - 24}px); }
  }

  /* ---- 文字区 ---- */
  .body { flex: 1; padding: 20px 26px 0; display: flex; flex-direction: column; }

  /*
   * 品牌名用超大字号 + 收紧字距。
   * 系统字体在 30px 以上默认字距偏松，不收紧会显得松垮垮，
   * 撑不起"厚"的观感 —— 这是方案 A 排版的关键一笔。
   */
  .brand {
    font-size: 30px;
    font-weight: 800;
    line-height: 1.1;
    letter-spacing: -0.8px;
  }
  .tagline { margin-top: 6px; font-size: 12px; color: ${palette.muted}; }

  /*
   * 时码：整块电光绿底 + 近黑字，画面里唯一的重点。
   * 与App 内进度条同一种语言 —— 同一套颜色在两处出现，认得出是同一个软件。
   * 数字用等宽，跳动时不会左右抖。
   */
  .row { margin-top: 16px; display: flex; align-items: center; gap: 10px; }
  .tc {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 20px; font-weight: 700; letter-spacing: 0.5px;
    color: ${palette.accentInk};
    background: ${palette.accent};
    border-radius: 8px;
    padding: 5px 12px;
    font-variant-numeric: tabular-nums;
  }
  .tc-label { font-size: 11px; color: ${palette.muted}; }

  /* 进度条：6px、方头 —— 与 App 内 .progress 同一种形状 */
  .bar { margin-top: 14px; height: 6px; border-radius: 3px; background: ${palette.track}; overflow: hidden; }
  .bar > span { display: block; height: 100%; width: 40%; background: ${palette.accent}; animation: slide 1.15s cubic-bezier(0.32,0.72,0,1) infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }

  .status { margin-top: 10px; font-size: 12px; color: ${palette.muted}; min-height: 16px; }

  .credits { margin-top: auto; padding: 12px 0 16px; font-size: 11px; line-height: 1.75; color: ${palette.muted}; }
  .credits b { font-weight: 700; color: ${palette.text}; }

  /* 系统开了「减弱动态效果」：不滚动、不扫光，只留时码在走 */
  @media (prefers-reduced-motion: reduce) {
    .strip { animation: none; }
    .scan { display: none; }
    .bar > span { animation: none; width: 100%; opacity: 0.5; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="film">
      <div class="strip">
        <div class="frame"><span class="cell"></span><span class="cell"></span></div>
        <div class="frame"><span class="cell"></span><span class="cell"></span></div>
        <div class="frame"><span class="cell"></span><span class="cell"></span></div>
        <div class="frame"><span class="cell"></span><span class="cell"></span></div>
        <div class="frame"><span class="cell"></span><span class="cell"></span></div>
      </div>
      <div class="scan"></div>
    </div>
    <div class="body">
      <div class="brand">${APP_NAME}</div>
      <div class="tagline">素材拷贝 · 哈希校验 · 报告</div>
      <div class="row">
        <span class="tc" id="tc">00:00:00:00</span>
        <span class="tc-label">24 fps</span>
      </div>
      <div class="bar"><span></span></div>
      <div class="status" id="status">正在启动…</div>
      <div class="credits">
        <div><b>开发者</b>：Shanfly 鱼鱼子</div>
        <div><b>鸣谢</b>：吉林动画学院电影学院影制系</div>
        <div style="opacity:.75">v${APP_VERSION}</div>
      </div>
    </div>
  </div>
<script>
  // 时码从零开始按 24 fps 往上走。纯装饰，但和这个软件处理的东西是一回事。
  (function () {
    var frames = 0
    var el = document.getElementById('tc')
    var tick = function () {
      frames++
      var f = frames % 24
      var totalSeconds = Math.floor(frames / 24)
      var s = totalSeconds % 60
      var m = Math.floor(totalSeconds / 60) % 60
      var h = Math.floor(totalSeconds / 3600) % 24
      var pad = function (n) { return String(n).padStart(2, '0') }
      el.textContent = pad(h) + ':' + pad(m) + ':' + pad(s) + ':' + pad(f)
    }
    setInterval(tick, 1000 / 24)
  })()

  // 供主进程调用：更新加载文字 / 淡出
  window.__splashSetStatus = function (text) {
    var el = document.getElementById('status')
    if (el) el.textContent = text
  }
  window.__splashFadeOut = function () {
    document.body.classList.add('fading')
  }
</script>
</body>
</html>`
}
