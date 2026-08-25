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
plutil -convert binary1 apps/desktop/packaging/Info.plist -o "$app/Contents/Info.plist"
cp apps/desktop/packaging/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
# 触发 Finder/桌面重读图标缓存，避免沿用未带图标版本的旧图标。
rm -rf "$app/Icon\r"

# 应用资源包含原始 Node 可执行文件和预展开的 Host 闭包；启动时不向 $DSH_HOME 解压。
host=
for candidate in dist/coding-runtime/coding-node-darwin-*; do
  if [ -f "$candidate" ]; then
    host=$candidate
    break
  fi
done
runtime=dist/coding-runtime/runtime
entry="$runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"
metadata=dist/coding-runtime/metadata.json
if [ -z "$host" ] || [ ! -f "$entry" ] || [ ! -f "$metadata" ]; then
  echo "package-macos-app: preexpanded desktop runtime missing; run 'make runtime' first" >&2
  exit 1
fi
cp "$host" "$app/Contents/Resources/coding-host"
chmod 755 "$app/Contents/Resources/coding-host"
cp -R "$runtime" "$app/Contents/Resources/runtime"
cp "$metadata" "$app/Contents/Resources/metadata.json"

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
