#!/bin/sh
# 冒烟检查：预展开桌面 Host 在干净 DSH_HOME 中输出就绪行即通过。
# Makefile check 目标调用；要求 dist/coding-runtime/ 下已有本机产物。

set -e

host=
for candidate in dist/coding-runtime/coding-node-*; do
  if [ -x "$candidate" ]; then
    host=$candidate
    break
  fi
done
entry=dist/coding-runtime/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js
if [ -z "$host" ] || [ ! -f "$entry" ]; then
  echo "check-runtime-start: 缺少预展开桌面运行时，先运行 make runtime" >&2
  exit 1
fi

tmp=$(mktemp -d)
DSH_HOME="$tmp" "$host" "$entry" web --coding-host >"$tmp/out.log" 2>&1 &
pid=$!
cleanup() { kill "$pid" 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT

for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sleep 5
  if grep -q 'coding-host-ready' "$tmp/out.log"; then
    if [ -e "$tmp/runtime" ]; then
      echo "check-runtime-start: 预展开桌面 Host 不应创建 $tmp/runtime" >&2
      exit 1
    fi
    echo "check-runtime-start: $(head -n 1 "$tmp/out.log")"
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "check-runtime-start: Host 在就绪前退出：" >&2
    cat "$tmp/out.log" >&2
    exit 1
  fi
done

echo "check-runtime-start: 60 秒内未出现就绪行：" >&2
cat "$tmp/out.log" >&2
exit 1
