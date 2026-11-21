# coding-tool-notes-tabs

笔记专用模式的临时标签发布路由与模型工具。只在 `notes` agent preset 中挂载插件；同一插件生命周期持有 HTTP 路由、内存快照和 `notes_tabs` 工具，不在其他模式注册。浏览器发来的相对路径不会直接作为文件绝对路径：Host 按当前文件库根目录逐项核验真实文件，返回工具时再次核验。只有笔记会话的 live Agent、对应的 Session，以及该会话工作目录恰好为笔记根目录时才接受发布。此端点仅在 Host 监听 `127.0.0.1`、请求来自本机且通过 connection 同源检查时可用；同源检查不构成独立身份认证，不能把此端点作为任意外部客户端的安全授权接口。

## 发布协议

客户端使用 `POST /api/notes/tabs`，`Content-Type: application/json`，请求体类型从 `coding-tool-notes-tabs/protocol` 导入 `NotesTabsPublishRequest`；浏览器仅发送以下字段，不能提交绝对路径：

```json
{"sessionId":"当前笔记会话标识","windowId":"该窗口存活期唯一标识","version":1,"openTabs":["第一篇.md","分类/第二篇.markdown"],"activeTabPath":"分类/第二篇.markdown","activeKind":"note"}
```

`openTabs` 是有序完整快照，最多 64 项；支持 Markdown、`.markdown` 和 `.codingppt` 幻灯片工程目录，`activeTabPath` 必须为其中一项，空标签状态传 `null`。活动类型 `ppt` 仅可对应 `.codingppt` 目录，`note` 仅可对应 Markdown。发布者须为当前笔记会话页面，每次内容变化及心跳发送严格递增的安全整数 `version`；同一窗口会话重挂载时使用新 `windowId`，版本可从 1 开始。单次 JSON 请求体不超过 64 KiB，拒绝未知字段、重复标签和路径越界。`200` 响应为 `{ "ok": true, "sessionId": "...", "windowId": "...", "version": 1 }`；`400` 为 `{ "ok": false, "error": "invalid" }`；`409` 为 `{ "ok": false, "error": "stale" }` 或 `{ "ok": false, "error": "session-mismatch" }`。不可信来源返回 `403`，非 POST 返回 `405`，非 JSON 返回 `415`。发布失败不修改旧快照。

Host 仅保留内存数据：重启或预设卸载后需要再次发布，关闭页面不发送虚构空标签；页面可每 10 秒重发递增版本作为心跳，30 秒未发布的窗口从工具查询中排除。多个窗口在同一会话内保持活跃时工具拒绝选择，避免把另一个窗口的活动标签当成当前内容；客户端应关闭多余窗口或自行使旧窗口超时。笔记文件消失或路径核验失败时工具不返回该快照。此路由不是强认证发布通道：同机上能够向本机 API 发请求的进程可冒用已知会话标识；不能以此作为互不信任本地进程之间的权限边界。

## Model Experience

### `notes_tabs` 工具

#### What the model sees

仅笔记专用预设出现的无参工具。成功返回 `status: "ready"`、会话和窗口标识、发布版本、按标签顺序排列的 `{path, absolutePath}`，以及 `activeTabPath`、`activeKind`。未发布、所有窗口超时、多个窗口活跃或会话归属不符时返回 `status: "unavailable"` 与具体 `reason`（`not-published`、`window-closed`、`ambiguous-window` 或 `session-mismatch`），不伪造文件路径。完整工具 schema 以生成的[工具目录](../../../docs/tool-catalog.md)为准。

#### Token effect

工具声明只在笔记预设中占用固定请求 token；调用结果作为已记录的工具输出追加，标签数至多 64，路径各至多 4096 字符，运行时不注入页面状态或历史快照。

#### KV Cache effect

未调用时不改变既有上下文前缀；工具结果会增长对话后缀，下一轮调用的结果随已发布状态改变，不保证结果段可复用。

## Known Limitations and Deferred Work

端点局限在 Host 回环同源和 live 会话校验，不验证浏览器窗口与会话之间的不可伪造凭据；在同机不可信进程可访问 HTTP 的部署中，不能把发布状态视作具有密码学来源证明。窗口关闭依靠心跳超时而非立即撤销；超时前模型看到的状态可能仍是上次发布值。幻灯片标签的路径校验以笔记根目录里真实的 `.codingppt` 工程目录为依据，不推断工作台工程状态。
