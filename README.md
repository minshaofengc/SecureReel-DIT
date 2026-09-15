# SecureReel DIT

SecureReel DIT 是一款面向 macOS 13+ 的免费开源摄影机素材拷贝与校验工具。它将多目标拷贝、xxHash64 复核、ASC MHL、PDF/JSON 报告和 HDE 官方工作流放在一个清晰的桌面界面中。

## 核心能力

- 单个源卷同步拷贝至 1–8 个目标，单盘故障不会中断其他健康目标。
- 源文件读取时计算所选校验值，目标写入后独立重读校验，再原子改名。普通任务支持 xxHash64（默认）、MD5（兼容）和 ASC C4（归档）。
- 文件级 SQLite 检查点、任务队列、暂停/继续/取消与应用重启恢复。
- ASC MHL 2.0（默认）和传统 MHL v1 清单。
- 不可变的 PDF/JSON/离线 HTML 报告修订：R001、R002……旧报告不会被覆盖。
- 通过随应用分发的开源 FFmpeg/ffprobe 读取可支持素材的拍摄时间、时长、时码并提取首尾帧；解析失败不会影响哈希报告。
- 自定义“职务 + 所属人”（最多 50 行）及 4000 字项目备注；执行期间自动保存并进入新报告修订。
- 竹林「清和」与粉蓝「雾光」，均支持跟随系统、明亮和黑暗模式。
- 简体中文和英文界面，以及内置帮助中心。

## HDE 合规说明

SecureReel DIT **不实现、不逆向工程、也不打包任何 HDE 编码器或 CODEX/ARRI 专有二进制**。

- ALEXA Mini / Mini LF：通过用户自行安装的 CODEX Device Manager VFS 读取 `.arx` 或 HDE `.mxf`。这些文件在 Finder 中显示为 0 字节是预期行为。
- ALEXA 35 / 35 Xtreme / 265：参数化调用用户自行安装的官方 `arrirawhde` 工具，且始终使用参数数组与 `shell: false`。
- 未检测到官方工具时，应用会解释原因，并仅在用户明确确认后降级为普通 ARRIRAW 拷贝 + xxHash64 校验。

HDE 编码能力由 ARRI/CODEX 官方免费工具提供。SecureReel DIT 不随安装包分发这些工具。

随应用提供的 FFmpeg/ffprobe 仅用于报告媒体读取与缩略图提取，许可与来源见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。它们不提供 HDE 编码。

## 开发

要求 Node.js 22.12+ 与 npm 10+。

```bash
npm install
npm run dev
npm run test
npm run type-check
npm run lint
npm run build
```

构建目标为 Electron 43、React 18 与 TypeScript。渲染进程启用 sandbox 和 context isolation，关闭 Node integration；文件、哈希、数据库、报告与外部工具均位于主进程分层中。

如需指定官方转码器路径，可在启动前设置绝对路径环境变量 `ARRIRAW_HDE_PATH`。应用不会将该路径或命令参数显示给最终用户。

## 本地数据

任务数据库、结构化日志、HDE 结果与不可变报告档案保存在 Electron 的 macOS `userData` / `logs` 目录中。SecureReel DIT 不上传遥测，不格式化磁盘，不删除源素材。

## 联系

Shanfly — [minshaofengc@gmail.com](mailto:minshaofengc@gmail.com)

## 许可

应用代码采用 [GPL-3.0-only](LICENSE)。随包提供的 Noto Sans SC 字体采用 SIL Open Font License 1.1。
