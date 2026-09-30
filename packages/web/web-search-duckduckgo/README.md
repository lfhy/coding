# @deepseek-ai/dsh-web-search-duckduckgo

无密钥的 DuckDuckGo 搜索提供方，向 [`ctx.web`](../web/README.md) 注册 id `duckduckgo`。默认组合通过 `web.searchProvider: duckduckgo` 选择它；将该设置改为 `deepseek-official` 后，本提供方不会承接后者的凭据或认证错误。

## 配置与行为

本包没有 API key 或可修改的网络端点。每次搜索向固定的 `https://html.duckduckgo.com/html/` 发送匿名 GET，只携带 URL 编码的 `q` 搜索词；不跟随 HTTP 重定向，不发送凭据。解析公共 HTML 页面中的 `result__a` 目标链接及 `result__snippet` 摘要，并将 DuckDuckGo 的 `uddg` 跳转链接还原成来源 URL；仅保留 HTTP(S)、无 URL 用户信息且不超过 2048 字符的来源，同一 URL 只返回一次。响应最多读取 2 MB，最多返回 20 条来源，标题和摘要分别最多 200 与 500 字符，`ctx.web` 仍会按调用的 `maxResults` 截断。

HTTP 错误、跳转、非 HTML 内容、过大响应、取消及无法识别的页面（包括验证页）均以 `WebError` 失败；只有明确的无结果页面才返回空列表。该公共 HTML 页面不是受支持的稳定搜索 API，其标记、反自动化策略、可用性和搜索质量均由 DuckDuckGo 决定，不承诺与付费搜索端点等价；若页面格式改变，需要更新本包解析器。未受限于单独的 API 配额，但远端可能限流。

## 模型体验

模型仅通过 [`web_search`](../tool-web/README.md) 看到标题、来源 URL 与有界摘要；本包不贡献提示词或工具 schema。结果与提供方错误会追加到工具结果，token 用量取决于实际返回条目；注册和切换提供方不会直接改变既有请求前缀或 KV Cache。

## 已知限制与暂缓事项

- **公共 HTML 页面非稳定 API**：DuckDuckGo 可以更改标记或限制自动化访问；异常页面会明确失败，不将空白内容作为成功搜索。
- **不提供生成答案和发布日期**：结果仅保留搜索页可引用的链接、标题与摘要。
