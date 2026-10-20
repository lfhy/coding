# Host 启动器

`hostlaunch` 为桌面 helper 和 TUI 发现、核验和启动本地 Coding Host。`Options.Home` 指定发现记录与启动锁所在目录；命令、版本、工作目录、附加环境和启动超时由 `Options` 配置。`DSH_HOME`、`DSH_CWD`、`DSH_APP_VERSION` 由启动器覆盖，调用方环境不能替换它们。

## 子进程所有权

`Ensure(ctx)` 在跨进程启动锁内发现或启动 Host；只有实际启动且就绪记录的 PID 与原 child 一致、健康探针通过时，才返回 `Endpoint.Started=true`。启动失败、超时或取消会强停原 child，并最多额外等待 2 秒完成回收；每个 child 只有一个 `Cmd.Wait`，stdout 在就绪后仍持续被读取。`OnProgress` 在 stdout 读取过程中同步调用，必须及时返回。

需要 Host 与客户端共同退出的调用方应保留同一 `Launcher` 与原始 `Endpoint`，退出时调用 `StopOwned(ctx, endpoint)`。附着的 `Started=false` Endpoint 是空操作；其他 Launcher 创建或被改写的 Endpoint 返回 `ErrHostNotOwned`。首次停止信号前，磁盘记录和健康响应必须仍与原 Endpoint 的身份一致，否则返回 `ErrHostIdentityChanged`，不向任何记录里的 PID 发信号。

Unix 先向原始进程发 SIGTERM，给予 6 秒正常退出时间，再强停同一原始进程；Windows 使用原始进程句柄直接停止。首次信号后 Host 可以删除发现记录或关闭健康端点，后续强停仍只使用原始进程。Darwin 在实际回收 child 前先观察系统退出事件并封闭信号入口，避免 PID 复用导致后继进程被误停。

`StopOwned` 可重复或并发调用，已退出并回收的 child 返回成功。等待受调用方取消或截止时间约束，并有 10 秒内部上限；超时返回相应 context 错误，不代表进程已经退出。调用方应给足正常退出时间，不能先取消停机 context 再要求完成回收。唯一的 `Wait` 会在子进程最终退出后继续完成资源回收。
