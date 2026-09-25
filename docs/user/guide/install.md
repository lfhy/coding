# 从源码安装 Coding

本指南适用于从仓库源码构建的本地应用，未提供可下载的桌面安装包。macOS arm64 可构建 Electron 桌面应用；Linux 可构建交互式终端客户端。Windows 桌面安装包尚不可用。

## macOS 桌面应用

在 macOS arm64 上准备 Node.js（`^22.19.0 || >=24.0.0`）、仓库指定的 pnpm、Go 和本机 Xcode 命令行工具，并确保可以写入用于安装的 `/Applications` 目录。从仓库根目录构建：

```sh
make desktop
```

构建会安装锁定依赖，并在 `dist/Coding.app` 生成带独立 Node Host、Go helper 和远端 agent 资源的 Electron 应用。构建不会修改 `/Applications/Coding.app`。可以先直接打开本地构建产物；如需安装到系统应用目录，再从仓库根目录运行：

```sh
make install
```

`make install` 会重新构建，并在 `/Applications` 内暂存新应用，再替换已有的 `/Applications/Coding.app`；替换失败时会尝试恢复旧应用。运行前请确认该目录中的现有应用可以被替换。也可自行复制 `dist/Coding.app`，但手动复制不经过上述安装流程。

应用只使用本机 ad-hoc 签名，未经 Apple 公证，也没有 `.dmg`。从其他机器复制或下载应用后，macOS Gatekeeper 可能阻止打开；签名校验通过不等于获准在其他机器运行。当前的打包版验证是在隔离的用户目录中直接运行构建产物，不能视为 `/Applications` 安装后运行或真实模型请求已经验收。

桌面应用从自身 `Contents/Resources/coding-host` 和预展开的 `Contents/Resources/runtime` 启动 Host，使用时无需单独安装 Node。它把会话、设置和凭据保存在固定的 `~/.dsh`，将 Electron 浏览器数据保存在 `~/.dsh-electron-user-data`；设置 `DSH_HOME` 不会迁移桌面应用的数据。开发态 `make dev` 使用独立的 `~/.dsh-electron-dev`，不读取上述安装版设置与凭据；开发入口另见 [Electron 桌面壳说明](../../../apps/desktop-electron/README.md#开发运行)。

## Linux 终端客户端

Linux x64 的 `coding` 是终端界面，不是桌面 GUI。从仓库构建需要 Node.js、仓库指定的 pnpm 和 Go 1.24 或更新版本。先安装依赖，再构建客户端与它需要的 Host：

```sh
pnpm install --frozen-lockfile
make tui
make runtime
```

产物分别位于 `dist/coding` 和 `dist/coding-runtime/coding-host-linux-x64`。客户端会从 `PATH` 查找名为 `coding-host` 的 Host；例如安装到用户目录：

```sh
mkdir -p "$HOME/.local/bin"
install -m 0755 dist/coding "$HOME/.local/bin/coding"
install -m 0755 dist/coding-runtime/coding-host-linux-x64 "$HOME/.local/bin/coding-host"
```

确保 `$HOME/.local/bin` 在 `PATH` 中，然后运行 `coding`；`coding --cwd <dir>` 可指定默认工作目录。Linux 上的 `make install` 只把客户端放在 `$(HOME)/.local/bin`（可用 `PREFIX` 或 `BINDIR` 覆盖），不会安装 Host；若使用该命令，仍需另行把构建好的 `coding-host` 放进 `PATH`。

Linux Host 首次启动时把内嵌的运行时归档解压到 `~/.dsh/runtime/<sha256>`；归档内容相同时复用该目录。`coding` 启动器从固定的 `~/.dsh` 查找 Host，单独设置 `DSH_HOME` 不会迁移客户端的发现目录。

## 本地 Host 与数据

客户端通过各自 Host 数据目录中的 `host.json` 查找仅监听本机回环地址的 Host。不要把 `~/.dsh` 当作可随意清理的构建缓存：它包含会话、设置和凭据。macOS 桌面应用的 Electron 浏览器数据位于单独的 `~/.dsh-electron-user-data`。
