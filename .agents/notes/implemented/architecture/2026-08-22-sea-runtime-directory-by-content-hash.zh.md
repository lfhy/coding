# Agent Note: SEA 运行时目录按内容哈希命名

Status: implemented

[English](2026-08-22-sea-runtime-directory-by-content-hash.md) | 中文

## Problem

Coding 的 SEA 引导器把 Host 闭包物化到 `$DSH_HOME/runtime/<version>`，并把匹配的产品版本与归档 SHA-256 视为命中。原生启动器仍用产品版本发布 `host.json` 和 `DSH_APP_VERSION`，因此该标签仍是在线兼容性键。磁盘目录却只是归档字节的缓存。后续产品版本若携带同一闭包仍会再次解压，因此重新构建或改标签的桌面应用即使 Host 文件未变，也要再付一次首次运行的拷贝成本。

## Decision

`scripts/sea/bootstrap.cjs` 把物化目录命名为 `$DSH_HOME/runtime/<sha256>`。命中只要求 marker 的 `sha256` 与内嵌归档一致，且 `node_modules/@deepseek-ai/dsh/lib/bin.js` 存在。产品版本仍写在 marker 中，并继续拥有 `DSH_APP_VERSION` 和 Host 就绪记录。当前 Host 拥有 `host.json` 后，清理会删除名称不是当前归档哈希的所有运行时兄弟目录。`scripts/build-coding-runtime.ts` 在完整构建未产出 `apps/cli/lib/bin.js` 时于 deploy 前失败，在暂存闭包缺少 `node_modules/@deepseek-ai/dsh/lib/bin.js` 时于 deploy 后失败；host tsdown workspace 入口包含 `lib/types/bin.js`，因此构建出的 bin 会随闭包发布。

## Alternatives considered

**保留按版本命名的目录，只在命中检查中忽略版本。** 拒绝，因为共享字节的两个产品版本仍会占用两个目录，直到其中一个 Host 启动并清理另一个。

**不落盘，直接从 SEA 资源加载模块。** 拒绝，因为原生侧车和普通 Node 模块解析仍需要磁盘文件。

## Consequences

后续产品版本若携带相同归档字节，会从已有运行时目录启动。不同的归档哈希仍会解压一次到新目录。Host 发现继续比较产品版本，因此另一个产品版本的在线 Host 即使重启后会共享缓存目录，当前仍视为不兼容。
