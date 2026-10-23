# coding-web-search-searxng

无密钥的 SearXNG 元搜索提供方，向 [`ctx.web`](../web/README.md) 注册 id `searxng`。逐个请求实例的 JSON 接口（`{base}/search?q=…&format=json`），按实例列表顺序自动切换；请求形状参考 MIT 许可的 [omdsh-dev/dsh-free-search](https://github.com/omdsh-dev/dsh-free-search) 的 `searchSearxng`，按本仓 provider 形态重写。

## 配置与行为

本包没有 API key。可在 `web-search-searxng` 设置分节或插件配置中填写：

- `instances`：自定义实例基址，按数组顺序尝试。省略或为空数组时使用内置的 6 个公共实例（`SEARXNG_INSTANCES`：`opnxng.com`、`priv.au`、`searx.be`、`searx.tiekoetter.com`、`search.inetol.net`、`paulgo.io`）。每项必须是 `http(s)` 绝对地址，且不带凭据、查询串与片段；允许挂在子路径下（如 `https://host/searxng`），末尾斜杠在请求前归一化。
- `outbound`：出站选择，复用共享契约（直连缺省、内置代理池或自定义代理）。直连走原生 fetch，自定义代理经独立 HTTPS CONNECT 发起并在请求结束或取消后释放连接，不改动全局代理设置；自定义地址仅允许不带凭据、查询串与片段的 HTTP(S) URL。

每次搜索按顺序尝试实例，每次尝试独立：向 `{base}/search` 发送匿名 GET，只携带 URL 编码的 `q` 与 `format=json`；不跟随 HTTP 重定向，不发送凭据，使用常量桌面 UA，单实例 8 秒超时。某个实例超时、HTTP 非 2xx、非 JSON 内容、超过响应上限或 JSON 形状不符时，只记下一条失败原因并继续下一个实例；调用方的取消则立即终止剩余尝试。

全部实例失败时抛出 `WEB_PROVIDER_ERROR`，消息以 `all SearXNG instances failed:` 起头并汇总每个实例的原因（超过 300 字符截断，避免刷屏）；自定义实例列表里不可用的地址以序号点名（回显用户误填的地址可能泄露凭据，所以只报位置）。某个实例返回了合法的空结果时，按 0 结果返回空列表而不是报错，同时仍会继续尝试后续实例。

解析 `results[].{url,title,content}` 为来源：`content` 映射到摘要；仅保留 HTTP(S)、无 URL 用户信息且不超过 2048 字符的来源，同一 URL 只返回一次，最多 20 条，标题与摘要分别最多 200 与 500 字符，`ctx.web` 仍会按调用的 `maxResults` 截断（默认 10）；本包在请求层也按同一上限切片。取消映射为 `WEB_ABORTED`，其余失败映射为 `WEB_PROVIDER_ERROR`。

## 模型体验

模型仅通过 [`web_search`](../tool-web/README.md) 看到标题、来源 URL 与有界摘要；本包不贡献提示词或工具 schema。结果与提供方错误会追加到工具结果，token 用量取决于实际返回条目；注册和切换提供方不会直接改变既有请求前缀或 KV Cache。

## 已知限制与暂缓事项

- **公共实例不是稳定服务**：它们由志愿者维护，可能限流、返回 429/403、关闭 `format=json` 接口或整体下线。内置列表只是缺省起点，不构成可用性承诺；建议按需配置自己或团队自建的实例。
- **结果质量取决于实例**：SearXNG 聚合哪些引擎、索引覆盖面与排序都由实例决定，不同实例对同一查询可能返回差异很大的条目集合；某个实例返回 0 条结果时会换下一个实例。
- **不提供日期与生成答案**：跨实例映射只保留 URL、标题与摘要，`publishedAt` 与聚合生成答案都为空。
- **最坏耗时随实例数增长**：单实例超时固定为 8 秒且不暴露为配置项，六个公共实例全部卡死时一次搜索可能接近 48 秒；自定义列表越短，失败路径越快。
