# @deepseek-ai/dsh-tool-browser

`browser_use` 是 `ctx.browserUse` 的面向模型消费方。部署需挂载工具注册表、浏览器服务和持久附件存储；执行时还需一次性审批服务及活跃 Agent。每次调用（包括快照与关闭）都申请一次审批，只有 `allowed-once` 可以调用浏览器服务；拒绝、取消、应答者缺席及缺少审批服务均不会执行浏览器命令。

工具的 `action` 是 `navigate`、`snapshot`、`click`、`fill`、`scroll`、`screenshot` 或 `close`；人工操作的标签页选择、后退、前进、刷新与视口调整不属于模型工具。`navigate` 需要非空 `url`（最多 2048 字符）；`click` 和 `fill` 使用当前标签页上次观测中的不透明 `ref` 与正整数 `revision`，不接受 CSS 选择器或脚本；`fill.text` 最多 2000 字符；`scroll` 要求方向与 1–2000 的整数像素数。每个 action 拒绝其他 action 的字段。服务提供方负责 URL 和子请求网络访问策略、ref 新鲜度及按会话释放页面。

工具先检查会话工作区的 Remote-SSH marker，远程工作区一律拒绝，不回退至本机浏览器。没有工作区路径的本机会话可执行。审批前固定当前浏览器与活跃标签页的 generation、状态 revision、标签页身份和 URL，获准后由服务提供方在执行队列里复核；等待审批期间人工切换标签页再切回、同 URL 刷新或导航都会使调用失败，不在变化后的页面上执行。尚无会话时仅允许首次 `navigate`，并要求执行队列中仍无会话；人工创建但尚未观测的空白标签页可按其身份与 generation 绑定。成功值是 `{ action, observation, image }`；观测包含 tabId、generation、revision、URL、标题、快照、viewport、cursor，快照最多 12000 字符，标题 512 字符，URL 2048 字符，generation 128 字符。显式 `screenshot` 才把 PNG 经 `ctx.attachments.saveImage` 持久保存并将附件引用写入规范结果；原生工具结果额外附带图像块。截图存储失败则整个工具调用失败，不返回尚未持久化的图像引用。其余 action 不存储或渲染图像。工具失败经注册表成为普通 `isError` 文本，浏览器服务的策略与失败码由服务包持有。

审批理由显示操作和目标或活跃标签页的 HTTP(S) origin；无会话、无效或过长的 origin 显示为未知。`navigate` 的目标解析失败时显示无效目标；目标 URL 的用户信息、路径、查询参数和片段不写入审批理由或审计事件，`fill` 文本、页面内容与截图也不写入。`click` 与 `fill` 仅展示简短的安全字符 ref，其余 ref 显示占位符。理由仅供判断这一次调用：导航可能重定向或加载子资源，批准不会自动授权后续操作，最近观测也不决定访问权限；网络与 ref 校验仍由浏览器提供方执行。

## Model Experience

### browser_use schema

#### What the model sees

工具说明和参数见生成的[工具目录](../../../docs/tool-catalog.md#deepseek-aidsh-tool-browser)。模型只能提供上述结构化操作，不能提供选择器、脚本或任意浏览器运行时代码。

#### Token effect

schema 在工具可见时占用固定请求 token；每次成功调用的结构化观测最多携带 12000 字符的页面快照及有界元数据，只有显式截图额外携带一张 PNG 图像。

#### KV Cache effect

工具 schema 对同一工具集保持前缀稳定；工具可见性变化改变请求前缀。每次工具结果追加到会话历史并增长上下文，截图仅在显式调用后加入图像块。

## Known Limitations and Deferred Work

- 页面快照截断可能隐藏后段元素；模型应再次导航或调整页面而非猜测未见的 ref。提供方需限制完整采集大小，工具只限制模型结果。
- 不支持远程工作区浏览器操作；有远程 marker 的会话不会打开本机浏览器。
