#!/bin/sh
# 下载随包分发的 FFmpeg / ffprobe 静态二进制（macOS arm64 + x64）。
#
# 这些二进制不打进 git 仓库（太大），打包前跑一次这个脚本即可：
#   sh scripts/fetch-ffmpeg.sh
#
# 来源：https://github.com/eugeneware/ffmpeg-static（FFmpeg 6.0 静态构建）
# 许可与来源声明见 THIRD_PARTY_NOTICES.md。

set -e
BASE="https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0"
DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor/ffmpeg"
mkdir -p "$DIR"

for name in ffmpeg-darwin-arm64 ffmpeg-darwin-x64 ffprobe-darwin-arm64 ffprobe-darwin-x64; do
  if [ -f "$DIR/$name" ]; then
    echo "已存在，跳过：$name"
    continue
  fi
  echo "下载 $name ..."
  curl -fL --retry 3 --retry-delay 2 -o "$DIR/$name.gz" "$BASE/$name.gz"
  gunzip -f "$DIR/$name.gz"
  chmod +x "$DIR/$name"
done

echo "完成。文件位于 $DIR"
