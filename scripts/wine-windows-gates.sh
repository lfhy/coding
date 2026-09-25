#!/usr/bin/env bash
# 本地 `pnpm run check:windows-wine` 使用 Wine 下真正的 win-x64 Node.js
# 验证 Windows Node 冒烟及 Host/Client 构建。隔离方式与适用范围：
# 不修改工作树：把已跟踪文件及未忽略的未跟踪文件复制到临时目录，仅在副本的
# pnpm-workspace.yaml 中添加 Wine 专用的 hoisted 布局和 win32-x64 平台包；
# 安装与构建使用共享的 pnpm store。Wine prefix 和经过校验的 Windows Node
# zip 缓存在 .cache/wine-windows/，以便再次运行时复用。
# DSH_WINE_NODE_MAJOR 选择 Node 主版本（默认 PRIMARY_NODE_VERSION，其次 24）；
# DSH_WINE_GATE_CACHE_DIR 改变缓存位置；DSH_WINE_GATE_KEEP=1 保留临时目录。

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
node_major="${DSH_WINE_NODE_MAJOR:-${PRIMARY_NODE_VERSION:-24}}"
cache_dir="${DSH_WINE_GATE_CACHE_DIR:-$repo_root/.cache/wine-windows}"

export WINEDEBUG='-all'
export WINEARCH=win64
# Skip Wine Mono / Gecko installers: Node needs neither.
export WINEDLLOVERRIDES='mscoree,mshtml='
export WINEPREFIX="$cache_dir/prefix"

# ---- preflight: fail loud before any expensive work --------------------
wine_bin=''
for candidate in "$(command -v wine || true)" "$(command -v wine64 || true)" /usr/lib/wine/wine64; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then wine_bin="$candidate"; break; fi
done
# GNU coreutils sha256sum on Linux; perl shasum ships with macOS. Both
# accept the same "<hash>  <file>" --check input.
checksum_tool=''
if command -v sha256sum > /dev/null; then
  checksum_tool='sha256sum'
elif command -v shasum > /dev/null; then
  checksum_tool='shasum'
fi
missing=()
[ -n "$wine_bin" ] || missing+=('wine (apt: wine | brew: wine-stable)')
command -v curl > /dev/null || missing+=('curl')
command -v unzip > /dev/null || missing+=('unzip')
[ -n "$checksum_tool" ] || missing+=('sha256sum or shasum (apt: coreutils | macOS ships shasum)')
if ! command -v pnpm > /dev/null; then corepack enable > /dev/null 2>&1 || true; fi
command -v pnpm > /dev/null || missing+=('pnpm (corepack enable)')
if (( ${#missing[@]} > 0 )); then
  printf 'wine-windows-gates: missing required tool: %s\n' "${missing[@]}" >&2
  exit 1
fi

# Verify file $2 against SHA-256 hex $1 with whichever tool preflight found.
verify_sha256() {
  case "$checksum_tool" in
    sha256sum) printf '%s  %s\n' "$1" "$2" | sha256sum --check - > /dev/null ;;
    shasum) printf '%s  %s\n' "$1" "$2" | shasum -a 256 --check - > /dev/null ;;
  esac
}

scratch="$(mktemp -d "${TMPDIR:-/tmp}/dsh-wine-gates.XXXXXX")"
cleanup() {
  wineserver -k > /dev/null 2>&1 || true
  if [ "${DSH_WINE_GATE_KEEP:-0}" = '1' ]; then
    echo "wine-windows-gates: scratch tree kept at $scratch"
  else
    rm -rf "$scratch"
  fi
}
trap cleanup EXIT
mkdir -p "$cache_dir" "$scratch/logs"

# ---- provision Windows Node, boot Wine, snapshot + install concurrently ----
curl_metadata_args=(
  --fail --silent --show-error --location
  --retry 3 --retry-all-errors --retry-delay 2
  --http1.1 --connect-timeout 10 --max-time 30 --retry-max-time 120
)

download_node_archive() {
  local version="$1" output="$2" attempt status=0
  local archive="node-$version-win-x64.zip"
  local primary_url="https://nodejs.org/dist/$version/$archive"
  local mirror_url="https://npmmirror.com/mirrors/node/$version/$archive"

  if curl --fail --silent --show-error --location --http1.1 \
    --connect-timeout 10 --max-time 300 --speed-limit 1024 --speed-time 30 \
    -o "$output" "$primary_url"; then
    return 0
  fi
  echo 'wine-windows-gates: nodejs.org archive transfer stalled; resuming from the checksum-untrusted transport mirror' >&2
  for attempt in 1 2 3; do
    if curl --fail --silent --show-error --location --http1.1 \
      --continue-at - --connect-timeout 10 --max-time 300 \
      --speed-limit 1024 --speed-time 30 \
      -o "$output" "$mirror_url"; then
      return 0
    else
      status=$?
    fi
    (( attempt < 3 )) || break
    echo "wine-windows-gates: mirror transfer failed (exit $status) on attempt $attempt; resuming partial download" >&2
  done
  return "$status"
}

provision_node() {
  # Latest release of the primary line, checksum-verified against the same
  # dist directory. Bound and retry every transfer so a stalled nodejs.org
  # response cannot consume the entire CI job. Offline runs fall back to the
  # newest cached zip, loudly.
  local version zip
  version="$(curl "${curl_metadata_args[@]}" https://nodejs.org/dist/index.json 2> /dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const v=JSON.parse(d).find(r=>r.version.startsWith('v$node_major.'));if(v)console.log(v.version)})" \
    || true)"
  if [ -n "$version" ]; then
    zip="$cache_dir/node-$version-win-x64.zip"
    if [ ! -f "$zip" ]; then
      download_node_archive "$version" "$zip.tmp"
      local expected
      expected="$(curl "${curl_metadata_args[@]}" "https://nodejs.org/dist/$version/SHASUMS256.txt" \
        | awk -v a="node-$version-win-x64.zip" '$2 == a { print $1; exit }')"
      [ -n "$expected" ] || { echo "wine-windows-gates: no SHASUMS256 entry for node-$version-win-x64.zip" >&2; exit 1; }
      verify_sha256 "$expected" "$zip.tmp"
      mv "$zip.tmp" "$zip"
    fi
  else
    zip="$(ls -t "$cache_dir"/node-v"$node_major".*-win-x64.zip 2> /dev/null | head -1 || true)"
    [ -n "$zip" ] || { echo "wine-windows-gates: nodejs.org unreachable and no cached Windows Node v$node_major zip in $cache_dir" >&2; exit 1; }
    echo "wine-windows-gates: nodejs.org unreachable; using cached $(basename "$zip")" >&2
  fi
  unzip -q -o "$zip" -d "$scratch/node-win"
  echo "$scratch/node-win/$(basename "$zip" .zip)/node.exe" > "$scratch/node-win-path"
}

boot_wine() {
  "$wine_bin" wineboot --init > /dev/null 2>&1 || true
  wineserver -w || true
}

snapshot_and_install() {
  # Tracked + untracked-unignored files, minus agent-session litter; the
  # existence filter drops paths staged as deleted. Then the Wine-specific
  # install-time overrides go on the SNAPSHOT only: hoisted because Windows
  # Node under Wine does not realpath pnpm's isolated-layout symlinks, and
  # win32-x64 so the Windows esbuild/rolldown/rollup binaries materialize.
  # Neither is recorded in the lockfile, so --frozen-lockfile stays valid;
  # --ignore-scripts skips host lifecycle scripts no gate loads.
  git -C "$repo_root" ls-files -z --cached --others --exclude-standard -- . ':!:.claude' ':!:.codex' \
    | while IFS= read -r -d '' file; do [ -e "$repo_root/$file" ] && printf '%s\0' "$file"; done \
    | tar -C "$repo_root" --null --files-from=- -cf - \
    | tar -C "$scratch/tree" -xf -
  cat >> "$scratch/tree/pnpm-workspace.yaml" << 'EOF'

nodeLinker: hoisted
supportedArchitectures:
  os: [current, win32]
  cpu: [current, x64]
EOF
  # The hoisted linker — used only by this lane — has an upstream rename
  # race (pnpm/pnpm#12880): parallel linkers staging a nested package copy
  # (observed on the tree's nested esbuild versions) rename their _tmp_*
  # directory onto a path another racer already claimed, and the loser
  # exits ERR_PNPM_ENOENT although an identical re-install succeeds.
  # Exactly that signature earns up to two retries on a clean tree — the
  # snapshot contains no node_modules, so wiping them restores the
  # pre-install state; any other failure, or the race still standing after
  # the final attempt, fails loud with the log tail.
  local attempt
  for attempt in 1 2 3; do
    (cd "$scratch/tree" && pnpm install --frozen-lockfile --ignore-scripts > "$scratch/logs/install.log" 2>&1) \
      && return 0
    grep -q 'ERR_PNPM_ENOENT.*rename.*_tmp_' "$scratch/logs/install.log" || break
    (( attempt < 3 )) || break
    echo "wine-windows-gates: pnpm hoisted-linker rename race (pnpm/pnpm#12880) on install attempt $attempt; retrying on a clean tree" >&2
    find "$scratch/tree" -name node_modules -type d -prune -exec rm -rf {} +
  done
  tail -40 "$scratch/logs/install.log" >&2
  return 1
}

mkdir "$scratch/tree"
start=$SECONDS
provision_node & node_pid=$!
boot_wine & wine_pid=$!
snapshot_and_install & install_pid=$!
# Wait for EVERY child before judging any: a bare `wait` under set -e would
# exit on the first failure and let the EXIT trap delete $scratch while the
# other children still run inside it. Named statuses also make the report
# point at the root cause instead of a downstream symptom.
node_status=0; wait "$node_pid" || node_status=$?
wine_status=0; wait "$wine_pid" || wine_status=$?
install_status=0; wait "$install_pid" || install_status=$?
provision_failed=0
report_provision() {
  if (( $2 != 0 )); then
    echo "wine-windows-gates: FAILED $1 (exit $2)" >&2
    provision_failed=$2
  fi
}
report_provision 'Windows Node provisioning' "$node_status"
report_provision 'wineboot' "$wine_status"
report_provision 'workspace snapshot + pnpm install' "$install_status"
if (( provision_failed != 0 )); then exit "$provision_failed"; fi
node_win="$(cat "$scratch/node-win-path")"
echo "wine-windows-gates: provisioned in $((SECONDS - start))s (wine $("$wine_bin" --version 2> /dev/null), node $(basename "$(dirname "$node_win")"))"

# ---- 检查入口并验证 Windows Node ------------------------------------------
# Wine 下的 Node 无法将标准流连接到调用方的管道（启动时 Socket open EBADF），
# 因此每次调用都将标准输出和错误写入文件。
wine_node() {
  local log="$1"
  shift
  local status=0
  "$wine_bin" "$node_win" "$@" < /dev/null > "$log" 2>&1 || status=$?
  return "$status"
}

cd "$scratch/tree"
tsc_js='node_modules/typescript/bin/tsc'
tsdown_js='node_modules/tsdown/dist/run.mjs'
for entry in "$tsc_js" "$tsdown_js"; do
  [ -f "$entry" ] || { echo "wine-windows-gates: expected entrypoint missing after hoisted install: $entry" >&2; exit 1; }
done

wine_node "$scratch/logs/smoke.log" -p "'smoke: ' + process.platform + ' ' + process.arch + ' ' + process.version"
cat "$scratch/logs/smoke.log"
grep -q '^smoke: win32 x64' "$scratch/logs/smoke.log" || { echo 'wine-windows-gates: Windows Node smoke did not report win32 x64' >&2; exit 1; }

# ---- Host/Client 构建检查 -------------------------------------------------
# 保持 package.json 中先编译并打包 Host、再编译并打包 Client 的顺序。
build_gate() {
  wine_node "$scratch/logs/host-tsc.log" "$tsc_js" -b tsconfig.host.json --pretty false || return $?
  wine_node "$scratch/logs/host-tsdown.log" "$tsdown_js" --env.DSH_BUILD_FACE host || return $?
  wine_node "$scratch/logs/client-tsc.log" "$tsc_js" -b tsconfig.client.json --pretty false || return $?
  wine_node "$scratch/logs/client-tsdown.log" "$tsdown_js" --env.DSH_BUILD_FACE client
}
start=$SECONDS
build_gate & build_pid=$!
build_status=0
wait "$build_pid" || build_status=$?
elapsed=$((SECONDS - start))

report() {
  local label="$1" status="$2"
  shift 2
  if (( status == 0 )); then
    echo "wine-windows-gates: PASS $label (${elapsed}s window)"
  else
    echo "== FAILED $label (exit $status) ==" >&2
    for log in "$@"; do tail -n 200 "$log" >&2 || true; done
  fi
}
report 'build (Host tsc/tsdown, Client tsc/tsdown)' "$build_status" \
  "$scratch/logs/host-tsc.log" \
  "$scratch/logs/host-tsdown.log" \
  "$scratch/logs/client-tsc.log" \
  "$scratch/logs/client-tsdown.log"
exit "$build_status"
