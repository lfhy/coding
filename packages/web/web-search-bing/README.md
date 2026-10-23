# coding-web-search-bing

无密钥的 Bing 搜索提供方，向 [`ctx.web`](../web/README.md) 注册 id `bing`。抓取 Bing 公共 SERP 页面（`https://www.bing.com/search`）并解析 `b_algo` 结果块；请求形状参考 MIT 许可的 [omdsh-dev/dsh-free-search](https://github.com/omdsh-dev/dsh-free-search) 的 `searchBing`，按本仓 provider 形态重写。

## 配置与行为

本包没有 API key。可在 `web-search-bing` 设置分节或插件配置中填写可选的 `market`（如 `zh-CN`），取值必须是 `ll-CC` 形态的语言区域标签；设置在下一次搜索生效。配置了 `market` 时请求才携带 `mkt` 参数，并按 market 反推 `Accept-Language`（如 `zh-CN` → `zh-CN,zh;q=0.9,en;q=0.8`）；省略时不发 `mkt`，`Accept-Language` 固定为 `zh-CN,en;q=0.8`，由 Bing 自行本地化——实测 `mkt=zh-CN` 在部分地区／线路会返回空 SERP，因此默认不发送。出站选择复用共享契约 `outbound`（直连缺省、内置代理池或自定义代理）：直连走原生 fetch，自定义代理经独立 HTTPS CONNECT 发起并在请求结束或取消后释放连接，不改动全局代理设置；自定义地址仅允许不带凭据、查询串与片段的 HTTP(S) URL。

每次搜索向固定端点发送匿名 GET，只携带 URL 编码的 `q`（与可选的 `mkt`）；不跟随 HTTP 重定向，不发送凭据，使用常量桌面 UA，单次请求 12 秒超时并尊重调用方取消。解析 `b_algo` 块提取 url/title/snippet，把 Bing 的 `bing.com/ck/a` 跳转链接（`u` 参数，base64url + `a1` 前缀）还原成来源 URL，做 HTML 实体解码；仅保留 HTTP(S)、无 URL 用户信息且不超过 2048 字符的来源，同一 URL 只返回一次，最多返回 20 条，标题和摘要分别最多 200 与 500 字符，`ctx.web` 仍会按调用的 `maxResults` 截断（默认 10）。Bing 在查询无结果时会返回一张与查询完全无关的缓存 SERP；当解析出的结果与查询词面完全不重叠时，本包返回空列表而不是垃圾结果。

HTTP 错误、跳转、非 HTML 内容、超大响应与取消以 `WebError` 失败。Bing 会对可疑出口 IP 间歇性返回约 91KB 的空 SERP（`b_algo` 块数为 0），表现为按请求频率收紧、减少请求后自行恢复；此时本包返回空列表，不重试（实测重试会使请求数翻倍、更容易被压死）。

## 模型体验

模型仅通过 [`web_search`](../tool-web/README.md) 看到标题、来源 URL 与有界摘要；本包不贡献提示词或工具 schema。结果与提供方错误会追加到工具结果，token 用量取决于实际返回条目；注册和切换提供方不会直接改变既有请求前缀或 KV Cache。

## 已知限制与暂缓事项

- **公共 SERP 页面非稳定 API**：Bing 可以随时更改 `b_algo` 标记或反自动化策略；页面格式漂移时需要更新本包解析器，空 SERP 也可能来自出口 IP 而非页面格式。
- **不提供生成答案和发布日期**：结果仅保留搜索页可引用的链接、标题与摘要。
