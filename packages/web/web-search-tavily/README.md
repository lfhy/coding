# @deepseek-ai/dsh-web-search-tavily

Tavily 的专用搜索端点提供 `WebSearchProvider`，以 `tavily` 登记到 [web 能力](../web/README.md)（`ctx.web`）。仅在 `web.searchProvider` 显式选择或唯一可用时执行；选择失败、密钥缺失或请求失败都不自动切换其他提供方。此包只提供搜索，不注册面向模型的工具，也不改变 LLM 端点或代理。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 未设置 | 非空字面密钥；优先于凭据引用，配置描述会遮蔽它。 |
| `apiKeyEnv` | `TAVILY_API_KEY` | 逐次解析的凭据引用。已挂载 `ctx.credentials` 时只查询它，否则读取启动环境。 |
| `baseURL` | `https://api.tavily.com` | 独立端点基址，追加 `/search`；只允许至少两个非空域名标签、无凭据、查询和片段的公共 HTTPS 主机，拒绝 IP、localhost、`.local` 和 `.internal`。 |
| `proxyURL` | 未设置 | 仅此 Host 搜索使用的 HTTP(S) 前向代理；允许 loopback/IP，不允许 URL 内凭据、查询和片段。 |

配置属于 `web-search-tavily` 设置区，保存后的值在下一次搜索生效。每次请求锁定同一份配置与解析所得密钥；代理 dispatcher 只在本次请求使用，响应处理完即释放。未设置代理时使用原生 fetch；环境代理或其他插件的代理设置不会自动成为此配置。

请求向 `${baseURL}/search` 发送 `Authorization: Bearer`、`query`、`max_results`、`search_depth: basic`、`include_answer: false` 和 `include_raw_content: false`。结果数来自 web 请求的 `maxResults`，缺省为 8，并限制在 Tavily 的 20 项上限。响应的 `results[]` 必须合法，最多映射 20 个来源；每项的 HTTP(S) `url` 不超过 2048 字符，并在拒绝空白、控制字符后规范化与去重，Markdown 链接定界符会编码；可选 `title`、`content` 和 `published_date` 经校验后映射为 `url`、最多 200 字符的 `title`、最多 500 字符的 `snippet` 和 ISO-8601 `publishedAt`，无法解析的发布日期省略。标题和摘要会压平空白并截断，标题中的方括号与反斜杠会移除，避免破坏链接标签。Tavily 的生成答案不进入结果。参见 [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)。

取消返回 `WEB_ABORTED`，密钥缺失返回 `WEB_PROVIDER_CREDENTIAL_MISSING`，HTTP、网络、重定向和响应错误返回 `WEB_PROVIDER_ERROR`。成功和失败响应体均最多读取 2 MiB，并严格解码 UTF-8；解码或解析失败会取消流，关闭代理期间仍可由调用者取消。HTTP 错误保留状态，并在可用时包含最多 500 字符的服务端错误详情；错误消息中的密钥会被遮蔽。所有携带凭据的请求拒绝自动重定向，避免向 `Location` 转发密钥或查询。

## Model Experience

通过 [web 搜索工具](../tool-web/README.md)间接影响模型上下文：工具消费经 `maxResults` 限制的引用来源及错误；本包不增加提示词、工具 schema 或额外模型请求，Tavily 的生成答案与原始内容不进入上下文。

#### KV Cache effect

本包不直接改变模型请求前缀；工具执行后的搜索结果作为消费方的工具结果加入后续上下文，内容变化可能使后续前缀无法复用。

## Known Limitations and Deferred Work

- Tavily 的答案、原始正文、搜索深度及过滤参数没有映射到 web 搜索接口；当前只提供基础搜索和可引用来源。
- `published_date` 并非每个普通搜索响应都会返回；没有合法日期时不会推测发布日期。
