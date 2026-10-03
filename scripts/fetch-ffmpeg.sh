#!/bin/sh
# 下载随包分发的 FFmpeg / ffprobe 静态二进制。
#
# 这些二进制不打进 git 仓库（三个平台加起来约 300MB），打包前跑一次即可：
#   sh scripts/fetch-ffmpeg.sh
#
# 目录结构（electron-builder 按「平台段 + ${arch} 宏」选取，见 electron-builder.yml）：
#   vendor/ffmpeg/darwin-arm64/{ffmpeg,ffprobe}        macOS Apple 芯片
#   vendor/ffmpeg/darwin-x64/{ffmpeg,ffprobe}          macOS Intel
#   vendor/ffmpeg/win32-x64/{ffmpeg.exe,ffprobe.exe}   Windows x64
#
# 名字里带上「平台-架构」是必须的：electron-builder 的 ${arch} 宏在
# 交叉打包时也只会展开成 x64 / arm64，两个平台的同名文件会互相串。
#
# 来源：https://github.com/eugeneware/ffmpeg-static （release b6.0）
# 许可与来源声明见 THIRD_PARTY_NOTICES.md。
#
# ---- 国内网络 ----
# GitHub Release 直连常常只有几十 KB/s（27MB 要十几分钟）。可以指定镜像，
# 脚本会先试它、再试官方、最后试内置的国内镜像：
#   FFMPEG_DOWNLOAD_BASE='https://ghfast.top/https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0' \
#     sh scripts/fetch-ffmpeg.sh
# 镜像转发的是 GitHub 上的同一份字节。下载后会校验 gzip 完整性；
# 打 Windows 包前还有 scripts/check-win-assets.sh 复验它确实是 PE 而不是 Mach-O。
set -u

OFFICIAL='https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0'
MIRROR="https://ghfast.top/$OFFICIAL"
ROOT="$(cd "$(dirname "$0")/.." && pwd)/vendor/ffmpeg"

# 从某个 base 下 <名称>.gz 并解到 <目标路径>。
# 注意用 `gunzip -c` 而不是 `gunzip <文件>`：这些 .gz 的头部带原始文件名
# （FNAME 字段），默认解压出来的名字不受我们控制，只能靠 -c 重定向。
download_from() {
  base="$1"; out="$2"; name="$3"
  echo "  → $base/$name.gz"
  rm -f "$out.gz"
  if ! curl -fL --retry 3 --retry-all-errors --retry-delay 3 \
       --connect-timeout 20 --max-time 1800 -o "$out.gz" "$base/$name.gz"; then
    rm -f "$out.gz"
    return 1
  fi
  if ! gzip -t "$out.gz" 2>/dev/null; then
    echo "  ✗ gzip 校验不通过（下载不完整）"
    rm -f "$out.gz"
    return 1
  fi
  gunzip -c "$out.gz" > "$out" && rm -f "$out.gz"
}

fetch() {
  out="$1"; name="$2"
  if [ -s "$out" ]; then
    echo "已存在，跳过：$out"
    return 0
  fi
  echo "下载 $name ..."
  if [ -n "${FFMPEG_DOWNLOAD_BASE:-}" ]; then
    download_from "$FFMPEG_DOWNLOAD_BASE" "$out" "$name" && return 0
  fi
  download_from "$OFFICIAL" "$out" "$name" && return 0
  download_from "$MIRROR" "$out" "$name" && return 0
  echo "✗ 全部下载地址都失败：$name"
  return 1
}

mkdir -p "$ROOT/darwin-arm64" "$ROOT/darwin-x64" "$ROOT/win32-x64"

failed=0

fetch "$ROOT/darwin-arm64/ffmpeg"    ffmpeg-darwin-arm64   || failed=1
fetch "$ROOT/darwin-arm64/ffprobe"   ffprobe-darwin-arm64  || failed=1
fetch "$ROOT/darwin-x64/ffmpeg"      ffmpeg-darwin-x64     || failed=1
fetch "$ROOT/darwin-x64/ffprobe"     ffprobe-darwin-x64    || failed=1
fetch "$ROOT/win32-x64/ffmpeg.exe"   ffmpeg-win32-x64      || failed=1
fetch "$ROOT/win32-x64/ffprobe.exe"  ffprobe-win32-x64     || failed=1

# 可执行位只对 macOS 那两个有意义（Windows 看的是扩展名）
chmod +x "$ROOT/darwin-arm64/ffmpeg"  "$ROOT/darwin-arm64/ffprobe"  2>/dev/null
chmod +x "$ROOT/darwin-x64/ffmpeg"    "$ROOT/darwin-x64/ffprobe"    2>/dev/null

echo
echo "=== 结果 ==="
ls -la "$ROOT/darwin-arm64" "$ROOT/darwin-x64" "$ROOT/win32-x64"
if command -v file >/dev/null 2>&1; then
  file "$ROOT"/*/* 2>/dev/null
fi

if [ "$failed" -ne 0 ]; then
  echo
  echo "!! 有文件没下齐 —— 打出来的包会缺少随包的 ffmpeg/ffprobe。" >&2
  exit 1
fi

echo
echo "完成。"
