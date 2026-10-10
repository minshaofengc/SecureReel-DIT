#!/bin/sh
# 自建 **LGPL 版** ffmpeg / ffprobe（macOS），产物落到 vendor/ffmpeg/darwin-<架构>/。
#
# ── 为什么必须自建 ────────────────────────────────────────────────
# macOS 上没有可信的现成 LGPL 静态构建：evermeet.cx、martin-riedl.de、Homebrew
# 全是 GPL 构建（configuration 里带 --enable-gpl；当前 vendor 那份还带 --enable-nonfree，
# FFmpeg 对它的定义是"生成的二进制不可再分发"）。
# 商业闭源软件不能捆绑 GPL 二进制 —— 详见项目内 FFmpeg 许可调研笔记（不进仓库）。
#
# ── 用法 ─────────────────────────────────────────────────────────
#   sh scripts/build-ffmpeg-lgpl.sh                 # 构建当前机器架构
#   ARCH=x86_64 sh scripts/build-ffmpeg-lgpl.sh     # 指定架构（Intel Mac 上用）
#
#   首次构建约 8–15 分钟/架构。**不需要手工 lipo**：electron-builder 的
#   universal target 会把 darwin-arm64 / darwin-x64 两份合并成通用二进制。
#
# ── ⚠️ 两条最容易踩的坑 ──────────────────────────────────────────
#   1. `--disable-autodetect` 不能省。少了它，configure 会自动捡起构建机上
#      Homebrew 的 x264/x265，构建出来的东西**当场变回 GPL**，而且 configure 不报错。
#   2. 本机被注入了 ELECTRON_RUN_AS_NODE=1（见项目记忆）—— 本脚本不碰 Electron，
#      但别在这个 shell 里顺手跑 electron 命令。
set -eu

VERSION="${FFMPEG_VERSION:-7.1}"
ARCH="${ARCH:-$(uname -m)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/securereel-ffmpeg-lgpl-${ARCH}"
# 源码 tarball 单独放共享缓存：换架构重跑时不必再下一遍（直连 ffmpeg.org 很慢）
SRC_CACHE="${TMPDIR:-/tmp}/securereel-ffmpeg-src"
# ⚠️ 目录名要用 **electron-builder 的写法**（darwin-x64 / darwin-arm64），
# 不是 FFmpeg / 编译器的架构名（x86_64）。这两个名字不一样，
# 混用会把二进制放进 electron-builder 根本不会读的目录 —— 而且打包时**不会报错**，
# 只是包里静默少了 ffmpeg（实测踩到：x64 那份被写进了 darwin-x86_64）。
case "$ARCH" in
  x86_64 | i386) DEST_ARCH="x64" ;;
  *) DEST_ARCH="$ARCH" ;;
esac
DEST="$ROOT/vendor/ffmpeg/darwin-${DEST_ARCH}"
OFFICIAL="https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz"
# 国内直连 ffmpeg.org 常常很慢，可用镜像覆盖：
#   FFMPEG_SOURCE_BASE='https://ghfast.top/https://github.com/FFmpeg/FFmpeg/archive/refs/tags' ...
SOURCE_BASE="${FFMPEG_SOURCE_BASE:-https://ffmpeg.org/releases}"

echo "==> 目标：ffmpeg ${VERSION} · ${ARCH} → ${DEST}"

# ── 依赖检查 ──────────────────────────────────────────────────────
if ! xcode-select -p >/dev/null 2>&1; then
  echo "✗ 缺少 Xcode Command Line Tools：xcode-select --install" >&2
  exit 1
fi

# x86 汇编（nasm）只在 x86 架构上有意义。
#
# ⚠️ **arm64 上必须显式 --disable-x86asm**：否则 FFmpeg 7.1 会编出引用
# `_ff_tx_codelet_list_float_x86` 的 tx.o，而 arm64 上根本没有那份 x86 汇编，
# 于是在链接 ffmpeg 时报 `Undefined symbols for architecture arm64`。
# 实测踩到过：编译要到最后一刻才失败，前面几百个 .o 全白编。
# arm64 自己的 NEON 汇编不受这个开关影响，性能没有损失。
ASM_FLAG="--disable-x86asm"
case "$ARCH" in
  x86_64 | i386)
    if command -v nasm >/dev/null 2>&1; then
      ASM_FLAG="--enable-x86asm"
    else
      echo "ℹ️  未找到 nasm，关闭 x86 汇编优化（功能不受影响，只是慢一点）"
    fi
    ;;
esac

# ── 取源码 ────────────────────────────────────────────────────────
mkdir -p "$SRC_CACHE" "$WORK"
if [ ! -f "$SRC_CACHE/ffmpeg-${VERSION}.tar.xz" ]; then
  echo "==> 下载源码 $SOURCE_BASE/ffmpeg-${VERSION}.tar.xz"
  curl -fL --retry 3 --retry-all-errors --connect-timeout 20 --max-time 1800 \
    -o "$SRC_CACHE/ffmpeg-${VERSION}.tar.xz" "$SOURCE_BASE/ffmpeg-${VERSION}.tar.xz"
else
  echo "==> 复用已下载的源码包：$SRC_CACHE/ffmpeg-${VERSION}.tar.xz"
fi
# ⚠️ 每次构建都用**干净的源码目录**。
#
# 这里踩过一个很隐蔽的坑：同一个目录里换了编译器重新 configure（比如先失败一次、
# 改完参数再跑），make 只会重编"命令行变了"的那些 .o，剩下的仍是**上一次编译器产出的
# 目标文件**。结果是链接 ffmpeg 时报一堆莫名其妙的 undefined symbol
# （`_ff_calculate_bounding_box`、`_ff_perlin_get` …），而 `nm` 在归档里**明明能找到它们**。
# 花在诊断上的时间远比重新解包多，所以这里一律清干净。
case "$WORK" in
  */securereel-ffmpeg-lgpl-*) ;;
  *) echo "✗ 构建目录路径异常，已中止：$WORK" >&2; exit 1 ;;
esac
if [ -d "$WORK/ffmpeg-${VERSION}" ]; then
  echo "==> 清理上次构建残留（换编译器/换架构时必须，否则 .o 会混架构）"
  rm -rf "$WORK/ffmpeg-${VERSION}"
fi
echo "==> 解包到 $WORK"
tar -C "$WORK" -xf "$SRC_CACHE/ffmpeg-${VERSION}.tar.xz"
cd "$WORK/ffmpeg-${VERSION}"

# ── 配置 ──────────────────────────────────────────────────────────
# 只要"读元数据 + 解码提帧"这两件事：
#   · demuxer / 原生 decoder（H.264/HEVC/ProRes… 这些**都是 LGPL**）
#   · scale filter + mjpeg 编码器 + image2 muxer（写首尾帧图片）
#   · prores_ks 编码器（自检流水线造 ProRes 素材用；它是 FFmpeg 原生实现，LGPL）
# 编码 H.264/HEVC 用不到，所以 libx264/libx265 一律不要。
HOST_ARCH="$(uname -m)"

echo "==> configure"
# 用 `set --` 组参数：交叉编译时要**有条件地**多塞一个 --cc（见下方），
# 直接写进命令里会变成一个空参数，configure 会当成未知选项。
set -- \
  --prefix="$WORK/install-${ARCH}" \
  --arch="${ARCH}" \
  --enable-static \
  --disable-shared \
  --enable-pic \
  --disable-gpl \
  --disable-nonfree \
  --disable-autodetect \
  --disable-network \
  --disable-doc \
  --disable-debug \
  --disable-ffplay \
  --enable-ffmpeg \
  --enable-ffprobe \
  --enable-videotoolbox \
  --enable-audiotoolbox \
  --enable-zlib \
  "$ASM_FLAG"

# 交叉编译（Apple 芯片上编 Intel 版）：必须把 -arch 交给**编译器**。
#
# ⚠️ 这里踩过两个坑，别改回去：
#   1. 光给 `--arch=x86_64` 不够 —— 那只设置 FFmpeg 的目标宏，不改变 clang 的实际目标架构；
#   2. **`export CC=...` 完全无效** —— FFmpeg 的 configure 不读 CC 环境变量，只认 `--cc`。
#      实测：只设环境变量时 configure 输出仍是 `C compiler gcc`，随后在
#      `libavfilter/vf_gradfun.c` 的 `emms`（x86 内联汇编）上编译失败 ——
#      也就是说它一直在按 arm64 编。
if [ "$ARCH" != "$HOST_ARCH" ]; then
  echo "ℹ️  交叉编译 ${HOST_ARCH} → ${ARCH}：--cc='clang -arch $ARCH'"
  set -- "$@" "--cc=clang -arch $ARCH"
fi

./configure "$@"

echo "==> 编译（可能要 8–15 分钟）"
make -j"$(sysctl -n hw.ncpu)"
make install

# ── 合规守卫（三条，缺一不可） ────────────────────────────────────
BUILT_FFMPEG="$WORK/install-${ARCH}/bin/ffmpeg"
BUILT_FFPROBE="$WORK/install-${ARCH}/bin/ffprobe"

echo "==> 合规自检"
if "$BUILT_FFMPEG" -version | grep -qE 'enable-(gpl|nonfree)'; then
  echo "✗ 构建结果里出现了 --enable-gpl / --enable-nonfree —— 不能用于闭源分发！" >&2
  echo "  多半是 --disable-autodetect 没生效，或 configure 捡到了本机 Homebrew 的库。" >&2
  "$BUILT_FFMPEG" -version | head -3 >&2
  exit 1
fi
if otool -L "$BUILT_FFMPEG" | tail -n +2 | grep -qvE '/usr/lib/|/System/Library/'; then
  echo "⚠️  ffmpeg 仍依赖非系统动态库，LGPL 的静态链接义务会变复杂：" >&2
  otool -L "$BUILT_FFMPEG" >&2
  echo "  （本脚本预期是纯静态；出现这行说明本机环境干扰了链接）" >&2
fi

# ── 落盘 ──────────────────────────────────────────────────────────
mkdir -p "$DEST"
cp "$BUILT_FFMPEG" "$DEST/ffmpeg"
cp "$BUILT_FFPROBE" "$DEST/ffprobe"
chmod +x "$DEST/ffmpeg" "$DEST/ffprobe"

echo ""
echo "✅ 完成：$DEST"
"$DEST/ffmpeg" -version | head -2
echo ""
echo "下一步（顺序不能反）："
echo "  1. 另一个架构也要跑：ARCH=x86_64 sh scripts/build-ffmpeg-lgpl.sh"
echo "  2. 自检回归：npm run verify:pipeline    # 现在它会用随包那份 ffmpeg"
echo "  3. **改 THIRD_PARTY_NOTICES.md** 的 FFmpeg 段：GPL-3.0 → LGPL，"
echo "     并附 LGPL 全文与源码获取方式（声明必须与实际二进制一致，这一步不能省）"
