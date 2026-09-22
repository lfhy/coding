# native/

与 DeepSeek Harness 一同维护的原生源码和 workspace 包。[`landlock-run/` workspace](landlock-run/README.md) 负责 harness 使用的 Landlock 自限后执行启动器，包括其架构、由三个包组成的 npm 包家族、平台支持、开发工作流和[本地打包说明](landlock-run/docs/release.md)。

## Workspace 边界

`landlock-run/` 及其包属于仓库根 pnpm workspace，并共用根锁文件。开发和 CI 中的 harness 消费方直接使用当前 workspace 的入口包，因此启动器约定变更与消费方更新可以在同一个改动中落地并一起测试。

本 fork 没有原生 CI 或发布工作流。修改启动器时在本地构建并测试匹配的平台包；后续分发决策可以加入平台自动化和发布。入口包继续将平台包声明为 npm 可选依赖，因此 npm 只会安装与用户操作系统和 CPU 匹配的包。
