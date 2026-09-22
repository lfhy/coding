# Coding Host Runtime

这份仅用于部署的 manifest 定义了 Coding 客户端随附的 Node Host 闭包。它不是面向最终用户的包；[`scripts/build-coding-runtime.ts`](../../scripts/build-coding-runtime.ts) 会构建 CLI 和 Web 产物，部署不含符号链接的闭包，并生成 macOS 的预展开 `Coding.app/Contents/Resources/runtime` 载荷以及 Linux 终端启动器使用的 SEA archive。
