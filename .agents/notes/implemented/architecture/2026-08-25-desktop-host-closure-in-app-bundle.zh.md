# Agent Note: 桌面 Host 闭包随应用包预展开发布

Status: implemented

[English](2026-08-25-desktop-host-closure-in-app-bundle.md) | 中文

## Problem

macOS 桌面应用原先启动 Node SEA 引导器，其首次运行会把生产 Host 闭包解压到 `$DSH_HOME/runtime/<sha256>`。桌面包本身已有签名后的只读资源树，因此这份复制会让新安装在 Host 开始正常的 Node 与插件初始化之前额外等待。

## Decision

`scripts/build-coding-runtime.ts` 只部署一次生产闭包，拒绝残留符号链接，并产出原始 Node 可执行文件 `dist/coding-runtime/coding-node-<target>` 与 `dist/coding-runtime/runtime`。`scripts/package-macos-app.sh` 把它们分别放到 `Coding.app/Contents/Resources/coding-host` 和 `Coding.app/Contents/Resources/runtime`，并把构建元数据放在同级。

`apps/internal/hostlaunch` 使用 `runtime/node_modules/@deepseek-ai/dsh/lib/bin.js web --coding-host` 作为已打包 Node 可执行文件的参数启动 Host。闭包在应用包中保持只读；`$DSH_HOME` 保留会话、设置、凭据、插件、发现记录和其他可变用户数据。Linux 终端继续使用[SEA 运行时目录决策](2026-08-22-sea-runtime-directory-by-content-hash.md)中的内容哈希物化策略。

## Alternatives considered

**继续在 `$DSH_HOME` 物化桌面 SEA。** 拒绝，因为签名后的应用包可以直接携带首次桌面启动原本会复制的闭包。

**用符号链接或硬链接把 `$DSH_HOME/runtime` 指向应用包。** 拒绝，因为移动或替换应用会留下陈旧链接，硬链接要求共享文件系统，而且桌面启动器可直接推导资源路径，无需任一间接层。

**直接从 SEA 资源加载闭包。** 拒绝，因为普通 Node 解析和原生侧车需要真实文件。预展开应用包提供这些路径，无需解压到用户主目录。

## Consequences

macOS 应用会因包含展开后的闭包而变大，但桌面冷启动不会解压 Host 文件或修改 `$DSH_HOME`。直接 Node 可执行文件、入口模块或元数据缺失时打包会失败，已打包入口缺失时启动器会明确失败。每个新 Host 进程仍会进行正常的 Node、Web Host 和客户端插件初始化。

## Testing

`apps/internal/hostlaunch` 测试直接打包命令及其入口缺失错误。`scripts/check-runtime-start.sh` 在干净的 `DSH_HOME` 中以生成的原始 Node 可执行文件和生成的闭包启动，macOS 打包脚本会在签名应用前验证所需构建产物。
