# 第三方组件声明

SecureReel DIT 本体以 **GPL-3.0-only** 发布，许可证正文见 [`LICENSE`](LICENSE)。

本文件说明分发包中包含哪些第三方组件，以及哪些是**不由本项目分发**、需要用户自行安装的。

---

## 一、随分发包一同提供的组件

这些组件会以代码或运行时文件的形式出现在安装包内。

| 组件 | 版本 | 许可证 | 项目地址 |
|---|---|---|---|
| Electron | 43.7.0 | MIT | https://github.com/electron/electron |
| Chromium（随 Electron） | 随 Electron 版本 | BSD-3-Clause 及若干其他开源许可证 | https://www.chromium.org/ |
| Node.js（随 Electron） | 随 Electron 版本 | MIT | https://nodejs.org/ |
| React | 18.3.1 | MIT | https://github.com/facebook/react |
| React DOM | 18.3.1 | MIT | https://github.com/facebook/react |
| hash-wasm | 4.12.0 | MIT | https://github.com/Daninet/hash-wasm |
| zod | 4.6.5 | MIT | https://github.com/colinhacks/zod |
| FFmpeg / ffprobe | 6.0 | GPL-3.0（或更新版本） | https://ffmpeg.org/ |

> Electron 内嵌的 Chromium 与 Node.js 携带完整的第三方许可证清单，
> 随 Electron 官方发布包一并提供。本项目在打包时会将相关许可文件复制到应用包内。

### 关于随包分发的 FFmpeg

安装包内包含 FFmpeg 6.0 的 **静态编译二进制**（`ffmpeg` 与 `ffprobe`，Apple 芯片与 Intel 芯片各一份），
用于读取素材元数据（拍摄时间、时长、时码、编码）与提取首尾帧。

- **来源**：https://github.com/eugeneware/ffmpeg-static （FFmpeg 6.0 静态构建）
- **许可证**：该构建包含 GPL 许可的组件（如 libx264 等），整体按
  **GPL-3.0-or-later** 授权。源代码可在 https://ffmpeg.org/download.html 获取。
- 本项目本身以 GPL-3.0-only 发布，与之兼容；FFmpeg 二进制保持其原始许可证，
  未做任何修改。
- 本项目**未修改、未逆向** FFmpeg；仅以参数化方式调用其命令行接口。
- 获取脚本：`scripts/fetch-ffmpeg.sh`。

### 关于哈希算法实现

xxHash64、MD5、SHA-512 的计算依赖上表中的 `hash-wasm` 与 Node.js 内置的 `crypto` 模块。

ASC C4（SMPTE ST 2114）内容标识的实现为本项目自行编写，依据公开的规范文档，
未包含任何第三方私有实现。

---

## 二、**不**随分发包提供的组件

以下工具本项目**不分发、不打包、也不逆向**。用户如需相关能力，须自行从其官方渠道获取并安装。
这些工具各自适用其原始许可证，与本项目的 GPL-3.0 许可相互独立。

| 工具 | 用途 | 获取方式 |
|---|---|---|
| CODEX Device Manager | 通过虚拟文件系统读取 ALEXA Mini / Mini LF 的 HDE 素材（`.arx` / HDE `.mxf`） | CODEX 官方渠道 |
| ARRIRAW HDE Transcoder (`arrirawhde`) | ALEXA 35 / 35 Xtreme / 265 的 HDE 编码 | ARRI 官方渠道 |

**HDE 编码能力由 ARRI / CODEX 官方免费工具提供。** SecureReel DIT 只负责发现并以参数化方式调用这些工具，
不实现、不逆向工程、也不重新分发它们。未检测到官方工具时，应用会说明原因，
并且仅在用户明确确认后才降级为普通拷贝 + 哈希校验。

---

## 三、字体

**本项目不随包分发任何字体文件。**

界面样式表中引用了 `Noto Sans SC`、`PingFang SC`、`Microsoft YaHei` 等字体族名称，
实际渲染取决于用户操作系统上已安装的字体，由系统负责回退。

若用户系统已安装 Noto Sans SC，该字体按 SIL Open Font License 1.1 授权，
但该字体并非由本项目提供或分发。

---

## 四、构建期依赖（不进入分发包）

以下工具仅用于开发与构建过程，不会出现在最终安装包中：
TypeScript、Vite、electron-vite、Vitest、ESLint、Prettier、electron-builder。
各自许可证详见其 `node_modules/<包名>/LICENSE`。

---

_如发现本声明有遗漏或错误，请通过 README 中列出的联系方式告知。_
