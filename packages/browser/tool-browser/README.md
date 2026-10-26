# coding-tool-browser

`browser_navigate`、`browser_snapshot`、`browser_click`、`browser_fill`、`browser_act`、`browser_scroll`、`browser_viewport`、`browser_screenshot` 和 `browser_close` 是 `ctx.browserUse` 的面向模型消费方。部署需挂载工具注册表、浏览器服务、持久附件存储和系统提示词；执行时还需审批服务及活跃 Agent。只有调用会话的有效沙箱模式为 `danger-full-access`，且有效审批策略为 `never` 时，工具才不申请一次性审批并直接执行。有效权限结合该会话的覆盖与部署默认值解析，不受其他会话的选择影响。

其余组合保持一次性审批路径：`danger-full-access` 搭配 `ask` 仍对每次调用（包括快照与关闭）申请审批，只有 `allowed-once` 可以调用浏览器服务；较窄沙箱下的 `never` 会拒绝，而非授予浏览器访问。未挂载沙箱策略服务的部署也走审批路径。拒绝、取消或应答者缺席均不会执行浏览器命令；缺少审批服务时，即使沙箱模式为 `danger-full-access` 也不会执行。

九项工具都不接受顶层 `action` 字段：`browser_navigate` 只传 `url`，`browser_snapshot`、`browser_screenshot`、`browser_close` 不传参数，`browser_click` 传 `ref, revision`，`browser_fill` 传 `ref, revision, text`，`browser_act` 传 `revision, steps`，`browser_scroll` 传 `direction, pixels`，`browser_viewport` 传 `width, height`。多余字段会报出字段名及该工具允许的字段，不会静默忽略。`browser_act` 的 `steps` 是 1–8 个按顺序执行的动作对象，每个只有 `kind: "click"`（配 `ref`）或 `kind: "fill"`（配 `ref, text`），所有 `ref` 必须来自同一个 `revision`；`kind` 取值、步数、`ref` 与 `text` 上限和多余字段都在审批前拒绝。`browser_navigate` 需要非空、最多 2048 字符的纯绝对 HTTP(S) 或本机 `file:///` 地址，不能传 `[标题](https://example.com/)` 等 Markdown 链接；拒绝远程文件主机、含用户信息的 URL 以及编码斜杠等歧义路径。格式错误在审批前拒绝，诊断不回显 URL、文件路径或查询参数，提供方仍独立校验直接调用；`browser_click` 和 `browser_fill` 使用当前标签页最近观测中的不透明 `ref` 与正整数 `revision`，不接受 CSS 选择器或脚本；`browser_fill` 的 `text` 最多 2000 字符；`browser_scroll` 要求方向与 1–2000 的整数像素数，单次滚轮请求量至多一视口高度，实际位移由页面决定；`browser_viewport` 要求 200–1920 的宽、240–1400 的高且面积不超过 1,800,000 像素，越界在审批前拒绝，成功返回已按新尺寸重新采集的观测，模型据此核对响应式布局后再显式截图。服务提供方负责导航输入校验、ref 新鲜度及按会话释放页面；[Playwright 提供方](../browser-playwright/README.md)使用浏览器原生联网，不限制目的地、重定向或子资源。

工具先检查会话工作区的 Remote-SSH marker，远程工作区一律拒绝，不回退至本机浏览器。没有工作区路径的本机会话可执行。每次调用在审批前独占人工入口，排空此前已接纳的人工命令后，通过 `prepareTarget` 只刷新当前目标的身份并固定浏览器与活跃标签页的 generation、状态 revision、标签页身份和 URL，由服务提供方在执行队列里复核。页面在两次工具调用之间自行导航时，读取或交互等非导航调用可按新 URL 的 origin 重新申请审批；导航调用仍显示命令目标的 origin。刷新目标不会读取页面内容或截图，也不会使旧元素引用重新有效。占用从审批持续到执行及截图保存结束，拒绝、取消和失败时也释放；占用期间人工控制和同会话并发模型调用返回 `BROWSER_BUSY`。这不代替一次性审批，等待审批时页面再次导航或会话关闭仍使本次目标复核失败，下一次调用须重新绑定并审批。不申请审批的路径仍执行相同的目标、导航输入和 ref 校验。尚无会话时仅允许首次 `navigate`，并要求执行队列中仍无会话；人工创建但尚未观测的空白标签页可按其身份与 generation 绑定。成功值是 `{ action, observation, image }`，`browser_act` 另带 `steps`：按请求顺序列出实际尝试过的步骤及其 `ok`，失败步骤带提供方原因，缺失的步骤表示没有执行。观测包含 tabId、generation、revision、URL、标题、快照、viewport、cursor，快照最多 12000 字符，标题 512 字符，URL 2048 字符，generation 128 字符。显式 `screenshot` 才把 PNG 经 `ctx.attachments.saveImage` 持久保存并将附件引用写入规范结果；原生工具结果额外附带图像块，实际像素尺寸可为 CSS 视口的一倍或两倍。截图存储失败则整个工具调用失败，不返回尚未持久化的图像引用。其余 action 不存储或渲染图像。浏览器服务失败经注册表成为按动作限定恢复提示的 `isError` 文本，通常带 `BROWSER_*` 码；点击与填写因元素过期失败时，文本先给出提供方对原因的一句话诊断（被谁遮挡、隐藏、禁用、移出视口或身份变化，最多 200 字符并去掉控制字符），让模型能决定重拍快照、滚动还是换目标，其余错误只回显固定提示。未提交页面或无法取得新观测的安全停载导航超时保留固定原句，供客户端识别并显露原生页面。已经提交且仍为当前目标的页面由 Electron 提供方在安全停载后进行严格观测，成功时直接返回页面而无需手动再次调用 `browser_snapshot`。工具不回显提供方原始错误中可能含有的 URL，也不自动重试、重新导航或重放交互；服务失败码由服务包持有。

等待审批后、调用浏览器提供方之前再次读取 Remote-SSH marker；等待期间工作区切为远程则拒绝，不执行已批准的本机操作。提供方也将同 URL 自发重载视为目标变化，审批不授权后来加载的文档。

审批理由显示操作和目标或活跃标签页的 HTTP(S) origin；无会话、无效或过长的 origin 显示为未知。`navigate` 的目标解析失败时显示无效目标；目标 URL 的用户信息、路径、查询参数和片段不写入审批理由或审计事件，`fill` 文本、页面内容与截图也不写入。`click` 与 `fill` 仅展示简短的安全字符 ref，其余 ref 显示占位符；`act` 显示总步数与各类动作次数，一次审批覆盖这一批步骤，各步内容与 `fill` 文本仍不写入理由。理由仅供判断这一次调用：导航可能重定向或加载子资源，批准不会自动授权后续工具调用，也不限制页面的网络目的地；导航输入与 ref 校验仍由浏览器提供方执行。

## Model Experience

### 系统提示词指引

#### What the model sees

该插件以 order 107 贡献 `tool:browser` 段，其文本固定为：

> Use the browser tools, not a headless browser script run in bash, when a task needs a rendered page read, reproduced, verified, or driven, including your own app on localhost or a dev server.

这一段承担路由。这些工具的 schema 只在模型已经决定调用浏览器之后才生效，而任务要求复现或验证本机界面时，模型的默认路径是写一个无头浏览器脚本；跨过这一步的信号只有这一段常驻指引和按需加载的 [`browser-use` 技能](../../skill/skill-browser-use/README.md)。

#### Token effect

插件挂载期间该段固定出现在每个请求的系统提示词中，不跟随逐 agent 的工具遮蔽；加载 `browser-use` 正文是额外的一次性成本。

#### KV Cache effect

该段属于稳定请求前缀，不随页面观测或会话推进变化；插件启用状态或作用域变化才改变前缀。

### 浏览器操作工具 schema

#### What the model sees

工具说明和参数见生成的[工具目录](../../../docs/tool-catalog.md#deepseek-aidsh-tool-browser)。标准与 Code 预设还提供按需加载的 [`browser-use` 技能](../../skill/skill-browser-use/README.md)，说明观测、引用修订和失败恢复；模型只能提供上述九项结构化操作，不能提供选择器、脚本或任意浏览器运行时代码。`browser_act` 的说明直接给出「填两个字段再点提交」的例子，让模型在写表单任务时不必先逐字段尝试一次才想到批量。

#### Token effect

schema 在工具可见时占用固定请求 token；每次成功调用的结构化观测最多携带 12000 字符的页面快照及有界元数据，只有显式截图额外携带一张 PNG 图像。

#### KV Cache effect

工具 schema 对同一工具集保持前缀稳定；工具可见性变化改变请求前缀。每次工具结果追加到会话历史并增长上下文，截图仅在显式调用后加入图像块。

## Known Limitations and Deferred Work

- 页面快照截断可能隐藏后段元素；模型应再次导航或调整页面而非猜测未见的 ref。提供方需限制完整采集大小，工具只限制模型结果。
- `browser_act` 只覆盖点击与填写，不支持在批次中导航、滚动或截图：需要滚动到目标时先单独滚动并重拍快照。批次在第一个无法执行的步骤处停止，模型必须重新观测后再继续，不能把余下步骤当作已执行。
- 不支持远程工作区浏览器操作；有远程 marker 的会话不会打开本机浏览器。
