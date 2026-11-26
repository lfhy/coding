# coding-tool-apply-patch

基于 `ctx.fs` 的模型可见 `apply_patch` 工具。它使用 Codex 补丁封套；Responses 原生语法调用可直接传递补丁文本，其他协议及不支持语法工具的模型沿用必填 `input` 字符串的 JSON 工具参数。两条路径经过同一个执行器与文件系统策略；原生语法改编来源见 [NOTICE.md](NOTICE.md)。

## 支持的补丁操作

解析器接受 `*** Begin Patch`／`*** End Patch` 封套、`*** Add File` 与 `*** Update File`，更新段包含 `@@` 上下文、`+`／`-`／空格行和可选 `*** End of File`。模型侧提供与该子集一致的 Lark 语法；原生语法工具的说明要求直接提交补丁文本，不包 JSON。普通函数调用仍以 `{ "input": "<完整补丁文本>" }` 提交。

路径交给 `ctx.fs.resolve`，不在工具层预先要求工作区相对路径；文件系统提供方和沙箱策略负责解析与约束。新增和更新分别使用 `ctx.fs.writeText` 与 `ctx.fs.editText`，保留观测策略、版本检查与远程文件系统路由。`*** Delete File` 和 `*** Move to` 会明确拒绝：删除由 `coding-tool-fs` 的 `delete_file` 承担（它有自己的递归目录语义与符号链接护栏），改名仍没有后端原语，工具不会绕过能力边界直接操作宿主文件系统。

## 模型体验

本包贡献 `tool:apply_patch` 提示词段和 `apply_patch` schema。成功结果列出新增或更新的路径，客户端工具卡可读取可回放的 diff 元数据；补丁正文不会复制进成功摘要。工具定义使用 `summaryParameter: false`，原始补丁不要求模型补写仅供展示的摘要。

#### KV Cache 影响

工具挂载期间指导文本与 schema 稳定；补丁结果追加在已有可复用请求前缀之后。

## 已知限制与暂缓事项

- 删除与移动需要 `coding-fs` 及每个文件系统提供方先提供对应原语。
- 原生语法调用只在选定的 Responses 协议支持语法工具且模型未显式禁用该能力时启用；其他协议使用 JSON 函数调用，不能由模型名称推断协议能力。
