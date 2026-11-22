# coding-tool-notes-tabs

本包只在 `notes` 笔记预设挂载，持有临时标签快照、发布路由和 `notes_tabs`、`notes_mindmap`、`notes_office` 模型工具。发布要求同一仍存活的 Agent 与 Session、笔记预设，以及会话工作目录恰为文件库笔记根目录。Host 按该根目录逐项核验浏览器发来的相对路径，供工具使用前再次核验。发布端点仅在 Host 监听 `127.0.0.1`、请求来自本机且通过 connection 同源检查时可用；该检查不是独立的身份认证。

## 发布协议

客户端使用 `POST /api/notes/tabs`，`Content-Type: application/json`，请求体类型从 `coding-tool-notes-tabs/protocol` 导入 `NotesTabsPublishRequest`；浏览器仅发送以下字段，不能提交绝对路径：

```json
{"sessionId":"当前笔记会话标识","windowId":"该窗口存活期唯一标识","version":1,"openTabs":["第一篇.md","分类/计划.codingmindmap"],"activeTabPath":"分类/计划.codingmindmap","activeKind":"mindmap"}
```

`openTabs` 是有序完整快照，最多 64 项。活动类型须与真实条目匹配：`note` 对应 `.md`／`.markdown` 文件，`ppt` 对应 `.codingppt` 工程目录，`mindmap` 对应 `.codingmindmap` 文件，`word` 与 `excel` 分别对应 `.codingword` 与 `.codingexcel` 文件。`activeTabPath` 必须是已打开的一项，无活动标签时传 `null`，此时 `activeKind` 为 `note`。路径不得越界、经过符号链接或进入幻灯片工程目录。

客户端在目录初次核对后发布；标签改变时更新，每 10 秒重发快照作为心跳。`version` 是严格递增的安全整数，同一窗口的笔记页重挂载时沿用 `windowId`，版本继续递增。单次 JSON 请求体不超过 64 KiB，拒绝未知字段和重复标签。`200` 响应为 `{ "ok": true, "sessionId": "...", "windowId": "...", "version": 1 }`；`400` 为 `{ "ok": false, "error": "invalid" }`；`409` 为 `{ "ok": false, "error": "stale" }` 或 `{ "ok": false, "error": "session-mismatch" }`。不可信来源返回 `403`，非 POST 返回 `405`，非 JSON 返回 `415`。发布失败不修改旧快照。

快照只保存在 Host 内存中；重启或预设卸载后需要再次发布。页面卸载时不额外发送空快照；超过 30 秒没有成功发布的窗口从查询中排除。同一笔记会话有多个未超时的本机窗口时，工具拒绝选择来源；路径复核失败的快照也不返回。

## 思维导图操作

`notes_mindmap` 只在对应笔记根目录的笔记会话中操作原生导图，数据由[文件库](../../attachment/file-library/src/mindmap-notes.ts)读写。路径相对于笔记根目录；只读会话不可执行 `create` 或 `edit`。

对话和执行轨迹按动作显示「读取思维导图」「新建思维导图」或「编辑思维导图」；运行参数保留在展开的调用详情中。

- **`read`**：首读可提供 `path`，或省略它以使用经 Host 核验、唯一有效窗口中的真实活动导图；没有活动导图、标签失效或窗口有歧义时不猜测路径。结果包含 `path`、`revision`、`totalTopics`、按树顺序排列的 `topics`（`id`、`text`、`parentId`，中心主题的 `parentId` 为 `null`）和 `nextOffset`。每页至多 24 个主题，完整 JSON 不超过 8 KiB；翻页时将 `nextOffset` 传作 `offset`，并原样带回上一页的 `path` 和 `revision`，`nextOffset: null` 表示读完。若版本已变，重新从第一页读取。
- **`create`**：提供 `name` 和可选的相对 `directory`，省略目录时保存在笔记根目录；文件名称也用作初始中心主题。成功只返回 `path`，同名不覆盖。
- **`edit`**：使用读取返回的 `path`、`revision` 和主题标识，明确提供包含 1 至 32 项操作的 `edits`。`add` 在 `parentId` 下追加带 `text` 的子主题，标识由系统分配；`rename` 修改指定 `id` 的文字；`move` 把指定 `id` 的分支移至 `parentId`，可传从旧位置移除后计算的零基 `index`，默认追加；`delete` 删除指定 `id` 的分支及后代。中心主题不能移动或删除，分支不能移进自身或后代。整批通过校验才提交；版本冲突或操作无效不会写入，冲突后须重新读取并核对目标。成功返回新版本的第一页。

## 办公笔记操作

[`notes_office`](src/office-tool.ts) 只在对应笔记根目录的 `notes` 预设会话可用，通过[文件库](../../../docs/subsystems/attachment.md#word-与-excel-文档快照)操作原生 Word 与 Excel 笔记。所有路径相对笔记根目录；会话为只读时允许 `read`，禁止 `create`、`edit` 和 `export`。

- **`read`**：首读可传 `path`，也可省略以使用经 Host 复核、唯一有效窗口里的活动 Word 或 Excel 标签。窗口有歧义、标签未发布或失效时，必须指定路径。Word 返回带零基索引的段落；Excel 先返回工作表列表，再用表的 `sheetId` 读取单元格，可选零基、含起止端点的区域。读下一页或读指定工作表时，显式传入已返回的 `path`、`revision`；翻页复用查询条件并将 `nextOffset` 传作 `offset`，为 `null` 时读完。版本变化后重新读取。
- **`create`**：传 `kind`（`word` 或 `excel`）、`name` 和可选相对 `directory`；省略目录时保存在笔记根目录。成功返回 `path`，同名不覆盖。
- **`edit`**：显式传读取返回的 `path`、`revision` 和 1 至 32 项操作。Word 可以插入、完整替换或删除指定段落；Excel 可以新增、改名或删除工作表，也可按 `sheetId` 设置单元格（每项操作最多 256 格）。段落索引与单元格行列从零开始；替换段落或单元格时须带回未要求改变的内容及样式。整批校验后才写入，成功返回 `path`、`revision` 与 `kind`；发生冲突时先重新读取并核对目标。
- **`export`**：显式传读取或编辑返回的 `path`、`revision`。将同一版本生成的 `.docx` 或 `.xlsx` 登记到「设置 → 文件管理」，返回成品名称 `name` 和文件 ID `fileId`；不改写笔记。版本冲突时不导出。

## Model Experience

### `notes_tabs` 工具

#### What the model sees

仅笔记专用预设出现的无参工具。成功返回 `status: "ready"`、会话和窗口标识、发布版本、按标签顺序排列的 `{path, absolutePath}`，以及 `activeTabPath`、`activeKind`。未发布、所有窗口超时、多个窗口活跃或会话归属不符时返回 `status: "unavailable"` 与具体 `reason`（`not-published`、`window-closed`、`ambiguous-window` 或 `session-mismatch`），不伪造文件路径。工具声明见生成的[工具目录](../../../docs/tool-catalog.md#coding-tool-notes-tabs)。

#### Token effect

工具声明只在笔记预设中占用固定请求 token；调用结果作为已记录的工具输出追加，标签数至多 64，每条相对路径至多 4096 字符，运行时不注入页面状态或历史快照。

#### KV Cache effect

未调用时不改变既有上下文前缀；工具结果会增长对话后缀，下一轮调用的结果随已发布状态改变，不保证结果段可复用。

### `notes_mindmap` 工具

#### What the model sees

[工具定义](src/mindmap-tool.ts)的描述是「读取、创建或编辑笔记目录中的思维导图。读取可省略路径以使用当前导图；编辑必须使用读取返回的 path、revision 和主题 id。一批编辑全部成功才写入；版本变化时重新读取并核对目标，不要覆盖他人的修改。」参数和结果见[思维导图操作](#思维导图操作)。

#### Token effect

工具声明只在笔记预设中占用固定请求 token；调用结果作为已记录的工具输出追加，按上述分页预算返回结构化主题，不把整张导图自动注入模型请求。

#### KV Cache effect

工具不重写已有上下文前缀或发起独立模型请求；调用结果只追加到对话后缀，再次读取的页内容随磁盘版本变化。

### `notes_office` 工具

#### What the model sees

工具描述是「读取、创建、编辑或导出笔记目录中的 Word 文档和 Excel 工作簿。首次读取可省略路径使用当前文档；Excel 先读取工作表列表，再指定 sheetId 读取单元格。编辑或导出须使用读取返回的路径和版本；如有冲突，重新读取并核对目标。请保留用户未要求改动的内容和样式，不要用截断预览替代原内容。」参数和结果见[办公笔记操作](#办公笔记操作)。

#### Token effect

工具声明只在笔记预设中占用固定请求 token；调用结果追加到对话，不自动注入文档。每页至多 24 项，完整 JSON 不超过 8 KiB；单个段落或单元格超出一页预算时只返回截断预览，不能用它替换原内容。

#### KV Cache effect

工具不重写已有上下文前缀或发起独立模型请求；调用结果只追加到对话后缀，再次读取的页内容随磁盘版本变化。

## Known Limitations and Deferred Work

端点局限在 Host 回环同源和 live 会话校验，不验证浏览器窗口与会话之间的不可伪造凭据；在同机不可信进程可访问 HTTP 的部署中，不能把发布状态视作具有密码学来源证明。窗口关闭依靠心跳超时而非立即撤销；超时前模型看到的状态可能仍是上次发布值。幻灯片标签的路径校验以笔记根目录里真实的 `.codingppt` 工程目录为依据，不推断工作台工程状态。
