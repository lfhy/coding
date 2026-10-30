# coding-tool-context-compact

把压缩（compaction）的**时机**交给模型：通过 [`ctx.compaction`](../compaction/README.md) 注册面向模型的 `context_compact` 工具。工具只表达「较早的历史已经不值得继续占用上下文，后续工作真正需要保留这些」，范围选择、事务、摘要与持久化仍由挂载的后端负责。

它补的是自动策略看不到的两种情形：同一窗口里换了主题，以及 explore 结束、真正实施开始之前。此前的压缩要么由 token 压力被动触发，要么由人类执行 `/compact`；现在模型可以在自己的轮次里主动决定。

## 工具约定

| 输入 | 结果 |
|---|---|
| `context_compact { focus }` | 用一份检查点替换较早历史；`focus` 说明后续工作要保留什么（具体任务、仍然生效的决定与约束、相关文件与标识符）。 |
| `context_compact`（无 `focus`） | 同样替换，但摘要按通用工程检查点写；`focus` 为空串或只有空白时按未提供处理。 |
| `focus` 超过 2000 字符 | 调用失败，不进入压缩：`focus` 会被回放给摘要模型，无界输入会放大这次调用本要缩小的历史。 |
| 当前步骤之前没有安全范围 | `status: nothing_to_compact`，不写入任何事件。 |

`status` 是唯一的规范结论字段，`render` 负责给出下一步该做什么：

| `status` | 含义 |
|---|---|
| `compacted` | 已替换；`shadowedItems` 与 `shadowedTokens` 报告被遮蔽的节点数和估算 token。 |
| `nothing_to_compact` | 没有可替换的安全范围，会话不变。 |
| `busy` | 同一会话已有活动压缩（未匹配的 `compaction/start`，或另一入口正在运行），会话不变。 |
| `failed` | `failure` 给出 `changed`、`summary` 或 `commit`：所选范围在摘要期间改变、检查点不会比被替换内容更小，或提交阶段未干净完成。 |

取消与持久化失败不作为领域结论：它们让调用以错误结束，由执行流水线处理。工具没有其它参数——范围、保留尾部与重试都属于后端策略。

## 轮内事务

模型驱动的压缩在**当前打开的轮次内**执行：`compaction/start` 与 `compaction/end` 的 `turn` 是该轮次号，而不是 `/compact` 的空闲独立标记对。稳定检查只覆盖被选中的 span，因此摘要期间落地的其他节点（并行的工具结果、注入的上下文）会保留在检查点之后，不会把整次压缩判为 `changed`。当前步骤——发起本次调用的 assistant 消息及其尚未回答的工具调用——永不替换，工具配对边界始终成立。

`focus` 会记入 `compaction/summary.focus`：摘要指令取决于模型输入，记录它才能让那次一次性摘要请求仍可由日志 + 代码重建。

## 组合

注入 `tools` 与 `compaction`。挂载工具注册表、一个后端与本插件：

```yaml
- id: tools
  name: 'coding-tools'
- id: compaction-basic
  name: 'coding-compaction-basic'
- id: tool-context-compact
  name: 'coding-tool-context-compact'
```

随附 `dsh` 基础配置把它挂在 `coding-command-compact` 旁，两者共享同一个后端。未挂载压缩后端的组合不会激活该工具。

## 模型体验

### 模型主动压缩

#### 模型看到什么

工具描述指出两种触发情形（主题已换，或探索结束即将开始真正的工作），并要求用 `focus` 交代后续工作要保留的内容。成功的调用用一份带框架的检查点替换较早历史；结论文本报告被替换的历史项与估算 token，并提示基于检查点继续而不是复述它。`busy`、`failed` 与 `nothing_to_compact` 都明确说明会话未变、接下来继续做事。

#### Token 影响

检查点替换多个历史节点，从而减少后续请求；摘要生成本身是一次 `purpose: 'compaction'` 的辅助请求，不进入会话历史。检查点大于被替换范围时后端拒绝提交，因此该工具不会让上下文变大。

#### KV Cache 影响

成功替换会使从第一个被遮蔽 token 起的复用失效；`nothing_to_compact`、`busy` 与失败结论都不改变请求。

## 已知限制与暂缓事项

- **不暴露范围、保留尾部或策略参数**：这些属于后端策略；工具只表达时机与 `focus`，因此换后端时模型可见契约不变。
- **当前步骤不可压缩**：范围止于发起调用的步骤之前；一轮里只有一个尚未闭合的步骤时返回 `nothing_to_compact`。
- **不是纯粹的「变小」保证**：`focus` 与检查点结构都由摘要模型产出，压缩能否真的变小由后端在提交前判定；判不出来时报告 `failed/summary` 而不是部分写入。
- **只影响该会话的模型历史**：工具不修改系统提示词、工具清单或会话前缀。
