#!/bin/sh
# 下载随包分发的 FFmpeg / ffprobe 静态二进制（macOS arm64 + x64）。
#
# 这些二进制不打进 git 仓库（太大），打包前跑一次这个脚本即可：
#   sh scripts/fetch-ffmpeg.sh
#
# 目录结构（electron-builder 按 ${arch} 宏选取，universal 合并时
# @electron/universal 会把两套 lipo 成通用二进制）：
#   vendor/ffmpeg/arm64/{ffmpeg,ffprobe}
#   vendor/ffmpeg/x64/{ffmpeg,ffprobe}
#
# 来源：https://github.com/eugeneware/ffmpeg-static（FFmpeg 6.0 静态构建）
# 许可与来源声明见 THIRD_PARTY_NOTICES.md。

set -e
BASE="https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0"
ROOT="$(cd "$(dirname "$0")/.." && pwd)/vendor/ffmpeg"

fetch() {
  arch="$1"; tool="$2"; name="$3"
  if [ -f "$ROOT/$arch/$tool" ]; then
    echo "已存在，跳过：$arch/$tool"
    return
  fi
  echo "下载 $name ..."
  curl -fL --retry 3 --retry-delay 2 -o "$ROOT/$tool.gz" "$BASE/$name.gz"
  gunzip -f "$ROOT/$tool.gz"
  chmod +x "$ROOT/$tool"
}

mkdir -p "$ROOT/arm64" "$ROOT/x64"
fetch arm64 ffmpeg  ffmpeg-darwin-arm64
fetch arm64 ffprobe ffprobe-darwin-arm64
fetch x64   ffmpeg  ffmpeg-darwin-x64
fetch x64   ffprobe ffprobe-darwin-x64

echo "完成。文件位于 $ROOT/{arm64,x64}"
