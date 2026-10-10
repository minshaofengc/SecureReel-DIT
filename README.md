# SecureReel DIT

[English](#english) · [简体中文](#简体中文) · [Official website / 官网](https://securereel.pages.dev/) · [Download 2.0.6 / 下载](https://github.com/minshaofengc/SecureReel-DIT/releases/tag/v2.0.6)

---

## English

SecureReel DIT is a free, open-source camera media offload and verification tool for
**macOS 13+ and Windows 10/11 (x64)**. It brings multi-target copying, xxHash64
verification, ASC MHL, PDF/JSON reports and the official HDE workflow together in one
clear desktop interface.

### Features

- Copy a single source volume to 1–8 targets in parallel; one failing drive does not
  stop the healthy ones.
- Verification values are computed while reading the source; the target copy is then
  **read back independently** and renamed atomically only once it matches. Standard
  jobs support xxHash64 (default), xxHash3, xxHash128, MD5, SHA-1, SHA-256 and ASC C4.
  SHA-256 is not an element in the official ASC MHL 2.0 schema, so it can only be paired
  with the CSV / JSON manifests — the settings page greys out the impossible
  combinations and says why, rather than letting you write a list nobody can read.
- **Verify-only mode**: reads the source and an existing copy and compares them —
  writes and deletes nothing. Useful for a next-day re-check, or for auditing a drive
  someone else offloaded.
- File-level SQLite checkpoints, a job queue, pause/resume/cancel, and recovery after
  an app restart.
- ASC MHL 2.0 (default), legacy MHL v1, plus CSV (opens straight in Excel) and JSON
  hash lists for handoff and for scripts.
- Immutable PDF/JSON/offline-HTML report revisions: R001, R002, … Older reports are
  never overwritten. First-frame thumbnails are inlined into the HTML so the report
  stays self-contained when emailed.
- Reads capture time, duration and timecode from supported media, and extracts
  first/last frames, using the bundled open-source FFmpeg/ffprobe. A failed probe
  never affects the hash report.
- Custom "role + name" crew list (up to 50 rows) and a 4000-character project note;
  edits made during a run are saved and land in the next report revision.
- Three palettes — neutral, graphite blue and warm sand — each with system, light
  and dark modes; card, compact and focus view modes.
- Per-job editing proxies: ProRes 422 Proxy/LT/422/HQ, H.264 or H.265, output
  resolution and optional 3D LUT. Encoder availability is detected on the local
  machine; private RAW formats may not decode. Proxies never replace original backups.
- Simplified Chinese and English interface, plus a built-in help centre.

### Installation

Releases are **installers**. Both platforms get the same features and interface.

- **macOS 13+**: a universal `dmg` (Intel + Apple silicon). Open the disk image and
  drag the app into Applications.
- **Windows 10/11 (x64)**: an NSIS installer (`Setup`), plus a single-file portable
  executable (`Portable`) and a portable `zip`. Set machines often forbid
  installations — copy the portable build to a USB stick and run it from there.
  > ⚠️ **The Windows build is currently a public beta.** The code is identical to the
  > macOS build, but it has not been validated on enough real hardware yet. Keep a
  > separate reliable backup of important media. See `README-先看我.md` inside the
  > Windows package (includes a disclaimer).

Neither platform needs a command line or Node.js — the matching FFmpeg/ffprobe is
bundled, so thumbnails and metadata work out of the box.

Unsigned and unnotarised builds are blocked once by the OS on first launch. This is
expected:

- macOS: System Settings → Privacy & Security → "Open Anyway".
- Windows: SmartScreen → "More info" → "Run anyway".
  ⚠️ Some corporate or school machines have administrator policies that forbid
  unsigned binaries. On those you cannot install it and will need another machine.

### HDE compliance

SecureReel DIT **does not implement, reverse-engineer or bundle any HDE encoder or
proprietary CODEX/ARRI binary**.

- ALEXA Mini / Mini LF: reads `.arx` or HDE `.mxf` through the CODEX Device Manager
  virtual file system that the user installs. These files showing as 0 bytes in
  Finder is expected behaviour.
- ALEXA 35 / 35 Xtreme / 265: invokes the user-installed official `arrirawhde` tool
  with parameterised arguments and `shell: false`.
- When the official tooling is missing, the app explains why, and only degrades to
  plain ARRIRAW copy + xxHash64 verification after the user explicitly confirms.

HDE encoding is provided by ARRI/CODEX official free tools. SecureReel DIT does not
redistribute them.

The bundled FFmpeg/ffprobe are used for media reading, thumbnail
extraction and editing proxies; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for licence and
provenance. They do not provide HDE encoding.

### Development

Requires Node.js 22.13+ (the first release where `node:sqlite` is enabled by default)
and npm 10+.

> `启动 SecureReel DIT.command` is a **developer convenience script** for a local
> Node.js setup. For anyone else, point them at the installers above.

```bash
npm install
npm run dev
npm run test
npm run type-check
npm run lint
npm run build
sh scripts/fetch-ffmpeg.sh   # fetch the bundled ffmpeg/ffprobe (all platforms); run once before packaging
npm run check:win-assets     # hard pre-flight gate before packaging for Windows (see below)
npm run dist:mac             # build the macOS installers
npm run dist:win             # build the Windows installers
```

**Windows packages can be cross-built on macOS** — no Windows machine, no Wine and no
code signing required (NSIS and the executable icon are handled by pure-JS tooling).
`dist:win` sets the mirror variables for you.

Packaging downloads the Electron runtime and builder tools. Behind a slow or proxied
network, pass both mirror variables:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/ \
npm run dist:mac
```

#### Cross-platform constraints

Read these before touching platform code — all of them are pitfalls that were hit for real:

- **Bundled binaries are named by platform-arch**: `vendor/ffmpeg/{darwin-arm64,darwin-x64,win32-x64}`.
  During a cross-build, electron-builder's `${arch}` macro only ever expands to
  `x64`/`arm64`, so putting both architectures in a single `vendor/ffmpeg/x64` would
  ship a macOS Mach-O binary inside the Windows package.
- **ffmpeg's `extraResources` must live in the platform sections** (`mac:` / `win:`).
  The global section and the platform sections are **additive**, not overriding.
- **When an `extraResources` `from` directory is missing, electron-builder only warns
  and carries on**, silently producing a package with no ffmpeg. `npm run check:win-assets`
  is the hard gate for that; it also verifies the file header is a PE (`MZ`) and not a
  Mach-O — the two are close enough in size that the eye cannot tell them apart.
- **Platform differences are centralised in `src/main/platform.ts`** (pure functions,
  platform injectable). Do not scatter `process.platform` checks. Every function takes
  the platform as an optional trailing argument, so the Windows branches can be
  asserted by vitest on macOS.
- **Windows has no `diskutil eject` equivalent**: ejection uses the fallback chain in
  `src/main/volume-win.ts` and **must poll until the drive letter is genuinely gone**
  before reporting success — reporting a false eject loses media.
- The macOS implementation is preserved verbatim; this work changed no macOS behaviour.

Built on Electron 43, React 18 and TypeScript. The renderer runs sandboxed with context
isolation and no Node integration; files, hashing, the database, reports and external
tools all live in the main-process layers.

To point at a specific official transcoder, set its absolute path in the
`ARRIRAW_HDE_PATH` environment variable before launch. The app does not expose that
path or its command arguments to end users.

### Local data

The job database, structured logs, HDE results and the immutable report archive live in
Electron's user-data directory (under `~/Library/Application Support/` on macOS and
`%APPDATA%\` on Windows). SecureReel DIT uploads no telemetry, does not format drives
and never deletes source media. Uninstalling the app does not delete your jobs or reports.

### Contact

Shanfly — [minshaofengc@gmail.com](mailto:minshaofengc@gmail.com)

### Licence

Application code is [GPL-3.0-only](LICENSE). No fonts are redistributed. The bundled
FFmpeg/ffprobe are licensed under LGPL (LGPL-2.1 on macOS, LGPL-3.0 on Windows); see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

---

## 简体中文

SecureReel DIT 是一款面向 **macOS 13+ 与 Windows 10/11（x64）** 的**免费开源**摄影机素材拷贝与校验工具。它将多目标拷贝、xxHash64 复核、ASC MHL、PDF/JSON 报告和 HDE 官方工作流放在一个清晰的桌面界面中。

### 核心能力

- 单个源卷同步拷贝至 1–8 个目标，单盘故障不会中断其他健康目标。
- 源文件读取时计算所选校验值，目标写入后独立重读校验，再原子改名。普通任务支持 xxHash64（默认）、xxHash3、xxHash128、MD5、SHA-1、SHA-256 和 ASC C4（归档）。SHA-256 不在 ASC MHL 2.0 的官方架构里，只能配 CSV / JSON 清单——设置页会把不成立的组合标灰并写明原因，不让你生成一份别人读不进来的清单。
- **仅校验模式**：只读取源与已有拷贝并比对校验值，不写入、不删除任何数据——用于隔天复检或核对别人拷好的盘。
- 文件级 SQLite 检查点、任务队列、暂停/继续/取消与应用重启恢复。
- ASC MHL 2.0（默认）、传统 MHL v1，以及 CSV（Excel 直接打开）与 JSON 哈希清单，便于现场交付和脚本处理。
- 不可变的 PDF/JSON/离线 HTML 报告修订：R001、R002……旧报告不会被覆盖。首帧图内联进 HTML，报告单独发送也能看到画面。
- 通过随应用分发的开源 FFmpeg/ffprobe 读取可支持素材的拍摄时间、时长、时码并提取首尾帧；解析失败不会影响哈希报告。
- 自定义“职务 + 所属人”（最多 50 行）及 4000 字项目备注；执行期间自动保存并进入新报告修订。
- 按任务生成剪辑代理：ProRes 422 Proxy/LT/422/HQ、H.264、H.265，支持输出分辨率与可选 3D LUT。本机编码器探测决定可用性；私有 RAW 可能无法解码。代理不能替代原素材备份。
- 三套配色（中性、石墨蓝、暖砂），均支持跟随系统、明亮和黑暗模式；另有卡片／紧凑／专注三种视图模式。
- 简体中文和英文界面，以及内置帮助中心。

### 安装

发布形态是**安装包**，两个平台各一份，功能与界面一致：

- **macOS 13+**：`dmg`，Intel 与 Apple 芯片通用。打开磁盘映像，把应用拖进「应用程序」即可。
- **Windows 10/11（x64）**：NSIS 安装程序（`Setup`），另附免安装单文件（`Portable`）与免安装 `zip` 三种形态。
  现场用的机器常常不允许装东西，用免安装那份拷到 U 盘就能跑。
  > ⚠️ **Windows 版目前为公开测试版（Beta）**：代码与 mac 版完全一致，但尚未在
  > 足够多的真机上完成验证。重要素材请另留一份可靠备份。详见 Windows 包内的
  > `README-先看我.md`（含免责声明）。

两个平台都**不需要命令行、不需要 Node.js**，应用内置对应平台的 FFmpeg/ffprobe，装完即有完整的首帧图与元数据能力。

未签名/未公证的构建首次打开时系统会拦一下，属正常：

- macOS：在「系统设置 → 隐私与安全性」里点「仍要打开」一次即可。
- Windows：SmartScreen 蓝色提示 →「更多信息」→「仍要运行」。
  ⚠️ 注意：部分公司/学校电脑的管理员策略禁止运行未签名程序，这种情况下装不上，需换机器。

### HDE 合规说明

SecureReel DIT **不实现、不逆向工程、也不打包任何 HDE 编码器或 CODEX/ARRI 专有二进制**。

- ALEXA Mini / Mini LF：通过用户自行安装的 CODEX Device Manager VFS 读取 `.arx` 或 HDE `.mxf`。这些文件在 Finder 中显示为 0 字节是预期行为。
- ALEXA 35 / 35 Xtreme / 265：参数化调用用户自行安装的官方 `arrirawhde` 工具，且始终使用参数数组与 `shell: false`。
- 未检测到官方工具时，应用会解释原因，并仅在用户明确确认后降级为普通 ARRIRAW 拷贝 + xxHash64 校验。

HDE 编码能力由 ARRI/CODEX 官方免费工具提供。SecureReel DIT 不随安装包分发这些工具。

随应用提供的 FFmpeg/ffprobe 用于报告媒体读取、缩略图提取与剪辑代理，许可与来源见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。它们不提供 HDE 编码。

### 开发

要求 Node.js 22.13+（`node:sqlite` 默认可用的最低版本）与 npm 10+。

> `启动 SecureReel DIT.command` 是**开发者用的本地启动脚本**（依赖本机 Node.js 环境）。
> 给别人用请一律走上面的安装包，不要引导用户跑脚本。

```bash
npm install
npm run dev
npm run test
npm run type-check
npm run lint
npm run build
sh scripts/fetch-ffmpeg.sh   # 下载随包分发的 ffmpeg/ffprobe（三个平台，打包前跑一次）
npm run check:win-assets     # Windows 打包前的硬预检（见下）
npm run dist:mac             # 构建 macOS 安装包
npm run dist:win             # 构建 Windows 安装包
```

**Windows 包可以直接在 macOS 上交叉构建**，不需要 Windows 构建机、不需要 Wine、
不需要代码签名（NSIS 与 exe 图标都是纯 JS 工具处理的）。`dist:win` 会自动带上
国内镜像变量，省得每次手打。

打包时 electron-builder 需要下载 Electron 本体与构建工具，国内网络建议带上两个镜像变量：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/ \
npm run dist:mac
```

#### 跨平台移植的几条硬约束

改代码前请先读这几条，都是踩过的坑：

- **随包二进制按「平台-架构」命名**：`vendor/ffmpeg/{darwin-arm64,darwin-x64,win32-x64}`。
  electron-builder 的 `${arch}` 宏在交叉打包时也只展开成 `x64`/`arm64`，
  放进同一个 `vendor/ffmpeg/x64` 就会把 macOS 的 Mach-O 塞进 Windows 包。
- **ffmpeg 的 `extraResources` 必须写在平台段**（`mac:` / `win:` 各自一份）。
  全局段与平台段是**相加**关系，不是覆盖。
- **`extraResources` 的 `from` 目录不存在时 electron-builder 只警告就继续**，
  会静默产出一个不带 ffmpeg 的残包。`npm run check:win-assets` 就是为此存在的硬闸门，
  它还会核对文件头确为 PE（`MZ`）而不是 Mach-O —— 两者体积接近，肉眼分不出。
- **平台差异集中在 `src/main/platform.ts`**（纯函数、平台可注入），
  不要到处散落 `process.platform`。它的每个函数都把平台做成可选尾参，
  这样 Windows 分支能在 macOS 上被 vitest 直接断言。
- **Windows 上没有 `diskutil eject` 的等价物**：弹出走 `src/main/volume-win.ts`
  的降级链，并且**必须轮询确认盘符真的消失**才敢报成功 —— 谎报弹出是会丢素材的。
- macOS 的实现逐字保留，本次改造对 mac 端行为零变化。

构建目标为 Electron 43、React 18 与 TypeScript。渲染进程启用 sandbox 和 context isolation，关闭 Node integration；文件、哈希、数据库、报告与外部工具均位于主进程分层中。

如需指定官方转码器路径，可在启动前设置绝对路径环境变量 `ARRIRAW_HDE_PATH`。应用不会将该路径或命令参数显示给最终用户。

### 本地数据

任务数据库、结构化日志、HDE 结果与不可变报告档案保存在 Electron 的用户数据目录里
（macOS 在 `~/Library/Application Support/` 下，Windows 在 `%APPDATA%\` 下）。
SecureReel DIT 不上传遥测，不格式化磁盘，不删除源素材。卸载应用不会删除你的任务与报告。

### 联系

Shanfly — [minshaofengc@gmail.com](mailto:minshaofengc@gmail.com)

### 许可

应用代码采用 [GPL-3.0-only](LICENSE)。本项目不随包分发任何字体；随包分发的 FFmpeg/ffprobe 按 LGPL 授权（macOS 为 LGPL-2.1，Windows 为 LGPL-3.0），详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
