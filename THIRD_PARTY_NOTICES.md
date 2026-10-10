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
| FFmpeg / ffprobe | macOS 7.1 · Windows 8.1 | macOS：LGPL-2.1-or-later；Windows：LGPL-3.0-or-later | https://ffmpeg.org/ |

> Electron 内嵌的 Chromium 与 Node.js 携带完整的第三方许可证清单，
> 随 Electron 官方发布包一并提供。本项目在打包时会将相关许可文件复制到应用包内。

### 关于随包分发的 FFmpeg

安装包内包含 FFmpeg 的 **静态编译二进制**（`ffmpeg` 与 `ffprobe`）。每个平台/架构各带一份，
打进应用资源的 `bin/` 目录：

| 平台 | 随包文件 | 版本与来源 | 许可证 |
|---|---|---|---|
| macOS（Apple 芯片 + Intel） | `bin/ffmpeg`、`bin/ffprobe` | FFmpeg 7.1，本项目自行构建（`scripts/build-ffmpeg-lgpl.sh`） | **LGPL-2.1-or-later** |
| Windows（x64） | `bin/ffmpeg.exe`、`bin/ffprobe.exe` | FFmpeg 8.1，取自 BtbN/FFmpeg-Builds 的 `lgpl` 变体 | **LGPL-3.0-or-later** |

用于读取素材元数据（拍摄时间、时长、时码、编码）与提取首尾帧。

- **两个平台的构建都未启用任何 GPL 或 nonfree 组件**（无 `--enable-gpl`、无 `--enable-nonfree`），
  也未链接 libx264 / libx265 等 GPL 库 —— 本软件只需要解码与元数据读取，不需要编码 H.264/HEVC。
  可自行核对：`ffmpeg -version` 输出的 configuration 中不应出现 `--enable-gpl`。
- **对应源代码**：FFmpeg 完整源码可从 https://ffmpeg.org/releases/ 获取；
  macOS 侧的确切构建参数见 `scripts/build-ffmpeg-lgpl.sh`（含 `--disable-gpl --disable-nonfree
  --disable-autodetect`）。如需源码副本或构建材料，请联系 minshaofengc@gmail.com。
- **许可证全文**随包提供于 `LICENSES/` 目录（LGPL-2.1 与 LGPL-3.0 各一份）。
- 本项目**未修改、未逆向** FFmpeg；仅以参数化方式（独立进程 + 参数数组 + `shell: false`）调用其命令行接口。
  该二进制位于应用资源目录、未封进打包归档，用户可自行替换。
- 获取 / 构建脚本：`scripts/fetch-ffmpeg.sh`（Windows）、`scripts/build-ffmpeg-lgpl.sh`（macOS）。
- 打包前请用 `npm run check:win-assets` 核对 Windows 那两份确实是 PE 可执行文件 ——
  macOS 与 Windows 的二进制体积接近、文件名又相同，只看 `ls` 是分不出来的。

### 关于编解码器专利

本软件的解码能力来自 FFmpeg。**改用 LGPL 构建解决的是著作权义务，与专利无关** ——
H.264 / HEVC 等编解码器的**解码器**是 FFmpeg 的原生实现，在 LGPL 构建里同样存在，
不因换构建而消失。

> 某些编解码器（如 H.264 / HEVC）可能涉及第三方专利。本项目**不提供任何专利许可**，
> 使用者应自行确认其使用场景的合规性。

FFmpeg 官方对此的说明见 <https://ffmpeg.org/legal.html> 的 Patent Mini-FAQ：
私人自用"几乎没有理由担心"，而**商业分发**则可能需要取得专利许可。

### 关于哈希算法实现

xxHash64、MD5、SHA-512 的计算依赖上表中的 `hash-wasm` 与 Node.js 内置的 `crypto` 模块。

ASC C4（SMPTE ST 2114）内容标识的实现为本项目自行编写，依据公开的规范文档，
未包含任何第三方私有实现。

---

## 二、**不**随分发包提供的组件

以下工具本项目**不分发、不打包、也不逆向**。用户如需相关能力，须自行从其官方渠道获取并安装。
这些工具各自适用其原始许可证，与本项目的 GPL-3.0-only 许可相互独立。

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
