# Python 贡献者工作流

[English](development.md) | 中文

根据所需的贡献者成果选择工作流：构建运行时产物、验证 SDK、从源码运行或构建分发包。包行为分别见 [SDK 参考](sdk/README.md) 和[运行时载体参考](sdk-runtime/README.md)。

## 构建运行时产物

各平台可执行文件是构建产物，不检入 git。请在仓库根目录运行构建：

```sh
pnpm install
pnpm exec tsx scripts/build-exe-for-python-sdk.ts
```

所需 `lib/` 产物已存在时使用 `--skip-build`；如需选择平台，请使用 `--targets=node24-linux-x64,node24-linux-arm64,node24-macos-arm64`。产物写入 `dist-exe/`，脚本会将所选载体同步到 `python/sdk-runtime/`。macOS 构建还会同步 `node-pty` 所需的配套 spawn 辅助程序。

## 验证 SDK

请将虚拟环境放在 `python/` 之外，安装测试组，然后运行 Python 测试套件：

```sh
export UV_PROJECT_ENVIRONMENT="$PWD/tmp/py-sdk-venv"
uv sync --project python/sdk --group test
uv run --project python/sdk pytest
```

`python/sdk/tests/test_bundled_runtime.py` 会运行可用的内置载体；某个载体的产物尚未构建时，会跳过该载体。仓库级测试政策见 [测试](../docs/testing.md)。

该套件面向的是伪造的运行时对端。`scripts/smoke-python-runtime.py` 面向真实的打包运行时；必需的 `python-runtime` CI 任务会用新构建的可执行文件运行全部场景：

```sh
uv run --project python/sdk python scripts/smoke-python-runtime.py \
  --scenario sdk-minimal --exe dist-exe/dsh-jsonrpc-agent-pkg-macos-arm64
```

其中两个场景会比对 `scripts/snapshots/python-sdk-single-exe/` 下已提交的期望输出。`minimal/model-visible.json` 固定了签入的极简组合所组装的系统提示词、对外公布的工具 schema 以及模型可见消息，因此插件一旦贡献出计划外的系统分段或 user 消息，该任务即失败；它会丢弃动态运行时上下文快照——同一组合在 macOS 上会发出它，在 Linux 上不会（[#2488](https://github.com/deepseek-harness/deepseek-harness/issues/2488)）。`advanced/` 固定 SDK 结果与持久化的会话日志。重新运行对应场景时加上 `--update-snapshots`，并在提交前审阅该差异。

交互式冒烟测试需要环境变量或仓库根目录 `.env` 中存在 `DEEPSEEK_API_KEY`：

```python
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness() as harness:
    print(harness.run("say hi").final_response)
```

## 针对 Node 源码运行

仓库贡献者可以选择以下任一开发载体：

- 设置 `DSH_RUNTIME_MODE=node`，在系统 Node `>=22.19` 上使用已构建的 Node 载体。构建脚本会刷新该载体，但分发物绝不会包含或自动选择它。
- 将仓库根目录设为 `cwd`，并设置 `launch_args_override=("./node_modules/.bin/tsx", "packages/examples/jsonrpc-demo/src/bin.ts")`，以运行未构建的 TypeScript 源码。默认配置不合适时，请提供 `cordis=...`。

完整的源码模式调用见 `python/sdk/tests/manual_sdk_agent_smoke.py`。

## 构建分发包

根目录 `package.json` 的版本是两个 Python 分发包的权威版本。暂存脚本会将该版本注入两个 wheel 包，并将 SDK 固定到同版本的 `deepseek-harness-runtime-bin`。

纯 SDK wheel 包只需构建一次；每个原生平台分别构建一个运行时 wheel 包：

```sh
version="$(python - <<'PY'
import runpy

release = runpy.run_path("scripts/build-python-release.py")
print(release["pep440_version"](release["repository_version"]()))
PY
)"
python scripts/build-python-release.py --package sdk --output-dir dist-python
python scripts/build-python-release.py --package runtime --platform macos-arm64 --runtime-exe dist-exe/dsh-jsonrpc-agent-pkg-macos-arm64 --output-dir dist-python
pip install \
  "dist-python/deepseek_harness_sdk-$version-py3-none-any.whl" \
  "dist-python/deepseek_harness_runtime_bin-$version-py3-none-macosx_14_0_arm64.whl"
```

运行时分发包仅提供 wheel 包。本 fork 不在 CI 中发布或验证 Python wheel 包。先在目标平台本地构建 wheel 包，再将匹配的 SDK 与运行时 wheel 包安装到干净的虚拟环境中后使用。当前构建器支持 Linux x64、Linux arm64 和 macOS 14 或更高版本的 arm64；后续分发决策可以调整这些目标并加入 opt-in 工作流。

## 验证本地 wheel 包

本 fork 没有 Python 发布或上传工作流。验证候选包时，将匹配的 wheel 包安装到干净的虚拟环境，并运行准备分发的 SDK 路径。在选定包命名空间、支持平台、签名方式和分发责任前，不要上传包、配置发布凭据，或将 `python-v*` 标签视为发布触发条件。
