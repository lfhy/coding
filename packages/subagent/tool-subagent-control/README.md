# @deepseek-ai/dsh-tool-subagent-control

可选的全局具名 `send_message`、`interrupt_agent`、`list_agents` 与 `list_subagent_models` 工具分别提供可继续子级控制、目录和子级可选模型目录。根插件只注册前两个工具；独立的 `./list-agents` 使用 `subagents` 与 `agents`，调用时还需会话存储与投影；独立的 `./list-models` 使用 `llm` 的已注册模型路由。提供方绑定的 `@deepseek-ai/dsh-tool-subagent` 每个实例仍各自注册一个委派工具，多个实例不重复注册这些全局工具。模型目录不是路由权限表：未列出的模型仍可能被适配器接受。

本工具不执行生命周期路由：驻留与冷恢复归 subagent 服务所有。它将 `exec.agent` 作为授权投递的确切在线父级传入，并把每条消息的来源记录为 `{ kind: 'coordinator', form: 'relay', senderSessionId: parent.id }`；服务会保留该来源，但绝不将其视为权限。`send_message` 始终把消息放入子级下一步骤的收件箱：如果子 agent 正在工作，消息会在下一步骤被领取，但不能打断正在执行的模型请求或工具调用；子 agent 空闲时会被唤醒。本工具会转发其执行信号，该信号只在 inbox 接受之前掌管准入；一旦接受便无法通过本工具撤回。调用结果仅确认消息已被接受，不表示子 agent 已读到消息，也不返回其回复；持久化子会话是详细输出的真源。拥有 `report` 的子 agent 会自行把内容作为一条单独的父级消息发回。投递失败会变为出错的工具结果，并明确说明消息未送达。

`interrupt_agent(agent_id)` 将 `exec.agent` 作为 `ctx.subagents.interrupt()` 的确切在线 ancestor 授权传入：目标可以是直接 child 或更深的后代，由服务——而不是本工具——依据目标 Activation 记录的 lineage 校验调用方。只有目标的当前轮次会停止（`keepInbox`）：已排队的消息保持暂停直到之后的 `send_message`，已发布的后代继续运行，child 也仍可接受后续消息。调用在停止请求被接受后立即返回，不等待目标完全停稳；目标不存在或已结算是被接受的 no-op，而 self、sibling、陈旧与非 ancestor 调用方会成为出错结果。

`list_agents` 接受一个可选的 `scope` 参数，会从调用它的 agent 推导根 id，并且不使用 cursor，将服务目录投影为可继续 child。默认的 `children` scope 读取 `ctx.subagents.listChildren()`；`descendants` 读取 `ctx.subagents.listDescendants()`，其单份语料的遍历会穿过普通会话与一次性 child，并按稳定 pre-order 以 `parent=<id> depth=<n>` 渲染保留下来的条目。`send_message` 始终把消息放到可继续直接 child 的下一步骤；`parent` 注释是持久化直接 parent 会话 id，可能指向输出中省略的普通会话。对于调用本工具的 agent，只有 depth-1 child 条目可作为 `send_message` 候选；更深的 child 条目只能作为 `interrupt_agent` 候选。状态来自在线 Agent 注册表：`running`（driver 活跃）、`idle`（驻留但处于轮次之间，可能在等待它启动的 agent）或 `ready`（仅存于存储，表示可恢复而非终态）。服务结果还包含由会话支撑的一次性 subagent，以供 UI 等消费方使用；但这些条目无法接受 `send_message`，因此会从这个模型工具中排除。diagnostic 仍然可见，并在 descendants scope 中带有位置。持久化身份和模式来自每个子 agent 的描述符，消息送达时的鉴权和 Activation 所有权检查仍归服务负责。

`list_subagent_models` 读取 `ctx.llm.listProviders()`，逐个查询 `listModels(provider)`，返回每条路由公开的模型 ID 与名称；一个提供方的目录出错时仅该行返回错误，不隐藏其他路由。无须子级身份即可读取；结果只是调用时快照，既不表示凭据已配置，也不保证后续路由不会变化。子级创建时会另行验证精确路由。

## 模型体验

### 工具 schema

#### 模型看到的内容

已生成的 [schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control)：`send_message` 只包含 `subagent_id` 与 `message`，消息会在下一步骤被领取，本次调用仅确认接受、不返回 subagent 的回答，失败即未送达；`interrupt_agent` 包含 `agent_id`；`list_agents` 包含可选的 `scope`；`list_subagent_models` 无参数，按已注册的模型路由列出 ID。

#### Token 影响

每个父级请求支付固定的 schema 成本；模型目录结果随提供方及其模型数量增长。

#### KV Cache 影响

前缀保持稳定；schema 不会在运行时改变。

### 中断结果

#### 模型看到的内容

接受时返回 `interrupt requested for agent <agent_id>`。未授权的调用方——self、sibling、陈旧或非 ancestor——会成为指明拒绝原因的出错结果；目标不存在或已结算仍渲染接受行。

#### Token 影响

每次调用产生一条简短确认消息；被中断轮次的中止只在 child 自己的 transcript 中可见。

#### KV Cache 影响

仅追加；每个结果都位于可复用请求前缀之后。

### 投递结果

#### 模型看到的内容

接受时返回 `message accepted for next-step delivery to subagent <subagent_id>`，规范输出携带被接受的 `messageId`。这只代表已入 inbox，不能保证子 agent 已读取消息。失败，包括未授权或未知的子 agent、缺少描述符而无法恢复的子 agent，或准入被拒绝，都会成为出错的结果，其消息说明该消息未送达。

#### Token 影响

每次调用产生一条简短确认消息；子 agent 的响应绝不会通过本次调用返回。单独授予的 `report` 可以把选定内容追加到父级历史中。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 模型目录结果

#### 模型看到的内容

每个已注册路由一行 `<provider> (<name>): <model-id> (<model-name>), …`；目录失败则只在该行显示 `catalog unavailable: <error>`，没有路由时返回 `(no registered model providers)`。结果不包含密钥或服务设置。

#### Token 影响

调用时按目录大小增长，后续请求仅追加结果。

#### KV Cache 影响

目录变化不改变工具 schema；结果追加在既有前缀之后。

### 列表结果

#### 模型看到的内容

按稳定目录顺序，每个可继续 child 占一行：渲染为 `<id> [<status>] — <label>`（`running` 表示 driver 活跃，`idle` 表示驻留但处于轮次之间，`ready` 表示仅存于存储；可恢复而非终态，也不表示有结果等待收集——处于该状态的直接 child 可通过 `send_message` 恢复），另为无法读取的候选项渲染 `<id> [diagnostic: <reason>]`（`corrupt`、`unsupported` 或 `unavailable`）。`descendants` scope 会在每行 label 破折号之前插入 ` parent=<id> depth=<n>`，按 pre-order 排列。一次性 child 会被有意排除；`(no subagents)` 表示投影后没有留下可继续 child 或 diagnostic。诊断信息绝不会暴露描述符内容。

#### Token 影响

随所列可继续 child 数量线性增长——`descendants` scope 下为整棵树；没有 cursor 或上限，因此长期存活且有许多持久化 child 的 parent 每次调用都会承担完整列表成本。

#### KV Cache 影响

仅追加；每个结果都位于可复用请求前缀之后。

## 已知限制与暂缓事项

- **发送无法打断当前操作**：消息在活跃轮次的下一步骤前被领取，但已经发出的模型请求或工具调用不会被撤销；轮次若在领取前结束，该消息可在后续步骤读取。
- **队列没有独立结果**：接受时只返回 inbox `messageId`；subagent 的工作落入持久化子会话，绝不会通过本工具收集。获得 `report` 的子 agent 可以单独发回选定内容，但该消息不是本次调用的结果。
- **列表是快照，而非投递承诺**：它可能与发布、dispose（资源释放）或后续消息发生竞态，另一个进程也可能激活当前进程报告为 `ready` 的 child；跨进程准确性需要共享租约。`interrupt_agent` 自己执行权威的在线 lineage 检查，因此过期的发现结果不会授予权限。
- **没有分页或删除**：系统返回完整且稳定排序的集合；只要 child 会话仍在持久化存储中，它就会继续出现在列表中，服务级上限或删除操作留待后续产品决策。
