# coding-git

宿主读取本机仓库并执行远端操作的能力 seam（`ctx.git`），本包是它的 Service Definition。一个上下文只装载一个实现，实现既可以是驱动的本机 `git` 可执行文件（[`-local`](../git-local/README.md)），也可以是内置的纯 JavaScript 实现。

能力报告是异步的 `capability()`：探测本机可执行文件需要一次命令，因此实现返回 `{ mechanism: 'cli' | 'js', operations }`，消费方按 `operations` 决定展示哪些入口，而不是先调用再失败。没有安装 `git` 时克隆仍然可用，仓库状态、分支、历史与推送需要完整实现，未支持的操作以 `GIT_UNAVAILABLE` 明确失败。

失败统一为 `GitOperationError`，`code` 是契约的一部分：`GIT_UNAVAILABLE`（没有实现或机制不支持）、`GIT_NO_REPOSITORY`、`GIT_REMOTE_UNAVAILABLE`、`GIT_CONFLICT`、`GIT_BRANCH_NOT_FOUND`、`GIT_AUTH_REQUIRED`／`GIT_AUTH_FAILED`、`GIT_CREDENTIALS_UNAVAILABLE`、`GIT_TARGET_EXISTS`。带 `credentialRef` 的认证失败表示本机已存的那组凭据被远端拒绝，界面据此提示并允许清除它。

远端与克隆操作的凭据来源由 `GitRemoteOptions` 固定成三级顺序：宿主配置的凭据助手、本机凭据存储，最后才是调用方显式提供的凭据。显式凭据一旦提供就独占本次认证，因为它来自上一轮前两级都失败的弹窗。凭据只在不透明字符串的层面对存储可见：引用名由远端主机派生（`GIT_CREDENTIAL_<HOST>`），值是连主机名一起保存的 JSON，读取时复核主机名，所以归一化冲突不会把一组凭据交给另一个主机。

## 模型体验

无。本 seam 服务于宿主的仓库操作与创建面板；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **单元能力由实现决定**：seam 只声明操作集合，`operations` 是运行时事实。内置实现当前只承诺克隆，其余操作在未安装 `git` 的机器上直接报告不可用，而不是提供降级结果。
