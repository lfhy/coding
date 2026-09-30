# @deepseek-ai/dsh-client-ui-settings-search

独立的「联网搜索」设置分区。`web.searchProvider` 选择免费且无需密钥的 DuckDuckGo，或 DeepSeek 官方搜索；前者为默认值。DeepSeek 的 `baseURL`、`model` 和 `apiKeyEnv` 在 `web-search-deepseek` 命名空间中编辑，空白字段保存为取消用户覆盖，继承部署值；空白地址优先使用 `DEEPSEEK_SEARCH_BASE_URL` 环境变量，否则使用 `https://api.deepseek.com/anthropic/v1`，默认模型是 `deepseek-v4-flash`，默认凭据引用是 `DEEPSEEK_SEARCH_API_KEY`。更改提供方后对后续搜索生效，不改变已有会话。

密钥明文只发送给 `credentials.set`，不写入设置文档、页面共享 store 或任何读取响应；界面通过 `credentials.describe` 仅显示当前引用是否已配置及可写。选择 DeepSeek 后，缺少凭据会明确提示搜索不可用，不会静默回退 DuckDuckGo。设置写入由所属 `settingsScope` 以命名空间 revision 防止覆盖并发变更；拒绝或失败的草稿保留给用户修正。远程浏览器没有可写的 Host 设置。

## 模型体验

本包不直接贡献模型可见内容。搜索提供方产生的结果由 Web 搜索能力记录在所属会话事件中。

#### KV Cache 影响

本包只修改后续搜索提供方配置，不修改提示词前缀。
