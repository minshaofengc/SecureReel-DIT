#!/bin/sh
# 打 macOS 版安装包（universal 的 dmg + zip），产物落到工作区根的「02-Mac 版」文件夹。
#
#   SECUREREEL_OUTPUT_DIR=/absolute/candidate sh scripts/dist-mac.sh
#
# 📁 目录层级（与 dist-win.sh 完全对称）：
#   工作区根/
#   ├── 01-源码/SecureReel-DIT/   ← 本脚本所在（$ROOT）
#   ├── 02-Mac 版/                ← 本脚本的产物
#   └── 03-Windows 版/            ← dist-win.sh 的产物
#   源码重排前产物落在源码自己的 dist/ 里，所以工作区根从 $ROOT/.. 变成了
#   $ROOT/../..（**两层**）—— 改路径时别再按老的一层推。
#
# ⚠️ 打 dmg 要挂载临时镜像（hdiutil），**在受限沙箱里会失败**：
#    这个脚本要在沙箱外/正常终端跑；dist-win.sh 不需要。
#
# ⚠️ 打包前先确认没有任务在跑，并关掉正在运行的 SecureReel DIT 2
#    （详见项目记忆的「产物线」一节）。
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
  OUT_DIR="$(cd "$ROOT/../.." && pwd -P)/02-Mac 版"
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
# 后一个（老地址）对具体版本固定返回 502 Bad Gateway，现象是
# "npm install 成功、打包却卡在下载运行时"。2026-10-04 实测只有 -/binary/ 能出包。
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

cd "$ROOT" || exit 1

# 门禁：不能把验证入口打进安装包。
# package.json 的 dist:mac 里也有一道，这里是给"直接 sh scripts/dist-mac.sh"补的。
if [ -f out/main/verify.js ]; then
  echo "✗ out/main/verify.js 还在 —— 先跑 npm run build 重新构建，别把验证入口打进安装包。" >&2
  exit 1
fi

./node_modules/.bin/electron-builder --mac -c.directories.output="$OUT_DIR" || exit 1

# electron-builder 把 .app 放在 <产物目录>/mac-universal/ 下。
# 那个 .app 是 boss 平时直接双击用的，埋在两层子目录里不好找，
# 这里把它复制到「02-Mac 版」顶层，路径从此固定为：
#   02-Mac 版/SecureReel DIT 2.app
APP_SRC="$OUT_DIR/mac-universal/SecureReel DIT 2.app"
APP_DST="$OUT_DIR/SecureReel DIT 2.app"
if [ -d "$APP_SRC" ]; then
  # Keep previous destination-only files and builder output for recovery.
  /usr/bin/rsync -a "$APP_SRC/" "$APP_DST/" || exit 1
  echo "✓ 已把 .app 复制到顶层：$APP_DST"
fi

echo
echo "=== 产物 ==="
ls -la "$OUT_DIR"
echo
echo "提示：升版本后记得把上一版挪进「02-Mac 版/历史版本/<版本号>/」，"
echo "      并重算 02-Mac 版/SHA256SUMS.txt（只列 mac 的两个安装包）。"
