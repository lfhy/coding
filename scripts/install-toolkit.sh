#!/bin/sh
# 为 macOS 桌面构建准备工具；已有符合要求的版本保持不变。
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

say() {
  printf 'toolkit: %s\n' "$*"
}

fail() {
  printf 'toolkit: %s\n' "$*" >&2
  exit 1
}

if [ "$(uname -s)" != Darwin ]; then
  fail '自动安装目前仅支持 macOS；Linux 请按 docs/user/guide/install.md 准备工具。'
fi
if [ "$(uname -m)" != arm64 ]; then
  fail '桌面构建目前仅支持 macOS arm64；请使用原生 arm64 终端。'
fi

if ! xcode-select -p >/dev/null 2>&1 || \
   ! xcrun --find clang >/dev/null 2>&1 || \
   ! xcrun --find lipo >/dev/null 2>&1 || \
   ! command -v codesign >/dev/null 2>&1; then
  say '安装 Xcode 命令行工具…'
  xcode-select --install || fail '无法启动 Xcode 命令行工具安装。'
  fail '请完成系统安装窗口中的操作，然后重新运行 make toolkit。'
fi
say 'Xcode 命令行工具已可用，跳过安装。'

activate_brew() {
  if command -v brew >/dev/null 2>&1; then
    return
  fi
  if [ -x /opt/homebrew/bin/brew ]; then
    brew_environment=$(/opt/homebrew/bin/brew shellenv) || return 1
  elif [ -x /usr/local/bin/brew ]; then
    brew_environment=$(/usr/local/bin/brew shellenv) || return 1
  else
    return 1
  fi
  eval "$brew_environment"
  command -v brew >/dev/null 2>&1
}

ensure_brew() {
  if activate_brew; then
    return
  fi
  command -v curl >/dev/null 2>&1 || fail '缺少 curl，无法安装 Homebrew。'
  say '安装 Homebrew…'
  installer=$(mktemp)
  if ! curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$installer"; then
    rm -f "$installer"
    fail '无法下载安装 Homebrew 安装脚本。'
  fi
  if ! /bin/bash "$installer"; then
    rm -f "$installer"
    fail 'Homebrew 安装失败。'
  fi
  rm -f "$installer"
  activate_brew || fail 'Homebrew 已安装，但当前 PATH 中找不到 brew。'
}

prefer_brew() {
  ensure_brew
  brew_prefix=$(brew --prefix)
  PATH="$brew_prefix/bin:$brew_prefix/sbin:$PATH"
  export PATH
}

node_usable() {
  command -v node >/dev/null 2>&1 && \
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(process.arch === "arm64" && ((major === 22 && minor >= 19) || major >= 24) ? 0 : 1)'
}

if node_usable; then
  say "Node.js $(node --version) 已可用，跳过安装。"
else
  prefer_brew
  say '安装 Node.js…'
  if brew list --versions node >/dev/null 2>&1 && [ -n "$(brew list --versions node)" ]; then
    brew update
    brew upgrade node
  else
    brew install node
  fi
  node_usable || fail 'Node.js 已安装，但当前 PATH 中的版本或架构不符合桌面构建要求。'
fi

required_pnpm=$(cd "$root" && node -p 'require("./package.json").packageManager.split("@")[1]')
pnpm_usable() {
  command -v pnpm >/dev/null 2>&1 && [ "$(pnpm --version 2>/dev/null)" = "$required_pnpm" ]
}

if pnpm_usable; then
  say "pnpm $required_pnpm 已可用，跳过安装。"
else
  if command -v corepack >/dev/null 2>&1; then
    say "通过 Corepack 准备 pnpm $required_pnpm…"
    if ! corepack enable; then
      say 'Corepack 启用失败，尝试通过 npm 安装 pnpm。'
    fi
  fi
  if ! pnpm_usable; then
    command -v npm >/dev/null 2>&1 || fail '缺少 npm，无法安装 pnpm。'
    say "安装 pnpm $required_pnpm…"
    npm install --global --force "pnpm@$required_pnpm"
  fi
  pnpm_usable || fail "pnpm 已安装，但当前 PATH 中不是仓库要求的 $required_pnpm。"
fi

go_usable() {
  command -v go >/dev/null 2>&1 || return 1
  go_version=$(cd "$root/apps/desktop" && go version) || return 1
  node -e 'const match = /\bgo(\d+)\.(\d+)(?:\.|\b)/.exec(process.argv[1]); process.exit(match && (Number(match[1]) > 1 || Number(match[2]) >= 25) ? 0 : 1)' "$go_version"
}

selected_node_dir=$(dirname "$(command -v node)")
selected_pnpm_dir=$(dirname "$(command -v pnpm)")

if go_usable; then
  say "$(cd "$root/apps/desktop" && go version) 已可用，跳过安装。"
else
  prefer_brew
  say '安装或更新 Go…'
  if brew list --versions go >/dev/null 2>&1 && [ -n "$(brew list --versions go)" ]; then
    brew update
    brew upgrade go
  else
    brew install go
  fi
  go_usable || fail 'Go 已安装，但桌面构建仍无法使用 Go 1.25 或更新版本；请检查 PATH 和 GOTOOLCHAIN。'
fi

if ! node_usable; then
  PATH="$selected_node_dir:$PATH"
  export PATH
fi
if ! pnpm_usable; then
  PATH="$selected_pnpm_dir:$PATH"
  export PATH
fi
node_usable && pnpm_usable && go_usable || fail '工具版本在当前 PATH 中发生冲突；请检查 Node.js、pnpm 和 Go 的安装路径。'

say '构建工具已就绪。'

if [ "$#" -gt 0 ]; then
  exec "$@"
fi
