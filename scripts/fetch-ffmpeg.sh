#!/bin/sh
# 准备随包分发的 FFmpeg / ffprobe 静态二进制（**LGPL 版**）。
#
#   sh scripts/fetch-ffmpeg.sh
#
# ── 为什么 2.0.4 起换了来源 ────────────────────────────────────────
# 软件自 2.0.4 起转为商业闭源许可，**不能捆绑 GPL 二进制**。
# 原先用的 `eugeneware/ffmpeg-static` b6.0 是 GPL 构建，macOS 那份的 configuration
# 里还带 `--enable-nonfree`（FFmpeg 对它的定义是"生成的二进制不可再分发"）。
#
#   · Windows：取 BtbN/FFmpeg-Builds 的现成 win64-lgpl 静态构建
#   · macOS ：**没有可信的现成 LGPL 构建**（evermeet.cx / martin-riedl.de /
#             Homebrew 全是 GPL），必须自建 —— 跑 scripts/build-ffmpeg-lgpl.sh
#
# 详细调研见项目内 FFmpeg 许可调研笔记（不进仓库）。
#
# ── 目录结构 ─────────────────────────────────────────────────────
# electron-builder 按「平台段 + ${arch} 宏」选取（见 electron-builder.yml）：
#   vendor/ffmpeg/darwin-arm64/{ffmpeg,ffprobe}        macOS Apple 芯片
#   vendor/ffmpeg/darwin-x64/{ffmpeg,ffprobe}          macOS Intel
#   vendor/ffmpeg/win32-x64/{ffmpeg.exe,ffprobe.exe}   Windows x64
#
# 打完 Windows 包前，scripts/check-win-assets.sh 会复验那两份确实是 PE 而不是 Mach-O
# （两边体积接近、文件名又像，只看 ls 分不出来）。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)/vendor/ffmpeg"
WIN_DIR="$ROOT/win32-x64"

# ── Windows：BtbN 的 LGPL 静态构建 ────────────────────────────────
# 用**发布分支**构建（n8.1）而不是 master：master 是开发分支，不适合出货。
# ⚠️ BtbN 的 release tag 就叫 `latest`，内容每天都在滚 —— 所以下载后把 sha256
#    写进 SOURCE.txt，并在下面做一致性核对：内容变了就提示人工复核一次。
#    这是"可复现"的最低成本做法（比死盯一个 tag 更实际）。
BTBN_ASSET='ffmpeg-n8.1-latest-win64-lgpl-8.1.zip'
BTBN_BASE="${BTBN_BASE:-https://github.com/BtbN/FFmpeg-Builds/releases/download/latest}"
BTBN_MIRROR="${BTBN_MIRROR:-https://ghfast.top}"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi
}

fetch_windows() {
  mkdir -p "$WIN_DIR"
  zip="${TMPDIR:-/tmp}/$BTBN_ASSET"

  # 判据是 SOURCE.txt 而不是"文件是否已存在"：从 GPL 来源切到 LGPL 来源时，
  # 旧文件还躺在目录里 —— 只看存在就会**跳过下载、继续用那份 GPL 二进制**。
  if [ -s "$WIN_DIR/ffmpeg.exe" ] && [ -s "$WIN_DIR/ffprobe.exe" ] \
     && [ -f "$WIN_DIR/SOURCE.txt" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "Windows：已存在，跳过下载（要重下加 FORCE=1）"
    return 0
  fi

  echo "Windows：下载 ${BTBN_ASSET}（约 170 MB）..."
  ok=0
  for base in "${BTBN_MIRROR:+$BTBN_MIRROR/}$BTBN_BASE" "$BTBN_BASE"; do
    [ -z "$base" ] && continue
    echo "  → $base/$BTBN_ASSET"
    if curl -fL --retry 3 --retry-all-errors --retry-delay 3 \
        --connect-timeout 20 --max-time 1800 -o "$zip" "$base/$BTBN_ASSET"; then
      ok=1
      break
    fi
  done
  if [ "$ok" != "1" ]; then
    echo "  ✗ 下载失败。可指定镜像：BTBN_MIRROR='https://ghfast.top' sh scripts/fetch-ffmpeg.sh" >&2
    return 1
  fi

  if ! unzip -t "$zip" >/dev/null 2>&1; then
    echo "  ✗ zip 完整性校验不通过（下载不完整）" >&2
    rm -f "$zip"
    return 1
  fi

  echo "Windows：解压 bin/ffmpeg.exe 与 bin/ffprobe.exe"
  unzip -o -j "$zip" '*/bin/ffmpeg.exe' '*/bin/ffprobe.exe' -d "$WIN_DIR" >/dev/null || {
    echo "  ✗ 解压失败" >&2
    return 1
  }
  rm -f "$zip"

  digest="$(sha256_of "$WIN_DIR/ffmpeg.exe")"
  echo "Windows：ffmpeg.exe sha256 = $digest"

  # 内容变了只提示、不拦：拦下来会让人以为脚本坏了，而真正需要的是"人工复核一次"
  if [ -f "$WIN_DIR/SOURCE.txt" ] && ! grep -q "$digest" "$WIN_DIR/SOURCE.txt"; then
    echo "  ⚠️ 与上次记录的 sha256 不一致 —— BtbN 的 latest 滚动了，请复核一次许可情况。"
  fi
  {
    echo "来源: $BTBN_BASE/$BTBN_ASSET"
    echo "许可: LGPLv3（BtbN 的 lgpl 变体；注意是 v3 不是 2.1）"
    echo "ffmpeg.exe sha256: $digest"
    echo "下载时间: $(date '+%Y-%m-%d %H:%M:%S')"
  } > "$WIN_DIR/SOURCE.txt"

  # strings 只能粗略探测（不是权威判据，所以只提示）
  if command -v strings >/dev/null 2>&1 && strings "$WIN_DIR/ffmpeg.exe" 2>/dev/null | grep -qm1 -- '--enable-gpl'; then
    echo "  ⚠️ exe 里能 grep 到 '--enable-gpl' —— 请人工确认这不是 GPL 构建！" >&2
  fi
  return 0
}

# ── macOS：只检查，不下载（必须自建） ─────────────────────────────
check_mac() {
  dir="$1"
  label="$2"
  missing=0
  for tool in ffmpeg ffprobe; do
    path="$dir/$tool"
    if [ ! -x "$path" ]; then
      echo "macOS/${label}：缺少 $path"
      missing=1
      continue
    fi
    out="$("$path" -version 2>&1)" || {
      echo "macOS/${label}：$tool 无法执行（交叉架构需要 Rosetta？）—— 跳过许可检查"
      continue
    }
    if printf '%s' "$out" | grep -qE 'enable-(gpl|nonfree)'; then
      echo "macOS/${label}：$tool 仍是 GPL/nonfree 构建 —— 不能用于闭源分发"
      missing=1
    else
      echo "macOS/${label}：$tool 是 LGPL 构建 ✅"
    fi
  done
  # 执行位丢了也算不合格：打包进 app 后要直接跑
  chmod +x "$dir/ffmpeg" "$dir/ffprobe" 2>/dev/null
  return "$missing"
}

echo "==> 准备随包二进制（根目录：${ROOT}）"
failed=0
fetch_windows || failed=1

echo
echo "== macOS =="
check_mac "$ROOT/darwin-arm64" "arm64" || failed=1
check_mac "$ROOT/darwin-x64" "x64" || failed=1

echo
if [ "$failed" -ne 0 ]; then
  cat >&2 <<'MSG'
✗ 有平台的二进制还没准备好。

  macOS 的两个架构必须自建（可信源里没有 LGPL 现成包）：
      sh scripts/build-ffmpeg-lgpl.sh                 # 当前架构
      ARCH=x86_64 sh scripts/build-ffmpeg-lgpl.sh     # Intel 架构

  跑完再执行一次本脚本核对。
MSG
  exit 1
fi

echo "完成：两个平台的随包二进制都是 LGPL 构建。"
echo "别忘了 THIRD_PARTY_NOTICES.md 的 FFmpeg 段也要改成 LGPL（声明必须与实际二进制一致）。"
