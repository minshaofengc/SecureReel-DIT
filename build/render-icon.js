/**
 * 把 SVG 渲染成 1024x1024 的透明 PNG。
 *
 * 为什么用 Electron 而不是 rsvg-convert / ImageMagick：
 * 这台机器上两者都没装，而 Electron 就在 node_modules 里，
 * 用的是和应用完全相同的渲染引擎 —— 所见即所得，不需要额外装任何东西。
 *
 * 用法：
 *   electron render-icon.js <输入.svg> <输出.png>
 */
const { app, BrowserWindow } = require('electron')
const { readFile, writeFile } = require('node:fs/promises')

const [, , svgPath, outPath] = process.argv

if (svgPath === undefined || outPath === undefined) {
  console.error('用法：electron render-icon.js <输入.svg> <输出.png>')
  app.exit(1)
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  try {
    const svg = await readFile(svgPath, 'utf8')

    const win = new BrowserWindow({
      width: 1024,
      height: 1024,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    })

    // body 背景必须是透明的，否则截出来的 PNG 会带一层底色
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;width:1024px;height:1024px;background:transparent;overflow:hidden}
      svg{display:block;width:1024px;height:1024px}
    </style></head><body>${svg}</body></html>`

    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    // 等一帧渲染落定，否则可能截到空白
    await new Promise((resolve) => setTimeout(resolve, 600))

    const image = await win.webContents.capturePage()
    await writeFile(outPath, image.toPNG())
    console.log(`已写出 ${outPath}`)
    app.exit(0)
  } catch (error) {
    console.error(`渲染失败：${String(error)}`)
    app.exit(1)
  }
})
