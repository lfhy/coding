#!/bin/sh
# 打包并签名 macOS Coding.app。
# 用法：CODESIGN_IDENTITY="Apple Development: …" ./scripts/package-macos-app.sh
# 未提供身份时回退 ad-hoc 签名（本机可运行，不可分发）。

set -e

root=$(cd "$(dirname "$0")/.." && pwd)
app="dist/Coding.app"
identity=${CODESIGN_IDENTITY:-}

if [ ! -x dist/Coding ]; then
  echo "package-macos-app: 缺少 dist/Coding，先运行 make desktop" >&2
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

if [ -n "$identity" ]; then
  codesign --force --deep --options runtime --timestamp --sign "$identity" "$app"
  codesign --verify --strict "$app"
  echo "package-macos-app: 已用开发者证书签名 $app（公证执行：xcrun notarytool submit <dmg> --keychain-profile <profile>）"
else
  codesign --force --deep --sign - "$app"
  codesign --verify "$app"
  echo "package-macos-app: 已 ad-hoc 签名 $app（设置 CODESIGN_IDENTITY 可启用开发者签名）"
fi
