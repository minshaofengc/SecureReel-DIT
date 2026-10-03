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
export const SPLASH_WIDTH = 520
export const SPLASH_HEIGHT = 340

/** 淡出时长，必须与模板里 CSS 的 transition 保持一致。 */
export const SPLASH_FADE_MS = 240

export interface SplashPalette {
  card: string
  edge: string
  text: string
  muted: string
  faint: string
  accent: string
  track: string
}

/**
 * 两份配色，与「清和」的浅/深两套对齐。
 *
 * ⚠️ 这里的内联色值是一个**刻意的例外**。全项目的颜色都走
 * `styles/tokens.css` 的 CSS 变量，但这个窗口出现在主题系统就绪**之前**
 * （连设置都还没读出来），拿不到那套变量。
 * 代价：把主题钉成别的配色时，开屏那一两秒的主色会与界面不一致 ——
 * 换来的是"启动立刻有画面"。要改就改这里的常量，别去动 tokens.css。
 */
export const SPLASH_PALETTE: { light: SplashPalette; dark: SplashPalette } = {
  light: {
    card: '#ffffff',
    edge: '#dfe1d8',
    text: '#1b2a23',
    muted: '#62736a',
    faint: '#8b9a91',
    accent: '#3d7a58',
    track: '#f1f2ec'
  },
  dark: {
    card: '#1c2723',
    edge: '#2e3d36',
    text: '#e6efe9',
    muted: '#9aada3',
    faint: '#75877d',
    accent: '#74bf95',
    track: '#212e29'
  }
}

/**
 * 开屏页面的完整 HTML。
 *
 * 画面是**胶片 + 时码**：齿孔一排排走动、时码按 24 fps 往上跳，
 * 一道柔光横着扫过胶片暗示"正在读"。这是给剧组用的工具，
 * 这些东西组里人一眼就熟，也正好对应软件本身在做的事。
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
    border: 1px solid ${palette.edge};
    background: ${palette.card};
    color: ${palette.text};
    overflow: hidden;
  }

  /* ---- 胶片：上下各一排齿孔，中间一格格画面在走 ---- */
  .film {
    position: relative;
    height: 96px;
    background: ${palette.track};
    border-bottom: 1px solid ${palette.edge};
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
    flex: 0 0 12.5%;
    height: 100%;
    padding: 18px 4px;
    display: flex; gap: 4px;
  }
  .cell {
    flex: 1;
    border-radius: 3px;
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
      ${palette.edge} 5px 13px,
      transparent 13px 26px
    );
  }
  .frame::before { top: 4px; }
  .frame::after { bottom: 4px; }

  /* 扫描光：横着扫过胶片，暗示"正在读" */
  .scan {
    position: absolute; top: 0; bottom: 0; width: 84px;
    background: linear-gradient(90deg, transparent, ${palette.accent}33, transparent);
    animation: sweep 2.2s ease-in-out infinite;
  }
  @keyframes sweep {
    0% { transform: translateX(-84px); }
    100% { transform: translateX(${SPLASH_WIDTH}px); }
  }

  /* ---- 文字区 ---- */
  .body { flex: 1; padding: 18px 24px 0; display: flex; flex-direction: column; }
  .brand { font-size: 19px; font-weight: 600; letter-spacing: 0.2px; }
  .tagline { margin-top: 3px; font-size: 12px; color: ${palette.muted}; }

  .row { margin-top: 14px; display: flex; align-items: baseline; gap: 10px; }
  .tc {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 24px; font-weight: 600; letter-spacing: 1px;
    color: ${palette.accent};
    font-variant-numeric: tabular-nums; /* 数字等宽，跳动时不会左右抖 */
  }
  .tc-label { font-size: 11px; color: ${palette.faint}; }

  .bar { margin-top: 12px; height: 4px; border-radius: 999px; background: ${palette.track}; overflow: hidden; }
  .bar > span { display: block; height: 100%; width: 40%; background: ${palette.accent}; animation: slide 1.15s cubic-bezier(0.32,0.72,0,1) infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }

  .status { margin-top: 9px; font-size: 12px; color: ${palette.muted}; min-height: 16px; }

  .credits { margin-top: auto; padding: 12px 0 16px; font-size: 11px; line-height: 1.75; color: ${palette.faint}; }
  .credits b { font-weight: 600; color: ${palette.muted}; }

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
