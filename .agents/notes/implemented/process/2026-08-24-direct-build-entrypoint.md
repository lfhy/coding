# Agent Note: 构建脚本的直接入口判断

Status: implemented

## 问题

`scripts/build-coding-runtime.ts` 通过 `node --import tsx/esm` 启动 `scripts/build.ts`。运行时 deploy 复制 `lib/` 产物前，构建必须生成最新 Client bundle；否则桌面端安装包会含有源码中存在、Host 中却缺失的改动。

在本地会使用到的每个 Node 运行时里，`import.meta.main` 都不能可靠地表示这个 TypeScript 启动形式的入口。其值为假时，子进程会成功退出而不执行构建，运行时打包随即复制已有 Client 产物并报告安装成功。

## 决策

`scripts/build.ts` 将 `import.meta.url` 与经 `pathToFileURL(resolve(...))` 转换的 `process.argv[1]` 比较。仅当两个 URL 相同时执行构建。这直接使用 Node 的调用路径，并让测试和辅助调用继续能够安全导入该模块。

`scripts/build.spec.ts` 固定直接执行、导入其他路径和缺失调用路径三种情况。桌面运行时构建因此会在 SEA archive 收到文件前重新生成侧边栏 bundle。

[按内容哈希划分的 SEA 运行时目录](../architecture/2026-08-22-sea-runtime-directory-by-content-hash.md) 管理 archive 构建完成后的缓存选择；本记录管理生成该 archive 的直接构建调用。


## 考虑过的替代方案

**保留 `import.meta.main`。** 写法简短，但不可用的信号会让生产构建在没有生成当前产物时仍然成功。

**仅依赖受支持的 Node 版本范围。** 版本范围仍有价值，但本地环境落在范围外时，版本选择不能把构建变成成功的空操作。

**每次桌面端安装前单独构建侧边栏包。** 这会重复仓库构建顺序，并让其他 Client 包仍暴露在同一条陈旧产物路径上。

## 后果

构建入口保留一个明确的 ESM 判断和一条聚焦测试。`make install` 仍使用完整 Client 构建，打包后的 Host 反映源码树，而非旧的 `lib/` 目录。
