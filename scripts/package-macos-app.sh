#!/bin/sh
# 打包并签名 macOS Coding.app。
# 用法：CODESIGN_IDENTITY="Apple Development: …" ./scripts/package-macos-app.sh
# 未提供身份时回退 ad-hoc 签名（本机可运行，不可分发）。

set -e

root=$(cd "$(dirname "$0")/.." && pwd)
app="dist/Coding.app"
identity=${CODESIGN_IDENTITY:-}

if [ ! -x dist/Coding ]; then
  echo "package-macos-app: dist/Coding missing; run 'make desktop' first" >&2
  exit 1
fi

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/Frameworks"
cp dist/Coding "$app/Contents/MacOS/Coding"
cp apps/desktop/packaging/Info.plist "$app/Contents/Info.plist"

# 内嵌 SEA Host：首个运行物化到 $DSH_HOME/runtime，.app 内保持只读资源。
if ls dist/coding-runtime/coding-host-darwin-* >/dev/null 2>&1; then
  cp dist/coding-runtime/coding-host-darwin-* "$app/Contents/Resources/coding-host"
  chmod 755 "$app/Contents/Resources/coding-host"
fi

# codesign 自身输出重定向：只保留脚本自己的单行结论，避免多行噪音。
if [ -n "$identity" ]; then
  codesign --force --deep --options runtime --timestamp --sign "$identity" "$app" >/dev/null 2>&1
  codesign --verify --strict "$app"
  echo "package-macos-app: signed dist/Coding.app (developer identity)"
else
  codesign --force --deep --sign - "$app" >/dev/null 2>&1
  codesign --verify "$app"
  echo "package-macos-app: signed dist/Coding.app (ad-hoc; set CODESIGN_IDENTITY to enable developer signing)"
fi
