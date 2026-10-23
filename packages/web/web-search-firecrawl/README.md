# coding-web-search-firecrawl

Firecrawl 搜索提供方，向 [`ctx.web`](../web/README.md) 注册 id `firecrawl`。有 API key 时调用 Firecrawl 账号档，没有 key 时走官方 keyless 匿名额度；两者都请求 `POST {baseURL}/v2/search`。请求形状与 keyless 出口拒绝判定参考 MIT 许可的 [omdsh-dev/dsh-free-search](https://github.com/omdsh-dev/dsh-free-search) 的 `searchFirecrawl`，按本仓 provider 形态重写。

## 配置与行为

配置分两个来源，都可在 `web-search-firecrawl` 设置分节或插件配置中填写：

- **`apiKey`**（可选）：Firecrawl API key。省略时读取启动环境里的 `FIRECRAWL_API_KEY`；仍为空则走 keyless 匿名额度——此时请求**不带** `authorization` 头。设置在下一次搜索生效，每次搜索重新读取，因此环境变量或设置里的轮换无需重启。
- **`baseURL`**（可选）：端点基址，默认 `https://api.firecrawl.dev`，请求追加 `/v2/search`，必须是绝对 HTTP(S) 地址且不含凭据、查询串或片段。自带部署的 Firecrawl 通常在本机明文端口上，因此不强制 HTTPS；携带 API key 时应自行使用 HTTPS。
- **`outbound`**（可选）：出站选择，复用共享契约 `outbound`（直连缺省、内置代理池或自定义代理）。直连走原生 fetch，自定义代理经独立 HTTPS CONNECT 发起并在请求结束或取消后释放连接，不改动全局代理设置；自定义地址仅允许不带凭据、查询串与片段的 HTTP(S) URL。

每次搜索发送 `POST {baseURL}/v2/search`，JSON 请求体为 `query` 与 `limit`（`maxResults` 截到 1–20，默认 10）；不发送时间过滤条件。请求不跟随 HTTP 重定向，单次 12 秒超时并尊重调用方取消，响应（含错误响应）最多读取 2 MiB。响应按 v2 的 `data.web[]` 解析（同时接受 `data[]` 数组形态），逐条映射 `url`／`title`／`description` 到来源；仅保留 HTTP(S)、无 URL 用户信息且不超过 2048 字符的来源，同一 URL 只返回一次，最多 20 条，标题与摘要分别最多 200 与 500 字符，`ctx.web` 仍会按调用的 `maxResults` 截断。缺 URL 或 URL 不安全的单条结果被跳过，顶层结构不符才整体失败。

HTTP 错误、非 JSON 响应、超大响应、响应体解析失败与取消都以 `WebError` 失败：`401` 与 `429` 有各自的诊断（keyless 时提示配置 key），其余状态附带截断到 500 字符的服务端说明，并在拼接前抹掉本次请求携带的 key，避免密钥随错误体进入会话记录。

### keyless 档按出口 IP 判定

Firecrawl 的 keyless 档按出口 IP 判定，VPN／代理出口常被 `403` 拒绝。本包把「`403` 且响应体提到 vpn、proxy、without an api key 等字样」识别为出口拒绝而非 key 失效或限流；命中时在当前进程内**冷却 6 小时**，冷却期内同一个出口的 keyless 搜索直接返回诊断失败，**不再发送请求**（避免每次搜索都白等一次往返）。冷却按「代理指纹」记账，即当前 `outbound` 解析出的代理地址（直连记为 `direct`）：换出一套代理就是新的出口 IP，旧冷却立即失效并允许重新尝试；冷却期内配置 API key 则完全绕过该限制。冷却不参与提供方的可用性判断（`available()` 仍为 true），失败诊断由搜索调用给出，避免被选择层改写成笼统的「提供方不可用」。

## 模型体验

模型仅通过 [`web_search`](../tool-web/README.md) 看到标题、来源 URL 与有界摘要；本包不贡献提示词或工具 schema。结果与提供方错误（含 keyless 冷却诊断）会追加到工具结果，token 用量取决于实际返回条目与错误文案长度。

#### KV Cache 影响

不会直接导致 KV Cache 失效；本包不拥有请求前缀，注册、切换提供方或读取设置都不改动既有历史。每次搜索只在工具结果位置追加内容，新增内容不改变之前已发送的前缀。

## 已知限制与暂缓事项

- **keyless 额度不保底**：keyless 档由 Firecrawl 按出口 IP 授予匿名额度，VPN／代理出口会被拒绝；本包只做 6 小时冷却与明确诊断，不会自动切换其他搜索提供方。
- **冷却记录随实例保存**：冷却挂在提供方实例上（等价于本进程内），插件重载或换出口代理都会重新开始判定；不写入设置或磁盘。
- **不带生成答案、时间过滤与站点过滤**：只映射官方响应的 `data.web[]` 字段；`WebSearchRequest` 目前只携带 `query` 与 `maxResults`，本包也不额外附加 `tbs` 等 Firecrawl 专有参数。
