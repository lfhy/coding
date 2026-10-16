# 来源与许可

本包的 macOS 能力（`src/` 下的服务、提供方与工具语义，以及 `native/macos/` 与 `scripts/` 的 Swift helper 源码与构建脚本）移植自
[MIT 许可](LICENSE)的 [`Anionex/dsh-computer-use`](https://github.com/Anionex/dsh-computer-use)（Copyright (c) 2026 anionex），并按本仓库的包约定改造：
拆成宿主层的服务提供方与 agent 预设层的工具消费方两个包、接入 `ctx.computerUse`、
去掉其 Web 设置面板与诊断路由、服务方法改为中文 JSDoc、托管 helper 允许按仓库内源码重建。
上游原样保留的部分继续适用其 MIT 条款，见同目录的 `LICENSE`。

`src/providers/cua-driver.ts` 的驱动调用形状与坐标语义参考同样 MIT 许可的
[`988hj7tczd-oss/dsh-computer-use`](https://github.com/988hj7tczd-oss/dsh-computer-use)，
底层引擎是 [trycua/cua 的 cua-driver](https://github.com/trycua/cua)（MIT）。
