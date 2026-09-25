# @deepseek-ai/dsh-bash-local

`@deepseek-ai/dsh-shell` 执行器 seam 的 Service Provider。本地与 Remote-SSH agent 模式通过 [`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.md) 把 `bash -c <command>` 作为受管进程 spawn；Remote-SSH basic 模式的前台命令通过 bridge 发起一次 `/v1/exec`，后台命令通过 bridge 的受管进程接口运行。执行器负责命令默认值、超时和取消分类、终端环境，以及后台读取时的 stdout/stderr 合并。spill 文件、凭据清除、kill 升级和 dispose（资源释放）是受管 subprocess 路径的机制。

包根目录导出默认与具名的 `LocalBashExecutor` 插件及其 `Config`。

## 配置

```yaml
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: /path/to/workspace   # default: process.cwd()
    timeoutMs: 120000          # default foreground timeout
    maxTimeoutMs: 600000       # cap for per-call overrides
    maxOutputBytes: 64000      # per-stream in-memory cap; overflow spills to disk
    maxSpillBytes: 67108864    # per-stream full-output spill cap
    graceMs: 3000              # kill escalation and post-exit pipe-drain grace
```

## 行为

- **不保留 shell 状态**：每次调用都执行一条新的非登录 `bash -c`，且不读取 rc 文件。
- **组装条目是一层，而不是最终值**：当组装中存在 settings 提供方时，本执行器以上面的条目为 base 注册该能力的 [`bash` 命名空间](../shell/README.md)，因此 `settings.yaml` 中的用户段会叠加其上，下一条命令即按新预算运行。schema 无法判定的值（正有限、`graceMs` 的定时器上界）会在写入时被拒绝，运行中的执行器保持它最后一份可用的段；没有提供方、或提供方脱离之后，运行的就是组装条目。
- **执行预算**：`resolve()` 从配置补全 `workdir`／`timeoutMs`／`stdoutMaxBytes`，当工作目录处于当前 marker 下时派生 Remote-SSH target。受管 subprocess 路径每次 spawn 都传入字节与 spill 上限、`graceMs`；该宽限期须为正有限值，且不得大于 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)。进程组终止、退出后管道排空、尾部保留与 spill 文件是 [`dsh-subprocess-local`](../../subprocess/subprocess-local/README.md) 的机制。前台 `ShellExecRequest.stdoutMaxBytes` 可为受信任调用方提高单次 stdout 捕获预算；stderr 和后台运行仍使用 `maxOutputBytes`。basic 还受远端每流 1 MiB 的固定上限约束。
- **超时与取消分类**：受管 subprocess 路径的 `run()` 用同一个 deadline 融合超时与调用方信号；执行器自身的超时报告 `timedOut`，上游取消报告 `aborted`，自行信号终止的命令两者皆不报告。basic 超时或取消因无法证明进程树停稳而抛错，不返回这两个布尔值。
- **适合模型的终端环境**：`NO_COLOR=1 TERM=dumb PAGER=cat GIT_PAGER=cat` 防止分页器与 ANSI 颜色破坏结果。三种执行路径均从清除 ambient 凭据与 `DSH_*` 的环境开始，显式 `env` 和受信任 `dshEnv` 依次覆盖终端默认值；basic 模式经 SSH stdin 帧发送命令与环境，不把其值编入远端 SSH exec 命令行。
- **后台进程**：`start()` 立即返回活动 `ShellProcess`，且不应用超时；`readOutput()` 把基于偏移量的 stdout/stderr 读取合并为消费式增量，stderr 置于 `[stderr]` 下。运行中的进程属于 subprocess 服务，可在执行器重载后存活，并在服务 dispose 时执行终止；basic SSH 关闭 session 后无法证明远端进程树已退出。job id、所有权、轮询和通知属于通用 [`ctx.jobs` 运行时](../../jobs/jobs/README.md)，工具层会在其中注册该句柄。
- **桌面 Remote-SSH 执行世界**：agent marker 的前台和后台 Bash 使用受管 subprocess；basic marker 的前台 Bash 通过 `/v1/exec` 返回有界输出，后台 Bash 经 subprocess 路由到 `/v1/processes/*`。两种模式均先复核 marker 身份；过期 marker 或 bridge 失败会拒绝请求，绝不在本地 Host 上运行。Host 保留审批和面向模型的渲染。basic 前台响应按配置进一步截断字节尾部，不产生本地 spill 文件。

## 模型体验

通过 `dsh-tool-bash` 间接影响；该工具会渲染此执行器有界的 stdout/stderr 尾部、后台进程增量、spill 文件路径与基础设施失败。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由具名消费方负责。

## 已知限制与暂缓事项

- **自身不提供隔离**：此执行器始终以 harness 进程的权限运行命令；需要隔离的部署可以组合 [`dsh-bash-sandbox`](../bash-sandbox/README.md)，每次调用的 allow/deny/ask 策略则属于 `tools/pre-execute`。
- **没有持久 shell 或 PTY**：每次调用都启动新的非登录 `bash -c`；仅持久化 cwd 与交互式终端会话均继续暂缓，直到真实工作流需要它们。
- **仅支持 POSIX**：`bash` 二进制已硬编码，底层服务的进程组语义也是 POSIX 的；不支持 Windows。
- **后台 provider failure 提示只交付一次**：`SubprocessHandle.done` 可能在 target 开始执行前或后 reject；句柄以 `failed` 结算，把不声明阶段的提示与未读 stderr 一起追加到恰好一个 `readOutput()` 增量。basic 连接只输出 `subprocess failed before reporting an outcome; remote process status is unknown`，不附带 bridge 错误原文；丢弃该增量后无法恢复。
- **挂载沙箱时远程 Bash 需要非受限模式**：本地沙箱提供方无法约束远程进程，因此 `dsh-bash-sandbox` 只会以 `danger-full-access` 接纳 Remote-SSH 调用。
- **basic 取消后的进程状态未知**：SSH session 关闭不保证远端进程树退出。basic 前台命令超时或请求取消时抛出含未知状态的错误，不返回声称进程已被杀死的退出事实；后台句柄发出终止请求后保持 `running` 直至 provider 结算，无法确认清理时结算为 `failed`，不能保证远端进程树已停止，也不提供本地 spill 文件。

凭据清除启发式规则与 spill 保留的注意事项随 [`dsh-subprocess-local`](../../subprocess/subprocess-local/README.md) 记录；这些机制归它所有。
