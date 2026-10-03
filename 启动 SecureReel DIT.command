#!/bin/bash
#
# SecureReel DIT —— macOS 一键启动
#
# 双击这个文件即可。首次运行需要联网下载依赖，大约 1–3 分钟；
# 之后每次启动只需要几秒。
#
# 如果双击没反应，请在「终端」里运行：
#   chmod +x "启动 SecureReel DIT.command"
# 然后再双击。

set -u

cd "$(dirname "$0")" || exit 1

BOLD=$'\033[1m'
DIM=$'\033[2m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RED=$'\033[31m'
RESET=$'\033[0m'

echo ""
echo "${BOLD}SecureReel DIT${RESET}  ${DIM}素材拷贝 · 哈希校验 · 报告${RESET}"
echo "────────────────────────────────────────────────"

# 某些自动化环境会注入这个变量，它会让 Electron 退化成普通 Node 而无法启动
unset ELECTRON_RUN_AS_NODE

# 1) 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "${RED}没有找到 Node.js。${RESET}"
  echo ""
  echo "请先安装 Node.js 22 或更高版本："
  echo "  方式一（推荐）：到 https://nodejs.org 下载 macOS 安装包，双击安装"
  echo "  方式二：如果你装了 Homebrew，在终端执行  brew install node"
  echo ""
  echo "装好之后重新双击本文件即可。"
  echo ""
  read -r -p "按回车键关闭…" _
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "${RED}Node.js 版本过低（当前 $(node -v)），需要 22 或更高。${RESET}"
  echo "请到 https://nodejs.org 更新后重试。"
  echo ""
  read -r -p "按回车键关闭…" _
  exit 1
fi

echo "${GREEN}✓${RESET} Node.js $(node -v)"

# 2) 安装依赖
if [ ! -d node_modules ]; then
  echo "${YELLOW}首次运行：正在安装依赖，请耐心等待…${RESET}"
  # 国内网络下从官方源拉 Electron 二进制经常很慢，默认走镜像
  export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
  if ! npm install; then
    echo ""
    echo "${RED}依赖安装失败。${RESET}常见原因："
    echo "  · 网络不通 —— 检查能否访问 npm 源"
    echo "  · Electron 二进制下载失败 —— 已自动尝试国内镜像，可再试一次"
    echo ""
    read -r -p "按回车键关闭…" _
    exit 1
  fi
  echo "${GREEN}✓${RESET} 依赖安装完成"
fi

# 3) 检查 Electron 二进制是否真的下载成功
if [ ! -f node_modules/electron/path.txt ]; then
  echo "${YELLOW}正在补下载 Electron 运行时…${RESET}"
  ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" \
    node node_modules/electron/install.js || {
      echo "${RED}Electron 下载失败，请检查网络后重试。${RESET}"
      read -r -p "按回车键关闭…" _
      exit 1
    }
fi
echo "${GREEN}✓${RESET} Electron 运行时就绪"

echo "────────────────────────────────────────────────"
echo "正在启动应用…（关闭应用窗口即退出）"
echo ""
echo "${DIM}提示：切换页面或最小化窗口都不会中断正在进行的拷贝。${RESET}"
echo ""

# 4) 启动
npm run dev

STATUS=$?
if [ $STATUS -ne 0 ]; then
  echo ""
  echo "${RED}应用退出，返回码 $STATUS${RESET}"
  echo "日志在：~/Library/Application Support/SecureReel DIT 2/logs/"
  echo ""
  read -r -p "按回车键关闭…" _
fi
