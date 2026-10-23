# coding-web-search-parallel

Parallel 搜索提供方，向 [`ctx.web`](../web/README.md) 注册 id `parallel`。通过 Parallel 官方 MCP 端点发起 JSON-RPC `tools/call`（工具 `web_search`），无密钥时使用匿名额度，配置密钥后请求头带 `Authorization: Bearer` 提额。请求形状、结果字段与错误分层参考 MIT 许可的 [omdsh-dev/dsh-free-search](https://github.com/omdsh-dev/dsh-free-search) 的 `searchParallelMCP` 与 `mcp_adapter`，按本仓 provider 形态重写。

## 配置与行为

可在 `web-search-parallel` 设置分节或插件配置中填写：

| 配置 | 行为 |
|---|---|
| `apiKey` | Parallel API key。省略时读取启动环境里的 `PARALLEL_API_KEY`；两者都没有或为空（含纯空白）时使用匿名额度，请求不携带任何凭据。设置后每次请求发送 `Authorization: Bearer <key>`。 |
| `baseURL` | MCP 端点，默认 `https://search.parallel.ai/mcp`。必须是不带 URL 用户信息、查询串与片段的 HTTPS 地址；自建网关同样受此约束。 |
| `outbound` | 出站选择，复用共享契约：直连（缺省）、内置代理池或自定义代理。直连走原生 fetch，自定义代理经独立 HTTPS CONNECT 发起并在请求结束或取消后释放连接，不改动全局代理设置；自定义地址仅允许不带凭据、查询串与片段的 HTTP(S) URL。 |

每次搜索向端点发送一次匿名或带密钥的 POST：JSON-RPC 2.0 `tools/call`，`params.name` 为 `web_search`，`params.arguments` 为 `{ objective, search_queries: [query], session_id }`。`objective` 就是查询词本身；`session_id` 是每个提供方实例生成一次的 32 位十六进制随机串，参考实现用它把匿名请求归入同一条免费额度会话。请求头声明 `application/json` 与 `text/event-stream`，不跟随 HTTP 重定向，单次请求 12 秒超时并尊重调用方取消，响应体最多读取 2 MB。

响应先按纯 JSON 解析，失败再按 SSE 帧提取；非 2xx、JSON-RPC 层 `error`、工具层 `isError`、既不是 JSON 也不是 SSE 的正文，以及 text 块里找不到带 `results[]` 的 JSON，都以 `WebError` `WEB_PROVIDER_ERROR` 失败，消息带失败层级与原始细节片段（`401`／`403` 额外提示检查 API key），不返回部分结果。取消与超时映射为 `WEB_ABORTED`。

结果按 text 块里的 JSON `{ results: [...] }` 映射：`url`、`title`、摘要取首个非空 `excerpts[]` 元素（退回 `snippet`／`description`）、`publish_date` 映射 `publishedAt`。仅保留 HTTP(S)、无 URL 用户信息且不超过 2048 字符的来源，同一 URL 只返回一次；标题与摘要分别最多 200 与 500 字符。条数默认 10、上限 20：MCP 工具没有条数参数，服务端决定返回多少，本包按调用方预算在本地截断，`ctx.web` 仍会按调用的 `maxResults` 截断。

## 模型体验

模型仅通过 [`web_search`](../tool-web/README.md) 看到标题、来源 URL 与有界摘要；本包不贡献提示词或工具 schema。结果与提供方错误会追加到工具结果，token 用量取决于实际返回条目；注册和切换提供方不会直接改变既有请求前缀或 KV Cache。

## 已知限制与暂缓事项

- **匿名额度有限**：免费额度的速率与总量由 Parallel 决定；本包不重试、不切换其他提供方，额度耗尽或密钥失效时直接报告该提供方的错误（`HTTP 401`／`403`／`429`），换用其他引擎必须由用户改设置完成。
- **MCP 端点与工具名可能变化**：`https://search.parallel.ai/mcp`、工具名 `web_search`、`session_id` 用法与结果 JSON 形状都不是本仓契约；端点或格式漂移时需要更新本包，`baseURL` 只覆盖地址、不覆盖协议形状。
- **条数不受本包控制**：MCP 工具没有 `max_results` 参数，`maxResults` 只是本地截断，因此一次搜索仍可能消耗服务端更多配额。
- **不提供生成答案与时间过滤**：`WebSearchRequest` 只携带 `query` 与 `maxResults`，本包不发送发布时间过滤；参考实现的 `source_policy.after_date` 属于其 REST 路径，本包没有该参数。
