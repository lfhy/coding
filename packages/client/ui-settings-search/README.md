# @deepseek-ai/dsh-client-ui-settings-search

独立的「联网搜索」设置分区。`web.searchProvider` 选择 DuckDuckGo、DeepSeek 官方或 Tavily；DuckDuckGo 免费且无需密钥，并且是默认值。各提供方只显示自己的设置：DuckDuckGo 的 `proxyURL` 属于 `web-search-duckduckgo`；DeepSeek 的 `baseURL`、`proxyURL`、`model` 和 `apiKeyEnv` 属于 `web-search-deepseek`；Tavily 的 `baseURL`、`proxyURL` 和 `apiKeyEnv` 属于 `web-search-tavily`。所有字段留空保存会清除用户覆盖，继承部署值；空白代理表示没有该提供方的专用代理。代理使用 HTTP(S) 前向代理，允许本机与 IP 地址，不允许凭据、查询或片段。接口基址要求 HTTPS 且不允许凭据、查询或片段；DeepSeek 允许合法单标签主机名，但拒绝本机地址与内网后缀，Tavily 额外要求含点的公网域名。DeepSeek 空白基址优先使用 `DEEPSEEK_SEARCH_BASE_URL`，否则使用 `https://api.deepseek.com/anthropic/v1`；默认模型是 `deepseek-v4-flash`，默认凭据引用是 `DEEPSEEK_SEARCH_API_KEY`。Tavily 默认基址是 `https://api.tavily.com`，默认凭据引用是 `TAVILY_API_KEY`。更改提供方后对后续搜索生效，不改变已有会话。

密钥明文只发送给 `credentials.set`，不写入设置文档、页面共享 store 或任何读取响应；界面通过 `credentials.describe` 仅显示当前所选提供方的引用是否已配置及可写。选择 DeepSeek 或 Tavily 后，缺少凭据会明确提示搜索不可用，不会静默回退 DuckDuckGo。设置写入由各自的 `settingsScope` 以命名空间 revision 防止覆盖并发变更；拒绝、失败或等待保存期间更新的草稿保留给用户修正。远程浏览器没有可写的 Host 设置。

## 模型体验

本包不直接贡献模型可见内容。搜索提供方产生的结果由 Web 搜索能力记录在所属会话事件中。

#### KV Cache 影响

本包只修改后续搜索提供方配置，不修改提示词前缀。
