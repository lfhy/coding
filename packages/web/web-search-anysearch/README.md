# coding-web-search-anysearch

AnySearch 搜索提供方，向 [`ctx.web`](../web/README.md) 注册 id `anysearch`。AnySearch 提供免费匿名额度，配置 Bearer 密钥可提额；端点返回结构化 JSON，不需要抓取页面。请求形状参考 MIT 许可的 [omdsh-dev/dsh-free-search](https://github.com/omdsh-dev/dsh-free-search) 的 `searchAnysearch`，按本仓 provider 形态重写。

## 配置与行为

本包在 `web-search-anysearch` 设置分节或插件配置中提供三个可选字段，均在下一次搜索生效：

- `apiKey`：Bearer 密钥，设置里按 secret 保存。省略时读取启动环境变量 `$ANYSEARCH_API_KEY`；两者都为空则匿名请求。密钥每次都重新解析，改设置不需要重新注册提供方。
- `baseURL`：端点基址，缺省 `https://api.anysearch.com`，请求追加 `/v1/search`。因为该端点会收到 Bearer 密钥，只接受不含凭据、查询串与片段的公网 HTTPS 地址；内网字面地址、`localhost` 与 `.local`／`.internal` 域名在设置写入时即被拒绝。
- `outbound`：复用共享出站契约（直连缺省、内置代理池或自定义代理）。直连走原生 fetch；代理经独立 dispatcher 发起并在请求结束、失败或取消后释放，不改动全局代理设置。自定义地址仅允许不带凭据、查询串与片段的 HTTP(S) URL。

每次搜索向端点发送匿名或带密钥的 `POST`，`content-type` 为 `application/json`，请求体是 `{"query":…,"max_results":…}`：`max_results` 取调用方的 `maxResults`，缺省 10、上限 20。请求不跟随 HTTP 重定向（`redirect: 'error'`），不发送多余查询参数，单次搜索（含下述匿名重试）12 秒超时并尊重调用方取消，响应体最多读取 2 MB。

带密钥的请求返回 `401`／`403` 时，本进程忽略该密钥并用匿名档重试一次：结果前追加一行诊断说明本次走了匿名档，配置与存储都不修改，因此下一次搜索仍会先带该密钥请求。匿名重试同样被拒时按 `WEB_PROVIDER_ERROR` 报错。响应必须是 `code: 0` 的 JSON 对象且含 `data.results` 数组；无 URL 或 URL 不可引用的条目被跳过，同一 URL 只返回一次，来源仅保留 HTTP(S)、无 URL 用户信息、不超过 2048 字符的地址，标题和摘要分别最多保留 200 与 500 字符。HTTP 错误状态、跳转、非 JSON 内容、超大响应与取消以 `WebError` 失败。

## 模型体验

模型仅通过 [`web_search`](../tool-web/README.md) 看到标题、来源 URL、有界摘要，以及密钥被拒时的一行降级诊断；本包不贡献提示词或工具 schema。结果与提供方错误会追加到工具结果，token 用量取决于实际返回条目；注册和切换提供方不会直接改变请求前缀或 KV Cache。

## 已知限制与暂缓事项

- **匿名额度有限**：免费档的额度与限流由服务方按出口 IP 决定，本包不假设具体数值；额度耗尽时搜索以 `WEB_PROVIDER_ERROR` 失败，不静默改用其他提供方。
- **密钥被拒时每次搜索多一次请求**：降级只发生在单次搜索内，不记录“本进程已忽略该密钥”的粘性状态；密钥一直无效时，每次搜索都会先带密钥再匿名重试。这样设置与存储始终只由用户修改，代价是多一次请求。
- **不提供生成答案和发布日期**：端点返回的是标题、链接与摘要，本包不合成答案，也不臆造时间戳。
