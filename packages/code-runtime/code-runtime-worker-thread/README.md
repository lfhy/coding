# @deepseek-ai/dsh-code-runtime-worker-thread

这是 [`@deepseek-ai/dsh-code-runtime`](../code-runtime/README.md) seam 的 worker 线程实现。对于普通 Workspace，`WorkerThreadCodeRuntime` 会在每次运行中使用一个全新的 Node `worker_threads.Worker`，输入 TypeScript，由宿主侧剥离类型，通过消息端口桥接 binding，输出 `{ value, logs, error? }`。当 `CodeRunRequest.cwd` 解析为存活的 Remote-SSH marker 时，它会改为驱动远程 Go agent 的一个全新受限 re-exec 子进程；该子进程使用 esbuild/Goja 转换并执行程序，同时在本地 Node Host 上执行每个 binding。**这是隔离措施，而非安全边界**：其信任立场有意与 bash 等价（参见 Code Mode 设计记录 的 Trust posture 章节），但提供本地 worker 有、bash 没有的隔离：独立 isolate、空环境、堆上限与强制终止。

## 配置

```yaml
- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-worker-thread'
  config:
    computeMs: 60000              # busy-time budget (measured event-loop active time)
    maxWallMs: 600000             # wall-clock ceiling; never pauses for anything
    maxOutputBytes: 67108864      # combined serialized outer-output cap (64 MiB)
    maxOldGenerationSizeMb: 512   # local worker heap cap; remote child memory cap (1-2048 MiB)
```

每个字段都会验证并提供默认值；`maxOutputBytes` 必须是至少 4 字节的安全整数，`maxOldGenerationSizeMb` 必须是 1 到 2048 MiB（2 GiB）之间的安全整数，其余字段必须是有限正数，`maxWallMs` 还必须不超过 `2147483647`（Node 的 `setTimeout` 最大延迟），此外没有其他可调项。远端 Go agent 会在 HTTP 与 isolate 边界执行同一个 2 GiB 字节上限。

## 设计

- **每次本地运行使用一个全新 worker，不设池化**：本地程序所在的世界会随 worker 一同终止，不会留下需要记录的跨运行状态，也无法发生状态泄漏；仅凭会话日志即可重建运行。
- **远程 marker 运行使用受限 Goja 子进程**：父 Go agent 会为每个经 esbuild 转换的 TypeScript 程序启动一个 re-exec 子进程，并赋予由本地 Host 的 `maxOldGenerationSizeMb` 设置换算出的字节上限（上限为 2 GiB）。子进程只拥有程序 runner 和带帧事件通道，不拥有 HTTP listener 或保留的 session 状态，因此 OOM 或被强制结束只会终止当前运行，不会带走 agent。父进程会轮询有序的工具调用、日志和终态事件。工具调用会回到本地 binding 函数，因此 Code Mode 的审批、调度和持久子分派日志仍留在 Host；reply 只携带无损 JSON。Host 还会发送 `computeMs`（向上取整为整毫秒，并限制为 agent 的十分钟上限）；子进程只统计 Goja 实际执行程序和 continuation 的时间，不统计等待本地 binding reply 的时间，并会以 `timeout` 中断热循环。start、polling 和 reply 操作都会复核 marker，因此重新绑定会让旧 session 失败，而不是控制新连接。start 已被接受并发布后，任何 marker、next 或 reply 失败、取消或拆卸都只能使用记录的 owner 尽力取消旧 session；它绝不会选择重新绑定后的连接，也不会运行 start、polling 或 reply。agent 会保留已完成的 session 两分钟，供终态 polling 重试，并且最多接纳八个活动或保留中的 session（超出的 start 返回 `code-session-limit`）；单次 polling 中断不会终止程序。远程运行使用 `maxWallMs` 与 agent 十分钟上限中较小的值。
- **在本地执行上下文中，由宿主侧剥离类型**：本地程序会包裹在异步函数外壳中，通过 `node:module` 的 `stripTypeScriptTypes` 剥离类型（只支持可擦除语法；`enum`／namespace 会作为程序 `exception` 被拒绝，且不会启动 worker），再按字节位置切回原内容。之后程序作为 `AsyncFunction` 的函数体执行，因此顶层 `await`／`return` 可用。
- **端口把对端视为不可信**：模型代码能够访问 `parentPort` 并伪造通信，因此任何代码读取入站消息前，系统都会验证其形状并重新构建（`null`、原始值、无效类型和格式错误的载荷会被静默丢弃；伪造的额外字段绝不会被带入）；宿主对每个调用 id 最多响应一次，只将绑定名称解析为自有属性（伪造的 `constructor` 无法沿原型链访问），丢弃结算后的回复，并验证每个绑定 resolve 值与完成值是否为无损 JSON。伪造的 `log`／`done` 消息无法绕过外层上限：宿主会再次验证，并统计每条获准日志以及完成值或诊断。worker 侧命名空间使用 null-prototype 和 `defineProperty`，因此形似 `__proto__` 的绑定名称只是普通键。
- **绑定调用被拒绝时使用的异常类属于请求数据**：可选命名空间描述符会指定构造器全局变量，以及用于接收调用失败的成员名称的自有属性。worker 会创建并注入该真实类，使 `instanceof` 生效，同时无需硬编码 `tools` 或 `ToolCallError`；全局变量无效或冲突的声明会在启动 worker 前失败。失败路径使用模块捕获的错误 intrinsic 与属性定义 intrinsic，以及 null-prototype 描述符，因此模型之后的修改无法把被拒绝的绑定变成 worker 崩溃。
- **两个独立预算，因为对端不可信**：`computeMs` 统计本地 worker 实际测得的忙碌时间（轮询 `worker.performance.eventLoopUtilization()`）；热循环无法借助待完成的诱饵 dispatch 隐藏，程序等待慢工具时则不累计。远程 Goja 会收到相同预算，并且仅在运行 JavaScript 或 promise continuation 时启动计时器，因此本地 binding 的等待不会消耗它。`maxWallMs` 为忙碌时间无法观测的情况兜底（例如等待永远不会 resolve 的 promise）。本地限制最终调用 `worker.terminate()`，远程活动片段计时器则中断 Goja；堆溢出会表现为本地 worker 或隔离子进程退出（`kind: 'worker-exit'`）。`maxWallMs` 在加载时会对照 `MAX_TIMER_DELAY_MS` 做范围校验：`setTimeout` 会把更长的延迟限制为 1 ms，仅有正数校验会放行一个在第一个 tick 就到期的上限。`computeMs` 不需要本地的这道上界，因为它对照的是实测占用率，而不是喂给定时器。
- **中间绑定值是完整 JSON**：绑定参数与 resolve 值会接受迭代式无损 JSON 验证。程序执行前，worker 会捕获自己 realm 中的普通容器原型身份，以及只用于外部 realm 的原生函数源码检查，因此构造器槽修改和用户编写的仿冒对象都无法改变容器分类。它还会捕获该 JSON 边界使用的每一个结构与计量 intrinsic，以无原型对象创建属性描述符，并绕过可变集合原型管理私有遍历状态；因此，模型对全局对象、原型方法或 `Object.prototype` 上形似描述符字段的修改，都无法改变验证、wire 传输或字节计量。值会展平为自身嵌套深度有界的前序 wire 值，供 structured clone 使用，并在另一侧迭代式重建。它们没有字节、JavaScript 调用栈或嵌套 structured-clone 深度上限，绝不会进入外层输出账本或模型上下文；上限仍来自提供方／执行器获取限制与进程／worker 内存。
- **日志主动流入一个外层账本**：console／stdout／stderr 文本按产生顺序经端口传输，因此超时或被终止的程序仍会显示已经打印的内容。worker 会精确统计 JSON 字符串的字节数，并在发送完成值和异常诊断前，根据组合预算的剩余量预检；因此，抛出的百万字节 stack 会在 worker 边界变成固定的 `output-limit` 诊断。绕过补丁 stream 槽的原生写入会到达独立于完成端口的 pipe，因此宿主会针对这些字节和不可信伪造通信再次执行账本统计；在物化结果前，结算过程会持续进行有界 pipe 捕获，直到 worker 完成终止。`maxOutputBytes` 统计外层 `logs` 数组加完成值或失败消息载荷的 JSON 序列化；固定的 `CodeRunResult` 字段名、花括号、有界错误 kind 标签，以及后续呈现空白不计入这份可变载荷账本。未超过上限时会返回精确值；有损完成值属于 `invalid-output`，组合溢出属于 `output-limit`，不会用 inspected string 代替。失败会保留能容纳的已捕获前缀，之后按普通外层 `run_code` 落盘策略处理。
- **本地 worker 的空环境**：worker 使用 `env: {}` 和 `execArgv: []`，既不会获得环境变量中的凭据（比 spawn 命令的清理环境规则更严格），也不会继承 loader 标志。远程 Goja 子进程只公开已声明的 binding namespace，不公开 Node 全局变量、`process`、`require`、`fetch`、文件系统 API 或 Host 环境。
- **dispose（资源释放）时等待完全停稳**：清理会使进行中的本地运行以 `abort` 失败，并会等待每个 worker 退出；它也会取消并等待每个已启动的远程 session。

## 未构建与已构建的 worker 入口

源代码模式通过 Node 原生类型剥离加载只包含可擦除语法的 `src/worker.ts`。其传递运行时闭包只包含 Node 内置模块和相对源模块，因此全新 checkout 绝不需要兄弟工作区包尚未构建的 `lib/` 导出。worker 本地和会话自有的 JSON 边界都会在消息端口两侧展平并重建已验证值，使应用嵌套永远不会进入 structured clone。构建模式会把兄弟文件 `lib/worker.cjs` 作为文件系统路径传入，因为 pkg 的虚拟文件系统（VFS）Worker hook 要求 CommonJS；同一路径也可在普通 Node 下使用。对这个已发布入口路径进行测试的仓库级要求由[测试策略](../../../docs/testing.md)规定。

SDK 对外提供默认及具名导出的 `WorkerThreadCodeRuntime` 类，以及 `Config`。运行所用的 `./worker` 子路径仅作为打包后的 spawn 入口存在；wire 协议与启动辅助模块是源代码私有的实现细节。

## 模型体验

通过 [`dsh-tools`](../../core/tools/README.md) 中的 Code Mode 间接提供；如果外层值能容纳则原样渲染，否则返回明确的 `invalid-output`／`output-limit` 失败。只有外层 `run_code` 结果进入模型上下文并使用普通落盘策略；绑定通信与中间值始终只存在于执行环境中。

#### KV Cache 影响

不会直接失效；由上述消费方负责请求前缀变更。

## 已知限制与暂缓事项

- **本地 worker 派生的 OS 进程在程序终止后仍会存活**：`worker.terminate()` 只结束线程，比 bash-local 的进程组终止更弱；在容器后端出现前，孤儿进程清理属于部署职责。
- **本地类型剥离依赖 Node 的实验性 `stripTypeScriptTypes` API**：如依赖的行为发生变化，amaro 或 sucrase 是已经点名的直接替代品。
- **远程 Goja 不是 Node 兼容层**：经 marker 路由的程序没有 Node 全局变量、内建模块、原生 addon 或进程内 Host 状态；其受限子进程只拥有 TypeScript 转换、console shim 和声明的异步 binding。
- **本地 worker 的 `computeMs` 到期最多可能超过一个轮询间隔**：系统每 25 ms 采样一次忙碌时间（内部常量，有意不做成配置）。
- **远程 Goja 的活动片段计时器在调度延迟时可能晚于目标触发**：超出预算的完成值仍会被作为 `timeout` 拒绝，而不会发布。
- **程序获得一个含 5 个方法的 `console` shim**（`log`／`info`／`warn`／`error`／`debug`）：有意不提供 Node 的完整 console 接口。
- **中间绑定值没有字节上限**：程序可以用永远不会成为外层输出的值耗尽进程或 worker 内存。
- **默认 64 MiB 是拒绝边界，不是可恢复存储**：外层落盘只能保存发生 `output-limit` 后返回的有界日志和诊断；在运行时上限之外被拒绝的字节永远不会到达落盘层。
