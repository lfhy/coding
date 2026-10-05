/** 搜索分区的用户可见文案。 */
export type SearchSettingsKey = keyof typeof zh

/** 搜索设置分区的简体中文界面文案。 */
export const zh = {
  nav: '联网搜索', title: '联网搜索', intro: '选择搜索来源，并按需配置各自的接口与代理。',
  provider: '搜索来源', duckduckgo: 'DuckDuckGo', duckduckgoHint: '免费，无需配置密钥。',
  deepseek: 'DeepSeek 官方', deepseekHint: '使用专用模型和密钥；未配置密钥时搜索不可用，不会自动回退。',
  tavily: 'Tavily', tavilyHint: '使用独立的 Tavily API 密钥；未配置密钥时搜索不可用。',
  endpoint: '接口地址', endpointHint: 'Anthropic Messages 兼容基址；留空优先使用 DEEPSEEK_SEARCH_BASE_URL，否则使用官方地址。',
  tavilyEndpointHint: '留空使用 https://api.tavily.com。',
  proxy: 'HTTP 代理地址', proxyHint: '可填 HTTP(S) 前向代理地址（含本机地址）；留空不设置专用代理。',
  model: '搜索模型', modelHint: '留空恢复部署默认模型。',
  keyRef: '密钥环境变量名', keyRefHint: '仅保存凭据引用；留空恢复默认 DEEPSEEK_SEARCH_API_KEY。',
  tavilyKeyRefHint: '仅保存凭据引用；留空恢复默认 TAVILY_API_KEY。',
  apiKey: '专用搜索密钥', apiKeyHint: '密钥存入凭据服务；留空保持已保存密钥。',
  keySet: '此引用已配置密钥。', keyMissing: '此引用没有密钥；选用 DeepSeek 官方时搜索不可用。',
  tavilyKeyMissing: '此引用没有密钥；选用 Tavily 时搜索不可用。',
  keyLoading: '正在检查密钥…', keyError: '无法检查密钥状态，请重试。', keyReadOnly: '此密钥由环境提供，无法在此覆盖。', keyRefPending: '请先保存密钥环境变量名，再为该引用保存密钥。',
  save: '保存', saving: '保存中…', saveKey: '保存密钥', reset: '恢复默认',
  invalidEndpoint: '请输入不含凭据、查询、片段和内网字面主机名的 HTTPS 地址。',
  invalidProxy: '请输入不含凭据、查询和片段的 HTTP(S) 代理地址。',
  invalidModel: '模型名不能为空；可使用恢复默认。', invalidRef: '请输入合法的环境变量名。',
  readOnly: '本部署的设置为只读。', unavailable: '此部署没有开放联网搜索设置。',
  failed: '未能完成保存；此前的字段可能已生效。草稿已保留，请核对并重试。', keyFailed: '未能保存密钥，请检查并重试。',
} as const

/** 搜索设置分区的英文界面文案。 */
export const en: Record<SearchSettingsKey, string> = {
  nav: 'Web search', title: 'Web search', intro: 'Choose a search source and configure its endpoint or proxy as needed.',
  provider: 'Search source', duckduckgo: 'DuckDuckGo', duckduckgoHint: 'Free, with no API key required.',
  deepseek: 'DeepSeek official', deepseekHint: 'Uses a dedicated model and key; without a key search is unavailable, with no automatic fallback.',
  tavily: 'Tavily', tavilyHint: 'Uses a separate Tavily API key; without a key search is unavailable.',
  endpoint: 'Endpoint', endpointHint: 'Anthropic Messages-compatible base URL; blank uses DEEPSEEK_SEARCH_BASE_URL when set, otherwise the official endpoint.',
  tavilyEndpointHint: 'Leave blank for https://api.tavily.com.',
  proxy: 'HTTP proxy URL', proxyHint: 'HTTP(S) forward proxy, including localhost; blank leaves no provider-specific proxy.',
  model: 'Search model', modelHint: 'Leave blank to inherit the deployment default model.',
  keyRef: 'Credential environment name', keyRefHint: 'Only the credential reference is saved; leave blank for DEEPSEEK_SEARCH_API_KEY.',
  tavilyKeyRefHint: 'Only the credential reference is saved; leave blank for TAVILY_API_KEY.',
  apiKey: 'Dedicated search key', apiKeyHint: 'Stored in the credential service; leave blank to keep the existing key.',
  keySet: 'A key is configured for this reference.', keyMissing: 'No key for this reference; official DeepSeek search is unavailable.',
  tavilyKeyMissing: 'No key for this reference; Tavily search is unavailable.',
  keyLoading: 'Checking key…', keyError: 'Could not check key status. Please retry.', keyReadOnly: 'This key comes from the environment and cannot be overridden here.', keyRefPending: 'Save the credential name before saving a key for it.',
  save: 'Save', saving: 'Saving…', saveKey: 'Save key', reset: 'Restore default',
  invalidEndpoint: 'Enter an HTTPS URL without credentials, query, fragment, or a local literal hostname.',
  invalidProxy: 'Enter an HTTP(S) proxy URL without credentials, query, or fragment.',
  invalidModel: 'Enter a model name, or restore the default.', invalidRef: 'Enter a valid environment variable name.',
  readOnly: 'This deployment stores settings read-only.', unavailable: 'This deployment does not expose web search settings.',
  failed: 'Saving did not finish; earlier fields may have taken effect. Your draft remains for review and retry.', keyFailed: 'The key was not saved. Please check and retry.',
}
