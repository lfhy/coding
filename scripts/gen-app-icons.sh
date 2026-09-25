#!/bin/sh
# 从正方形 logo 源图生成全套应用图标资产。
# 用法: scripts/gen-app-icons.sh <正方形PNG源图>
# 仅支持 macOS（依赖 sips / iconutil / swift）。
# 产物：
#   apps/desktop/packaging/icon.iconset/ + AppIcon.icns macOS 应用图标（squircle 圆角）
#   apps/web/public/favicon.png / favicon.svg          Web favicon（PNG 全出血，SVG 内嵌圆角 128px）
set -eu

if [ "$(uname)" != "Darwin" ]; then
  echo "gen-app-icons: 仅支持 macOS（需要 sips / iconutil / swift）" >&2
  exit 1
fi

if [ "$#" -ne 1 ]; then
  echo "用法: $0 <正方形PNG源图>" >&2
  exit 1
fi

src=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
if [ ! -f "$src" ]; then
  echo "gen-app-icons: 源图不存在: $src" >&2
  exit 1
fi

root=$(cd "$(dirname "$0")/.." && pwd)
iconset="$root/apps/desktop/packaging/icon.iconset"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# 圆角蒙版：连续圆角矩形（squircle 近似），半径约为边长的 22.37%。
cat >"$work/rounded.swift" <<'EOF'
import CoreGraphics
import ImageIO
import Foundation
import UniformTypeIdentifiers

func roundedImage(path: String, size: Int) -> CGImage? {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
    let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
  else { return nil }
  let w = CGFloat(size)
  let h = CGFloat(size)
  guard
    let ctx = CGContext(
      data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { return nil }
  let r = w * 0.2237
  // macOS 图标圆角：外凸贝塞尔控制点，比普通圆角矩形更接近系统 squircle。
  let c = r * 0.55
  let p = CGMutablePath()
  p.move(to: CGPoint(x: r, y: 0))
  p.addLine(to: CGPoint(x: w - r, y: 0))
  p.addCurve(
    to: CGPoint(x: w, y: r), control1: CGPoint(x: w - r + c, y: 0), control2: CGPoint(x: w, y: r - c))
  p.addLine(to: CGPoint(x: w, y: h - r))
  p.addCurve(
    to: CGPoint(x: w - r, y: h), control1: CGPoint(x: w, y: h - r + c), control2: CGPoint(x: w - r + c, y: h))
  p.addLine(to: CGPoint(x: r, y: h))
  p.addCurve(
    to: CGPoint(x: 0, y: h - r), control1: CGPoint(x: r - c, y: h), control2: CGPoint(x: 0, y: h - r + c))
  p.addLine(to: CGPoint(x: 0, y: r))
  p.addCurve(
    to: CGPoint(x: r, y: 0), control1: CGPoint(x: 0, y: r - c), control2: CGPoint(x: r - c, y: 0))
  p.closeSubpath()
  ctx.addPath(p)
  ctx.clip()
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
  return ctx.makeImage()
}

let input = CommandLine.arguments[1]
let output = CommandLine.arguments[2]
let size = Int(CommandLine.arguments[3]) ?? 1024
guard let cg = roundedImage(path: input, size: size) else { fatalError("rounded: failed to process \(input)") }
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, cg, nil)
CGImageDestinationFinalize(dest)
EOF

mkdir -p "$iconset"

# iconset 标准十档；圆角蒙版在目标尺寸直接渲染，避免缩小后边缘锯齿。
for spec in \
  16:16x16 32:16x16@2x \
  32:32x32 64:32x32@2x \
  128:128x128 256:128x128@2x \
  256:256x256 512:256x256@2x \
  512:512x512 1024:512x512@2x
do
  px=${spec%%:*}
  name=${spec##*:}
  swift "$work/rounded.swift" "$src" "$iconset/icon_$name.png" "$px" >/dev/null 2>&1
done

iconutil -c icns "$iconset" -o "$work/AppIcon.icns"
mv -f "$work/AppIcon.icns" "$root/apps/desktop/packaging/AppIcon.icns"

# Web favicon 保持全出血方图；界面里的圆角由 CSS 负责。
sips -z 512 512 "$src" --out "$root/apps/web/public/favicon.png" -s format png >/dev/null 2>&1

node -e "
const fs = require('fs')
const b64 = fs.readFileSync('$iconset/icon_128x128.png').toString('base64')
const svg = '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"128\" height=\"128\" viewBox=\"0 0 128 128\">\n  <image href=\"data:image/png;base64,' + b64 + '\" width=\"128\" height=\"128\"/>\n</svg>\n'
fs.writeFileSync('$root/apps/web/public/favicon.svg', svg)
"

echo "gen-app-icons: 已更新 AppIcon.icns、iconset 与 web favicon"
