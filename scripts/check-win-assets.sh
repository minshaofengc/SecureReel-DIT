#!/bin/sh
# 打 Windows 包之前的硬预检。
#
# 为什么必须在打包**之前**查：electron-builder 在 extraResources 的 `from`
# 目录不存在时**只打一行 warning 就继续**（app-builder-lib 的 fileMatcher.js），
# 结果会静默产出一个「装完读不到时长与分辨率」的残包 —— 这种包在 Mac 上
# 完全看不出问题，要等用户装上才发现。所以这里宁可提前失败。
#
# 顺带查一件肉眼看不出来的事：vendor/ffmpeg 里是不是混进了 macOS 的二进制。
# Mach-O 与 PE 的**体积接近**（都是 80MB 上下），命名又都叫 ffmpeg，
# 靠 `ls` 根本分不出来，只能看文件头的魔术字节。
#
#   sh scripts/check-win-assets.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WIN_DIR="$ROOT/vendor/ffmpeg/win32-x64"
ICON="$ROOT/build/icon.png"

problems=0

fail() {
  echo "✗ $1"
  problems=$((problems + 1))
}

echo "检查 Windows 打包所需的资源 ..."

# ---- 1. 随包二进制存在且非空 ----
for name in ffmpeg.exe ffprobe.exe; do
  target="$WIN_DIR/$name"
  if [ ! -f "$target" ]; then
    fail "缺少 ${target}（先跑 sh scripts/fetch-ffmpeg.sh）"
    continue
  fi
  size=$(wc -c < "$target" | tr -d ' ')
  if [ "$size" -lt 1000000 ]; then
    fail "${target} 只有 ${size} 字节，明显不是一个完整的 ffmpeg"
    continue
  fi

  # ---- 2. 确认是 PE（Windows 可执行文件以 "MZ" 开头）----
  magic=$(head -c 2 "$target" 2>/dev/null)
  if [ "$magic" != "MZ" ]; then
    fail "${target} 不是 Windows 可执行文件（文件头应为 MZ）—— 极可能是误下了 macOS 的 Mach-O"
    continue
  fi

  echo "✓ ${name}（${size} 字节，PE 可执行文件）"
done

# ---- 3. Windows 图标 ----
# electron-builder 会用内置工具把 png 转成多尺寸 .ico，要求原图 ≥256×256。
if [ ! -f "$ICON" ]; then
  fail "缺少 ${ICON}（Windows 图标由它转换而来）"
else
  # PNG 的 IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后：
  # 宽度在偏移 16，高度在偏移 20，都是大端 32 位。
  icon_size=''
  if command -v xxd >/dev/null 2>&1; then
    hex=$(xxd -p -s 16 -l 8 "$ICON" 2>/dev/null | tr -d '\n ')
    if [ "${#hex}" -eq 16 ]; then
      w=$((16#${hex%????????}))
      h=$((16#${hex#????????}))
      icon_size="${w}x${h}"
    fi
  fi
  if [ -n "$icon_size" ]; then
    if [ "$icon_size" = "1024x1024" ] || [ "${icon_size%x*}" -ge 256 ]; then
      echo "✓ build/icon.png（${icon_size}）"
    else
      fail "build/icon.png 是 ${icon_size}，小于 256×256，electron-builder 转不出多尺寸 .ico"
    fi
  else
    echo "? build/icon.png 存在（尺寸解析失败，交给 electron-builder 自己判断）"
  fi
fi

echo
if [ "$problems" -ne 0 ]; then
  echo "预检未通过（$problems 项）。修好再打包，否则会产出一个静默残缺的 Windows 包。" >&2
  exit 1
fi
echo "预检通过，可以打包。"
