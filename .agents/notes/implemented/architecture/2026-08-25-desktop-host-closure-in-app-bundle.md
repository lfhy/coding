# Agent Note: 桌面 Host 闭包随应用包预展开发布

Status: implemented

## Problem

macOS 桌面应用原先启动 Node SEA 引导器，其首次运行会把生产 Host 闭包解压到 `$DSH_HOME/runtime/<sha256>`。桌面包本身已有签名后的只读资源树，因此这份复制会让新安装在 Host 开始正常的 Node 与插件初始化之前额外等待。

## Decision

`scripts/build-coding-runtime.ts` 只部署一次生产闭包，拒绝残留符号链接，并产出原始 Node 可执行文件 `dist/coding-runtime/coding-node-<target>` 与 `dist/coding-runtime/runtime`。`scripts/package-macos-app.sh` 把它们分别放到 `Coding.app/Contents/Resources/coding-host` 和 `Coding.app/Contents/Resources/runtime`，并把构建元数据放在同级。

legacy pnpm deploy 完成后，打包流程会先按锁文件恢复完整工作区依赖。虽然包内容写入暂存目录，legacy deploy 仍会把仅生产依赖和 hoisted 布局设置写入源码工作区的 `node_modules` 元数据；恢复操作可防止后续 `pnpm run` 用仅生产依赖安装替换开发依赖。部署或恢复失败都会停止构建，两者同时失败时会报告两个原因。

`apps/internal/hostlaunch` 使用 `runtime/node_modules/@deepseek-ai/dsh/lib/bin.js web --coding-host` 作为已打包 Node 可执行文件的参数启动 Host。闭包在应用包中保持只读；`$DSH_HOME` 保留会话、设置、凭据、插件、发现记录和其他可变用户数据。Linux 终端继续使用[SEA 运行时目录决策](2026-08-22-sea-runtime-directory-by-content-hash.md)中的内容哈希物化策略。

## Alternatives considered

**继续在 `$DSH_HOME` 物化桌面 SEA。** 拒绝，因为签名后的应用包可以直接携带首次桌面启动原本会复制的闭包。

**用符号链接或硬链接把 `$DSH_HOME/runtime` 指向应用包。** 拒绝，因为移动或替换应用会留下陈旧链接，硬链接要求共享文件系统，而且桌面启动器可直接推导资源路径，无需任一间接层。

**直接从 SEA 资源加载闭包。** 拒绝，因为普通 Node 解析和原生侧车需要真实文件。预展开应用包提供这些路径，无需解压到用户主目录。

**把此构建切换到 pnpm 的 shared-lockfile deploy。** 该隔离实现不会修改源码工作区元数据，但当前锁文件的 `autoInstallPeers` 设置与闭包策略冲突，注入后的工作区 postinstall 还会获得不同的 `allowBuilds` 身份。改变这些包管理器约定会改动部署闭包，并非只修复工作区状态。

## Consequences

macOS 应用会因包含展开后的闭包而变大，但桌面冷启动不会解压 Host 文件或修改 `$DSH_HOME`。runtime 构建成功后，源码工作区会保留完整开发依赖和默认 `node_modules` 布局。部署、依赖状态恢复、直接 Node 可执行文件、入口模块或元数据缺失时打包会失败，已打包入口缺失时启动器会明确失败。每个新 Host 进程仍会进行正常的 Node、Web Host 和客户端插件初始化。

## Testing

`scripts/build-coding-runtime.spec.ts` 锁定了部署成功或失败后的恢复、恢复失败，以及部署与恢复同时失败时保留两个原因。`apps/internal/hostlaunch` 测试直接打包命令及其入口缺失错误。`scripts/check-runtime-start.sh` 在干净的 `DSH_HOME` 中以生成的原始 Node 可执行文件和生成的闭包启动，macOS 打包脚本会在签名应用前验证所需构建产物。`build:runtime` 后接 `build:remote-agent` 的发布顺序会用真实 pnpm 状态覆盖恢复行为，因为后者通过仅开发依赖的 `tsx` 二进制文件启动。
