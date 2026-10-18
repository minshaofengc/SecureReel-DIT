#!/bin/sh
# 打 Windows 版安装包，产物直接落到工作区根的「03-Windows 版」文件夹。
#
#   SECUREREEL_OUTPUT_DIR=/absolute/candidate sh scripts/dist-win.sh
#
# 📁 目录层级（2026-10-04 工作区重排后）：
#   工作区根/
#   ├── 01-源码/SecureReel-DIT/   ← 本脚本所在（$ROOT）
#   ├── 02-Mac 版/                ← dist-mac.sh 的产物
#   └── 03-Windows 版/            ← 本脚本的产物
#   所以工作区根 = $ROOT/../..（**两层**，源码重排前是一层，别再按老路径推）。
#
# 为什么单独一个脚本而不是写进 package.json：
#   1. 产物目录是**工作区根的兄弟目录**（../../03-Windows 版），里面还有中文和空格，
#      塞进 npm script 里既要转义又要担心各平台 shell 的差异；
#   2. 打包必须带两个国内镜像变量（与 dist:mac 同一个道理），
#      在脚本里可以写成"没设才设"，比在命令行里每次手打省事；
#   3. 打包前那次硬预检（scripts/check-win-assets.sh）也一并挂进来。
#
# ⚠️ 不要升级 electron-builder 到别的版本而不重读这条：
# 「在 macOS 上打 Windows 包不需要 Wine」依赖的是
# app-builder-lib/out/util/macosVersion.js 里 isMacOsCatalina() 的实际语义
# （它其实是「macOS ≥ 10.15」）—— 满足时走纯 JS 的 UninstallerReader。
# 万一哪天构建日志里出现了 wine，说明版本变了，回来重新审这一步。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)" || exit 1

# Linked worktrees live at another depth; never infer release destinations there.
# The override also lets a normal checkout build candidates without touching releases.
if [ "${SECUREREEL_OUTPUT_DIR+x}" = x ]; then
  OUT_DIR="$SECUREREEL_OUTPUT_DIR"
  case "$OUT_DIR" in
    /*) ;;
    *) echo "✗ SECUREREEL_OUTPUT_DIR 必须是非空绝对目录。" >&2; exit 1 ;;
  esac
elif [ -f "$ROOT/.git" ]; then
  echo "✗ 隔离工作树必须显式设置 SECUREREEL_OUTPUT_DIR 指向候选产物目录。" >&2
  exit 1
else
  OUT_DIR="$(cd "$ROOT/../.." && pwd -P)/03-Windows 版"
fi

# Resolve existing ancestors without creating output, including symlink aliases.
# Reject traversal, files, dangling links, repository paths and their ancestors.
case "/$OUT_DIR/" in
  *'/../'*|*'/./'*) echo "✗ 产物目录不能包含 . 或 .. 路径段。" >&2; exit 1 ;;
esac
OUT_ANCESTOR="$OUT_DIR"
OUT_SUFFIX=''
while [ ! -d "$OUT_ANCESTOR" ]; do
  if [ -e "$OUT_ANCESTOR" ] || [ -L "$OUT_ANCESTOR" ]; then
    echo "✗ 产物路径不是可用目录。" >&2
    exit 1
  fi
  OUT_SUFFIX="/$(basename "$OUT_ANCESTOR")$OUT_SUFFIX"
  OUT_ANCESTOR="$(dirname "$OUT_ANCESTOR")"
done
OUT_ANCESTOR="$(cd "$OUT_ANCESTOR" && pwd -P)" || exit 1
OUT_DIR="${OUT_ANCESTOR%/}$OUT_SUFFIX"
case "$OUT_DIR" in
  ''|/|"$ROOT"|"$ROOT"/*|*/.git|*/.git/*)
    echo "✗ 产物目录不能是根目录或源码目录。" >&2; exit 1 ;;
esac
case "$ROOT/" in
  "$OUT_DIR/"*) echo "✗ 产物目录不能包含源码目录。" >&2; exit 1 ;;
esac

# 国内镜像：没设才设，已设的尊重调用方。
#
# ⚠️ 必须用 registry.npmmirror.com/-/binary/，**不是** npmmirror.com/mirrors/。
# 后一个（老地址、网上教程里到处都是）现在对具体版本固定返回 502 Bad Gateway，
# 而 npm 包本身装得好好的 —— 现象是"npm install 成功、打包却卡在下载运行时"。
# 2026-10-04 实测：只有 -/binary/ 那条路能出包。
if [ -z "${ELECTRON_MIRROR:-}" ]; then
  ELECTRON_MIRROR='https://registry.npmmirror.com/-/binary/electron/'
  export ELECTRON_MIRROR
fi
if [ -z "${ELECTRON_BUILDER_BINARIES_MIRROR:-}" ]; then
  ELECTRON_BUILDER_BINARIES_MIRROR='https://registry.npmmirror.com/-/binary/electron-builder-binaries/'
  export ELECTRON_BUILDER_BINARIES_MIRROR
fi

echo "产物目录：$OUT_DIR"
echo

sh "$ROOT/scripts/check-win-assets.sh" || exit 1
echo

cd "$ROOT" || exit 1
./node_modules/.bin/electron-builder --win --x64 -c.directories.output="$OUT_DIR" || exit 1

echo
echo "=== 产物 ==="
ls -la "$OUT_DIR"
