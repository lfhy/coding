# @deepseek-ai/dsh-subprocess-local


[`@deepseek-ai/dsh-subprocess`](../subprocess/README.md) seam 的 Service Provider。`LocalSubprocessRuntime` 对普通本地工作解析本地可执行文件，以显式 stdio spawn detached 进程树，并通过 `node-pty` 加平台进程检查实现终端进程。在 Windows 上，非终端子进程会隐藏其控制台窗口，因此后台命令不会抢占焦点。对于已验证的桌面 Remote-SSH marker，`agent` 和 `basic` 模式都将进程与 PTY 请求转发给远端 bridge；`basic` 由直接 SSH 后端承接。该实现没有任何配置：每项处置方式、限制、终端尺寸、宽限期与目录都来自调用方能力 seam（[`dsh-bash-local`](../../shell/bash-local/README.md)、[`dsh-lsp-stdio`](../../lsp/lsp-stdio/README.md) 和 [`dsh-terminal-bash`](../../terminal/terminal-bash/README.md)）。

## 行为

- **本地普通进程树**：在本地 Host 上，POSIX 子进程使用 `detached` spawn（拥有独立进程组），信号以负 pgid 发送并以直接子进程作为回退；本地 Windows 通过 `taskkill /PID <pid> /T /F` 终止进程树。`terminate()`（句柄唯一的终止操作）先发送 SIGTERM，经过 spec 的宽限期后再发送 SIGKILL（沿用 OpenCode 的升级策略；流水线与子 shell 会随父进程一起结束），进程树消亡后为空操作；`waitForExit()` 轮询整棵进程树的存活状态，使消费方的拆卸能确认真正的完全停稳。组长进程退出后，仍然打开的管道也只获得同样有界的排空宽限期，因此存活的后代进程无法无限期地拖住结果不结算。系统会容忍 ESRCH；重新指定父进程并脱离该组的 daemon 仍可能存活。
- **按流划分的处置方式**：`'pipe'` 把原始流原样交给调用方（协议分帧仍归消费方所有）；`'inherit'` 直通父进程的描述符；收集模式（collect）在输出超过上限后于内存中保留尾部（错误与结果通常聚集在末尾，沿用 pi/OpenCode 的理由），并在配置了 spill 上限时把完整流追加到一个私有临时文件；省略 `spill` 则只保留用于诊断的尾部。某条流大于 spill 上限时，会丢弃已不完整的 spill，仅返回带截断标记的尾部；spill 文件描述符在结算时封存，最终关闭失败时则不公布路径，以免声称存在不完整的文件。spill 文件权限为 `0600`、名称随机，位于按需创建、权限为 `0700` 的每进程目录之下。
- **凭据清除 + 显式合并**：以 `process.env` 为基础，移除形似凭据的变量（`*KEY*`／`*PASSWORD*`／`*SECRET*`／`*TOKEN*`）和所有环境中已有的 `DSH_*` 名称；spec 的显式 `env` 在该清除之后合并且不做命名空间校验，因此有意提供的凭据或当前 `DSH_*` 事实会胜出，而陈旧的嵌套 harness 身份无法从环境中隐式漏入。提供的 stdin 会被写入后关闭；否则 fd 0 指向 `/dev/null`。参见 stdin/env 设计记录与受管环境 设计记录。
- **基于偏移量的读取**：收集模式的读取器按完整流的字节坐标返回增量；服务自身从不持有游标，因此消费方自有的游标（bash 的后台读取路径）与完整流重读可以共存，结算前后皆然。远程收集流会在 Host 中保留请求的尾部，较早偏移已离开该窗口时报告 `lossy`；绝不把 agent 上的路径暴露为本地 spill 路径。
- **可执行文件查找**：`resolveExecutable` 检查绝对文件，或根据平台可执行文件扩展名在清理后的有效 PATH 中搜索；含分隔符的相对路径在该 seam 处被拒绝，相对 PATH 条目从对应执行世界的 cwd 解析。已验证的 marker target 会经 bridge 在远端查找，而不是查询 Host PATH。
- **远端 marker 转发**：可执行文件查找、受管 spawn、终端分配和普通句柄操作会在使用目标远端后端前复核 marker target。普通 pipe 流、收集读取器、进程句柄和 PTY 句柄仍保持 seam 既有形状；marker 过期、bridge 不可用或远端失败都会快速失败，绝不启动本地替代项。所选远程根目录只是请求解析时的执行坐标，不是 OS 沙箱：它不能防御目标侧并发替换已检查的符号链接或祖先目录。进程或终端已发布后，清理可在 marker 丢失时仅使用记录的原连接尝试终止该旧句柄；它绝不会选择或控制重新绑定后的连接。
- **基础远端进程与终端**：`basic` marker 的 `resolveExecutable`、`spawn` 和 `spawnTerminal` 经同一远端 bridge 到达直接 SSH 后端，绝不回退到 Host 本地进程。SSH 不能证明前台进程组，也不能确认信号已抵达或整个进程树已终止：PTY 的 `inspectForeground()`、`signalForeground()` 和 `terminate()` 可能以 bridge 的 501／503 分类错误拒绝，不能把这些错误当作已完成的前台控制或树清理。后台进程的 `terminate()` 为同步触发，后续 `done`／`waitForExit()` 可能因无法证明树终止而拒绝；调用方不能将其视为可靠的树终止保证。
- **终端进程所有权**：在本地 Host 上，`spawnTerminal` 分配 `node-pty`，桥接 UTF-8 终端文本，并把经过统一边界校验的动态列／行直接提交给 PTY；本地 POSIX 与本地 Windows 都使用这一路径。它还检查当前前台进程组并向其发送信号，通过一项须等待的终止操作在终止顶层 shell 前后清理后代进程。Linux 只有在等待线程自身的 fd 0 指向 shell 的控制终端时才报告精确输入等待，`/dev/tty` 别名也包含在内，因此阻塞在 `pipe:[…]` 上的流水线读取器无法发布终端就绪。若用户态模拟使用了不同于运行时架构的内核 ABI，syscall 探针会匹配每一种受支持的内核 ABI。每次前台检查都会保留根进程树中的精确身份；Linux 还会在 POSIX 会话 leader 退出后枚举该会话。因此，之前观察到的 macOS 后代以及同会话 Linux 成员在重新设定父进程后仍受围栏保护，pid/start 身份则防止清理跟随 PID 复用。在本地 Windows 上，基于 koffi 的检查器通过 Toolhelp32 枚举进程表，把 GetProcessTimes 启动身份与进程句柄零时等待结合起来判断存活状态，并把 shell pid 作为伪前台进程组（Windows 没有 POSIX 进程组）。拆卸会验证 shell 已终止，因为被外部 taskkill 的 shell 可能永远不会触发 node-pty 的退出通知。对于 `agent` 模式的 Remote-SSH，Go agent 拥有 PTY：普通 resize RPC 会复核 marker 和所捕获的执行 owner，再由 Unix PTY 或 Windows ConPTY 应用尺寸；Windows 后端使用 Job Object，将根 shell PID 发布为兼容性的前台控制身份，以 ETX 实现 `SIGINT`，将 `SIGTERM` 映射为 Job Object 终止，并拒绝通过前台控制向根进程发送 `SIGKILL`；`terminate()` 负责进程树清理。上层 PTY 后端负责提示符就绪、缓冲区与面向模型的操作。
- **先终止再等待退出的 dispose（资源释放）**：服务保留存活句柄，使自身的 dispose 能对每个仍在运行的进程树执行升级并等待其退出；完全停稳与 spawn 失败的句柄会在整棵进程树或 terminal session 清理完成后离开存活集合。
- **同步宿主退出最终清理**：服务 effect 仍有效时，Node `exit` listener 会强制终止同一组存活集合中仍存在的每棵普通进程树和可观察 terminal session。对于本地句柄，它会向受管 POSIX 进程组发送 SIGKILL、在 Windows 运行 `taskkill /T /F`，并在终止 PTY root 前后同步向已捕获及当前可观察的 terminal 身份发送信号。对于已发布的远端句柄，它只会经记录的连接尽力发出请求，无法等待投递。这些路径不会创建 Promise 或 timer，不改变宿主退出码与诊断，会分别包含每个目标的失败，也不会声称已经完全停稳。正常 dispose 仍使用上面的须等待温和路径。参见宿主退出清理决策。

## 模型体验

间接地，通过 `dsh-tool-bash` 背后的 bash 执行器家族等 Consumer 影响模型；进程输出与生命周期面向模型的全部渲染归 Consumer 所有。

#### KV 缓存影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延后工作

- **本地 Windows 进程树支持仅为尽力而为**：本地终止经由 `taskkill /PID <pid> /T /F` 完成，所有结果都被就地吸收，不向外抛出（进程树已不存在、竞态、二进制缺失），存活探测则回退到直接子进程边界。
- **本地 Windows 终端信号是控制台级的**：本地 SIGINT 以 `\x03` Ctrl-C 输入写入投递，由 conhost 转为控制台级 CTRL_C 事件；SIGTSTP 与 SIGHUP 被拒绝（不可用）；不带 `/F` 的 `taskkill` 无法终止控制台进程，因此本地拆卸的 TERM 档是 `/F` 升级前的宽限等待。本地 Windows 就绪没有精确的 stdin-wait 档：prompt-marker 快路径把 shell pid 作为伪前台进程组比较，其余由静默／计时档覆盖。
- **远端 Windows 终端控制采用提供方原生语义**：Go agent 的 ConPTY + Job Object 后端不公开 POSIX 进程组。`SIGINT` 写入 ETX，`SIGTERM` 终止 Job Object，`SIGTSTP` 与 `SIGHUP` 不可用，向根 shell 发出的前台 `SIGKILL` 会被拒绝；请使用终端句柄的 `terminate()` 清理进程树。
- **守护化的终端后代仍可能逃出可观察边界**：在 macOS 上，子进程如果在任何前台检查快照之前重新设定父进程，将无法再从 `node-pty` 根进程发现；在 Linux 上，调用 `setsid` 的子进程会同时离开进程树与自有终端会话。本地提供方不会新增持续进程表监视器。
- **进程内清理要求退出阶段仍能执行 JavaScript**：直接 `process.exit()`、默认未捕获异常和默认未处理 rejection 会发出 Node 同步 `exit` 事件。未安装 handler 时，`SIGTERM`、`SIGINT` 或 `SIGHUP` 的默认 OS 处置不会发出该事件；应用只有安装执行正常 dispose 或调用 `process.exit()` 的 handler 才能覆盖这些信号。`SIGKILL`、fatal OOM、`process.abort()`、native crash、断电，以及任何无法运行 JavaScript 的故障，都需要外部 supervisor、容器 init 或等价的 OS 所有者负责。
- **凭据清除依赖名称启发式规则**：只匹配 `*KEY*`／`*PASSWORD*`／`*SECRET*`／`*TOKEN*`；名称不同的 secret（例如 `*PASSPHRASE*`）会继续传递，对误删变量引入白名单属于已记录的后续工作。
- **不会删除已完成的 spill 文件**：有界的完整输出恢复文件（以及每个进程的私有 spill 目录）会在 OS tmpdir 下累积，直到外部机制进行清理；超大的不完整 spill 会被丢弃并立即尝试删除，但清理失败可能留下一个有界文件。
- **远端输出没有 Host 可读的 spill 文件**：远程收集只在 Host 保留经配置限制的尾部；读取器从保留窗口之前开始时会得到 `lossy: true`，但没有 spill 路径。

原始进程处理位于 `src/spawn.ts`；`src/index.ts` 负责服务接线。
